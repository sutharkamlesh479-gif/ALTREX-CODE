import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { classifyCommand } from '../security/command-classifier'
import type { PermissionProfile } from '../security/policy'
import { uuidv7 } from '../util/uuid'
import { runProjectCommand } from './command-runner'
import type { ToolEvent } from './project-tools'
import { CoreCommandError } from '../errors'

export type TerminalRunInput = { projectPath: string; command: string; args: string[]; timeoutMs: number; profile: PermissionProfile }
export type TerminalRunResult = { commandId: string; exitCode: number | null; timedOut: boolean; durationMs: number; output: string }

/**
 * Commands the user runs from the UI. The user is the actor, so HIGH-risk commands the user typed are
 * allowed (no approval round-trip), but FORBIDDEN is refused and read-only projects allow LOW only. Execution
 * is the same argv-only runner agents use (no shell, secrets stripped from the environment, tree kill).
 */
export class UserTerminal {
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly onEvent: (event: Extract<ToolEvent, { type: 'command.started' | 'command.output' | 'command.completed' }>) => void = () => undefined) {}

  async run(input: TerminalRunInput): Promise<TerminalRunResult> {
    const root = realpathSync(input.projectPath)
    let scripts: Record<string, string> = {}
    try { scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {} } catch { /* no package.json */ }
    const classification = classifyCommand(input.command, input.args, { scripts, fileExists: path => { try { return lstatSync(join(root, path)).isFile() } catch { return false } } })
    if (classification.risk === 'FORBIDDEN') throw new CoreCommandError('POLICY_DENIED', `ALTREX does not run this command: ${classification.reason}. Run it in your own terminal if you intend to.`)
    if (input.profile === 'read_only' && classification.risk !== 'LOW') throw new CoreCommandError('POLICY_DENIED', `The project is read-only in ALTREX (${classification.risk}: ${classification.reason}).`)
    const commandId = uuidv7(), controller = new AbortController(), started = Date.now(), shown = [input.command, ...input.args].join(' ')
    this.running.set(commandId, controller)
    this.onEvent({ type: 'command.started', commandId, command: shown })
    try {
      const result = await runProjectCommand({ projectRoot: root, command: input.command, args: input.args, timeoutMs: input.timeoutMs, signal: controller.signal, onOutput: (stream, text) => this.onEvent({ type: 'command.output', commandId, stream, text }) })
      const durationMs = Date.now() - started
      this.onEvent({ type: 'command.completed', commandId, command: result.command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs })
      if (controller.signal.aborted) throw new CoreCommandError('CANCELLED', 'The command was cancelled.')
      return { commandId, exitCode: result.exitCode, timedOut: result.timedOut, durationMs, output: result.output.slice(-200_000) }
    } catch (error) {
      if (error instanceof CoreCommandError) throw error // already reported as completed
      this.onEvent({ type: 'command.completed', commandId, command: shown, exitCode: null, timedOut: false, durationMs: Date.now() - started })
      if (controller.signal.aborted) throw new CoreCommandError('CANCELLED', 'The command was cancelled.')
      throw new CoreCommandError('INVALID_REQUEST', error instanceof Error ? error.message : 'The command could not start.')
    } finally { this.running.delete(commandId) }
  }

  cancel(commandId: string): boolean {
    const controller = this.running.get(commandId)
    if (!controller) return false
    controller.abort()
    return true
  }
}
