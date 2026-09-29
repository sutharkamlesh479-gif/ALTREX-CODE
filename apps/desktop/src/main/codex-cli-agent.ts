import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ChatRequest, ChatStreamEvent, CodexRuntimeInfo } from '../shared/desktop-api'
import type { ResolvedAttachment } from './attachment-service'
import { IGNORED_DIRECTORIES } from '@altrex/core/workspace/ignore'

type JsonRpcId = number | string

type JsonRpcMessage = {
  id?: JsonRpcId
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

type ThreadItem = {
  id?: string
  type?: string
  text?: string
  summary?: string[]
  command?: string
  cwd?: string
  status?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  changes?: Array<{ path?: string; kind?: string; diff?: string }>
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const ignoredSnapshotEntries = IGNORED_DIRECTORIES

/** Provider label the service reports for Codex-engine tasks (the engine chooses its own model). */
export const CODEX_PROVIDER_LABEL = 'OpenAI Codex'

function findCodexExecutable(): string | null {
  const configuredBinary = process.env.CODEX_CLI_PATH
  if (configuredBinary !== undefined && existsSync(configuredBinary)) return configuredBinary
  if (process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined) {
    const desktopBinRoot = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    if (existsSync(desktopBinRoot)) {
      try {
        const desktopBinaries = readdirSync(desktopBinRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(desktopBinRoot, entry.name, 'codex.exe'))
          .filter((candidate) => existsSync(candidate))
          .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
        if (desktopBinaries[0] !== undefined) return desktopBinaries[0]
      } catch {
        // Fall through to the globally installed runtime.
      }
    }
  }
  if (process.platform === 'win32' && process.env.APPDATA !== undefined) {
    const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64'
    const npmBinary = join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      packageName,
      'vendor',
      target,
      'bin',
      'codex.exe',
    )
    if (existsSync(npmBinary)) return npmBinary
  }
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(finder, ['codex'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return null
  const candidates = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
  return candidates.find((entry) => process.platform !== 'win32' || entry.toLowerCase().endsWith('.exe')) ?? candidates[0] ?? null
}

export function getCodexRuntimeInfo(executable = findCodexExecutable()): CodexRuntimeInfo {
  if (executable === null) return { available: false, version: null }
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  const version = result.status === 0 ? result.stdout.trim() : null
  return { available: version !== null && version.length > 0, version }
}

function snapshotProject(projectPath: string): Map<string, string> {
  const root = realpathSync(projectPath)
  const snapshot = new Map<string, string>()
  const visit = (directory: string): void => {
    if (snapshot.size >= 30_000) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignoredSnapshotEntries.has(entry.name) || entry.isSymbolicLink()) continue
      const absolute = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        const metadata = statSync(absolute)
        snapshot.set(relative(root, absolute).replaceAll('\\', '/'), `${metadata.size}:${metadata.mtimeMs}`)
      }
    }
  }
  if (existsSync(root) && lstatSync(root).isDirectory()) visit(root)
  return snapshot
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([
    ...[...after].filter(([path, fingerprint]) => before.get(path) !== fingerprint).map(([path]) => path),
    ...[...before.keys()].filter((path) => !after.has(path)),
  ])].slice(0, 500)
}

export function parseCodexEvent(line: string): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? parsed as JsonRpcMessage : null
  } catch {
    return null
  }
}

function promptFor(request: ChatRequest, attachments: ResolvedAttachment[]): string {
  const userPrompt = request.messages.filter((message) => message.role === 'user').at(-1)?.content.trim() ?? ''
  const attachmentContext = attachments.length === 0
    ? ''
    : `Attached files:\n${attachments.map((attachment) => `- ${attachment.name}: ${attachment.projectRelativePath ?? attachment.absolutePath ?? 'attached input'} (${attachment.mimeType})`).join('\n')}\nInspect and use these attachments as part of the task.`
  return [
    'You are the real autonomous Codex coding engine inside ALTREX CODE.',
    'Work directly in the current selected project. Inspect the repository, create every required file and folder, install necessary dependencies, run relevant builds and tests, fix failures, and continue until the task is genuinely complete.',
    'Act immediately. Use reasonable professional defaults for the stack, architecture, design, sample content, and implementation details. Do not ask about budget, audience, framework preference, branding, sample data, or other choices you can make yourself.',
    'Implement the task instead of merely explaining, outlining steps, or returning code snippets in chat. If the request is large, build a complete working first version and then improve it. Do not claim a file, command, dependency, test, server, or website exists unless you actually created or ran it in the selected workspace.',
    'Ask the user only when a genuinely unavailable credential, external account authorization, or destructive irreversible product decision makes further implementation impossible. Otherwise keep working autonomously until the result is verified.',
    attachmentContext,
    `User task:\n${userPrompt}`,
  ].filter((section) => section.length > 0).join('\n\n')
}

function cleanCodexEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('CODEX_') && name !== 'CODEX_HOME' && name !== 'CODEX_API_KEY') delete environment[name]
  }
  return environment
}

function isInsideProject(projectPath: string, candidate: string): boolean {
  const canonicalProject = realpathSync(projectPath)
  const absolute = resolve(isAbsolute(candidate) ? candidate : resolve(canonicalProject, candidate))
  let existingAncestor = absolute
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) return false
    existingAncestor = parent
  }
  const canonicalCandidate = resolve(realpathSync(existingAncestor), relative(existingAncestor, absolute))
  const difference = relative(canonicalProject, canonicalCandidate)
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))
}

function filesystemRequestStaysInsideProject(projectPath: string, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value !== 'object') return false
  const permissions = value as {
    read?: unknown
    write?: unknown
    entries?: unknown
  }
  for (const list of [permissions.read, permissions.write]) {
    if (list === null || list === undefined) continue
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string' || !isInsideProject(projectPath, entry))) return false
  }
  if (permissions.entries !== null && permissions.entries !== undefined) {
    if (!Array.isArray(permissions.entries)) return false
    for (const entry of permissions.entries) {
      if (typeof entry !== 'object' || entry === null) return false
      const path = (entry as { path?: unknown }).path
      if (typeof path !== 'object' || path === null) return false
      const typedPath = path as { type?: unknown; path?: unknown }
      if (typedPath.type !== 'path' || typeof typedPath.path !== 'string' || !isInsideProject(projectPath, typedPath.path)) return false
    }
  }
  return true
}

function requestedPermissionsStayInsideProject(projectPath: string, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value !== 'object') return false
  return filesystemRequestStaysInsideProject(projectPath, (value as { fileSystem?: unknown }).fileSystem)
}

function itemFrom(params: Record<string, unknown> | undefined): ThreadItem | null {
  const item = params?.item
  return typeof item === 'object' && item !== null ? item as ThreadItem : null
}

class CodexAppServerSession {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly lines
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private nextRequestId = 1
  private closed = false
  private stderr = ''
  private threadId: string | null = null
  private turnId: string | null = null
  private streamedAgentMessage = false
  private failureMessage = ''

  constructor(
    executable: string,
    private readonly projectPath: string,
    private readonly request: ChatRequest,
    private readonly attachments: ResolvedAttachment[],
    private readonly signal: AbortSignal,
    private readonly emit: (event: ChatStreamEvent) => void,
    private readonly onThread: (threadId: string) => void,
  ) {
    this.child = spawn(executable, [
      'app-server',
      '-c', 'sandbox_workspace_write.network_access=true',
      '--stdio',
    ], {
      cwd: projectPath,
      env: cleanCodexEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16_000)
    })
    this.signal.addEventListener('abort', () => this.interrupt(), { once: true })
  }

  async run(priorThreadId: string | undefined): Promise<void> {
    const processFailure = new Promise<never>((_resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('close', (code) => {
        const intentionallyClosed = this.closed
        this.closed = true
        if (intentionallyClosed) return
        if (this.signal.aborted) reject(new DOMException('The operation was aborted.', 'AbortError'))
        else reject(new Error(this.failureMessage || this.stderr.trim() || `Codex App Server exited with code ${code ?? 'unknown'}.`))
      })
    })

    const work = async (): Promise<void> => {
      await this.call('initialize', {
        clientInfo: { name: 'altrex_code', title: 'ALTREX CODE', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      this.notify('initialized')

      let threadId = priorThreadId
      if (threadId !== undefined) {
        try {
          const resumed = await this.call('thread/resume', this.threadConfiguration({ threadId, excludeTurns: true })) as { thread?: { id?: string } }
          threadId = resumed.thread?.id ?? threadId
        } catch {
          threadId = undefined
        }
      }
      if (threadId === undefined) {
        const started = await this.call('thread/start', this.threadConfiguration({ serviceName: 'altrex_code' })) as { thread?: { id?: string } }
        threadId = started.thread?.id
      }
      if (typeof threadId !== 'string' || threadId.length === 0) throw new Error('Codex did not return a workspace thread ID.')
      this.threadId = threadId
      this.onThread(threadId)

      const startedTurn = await this.call('turn/start', {
        threadId,
        input: [
          { type: 'text', text: promptFor(this.request, this.attachments), text_elements: [] },
          ...this.attachments.flatMap((attachment) => attachment.kind === 'image' && attachment.absolutePath !== undefined
            ? [{ type: 'localImage', path: attachment.absolutePath }]
            : []),
        ],
        effort: 'medium',
      }) as { turn?: { id?: string } }
      this.turnId = startedTurn.turn?.id ?? null
      await this.waitForTurnCompletion()
    }

    try {
      await Promise.race([work(), processFailure])
    } finally {
      this.shutdown()
    }
  }

  private threadConfiguration(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      ...extra,
      cwd: this.projectPath,
      runtimeWorkspaceRoots: [this.projectPath],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      developerInstructions: 'Operate autonomously inside the selected workspace. Start implementing immediately, choose reasonable defaults without asking preference questions, create and edit all required files, install dependencies, run commands and tests, and iterate until the user task is complete. Never substitute explanations or sample snippets for actual workspace changes.',
    }
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex App Server is not running.'))
    const id = this.nextRequestId++
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      this.write({ id, method, params })
    })
  }

  private notify(method: string): void {
    this.write({ method })
  }

  private write(message: JsonRpcMessage): void {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    const message = parseCodexEvent(line)
    if (message === null) return
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? 'Codex request failed.'))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method !== undefined) {
      this.handleApprovalRequest(message)
      return
    }
    if (message.method !== undefined) this.handleNotification(message.method, message.params)
  }

  private handleApprovalRequest(message: JsonRpcMessage): void {
    const id = message.id as JsonRpcId
    const params = message.params ?? {}
    if (message.method === 'item/fileChange/requestApproval') {
      const grantRoot = params.grantRoot
      const allowed = (grantRoot === null || grantRoot === undefined || (typeof grantRoot === 'string' && isInsideProject(this.projectPath, grantRoot)))
      this.write({ id, result: { decision: allowed ? 'acceptForSession' : 'decline' } })
      return
    }
    if (message.method === 'item/commandExecution/requestApproval') {
      const cwd = params.cwd
      const allowedCwd = cwd === null || cwd === undefined || (typeof cwd === 'string' && isInsideProject(this.projectPath, cwd))
      const allowed = allowedCwd && requestedPermissionsStayInsideProject(this.projectPath, params.additionalPermissions)
      const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
      const acceptedDecision = available.includes('acceptForSession') || available.length === 0 ? 'acceptForSession' : 'accept'
      this.write({ id, result: { decision: allowed ? acceptedDecision : 'decline' } })
      return
    }
    if (message.method === 'item/permissions/requestApproval') {
      const cwd = params.cwd
      const permissions = params.permissions
      const allowed = typeof cwd === 'string' && isInsideProject(this.projectPath, cwd) && requestedPermissionsStayInsideProject(this.projectPath, permissions)
      if (allowed && typeof permissions === 'object' && permissions !== null) {
        this.write({ id, result: { permissions, scope: 'session' } })
      } else {
        this.write({ id, error: { code: -32001, message: 'ALTREX only grants additional access inside the selected project.' } })
      }
      return
    }
    this.write({ id, error: { code: -32601, message: `ALTREX does not support the ${message.method ?? 'unknown'} server request.` } })
  }

  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
      this.streamedAgentMessage = true
      this.emit({ requestId: this.request.requestId, type: 'delta', delta: params.delta })
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' && typeof params?.delta === 'string') {
      // Reasoning is not a user-facing operation. Command and file events provide activity.
      return
    }
    if (method === 'item/started') {
      const item = itemFrom(params)
      if (item?.type === 'commandExecution' && typeof item.command === 'string') {
        this.emit({ requestId: this.request.requestId, type: 'activity', message: `Running ${item.command.slice(0, 140)}` })
      } else if (item?.type === 'fileChange') {
        this.emit({ requestId: this.request.requestId, type: 'activity', message: 'Applying workspace file changes' })
      }
      return
    }
    if (method === 'item/completed') {
      const item = itemFrom(params)
      if (item?.type === 'commandExecution' && typeof item.command === 'string') {
        this.emit({
          requestId: this.request.requestId,
          type: 'command-result',
          command: item.command,
          exitCode: typeof item.exitCode === 'number' ? item.exitCode : item.status === 'completed' ? 0 : null,
          output: (item.aggregatedOutput ?? '(command completed)').slice(0, 8_000),
        })
      }
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && !this.streamedAgentMessage) {
        this.emit({ requestId: this.request.requestId, type: 'delta', delta: item.text })
      }
      return
    }
    if (method === 'error') {
      const error = params?.error
      if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
        this.failureMessage = (error as { message: string }).message
      }
      return
    }
    if (method === 'turn/started') {
      this.emit({ requestId: this.request.requestId, type: 'activity', message: 'Codex is inspecting and implementing the task' })
    }
  }

  private waitForTurnCompletion(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const handle = (line: string): void => {
        const message = parseCodexEvent(line)
        if (message?.method !== 'turn/completed') return
        const turn = message.params?.turn
        if (typeof turn !== 'object' || turn === null) return
        const typedTurn = turn as { id?: unknown; status?: unknown; error?: { message?: unknown } | null }
        if (this.turnId !== null && typedTurn.id !== this.turnId) return
        this.lines.off('line', handle)
        if (typedTurn.status === 'failed') {
          const turnMessage = typedTurn.error !== null && typeof typedTurn.error?.message === 'string' ? typedTurn.error.message : this.failureMessage
          rejectPromise(new Error(turnMessage || 'Codex could not complete the workspace task.'))
        } else if (typedTurn.status === 'interrupted' || this.signal.aborted) {
          rejectPromise(new DOMException('The operation was aborted.', 'AbortError'))
        } else resolvePromise()
      }
      this.lines.on('line', handle)
    })
  }

  private interrupt(): void {
    if (this.closed) return
    if (this.threadId !== null && this.turnId !== null) {
      void this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => undefined)
    }
    setTimeout(() => this.shutdown(), 1_000).unref()
  }

  private shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const pending of this.pending.values()) pending.reject(new Error('Codex App Server stopped.'))
    this.pending.clear()
    if (this.child.stdin.writable) this.child.stdin.end()
    if (!this.child.killed) this.child.kill()
  }
}

export class CodexCliAgent {
  private readonly executable: string | null
  private readonly runtimeInfo: CodexRuntimeInfo
  private readonly threadsByProject = new Map<string, string>()

  constructor(executable = findCodexExecutable()) {
    this.executable = executable
    this.runtimeInfo = getCodexRuntimeInfo(executable)
  }

  getRuntimeInfo(): CodexRuntimeInfo {
    return this.runtimeInfo
  }

  async run({
    request,
    attachments = [],
    signal,
    emit,
  }: {
    request: ChatRequest
    attachments?: ResolvedAttachment[]
    signal: AbortSignal
    emit: (event: ChatStreamEvent) => void
  }): Promise<void> {
    if (request.projectPath === null) throw new Error('Open a project before running Codex Agent mode.')
    if (this.executable === null) throw new Error('The Codex runtime is not installed. Install or update the Codex desktop app, then restart ALTREX.')
    const projectPath = realpathSync(request.projectPath)
    const before = snapshotProject(projectPath)
    const priorThread = this.threadsByProject.get(projectPath)
    emit({ requestId: request.requestId, type: 'activity', message: priorThread === undefined ? 'Starting Codex in the selected folder' : 'Continuing the Codex workspace thread' })

    const session = new CodexAppServerSession(
      this.executable,
      projectPath,
      request,
      attachments,
      signal,
      emit,
      (threadId) => this.threadsByProject.set(projectPath, threadId),
    )
    await session.run(priorThread)

    const files = changedFiles(before, snapshotProject(projectPath))
    if (files.length > 0) emit({ requestId: request.requestId, type: 'files-changed', files })
  }
}
