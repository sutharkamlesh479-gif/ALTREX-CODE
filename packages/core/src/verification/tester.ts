import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckName, Evidence } from '@altrex/contracts'
import type { ProjectProfile } from '../repo/project-profile'
import { classifyCommand } from '../security/command-classifier'
import { decide, type PermissionProfile } from '../security/policy'
import { runProjectCommand, type ProjectCommandResult } from '../tools/command-runner'
import { uuidv7 } from '../util/uuid'
import { parseTestOutput } from './parsers'
import { treeHash as computeTreeHash } from './tree-hash'

export type CheckSpec = { name: CheckName; argv: string[]; source: string }
export type TesterEvent =
  | { type: 'test.started'; testId: string; name: CheckName; command: string }
  | { type: 'test.completed'; testId: string; evidence: Evidence }

export type TesterOptions = {
  root: string
  checks: CheckSpec[]
  signal: AbortSignal
  profile?: PermissionProfile
  onEvent?: (event: TesterEvent) => void
  /** Per check. Default 10 minutes. */
  timeoutMs?: number
  /** Injected for tests. */
  runner?: typeof runProjectCommand
  treeHash?: (root: string) => string | null
}

export type TesterResult = { evidence: Evidence[]; outputs: Map<string, string> }

const ORDER: CheckName[] = ['typecheck', 'lint', 'test', 'build']
const TAIL = 4000

/** Checks the project declares (profile commands), one per kind, in a stable order. Never invented. */
export function discoverChecks(profile: Pick<ProjectProfile, 'commands'>): CheckSpec[] {
  const checks: CheckSpec[] = []
  for (const name of ORDER) {
    const command = profile.commands.find(item => item.kind === name)
    if (command) checks.push({ name, argv: command.argv, source: command.source })
  }
  return checks
}

function tail(output: string): string {
  if (output.length <= TAIL) return output
  const lines = output.split(/\r?\n/)
  const firstError = lines.findIndex(line => /error|fail|exception|traceback/i.test(line))
  const head = firstError >= 0 ? lines.slice(firstError, firstError + 12).join('\n').slice(0, 1500) : ''
  const end = output.slice(-(TAIL - head.length - 20))
  return (head ? `${head}\n…\n${end}` : end).slice(-TAIL)
}

/**
 * The Tester (code, not a model): runs each discovered check through the permission policy, records
 * Evidence bound to the tree it ran against, and flags checks that modified source files. Dependencies are
 * installed with lifecycle scripts disabled when node_modules is missing.
 */
export async function runChecks(options: TesterOptions): Promise<TesterResult> {
  const runner = options.runner ?? runProjectCommand
  const hashOf = options.treeHash ?? computeTreeHash
  const evidence: Evidence[] = [], outputs = new Map<string, string>()
  const notRun = (check: CheckSpec, note: string) => {
    const item: Evidence = { evidenceId: uuidv7(), name: check.name, argv: check.argv, status: 'NOT_RUN', exitCode: null, timedOut: false, durationMs: 0, treeHash: hashOf(options.root) ?? 'unknown', outputTail: '', note: note.slice(0, 1000), at: new Date().toISOString() }
    evidence.push(item)
    options.onEvent?.({ type: 'test.completed', testId: item.evidenceId, evidence: item })
  }

  const prepared = await prepareDependencies(options, runner)
  for (const check of options.checks) {
    options.signal.throwIfAborted()
    const [command, ...args] = check.argv
    const classification = classifyCommand(command!, args, { scripts: scripts(options.root), fileExists: path => { try { return lstatSync(join(options.root, path)).isFile() } catch { return false } } })
    const decision = decide(options.profile ?? 'standard', classification.risk, classification.capability, classification.reason)
    if (decision.action !== 'allow') { notRun(check, `Not run: ${decision.reason} (${decision.risk}).`); continue }
    if (!prepared.ok) { notRun(check, prepared.note); continue }

    const testId = uuidv7(), before = hashOf(options.root), started = Date.now(), shown = check.argv.join(' ')
    options.onEvent?.({ type: 'test.started', testId, name: check.name, command: shown })
    let result: ProjectCommandResult | null = null, error: string | null = null
    try { result = await runner({ projectRoot: options.root, command: command!, args, timeoutMs: options.timeoutMs ?? 600_000, signal: options.signal }) }
    catch (caught) { if (options.signal.aborted) throw caught; error = caught instanceof Error ? caught.message : 'The check could not start.' }
    const after = hashOf(options.root), output = result?.output ?? error ?? ''
    const modifiedSource = before !== null && after !== null && before !== after
    const parsed = check.name === 'test' && result ? parseTestOutput(output) : undefined
    const status: Evidence['status'] = error ? 'ERROR' : result!.timedOut ? 'TIMEOUT' : modifiedSource ? 'ERROR' : result!.exitCode === 0 ? 'PASS' : 'FAIL'
    const item: Evidence = {
      evidenceId: testId, name: check.name, argv: check.argv, status, exitCode: result?.exitCode ?? null, timedOut: result?.timedOut ?? false,
      durationMs: Date.now() - started, treeHash: before ?? 'unknown', outputTail: tail(output), at: new Date().toISOString(),
      ...(parsed ? { parsed } : {}),
      ...(error ? { note: error.slice(0, 1000) } : modifiedSource ? { note: 'The check modified project source files, so its result does not describe the tree under test.' } : {}),
    }
    evidence.push(item); outputs.set(testId, output)
    options.onEvent?.({ type: 'test.completed', testId, evidence: item })
  }
  return { evidence, outputs }
}

function scripts(root: string): Record<string, string> {
  try { return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {} } catch { return {} }
}

async function prepareDependencies(options: TesterOptions, runner: typeof runProjectCommand): Promise<{ ok: true } | { ok: false; note: string }> {
  const manager = options.checks.find(check => ['pnpm', 'npm', 'yarn', 'bun'].includes(check.argv[0]!))?.argv[0]
  if (!manager || existsSync(join(options.root, 'node_modules'))) return { ok: true }
  let pkg: { dependencies?: object; devDependencies?: object; workspaces?: unknown } = {}
  try { pkg = JSON.parse(readFileSync(join(options.root, 'package.json'), 'utf8')) as typeof pkg } catch { return { ok: true } }
  const needs = Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).length > 0 || Boolean(pkg.workspaces)
  if (!needs) return { ok: true }
  if ((options.profile ?? 'standard') === 'read_only') return { ok: false, note: 'Dependencies are not installed and the project is read-only, so checks could not run.' }
  const args = manager === 'npm' ? [existsSync(join(options.root, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts']
  try {
    const result = await runner({ projectRoot: options.root, command: manager, args, timeoutMs: 600_000, signal: options.signal })
    return result.exitCode === 0 && !result.timedOut ? { ok: true } : { ok: false, note: `Dependency installation (${manager} ${args.join(' ')}) failed, so checks could not run: ${tail(result.output).slice(-600)}` }
  } catch (error) {
    if (options.signal.aborted) throw error
    return { ok: false, note: `Dependency installation could not start: ${error instanceof Error ? error.message : 'unknown error'}` }
  }
}
