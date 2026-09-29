import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { isCommandName, parseCommandRequest, parseCommandResponse, type CommandName, type CommandResponse, type ModelView, type ParsedCommandRequest, type ProviderView, type RoutingPreview } from '@altrex/contracts'
import type { EventBus } from '@altrex/core/events/event-bus'
import type { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { LegacyEventBridge } from './legacy-event-bridge'
import type { RepositoryIntelligence } from '@altrex/core/repo/intelligence'
import { retrieveContext } from '@altrex/core/context/retrieval'
import type { PermissionCenter } from '@altrex/core/security/permission-center'
import type { TaskManager } from '@altrex/core/orchestrator/task-manager'
import type { ProjectMemory } from '@altrex/core/memory/project-memory'
import { CoreCommandError, toCoreError } from '@altrex/core/errors'
import { diff as gitDiff, isRepository, status as gitStatus } from '@altrex/core/git/git'
import { UserTerminal } from '@altrex/core/tools/terminal'
import { discoverChecks, runChecks } from '@altrex/core/verification/tester'
import { codingToolDefinitions } from './project-tool-broker'
import type { CoreInvokeResult, ProjectSummary } from '@altrex/contracts'

export type CoreHostDependencies = {
  events: EventBus
  checkpoints: CheckpointStore
  /** True when the user opened this project in ALTREX during this session (native dialog / recent). */
  isProjectTrusted: (projectPath: string) => boolean
  /** True while a task is working in the project; restores must wait for it. */
  isProjectBusy: (projectPath: string) => boolean
  onBridgeError?: (error: unknown) => void
  /** Provider and model catalog views (no secrets). */
  catalog?: { providers(): ProviderView[]; models(providerId?: string): ModelView[] }
  /** Router explanations (no model calls). */
  routing?: { preview(request: ParsedCommandRequest<'router.preview'>): Promise<RoutingPreview> }
  /** Repository intelligence for an opened project. */
  repo?: (projectPath: string) => RepositoryIntelligence
  /** Permission profiles and pending approvals. */
  permissions?: PermissionCenter
  /** Task records and history. Without it, tasks are tracked in memory only. */
  tasks?: TaskManager
  /** Starts a task from `task.start` (the host validates project access and attachments). Returns the task id. */
  startTask?: (request: ParsedCommandRequest<'task.start'>) => Promise<string>
  /** Cancels the engine request behind a task. */
  cancelRequest?: (requestId: string) => void
  /** Evidence-backed project memory. */
  memory?: ProjectMemory
  /** Native project picker and the projects open in this session. */
  projects?: { open(): Promise<ProjectSummary | null>; list(): ProjectSummary[] }
  /** Provider profile management (keys stay in the main process). */
  providers?: {
    connect(input: ParsedCommandRequest<'provider.connect'>): Promise<void>
    disconnect(providerId: string): void
    test(): Promise<void>
    refresh(): Promise<void>
    /** Opens an official provider page (registry URL, HTTPS, approved hosts). */
    openLink(providerId: string, kind: 'apiKey' | 'accountId' | 'install' | 'docs'): Promise<boolean>
  }
  /** Cloud-code consent (enforced by the provider service). */
  consent?: {
    list(): CommandResponse<'consent.list'>
    grant(endpoint: { providerId: string; baseUrl: string }): boolean
    revoke(endpoint: { providerId: string; baseUrl: string }): boolean
  }
}

function canonical(path: string): string {
  let value: string
  try { value = realpathSync.native(path) } catch { value = resolve(path) }
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function sameProject(left: string, right: string): boolean {
  return canonical(left) === canonical(right)
}

/**
 * Main-process side of the contract-v1 core bridge (`window.altrexCore`). Every command name,
 * request and response is validated against @altrex/contracts at this boundary.
 */
export class CoreHost {
  readonly legacy: LegacyEventBridge
  private readonly terminal: UserTerminal

  constructor(private readonly deps: CoreHostDependencies) {
    this.legacy = new LegacyEventBridge(deps.events, deps.onBridgeError, deps.tasks)
    this.terminal = new UserTerminal(event => {
      if (event.type === 'command.output') { for (let offset = 0; offset < event.text.length; offset += 8192) deps.events.publish('command.output', { commandId: event.commandId, stream: event.stream, text: event.text.slice(offset, offset + 8192) }, null) }
      else if (event.type === 'command.started') deps.events.publish('command.started', { commandId: event.commandId, command: event.command }, null)
      else deps.events.publish('command.completed', { commandId: event.commandId, command: event.command, exitCode: event.exitCode, timedOut: event.timedOut, durationMs: Math.max(0, Math.round(event.durationMs)) }, null)
    })
  }

  get events(): EventBus {
    return this.deps.events
  }

  /** Result envelope for the IPC boundary: failures become contract `CoreError`s, never raw exceptions. */
  async handleResult(name: unknown, request: unknown): Promise<CoreInvokeResult<CommandName>> {
    try { return { ok: true, value: await this.handle(name, request) as CommandResponse<CommandName> } }
    catch (error) { return { ok: false, error: toCoreError(error) } }
  }

  async handle(name: unknown, request: unknown): Promise<unknown> {
    if (!isCommandName(name)) throw new CoreCommandError('UNKNOWN_COMMAND', 'Unknown ALTREX core command.')
    const parsed = parseCommandRequest(name, request)
    return parseCommandResponse(name, await this.dispatch(name, parsed))
  }

  private async dispatch<N extends CommandName>(name: N, request: ParsedCommandRequest<N>): Promise<CommandResponse<CommandName>> {
    switch (name) {
      case 'events.replay':
        return this.deps.events.replay((request as ParsedCommandRequest<'events.replay'>).afterSeq)
      case 'checkpoint.list': {
        const { projectPath } = request as ParsedCommandRequest<'checkpoint.list'>
        this.assertTrusted(projectPath)
        return this.deps.checkpoints.list(projectPath)
      }
      case 'checkpoint.preview': {
        const { checkpointId, scope } = request as ParsedCommandRequest<'checkpoint.preview'>
        this.assertTrusted((await this.deps.checkpoints.get(checkpointId)).projectPath)
        return this.deps.checkpoints.plan(checkpointId, scope)
      }
      case 'checkpoint.restore': {
        const { checkpointId, scope } = request as ParsedCommandRequest<'checkpoint.restore'>
        const checkpoint = await this.deps.checkpoints.get(checkpointId)
        this.assertTrusted(checkpoint.projectPath)
        if (this.deps.isProjectBusy(checkpoint.projectPath)) throw new CoreCommandError('PROJECT_BUSY', 'A task is still running in this project. Stop it before restoring a checkpoint.', true)
        const result = await this.deps.checkpoints.restore(checkpointId, scope)
        this.deps.events.publish('checkpoint.restored', result, checkpoint.taskId)
        return result
      }
      case 'permission.respond': {
        const { approvalId, decision, scope } = request as ParsedCommandRequest<'permission.respond'>
        return { accepted: this.permissions().approvals.respond(approvalId, decision, scope) }
      }
      case 'permission.pending':
        return this.permissions().pending()
      case 'permission.configure': {
        const { interactive } = request as ParsedCommandRequest<'permission.configure'>
        this.permissions().approvals.setInteractive(interactive)
        return { interactive: this.permissions().approvals.isInteractive() }
      }
      case 'project.permissions': {
        const { projectPath, profile } = request as ParsedCommandRequest<'project.permissions'>
        this.assertTrusted(projectPath)
        const center = this.permissions()
        return { projectPath, profile: profile === undefined ? center.profileFor(projectPath) : center.setProfile(projectPath, profile) }
      }
      case 'task.start': {
        const start = request as ParsedCommandRequest<'task.start'>
        if (start.projectPath !== null) this.assertTrusted(start.projectPath)
        // One write-capable task per project: concurrent agents would interleave edits and checkpoints.
        if (start.projectPath !== null && start.mode !== 'ASK' && this.deps.isProjectBusy(start.projectPath)) throw new CoreCommandError('PROJECT_BUSY', 'A task is already working in this project. Wait for it to finish or stop it, then try again.', true)
        if (!this.deps.startTask) throw new CoreCommandError('UNAVAILABLE', 'Starting tasks is not available in this build.')
        return { taskId: await this.deps.startTask(start) }
      }
      case 'task.cancel': {
        const { taskId } = request as ParsedCommandRequest<'task.cancel'>
        const requestId = this.legacy.tasks.isActive(taskId) ? this.legacy.tasks.requestIdFor(taskId) : null
        if (requestId === null || !this.deps.cancelRequest) return { cancelled: false }
        this.deps.cancelRequest(requestId)
        return { cancelled: true }
      }
      case 'task.list': {
        const { projectPath, limit } = request as ParsedCommandRequest<'task.list'>
        return this.legacy.tasks.list({ projectPath, limit })
      }
      case 'task.get': {
        const task = this.legacy.tasks.get((request as ParsedCommandRequest<'task.get'>).taskId)
        if (!task) throw new CoreCommandError('NOT_FOUND', 'Unknown task.')
        return task
      }
      case 'task.events': {
        const { taskId, limit } = request as ParsedCommandRequest<'task.events'>
        return { taskId, ...this.legacy.tasks.events(taskId, limit) }
      }
      case 'checkpoint.diff': {
        const { checkpointId, path } = request as ParsedCommandRequest<'checkpoint.diff'>
        this.assertTrusted((await this.deps.checkpoints.get(checkpointId)).projectPath)
        return this.deps.checkpoints.fileVersions(checkpointId, path)
      }
      case 'memory.list': {
        const { projectPath } = request as ParsedCommandRequest<'memory.list'>
        this.assertTrusted(projectPath)
        return this.memoryStore().facts(projectPath)
      }
      case 'memory.remember': {
        const { projectPath, key, value } = request as ParsedCommandRequest<'memory.remember'>
        this.assertTrusted(projectPath)
        this.memoryStore().remember(projectPath, key, value)
        return { key: `user.${key}` }
      }
      case 'memory.forget': {
        const { projectPath, key } = request as ParsedCommandRequest<'memory.forget'>
        this.assertTrusted(projectPath)
        return { removed: this.memoryStore().forget(projectPath, key) }
      }
      case 'project.open': {
        if (!this.deps.projects) throw new CoreCommandError('UNAVAILABLE', 'Opening projects is not available in this build.')
        return this.deps.projects.open()
      }
      case 'project.list':
        return this.deps.projects?.list() ?? []
      case 'session.list': {
        const { projectPath, limit } = request as ParsedCommandRequest<'session.list'>
        return this.legacy.tasks.sessions({ projectPath, limit })
      }
      case 'provider.connect': {
        const providers = this.providerOps()
        await providers.connect(request as ParsedCommandRequest<'provider.connect'>)
        return this.deps.catalog?.providers() ?? []
      }
      case 'provider.disconnect': {
        this.providerOps().disconnect((request as ParsedCommandRequest<'provider.disconnect'>).providerId)
        return this.deps.catalog?.providers() ?? []
      }
      case 'provider.test':
        await this.providerOps().test()
        return this.deps.catalog?.providers() ?? []
      case 'provider.openLink': {
        const { providerId, kind } = request as ParsedCommandRequest<'provider.openLink'>
        return { opened: await this.providerOps().openLink(providerId, kind) }
      }
      case 'provider.refresh':
        await this.providerOps().refresh()
        return this.deps.catalog?.models() ?? []
      case 'tool.list':
        return codingToolDefinitions.map(tool => ({
          name: tool.function.name, description: tool.function.description,
          risk: tool.function.name === 'run_command' ? 'CLASSIFIED' as const : ['read_file', 'list_files', 'search_files', 'find_symbol', 'git_status', 'git_diff'].includes(tool.function.name) ? 'LOW' as const : 'MEDIUM' as const,
        }))
      case 'git.status': {
        const { projectPath } = request as ParsedCommandRequest<'git.status'>
        this.assertTrusted(projectPath)
        if (!isRepository(projectPath)) return { isRepository: false, branch: null, head: null, entries: [] }
        const state = gitStatus(projectPath)
        return { isRepository: true, branch: state.branch, head: state.head, entries: state.entries.slice(0, 5000) }
      }
      case 'git.diff': {
        const { projectPath, path, maxBytes } = request as ParsedCommandRequest<'git.diff'>
        this.assertTrusted(projectPath)
        if (!isRepository(projectPath)) throw new CoreCommandError('NOT_FOUND', 'The project is not a Git repository.')
        const text = gitDiff(projectPath, { ...(path ? { path } : {}), maxBytes: maxBytes + 1 })
        return { diff: text.slice(0, maxBytes), truncated: text.length > maxBytes }
      }
      case 'checks.discover': {
        const { projectPath } = request as ParsedCommandRequest<'checks.discover'>
        const intel = this.intel(projectPath)
        intel.refresh()
        return discoverChecks(intel.profile())
      }
      case 'checks.run': {
        const { projectPath, names } = request as ParsedCommandRequest<'checks.run'>
        const intel = this.intel(projectPath)
        intel.refresh()
        const checks = discoverChecks(intel.profile()).filter(check => !names || names.includes(check.name))
        const result = await runChecks({
          root: projectPath, checks, signal: new AbortController().signal, profile: this.deps.permissions?.profileFor(projectPath) ?? 'standard',
          onEvent: event => event.type === 'test.started'
            ? this.deps.events.publish('test.started', { testId: event.testId, name: event.name, command: event.command.slice(0, 1000) }, null)
            : this.deps.events.publish('test.completed', { testId: event.testId, evidence: event.evidence }, null),
        })
        return result.evidence
      }
      case 'terminal.run': {
        const { projectPath, command, args, timeoutMs } = request as ParsedCommandRequest<'terminal.run'>
        this.assertTrusted(projectPath)
        return this.terminal.run({ projectPath, command, args, timeoutMs, profile: this.deps.permissions?.profileFor(projectPath) ?? 'standard' })
      }
      case 'terminal.cancel':
        return { cancelled: this.terminal.cancel((request as ParsedCommandRequest<'terminal.cancel'>).commandId) }
      case 'consent.list':
        return this.consentOps().list()
      case 'consent.grant':
        return { granted: this.consentOps().grant(request as ParsedCommandRequest<'consent.grant'>) }
      case 'consent.revoke':
        return { revoked: this.consentOps().revoke(request as ParsedCommandRequest<'consent.revoke'>) }
      case 'provider.list':
        return this.deps.catalog?.providers() ?? []
      case 'model.list':
        return this.deps.catalog?.models((request as ParsedCommandRequest<'model.list'>).providerId) ?? []
      case 'router.preview': {
        const preview = request as ParsedCommandRequest<'router.preview'>
        return this.deps.routing ? this.deps.routing.preview(preview) : { mode: preview.mode, primary: null, fallbacks: [], reasons: ['Routing is not available.'], rejected: [] }
      }
      case 'repo.profile':
        return this.intel((request as ParsedCommandRequest<'repo.profile'>).projectPath).profile()
      case 'repo.search': {
        const { projectPath, ...query } = request as ParsedCommandRequest<'repo.search'>
        return this.intel(projectPath).search(query)
      }
      case 'repo.symbols': {
        const { projectPath, path, name } = request as ParsedCommandRequest<'repo.symbols'>
        const intel = this.intel(projectPath)
        return path ? intel.symbols(path).map(symbol => ({ path, ...symbol })) : intel.findDefinitions(name!)
      }
      case 'repo.related': {
        const { projectPath, path } = request as ParsedCommandRequest<'repo.related'>
        const intel = this.intel(projectPath)
        return { imports: intel.imports(path), importers: intel.importers(path), tests: intel.relatedTests(path) }
      }
      case 'context.preview': {
        const { projectPath, task, maxChars } = request as ParsedCommandRequest<'context.preview'>
        const result = retrieveContext(this.intel(projectPath), task, maxChars ? { maxChars } : {})
        return { seeds: result.seeds, items: result.items.map(item => ({ kind: item.kind, path: item.path, ...(item.range ? { range: item.range } : {}), reason: item.reason, chars: item.content.length })) }
      }
    }
    throw new CoreCommandError('UNAVAILABLE', 'This command is not implemented by this core.')
  }

  private intel(projectPath: string): RepositoryIntelligence {
    if (!this.deps.isProjectTrusted(projectPath)) throw new CoreCommandError('PROJECT_NOT_OPEN', 'Open the project in ALTREX before inspecting it.')
    if (!this.deps.repo) throw new CoreCommandError('UNAVAILABLE', 'Repository intelligence is not available.')
    return this.deps.repo(projectPath)
  }

  private assertTrusted(projectPath: string): void {
    if (!this.deps.isProjectTrusted(projectPath)) throw new CoreCommandError('PROJECT_NOT_OPEN', 'Open the project in ALTREX before managing it.')
  }

  private providerOps(): NonNullable<CoreHostDependencies['providers']> {
    if (!this.deps.providers) throw new CoreCommandError('UNAVAILABLE', 'Provider management is not available in this build.')
    return this.deps.providers
  }

  private consentOps(): NonNullable<CoreHostDependencies['consent']> {
    if (!this.deps.consent) throw new CoreCommandError('UNAVAILABLE', 'Cloud consent is not available in this build.')
    return this.deps.consent
  }

  private memoryStore(): ProjectMemory {
    if (!this.deps.memory) throw new CoreCommandError('UNAVAILABLE', 'Project memory is not available in this build.')
    return this.deps.memory
  }

  private permissions(): PermissionCenter {
    if (!this.deps.permissions) throw new CoreCommandError('UNAVAILABLE', 'Permissions are not available in this build.')
    return this.deps.permissions
  }
}
