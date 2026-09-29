import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProjectCommand } from '../project-command-runner'
import { changed, snapshot } from './workspace'
import type { Verification } from '../../shared/multi-ai'
export type VerifyCommand = { command: string; args: string[] }
export function projectChecks(root: string): VerifyCommand[] {
  const packagePath = join(root, 'package.json')
  if (existsSync(packagePath)) {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { packageManager?: string; scripts?: Record<string, string> }
    const manager = pkg.packageManager?.split('@')[0] || (existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm')
    if (!['pnpm', 'yarn', 'npm', 'bun'].includes(manager)) throw new Error('Unsupported package manager for verification.')
    return ['typecheck', 'test', 'build'].filter(name => pkg.scripts?.[name] && !/\b(watch|dev|start)\b/.test(pkg.scripts[name]!)).map(name => ({ command: manager, args: ['run', name] }))
  }
  if (existsSync(join(root, 'Cargo.toml'))) return [{ command: 'cargo', args: ['test'] }]
  if (existsSync(join(root, 'go.mod'))) return [{ command: 'go', args: ['test', './...'] }]
  if (existsSync(join(root, 'pytest.ini'))) return [{ command: 'python', args: ['-m', 'pytest'] }]
  return []
}
export async function verifyCommands(root: string, signal: AbortSignal, status: (text: string) => void): Promise<Verification['commands']> {
  const checks = projectChecks(root), results: Verification['commands'] = [], before = snapshot(root)
  const pkg = existsSync(join(root, 'package.json')) ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object; workspaces?: unknown } : null
  const needsDependencies = pkg && (Object.keys(pkg.dependencies ?? {}).length > 0 || Object.keys(pkg.devDependencies ?? {}).length > 0 || pkg.workspaces || existsSync(join(root, 'pnpm-workspace.yaml')))
  if (checks.length && needsDependencies && !existsSync(join(root, 'node_modules'))) {
    const manager = checks[0]!.command
    const args = manager === 'npm' ? [existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'] : manager === 'yarn' ? ['install', '--ignore-scripts'] : ['install', '--ignore-scripts']
    status('Preparing isolated dependencies with lifecycle scripts disabled.')
    const result = await runProjectCommand({ projectRoot: root, command: manager, args, timeoutMs: 300000, signal }); signal.throwIfAborted()
    results.push(result)
    if (result.exitCode !== 0 || result.timedOut) return results
  }
  for (const check of checks) {
    signal.throwIfAborted(); status(`Verifying: ${check.command} ${check.args.join(' ')}`)
    const result = await runProjectCommand({ projectRoot: root, ...check, timeoutMs: 300000, signal }); signal.throwIfAborted(); results.push(result)
    if (result.exitCode !== 0 || result.timedOut) break
  }
  // Build artifacts are excluded; verification must never silently rewrite project source.
  const edits = changed(before, snapshot(root)).filter(path => !/(^|\/)(pnpm-lock.yaml|package-lock.json|yarn.lock|bun.lockb?)$/.test(path))
  if (edits.length) results.push({ command: 'source integrity check', exitCode: 1, output: `Verification modified source: ${edits.join(', ')}` })
  return results.map(result => ({ command: result.command, exitCode: result.exitCode, output: result.output.slice(-12000) }))
}
