import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runProjectCommand, type ProjectCommandResult } from './command-runner'
import { ownsFile } from '../orchestrator/director-contracts'
import type { TaskContract } from '../orchestrator/director-types'
import type { ProviderToolCall } from './types'
import { IGNORED_DIRECTORIES } from '../workspace/ignore'
import { safePath } from '../security/path-guard'
import { classifyCommand, type Risk } from '../security/command-classifier'
import { decide, type PermissionProfile, type ToolCapability } from '../security/policy'
import type { ApprovalBroker } from '../security/approvals'
import { RepositoryIntelligence } from '../repo/intelligence'
import { globToRegExp } from '../repo/search'
import { diff as gitDiff, isRepository, status as gitStatus } from '../git/git'
import { applyUnifiedPatch } from './patch'
import { uuidv7 } from '../util/uuid'

export type { ProviderToolCall }

export type ToolExecutionResult = {
  toolCallId: string
  name: string
  content: string
  changedFile?: string
  changedFiles?: string[]
  commandResult?: ProjectCommandResult
}

/** Observable tool activity (mapped to contract events by the host). */
export type ToolEvent =
  | { type: 'command.started'; commandId: string; command: string }
  | { type: 'command.output'; commandId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'command.completed'; commandId: string; command: string; exitCode: number | null; timedOut: boolean; durationMs: number }
  | { type: 'tool.denied'; tool: string; summary: string; risk: Risk; reason: string }

export type ProjectToolOptions = {
  /** Permission profile of the project (default: standard). */
  profile?: PermissionProfile
  /** Human approvals for HIGH-risk actions. Without a broker, HIGH actions are denied with an explanation. */
  approvals?: ApprovalBroker
  taskId?: string
  onEvent?: (event: ToolEvent) => void
  repo?: RepositoryIntelligence
}

const ignored = IGNORED_DIRECTORIES
const MAX_EDIT_BYTES = 1_000_000

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false } } }) as const

export const codingToolDefinitions = [
  tool('edit_file', 'Replace one exact, unique text segment in a file. Read the relevant range first; use small edits for large files.', { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']),
  tool('append_file', 'Append a small text chunk to an existing owned file. Build large new files in bounded chunks instead of exceeding the response budget.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  tool('list_files', 'List files and directories inside the selected project. Use this before deciding what to edit. Set recursive with an optional glob (e.g. "src/**/*.ts") to list a subtree.', { path: { type: 'string', description: 'Project-relative directory. Use an empty string for the project root.' }, recursive: { type: 'boolean' }, glob: { type: 'string' } }),
  tool('read_file', 'Read a UTF-8 text file inside the selected project.', { path: { type: 'string', description: 'Project-relative file path.' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, ['path']),
  tool('write_file', 'Create or replace a UTF-8 text file inside the selected project. Parent directories are created automatically.', { path: { type: 'string', description: 'Project-relative file path.' }, content: { type: 'string', description: 'Complete file content.' } }, ['path', 'content']),
  tool('run_command', 'Run one development command in the selected project and return its real combined output and exit code. Use it to initialize projects, install dependencies, run builds and tests, and inspect failures. Commands are not executed through a general shell; pass every argument separately. Risky commands (downloading and executing packages, network tools, destructive Git) need user approval; shells, publishing and history rewriting are never allowed.', { command: { type: 'string', description: 'Executable name such as pnpm, npm, node, python, git, cargo, go, or dotnet.' }, args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed directly to the command.' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Optional timeout. Defaults to 120000 ms.' } }, ['command', 'args']),
  tool('search_files', 'Search project files for text or a regular expression. Returns matching lines with paths and line numbers.', { pattern: { type: 'string' }, regex: { type: 'boolean' }, glob: { type: 'string', description: 'Optional path filter, e.g. "src/**/*.ts".' }, max_results: { type: 'integer', minimum: 1, maximum: 500 } }, ['pattern']),
  tool('find_symbol', 'Find where a function, class, type or variable is defined and where it is used.', { name: { type: 'string' } }, ['name']),
  tool('apply_patch', 'Apply a unified diff (@@ hunks) to one file. All hunks must match or nothing changes. Prefer this for multi-location edits.', { path: { type: 'string' }, patch: { type: 'string' } }, ['path', 'patch']),
  tool('delete_file', 'Delete one file inside the project.', { path: { type: 'string' } }, ['path']),
  tool('move_file', 'Move or rename a file inside the project. The destination must not exist.', { from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']),
  tool('git_status', 'Show the Git status of the project (changed, staged and untracked files).', {}),
  tool('git_diff', 'Show the Git diff of the working tree against HEAD, optionally for one path.', { path: { type: 'string' } }),
] as const

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('Tool arguments were not valid JSON.')
  }
}
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')

/**
 * The tools an agent uses inside one project workspace. Every call is path-guarded (no traversal,
 * symlinks, reserved names or protected files), scope-checked for Director workers, policy-checked for
 * commands (classifier → profile → approval), and bounded (writes, bytes, commands, output).
 * A read ledger refuses to overwrite a file that changed outside this task since it was read.
 */
export class ProjectToolBroker {
  private readonly root: string
  private writes = 0
  private writtenBytes = 0
  private commands = 0
  private readonly signal: AbortSignal
  private readonly ledger = new Map<string, string>()
  private repo: RepositoryIntelligence | undefined

  constructor(projectPath: string, signal: AbortSignal = new AbortController().signal, private readonly scope?: TaskContract, private readonly options: ProjectToolOptions = {}) {
    this.root = realpathSync(projectPath)
    this.signal = signal
    this.repo = options.repo
  }

  async execute(call: ProviderToolCall): Promise<ToolExecutionResult> {
    try {
      this.signal.throwIfAborted()
      const args = parseArguments(call.arguments)
      switch (call.name) {
        case 'list_files': return this.listFiles(call.id, typeof args.path === 'string' ? args.path : '', args.recursive === true, typeof args.glob === 'string' ? args.glob : undefined)
        case 'read_file': return this.readFile(call.id, args.path, args.start_line, args.end_line)
        case 'write_file': return this.writeFile(call.id, args.path, args.content)
        case 'edit_file': case 'append_file': return this.editFile(call, args)
        case 'apply_patch': return this.patchFile(call.id, args.path, args.patch)
        case 'delete_file': return this.deleteFile(call.id, args.path)
        case 'move_file': return this.moveFile(call.id, args.from, args.to)
        case 'search_files': return this.searchFiles(call.id, args)
        case 'find_symbol': return this.findSymbol(call.id, args.name)
        case 'git_status': return this.gitStatus(call.id)
        case 'git_diff': return this.gitDiff(call.id, args.path)
        case 'run_command':
          if (this.scope) throw new Error('Worker commands must be requested through the Director for verification. Direct command execution is outside the worker file scope.')
          return await this.runCommand(call.id, args.command, args.args, args.timeout_ms)
        default: throw new Error(`Unknown tool: ${call.name}`)
      }
    } catch (error) {
      return { toolCallId: call.id, name: call.name, content: `ERROR: ${error instanceof Error ? error.message : 'Tool execution failed.'}` }
    }
  }

  // ---- policy ---------------------------------------------------------------------------------

  private get profile(): PermissionProfile { return this.options.profile ?? 'standard' }

  private assertWritable(capability: ToolCapability, summary: string): void {
    const decision = decide(this.profile, 'MEDIUM', capability, summary)
    if (decision.action === 'deny') { this.emit({ type: 'tool.denied', tool: capability, summary, risk: 'MEDIUM', reason: decision.reason }); throw new Error(`Not allowed: ${decision.reason}`) }
  }

  private async authorizeCommand(command: string, args: string[]): Promise<void> {
    const summary = [command, ...args].join(' ').slice(0, 300)
    const classification = classifyCommand(command, args, this.classifyContext())
    const decision = decide(this.profile, classification.risk, classification.capability, classification.reason)
    if (decision.action === 'allow') return
    if (decision.action === 'ask' && this.options.approvals) {
      const outcome = await this.options.approvals.request({ taskId: this.options.taskId ?? null, tool: 'run_command', summary, risk: decision.risk, capability: decision.capability, reason: decision.reason }, this.signal)
      if (outcome.decision === 'approved') return
      this.emit({ type: 'tool.denied', tool: 'run_command', summary, risk: decision.risk, reason: outcome.note })
      throw new Error(`Command not approved (${decision.risk}: ${decision.reason}). ${outcome.note}`)
    }
    const note = decision.action === 'ask'
      ? 'This action needs user approval, and no approval UI is connected. Choose a different approach, or ask the user to allow it.'
      : decision.risk === 'FORBIDDEN' ? 'ALTREX never runs this; the user must do it themselves.' : ''
    this.emit({ type: 'tool.denied', tool: 'run_command', summary, risk: decision.risk, reason: decision.reason })
    throw new Error(`Command is not allowed (${decision.risk}): ${decision.reason}. ${note}`.trim())
  }

  private classifyContext() {
    let scripts: Record<string, string> = {}
    try { scripts = (JSON.parse(readFileSync(join(this.root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {} } catch { /* no package.json */ }
    return {
      scripts,
      fileExists: (path: string) => { try { return lstatSync(this.resolvePath(path).absolute).isFile() } catch { return false } },
      hasLocalBin: (name: string) => /^[\w.@/-]+$/.test(name) && ['', '.cmd', '.exe'].some(suffix => existsSync(join(this.root, 'node_modules', '.bin', `${name}${suffix}`))),
    }
  }

  private emit(event: ToolEvent): void {
    try { this.options.onEvent?.(event) } catch { /* observers never break a tool */ }
  }

  // ---- files ----------------------------------------------------------------------------------

  private resolvePath(input: unknown, allowRoot = false): { absolute: string; relative: string } {
    if (typeof input !== 'string') throw new Error('A project-relative path is required.')
    const normalizedInput = input.trim().replaceAll('\\', '/')
    if ((!allowRoot && normalizedInput.length === 0) || isAbsolute(normalizedInput) || normalizedInput.includes('\0')) {
      throw new Error('The path must be relative to the selected project.')
    }
    const absolute = resolve(this.root, normalizedInput || '.')
    const projectRelative = relative(this.root, absolute)
    if (projectRelative === '..' || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) {
      throw new Error('Path traversal outside the selected project was blocked.')
    }
    if (projectRelative) safePath(projectRelative.replaceAll('\\', '/'))
    let cursor = this.root
    for (const segment of projectRelative.split(sep).slice(0, -1)) {
      cursor = resolve(cursor, segment)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic-link traversal was blocked.')
    }
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) throw new Error('Symbolic-link access was blocked.')
    return { absolute, relative: projectRelative.replaceAll('\\', '/') }
  }

  private owned(path: string): void {
    if (this.scope && !ownsFile(this.scope, path)) throw new Error(`SCOPE VIOLATION: ${path} is not owned by ${this.scope.id}. Request the dependency through the Director.`)
  }

  /** Refuse to overwrite a file that changed outside this task since the agent last read or wrote it. */
  private assertFresh(target: { absolute: string; relative: string }): void {
    const known = this.ledger.get(target.relative)
    if (known === undefined || !existsSync(target.absolute)) return
    if (sha(readFileSync(target.absolute)) !== known) throw new Error(`STALE: ${target.relative} changed outside this task since you read it. Read it again before editing.`)
  }

  private record(target: { absolute: string; relative: string }): void {
    if (existsSync(target.absolute)) this.ledger.set(target.relative, sha(readFileSync(target.absolute)))
    else this.ledger.delete(target.relative)
  }

  private countWrite(bytes: number): void {
    if (this.writes >= 40 || this.writtenBytes + bytes > 5_000_000) throw new Error('Task write limit exceeded.')
    this.writes += 1
    this.writtenBytes += bytes
  }

  private listFiles(toolCallId: string, path: string, recursive: boolean, glob?: string): ToolExecutionResult {
    const target = this.resolvePath(path, true)
    if (!existsSync(target.absolute) || !lstatSync(target.absolute).isDirectory()) throw new Error('Directory not found.')
    if (!recursive && !glob) {
      const entries = readdirSync(target.absolute, { withFileTypes: true })
        .filter((entry) => !ignored.has(entry.name) && !entry.isSymbolicLink())
        .slice(0, 250)
        .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
      return { toolCallId, name: 'list_files', content: entries.length > 0 ? entries.join('\n') : '(empty directory)' }
    }
    const filter = glob ? globToRegExp(glob) : null
    const files = this.repository().index().files.map(file => file.path).filter(file => (!target.relative || file.startsWith(`${target.relative}/`)) && (!filter || filter.test(file)))
    return { toolCallId, name: 'list_files', content: files.length ? `${files.slice(0, 500).join('\n')}${files.length > 500 ? `\n… ${files.length - 500} more` : ''}` : '(no matching files)' }
  }

  private readFile(toolCallId: string, path: unknown, start?: unknown, end?: unknown): ToolExecutionResult {
    const target = this.resolvePath(path)
    if (!existsSync(target.absolute) || !lstatSync(target.absolute).isFile()) throw new Error('File not found.')
    if (statSync(target.absolute).size > 2_000_000) throw new Error('File exceeds the 2 MB source retrieval limit.')
    const text = readFileSync(target.absolute, 'utf8')
    if (text.includes('\0')) throw new Error('Binary files cannot be sent as source context.')
    this.ledger.set(target.relative, sha(readFileSync(target.absolute)))
    const lines = text.split('\n')
    const first = typeof start === 'number' && Number.isInteger(start) ? Math.max(1, start) : 1
    const last = typeof end === 'number' && Number.isInteger(end) ? Math.min(first + 299, end) : first + 299
    const content = lines.slice(first - 1, last).map((line, index) => `${first + index}: ${line}`).join('\n').slice(0, 24000)
    return { toolCallId, name: 'read_file', content: `${target.relative} (${lines.length} lines; requested ${first}–${Math.min(last, lines.length)})\n${content}` }
  }

  private writeFile(toolCallId: string, path: unknown, content: unknown, name = 'write_file'): ToolExecutionResult {
    if (typeof content !== 'string') throw new Error('File content must be text.')
    if (content.length > MAX_EDIT_BYTES) throw new Error('A single file cannot exceed 1 MB.')
    if (this.writes >= 40 || this.writtenBytes + content.length > 5_000_000) throw new Error('Task write limit exceeded.')
    const target = this.resolvePath(path)
    this.owned(target.relative)
    this.assertWritable('fs.write', `write ${target.relative}`)
    this.assertFresh(target)
    if (existsSync(target.absolute) && readFileSync(target.absolute, 'utf8') === content) return { toolCallId, name, content: `No change: ${target.relative} already has the requested content.` }
    mkdirSync(dirname(target.absolute), { recursive: true })
    writeFileSync(target.absolute, content, 'utf8')
    this.countWrite(content.length)
    this.record(target)
    return { toolCallId, name, content: `Wrote ${target.relative} (${content.length} characters).`, changedFile: target.relative }
  }

  private editFile(call: ProviderToolCall, args: Record<string, unknown>): ToolExecutionResult {
    const target = this.resolvePath(args.path)
    this.owned(target.relative)
    if (!existsSync(target.absolute)) throw new Error('File not found.')
    if (statSync(target.absolute).size > MAX_EDIT_BYTES) throw new Error('File exceeds the editing limit.')
    this.assertFresh(target)
    const before = readFileSync(target.absolute, 'utf8')
    let after: string
    if (call.name === 'append_file') {
      if (typeof args.content !== 'string') throw new Error('Text content is required.')
      after = before + args.content
    } else {
      if (typeof args.old_text !== 'string' || !args.old_text || typeof args.new_text !== 'string') throw new Error('old_text must match exactly one nonempty segment; read the file again.')
      let oldText = args.old_text, newText = args.new_text
      // Models write LF; keep CRLF files consistent instead of failing the match.
      if (!before.includes(oldText) && before.includes('\r\n') && oldText.includes('\n')) { oldText = oldText.replace(/\r?\n/g, '\r\n'); newText = newText.replace(/\r?\n/g, '\r\n') }
      if (!before.includes(oldText) || before.indexOf(oldText) !== before.lastIndexOf(oldText)) throw new Error('old_text must match exactly one nonempty segment; read the file again.')
      after = before.replace(oldText, () => newText)
    }
    return { ...this.writeFile(call.id, args.path, after, call.name), name: call.name }
  }

  private patchFile(toolCallId: string, path: unknown, patch: unknown): ToolExecutionResult {
    if (typeof patch !== 'string' || !patch.trim()) throw new Error('A unified diff patch is required.')
    const target = this.resolvePath(path)
    this.owned(target.relative)
    if (!existsSync(target.absolute)) throw new Error('File not found; use write_file to create files.')
    this.assertFresh(target)
    const after = applyUnifiedPatch(readFileSync(target.absolute, 'utf8'), patch)
    return { ...this.writeFile(toolCallId, path, after, 'apply_patch'), name: 'apply_patch' }
  }

  private deleteFile(toolCallId: string, path: unknown): ToolExecutionResult {
    const target = this.resolvePath(path)
    this.owned(target.relative)
    this.assertWritable('fs.delete', `delete ${target.relative}`)
    if (!existsSync(target.absolute) || !lstatSync(target.absolute).isFile()) throw new Error('File not found (only single files can be deleted).')
    this.assertFresh(target)
    this.countWrite(0)
    unlinkSync(target.absolute)
    this.ledger.delete(target.relative)
    this.removeEmptyParents(dirname(target.absolute))
    return { toolCallId, name: 'delete_file', content: `Deleted ${target.relative}.`, changedFile: target.relative }
  }

  private moveFile(toolCallId: string, from: unknown, to: unknown): ToolExecutionResult {
    const source = this.resolvePath(from), destination = this.resolvePath(to)
    this.owned(source.relative); this.owned(destination.relative)
    this.assertWritable('fs.write', `move ${source.relative} → ${destination.relative}`)
    if (!existsSync(source.absolute) || !lstatSync(source.absolute).isFile()) throw new Error('Source file not found.')
    if (existsSync(destination.absolute)) throw new Error('Destination already exists.')
    this.assertFresh(source)
    this.countWrite(0)
    mkdirSync(dirname(destination.absolute), { recursive: true })
    renameSync(source.absolute, destination.absolute)
    this.ledger.delete(source.relative); this.record(destination)
    this.removeEmptyParents(dirname(source.absolute))
    return { toolCallId, name: 'move_file', content: `Moved ${source.relative} to ${destination.relative}.`, changedFiles: [source.relative, destination.relative] }
  }

  private removeEmptyParents(directory: string): void {
    let cursor = directory
    while (cursor.startsWith(this.root + sep) && cursor !== this.root) {
      try { if (readdirSync(cursor).length) return; rmdirSync(cursor) } catch { return }
      cursor = dirname(cursor)
    }
  }

  // ---- repository -----------------------------------------------------------------------------

  private repository(): RepositoryIntelligence {
    this.repo ??= new RepositoryIntelligence(this.root, { ttlMs: 2000 })
    return this.repo
  }

  private searchFiles(toolCallId: string, args: Record<string, unknown>): ToolExecutionResult {
    if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('A search pattern is required.')
    const result = this.repository().search({ pattern: args.pattern, regex: args.regex === true, ...(typeof args.glob === 'string' ? { glob: args.glob } : {}), maxResults: typeof args.max_results === 'number' ? args.max_results : 100 })
    const lines = result.matches.map(match => `${match.path}:${match.line}: ${match.text}`)
    return { toolCallId, name: 'search_files', content: lines.length ? `${lines.join('\n')}${result.truncated ? '\n[more matches omitted]' : ''}` : 'No matches.' }
  }

  private findSymbol(toolCallId: string, name: unknown): ToolExecutionResult {
    if (typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('A symbol name (identifier) is required.')
    const repo = this.repository()
    const definitions = repo.findDefinitions(name)
    const references = repo.findReferences(name, 20).matches
    const text = [
      definitions.length ? `Definitions:\n${definitions.map(item => `${item.path}:${item.line} ${item.kind}${item.exported ? ' (exported)' : ''}`).join('\n')}` : `No definition of ${name} found.`,
      references.length ? `References:\n${references.map(item => `${item.path}:${item.line}: ${item.text.trim()}`).join('\n')}` : 'No other references found.',
    ].join('\n\n')
    return { toolCallId, name: 'find_symbol', content: text }
  }

  private gitStatus(toolCallId: string): ToolExecutionResult {
    if (!isRepository(this.root)) return { toolCallId, name: 'git_status', content: 'The project is not a Git repository.' }
    const state = gitStatus(this.root)
    const lines = state.entries.slice(0, 300).map(entry => `${entry.untracked ? '??' : `${entry.index}${entry.worktree}`} ${entry.path}`)
    return { toolCallId, name: 'git_status', content: `Branch: ${state.branch ?? '(detached)'}\n${lines.length ? lines.join('\n') : 'Working tree clean.'}` }
  }

  private gitDiff(toolCallId: string, path: unknown): ToolExecutionResult {
    if (!isRepository(this.root)) return { toolCallId, name: 'git_diff', content: 'The project is not a Git repository.' }
    const target = typeof path === 'string' && path ? this.resolvePath(path).relative : undefined
    const text = gitDiff(this.root, { ...(target ? { path: target } : {}), maxBytes: 40_000 })
    return { toolCallId, name: 'git_diff', content: text || 'No differences from HEAD.' }
  }

  // ---- commands -------------------------------------------------------------------------------

  private snapshotFiles(): Map<string, string> {
    const snapshot = new Map<string, string>()
    const visit = (directory: string): void => {
      if (snapshot.size >= 20_000) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name) || entry.isSymbolicLink()) continue
        const absolute = resolve(directory, entry.name)
        if (entry.isDirectory()) visit(absolute)
        else if (entry.isFile()) {
          const metadata = statSync(absolute)
          snapshot.set(relative(this.root, absolute).replaceAll('\\', '/'), `${metadata.size}:${metadata.mtimeMs}`)
        }
      }
    }
    visit(this.root)
    return snapshot
  }

  private async runCommand(toolCallId: string, command: unknown, args: unknown, timeout: unknown): Promise<ToolExecutionResult> {
    if (typeof command !== 'string' || !Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
      throw new Error('run_command requires a command and an array of string arguments.')
    }
    if (this.commands >= 15) throw new Error('Task command limit exceeded.')
    await this.authorizeCommand(command, args as string[])
    const timeoutMs = typeof timeout === 'number' && Number.isInteger(timeout) ? Math.min(600_000, Math.max(1_000, timeout)) : 120_000
    const before = this.snapshotFiles()
    this.commands += 1
    const commandId = uuidv7(), started = Date.now(), shown = [command, ...(args as string[])].join(' ')
    this.emit({ type: 'command.started', commandId, command: shown })
    let result: ProjectCommandResult
    try {
      result = await runProjectCommand({ projectRoot: this.root, command, args: args as string[], timeoutMs, signal: this.signal, onOutput: (stream, text) => this.emit({ type: 'command.output', commandId, stream, text }) })
    } catch (error) {
      this.emit({ type: 'command.completed', commandId, command: shown, exitCode: null, timedOut: false, durationMs: Date.now() - started })
      throw error
    }
    this.emit({ type: 'command.completed', commandId, command: result.command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: Date.now() - started })
    const after = this.snapshotFiles()
    const changedFiles = [...new Set([
      ...[...after].filter(([path, fingerprint]) => before.get(path) !== fingerprint).map(([path]) => path),
      ...[...before.keys()].filter((path) => !after.has(path)),
    ])].slice(0, 250)
    for (const path of changedFiles) this.ledger.delete(path) // command output supersedes earlier reads
    const status = result.timedOut ? 'timed out' : `exited with code ${result.exitCode ?? 'unknown'}`
    return { toolCallId, name: 'run_command', content: `Command ${status}: ${result.command}\n\n${this.compactCommandOutput(result.output)}`, changedFiles, commandResult: result }
  }

  private compactCommandOutput(output: string): string {
    if (output.length <= 12_000) return output
    const lines = output.split(/\r?\n/), selected = new Set<number>()
    for (let index = 0; index < Math.min(20, lines.length); index++) selected.add(index)
    for (let index = Math.max(0, lines.length - 80); index < lines.length; index++) selected.add(index)
    for (let index = 0; index < lines.length; index++) if (/error|failed|failure|exception|traceback|fatal|warning|cannot|undefined|not found/i.test(lines[index]!)) for (let nearby = Math.max(0, index - 2); nearby <= Math.min(lines.length - 1, index + 2); nearby++) selected.add(nearby)
    const sorted = [...selected].sort((a, b) => a - b), result: string[] = [`[Compacted ${output.length} characters / ${lines.length} lines. Full output retained in the command result.]`]
    let previous = -2
    for (const index of sorted) { if (index > previous + 1) result.push('…'); result.push(`${index + 1}: ${lines[index]}`); previous = index; if (result.join('\n').length > 11_500) break }
    return result.join('\n').slice(0, 12_000)
  }
}
