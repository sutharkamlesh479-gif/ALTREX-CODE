import { nativeImage, safeStorage } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { requestPolicy } from '../shared/request-policy'
import type { RequestPolicy } from '../shared/request-policy'
import { Director } from './multi-ai/director'
import { PermissionCenter } from '@altrex/core/security/permission-center'
import { endForVerdict, type TaskManager } from '@altrex/core/orchestrator/task-manager'
import type { Verdict } from '@altrex/contracts'
import { verifyTask } from './task-verification'
import type { ProjectMemory } from '@altrex/core/memory/project-memory'
import { runTournament } from '@altrex/core/orchestrator/tournament'
import { CODEX_CONSENT_ENDPOINT, ConsentRequiredError, ConsentStore, type Endpoint } from '@altrex/core/security/consent'
import { acquireWorkspace, applyLease, leaseChanges, releaseWorkspace, type WorkspaceLease } from '@altrex/core/workspace/lease'
import { discoverChecks, runChecks } from '@altrex/core/verification/tester'
import { unifiedDiff } from '@altrex/core/util/text-diff'
import { repositoryIntelligence } from './repository-context'
import { RunStore } from './multi-ai/state-store'
import { ModelRegistry, RoleRouter, type RoutingEvent } from './providers/model-registry'
import { runProjectCommand } from './project-command-runner'
import { buildRepositoryContext as buildRepositoryContextForCheck } from './repository-context'
import {
  providerPresets,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type ProviderConnectionInput,
  type ProviderId,
  type ProviderProfileStatus,
  type ProviderStatus,
  type ProviderTestResult,
} from '../shared/desktop-api'
import { normalizeProviderBaseUrl } from '../shared/provider-protocol'
import { selectCodingModelCandidates } from '../shared/model-router'
import type { ProviderMessage, ProviderRuntimeConnection } from './providers/model-provider'
import { OpenAiCompatibleProvider } from './providers/openai-compatible'
import { CodexCliAgent } from './codex-cli-agent'
import { runCodingAgent } from './agent-runner'
import type { ResolvedAttachment } from './attachment-service'
import type { ProviderContentPart } from './providers/model-provider'
import { ensureLocalAiServer, pullLocalModel, unloadLocalModel } from './local-ai-service'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import type { EventBus } from '@altrex/core/events/event-bus'
import { CODEX_PROVIDER_LABEL } from './codex-cli-agent'
import type { PersistedProviderHealth } from '@altrex/core/gateway/request-executor'
import type { DiscoveredModel } from '@altrex/core/gateway/stream-types'
import { ProviderFailure } from './providers/request-manager'
import type { ProviderErrorCategory } from '../shared/provider-errors'
import { endpointPrivacy, providerDefinition } from '../shared/provider-registry'
import { wireProtocol } from '@altrex/core/gateway/gateway'
import { classifyDifficulty, type RoutingMode } from '@altrex/core/router/router'
import type { RoutingPreview } from '@altrex/contracts'
import type { ModelView, ProviderView } from '@altrex/contracts'
import { isApprovedLocalModel, isApprovedLocalVisionModel, recommendedLocalVisionModel } from '../shared/local-ai'

type StoredProvider = {
  version: 1 | 2
  providerId: ProviderId
  baseUrl: string
  model: string
  encryptedApiKey: string
  /** Last four characters of the key, captured when it was saved, so status never needs decryption. */
  keyHint?: string | null
  additionalFields?: Record<string, string>
  verification?: {
    ok: boolean
    category: ProviderErrorCategory | null
    message: string
    testedAt: string
  }
  requestPolicy?: Partial<RequestPolicy>
}

type CachedCatalog = { providerId: ProviderId; baseUrl: string; models: string[]; fetchedAt: string; errorCategory: ProviderErrorCategory | null }

function providerName(providerId: ProviderId): string {
  return providerPresets.find((provider) => provider.id === providerId)?.displayName ?? 'OpenAI-compatible'
}

function validateConnection(input: ProviderConnectionInput): ProviderConnectionInput {
  const apiKey = input.apiKey.trim()
  const model = input.model.trim()
  if (!providerPresets.some((provider) => provider.id === input.providerId)) throw new Error('Unsupported provider.')
  const definition = providerDefinition(input.providerId)
  if (definition.requiresApiKey && (apiKey.length < 8 || apiKey.length > 4096)) throw new Error(`Enter a valid ${input.providerId === 'cloudflare' ? 'API token' : 'API key'}.`)
  if (!definition.requiresApiKey && apiKey.length > 4096) throw new Error('The optional API key is too long.')
  if (model.length > 200) throw new Error('Enter a valid model ID.')
  const additionalFields = Object.fromEntries(Object.entries(input.additionalFields ?? {}).map(([key, value]) => [key, value.trim()]))
  if (input.providerId === 'cloudflare') {
    const accountId = additionalFields.accountId ?? ''
    if (accountId.length < 4 || accountId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('Enter your Cloudflare Account ID.')
  }
  const configuredBaseUrl = definition.userBaseUrl
    ? normalizeProviderBaseUrl(input.baseUrl.trim() || definition.baseUrl)
    : normalizeProviderBaseUrl(definition.baseUrl.replace('{accountId}', encodeURIComponent(additionalFields.accountId ?? '')))
  return { ...input, apiKey, model, additionalFields, baseUrl: configuredBaseUrl, requestPolicy: requestPolicy(input.providerId, input.requestPolicy) }
}

function emptyStatus(): ProviderStatus {
  return { connected: false, providerId: null, displayName: null, baseUrl: null, model: null }
}

export type ProviderServiceOptions = {
  /** Where pre-task checkpoints are stored. Defaults to `<state>/../core/checkpoints`. */
  checkpoints?: CheckpointStore
  /** V4 event stream for checkpoint events. Optional so legacy callers and tests keep working. */
  events?: EventBus
  /** Starts the local AI runtime on demand. Defaults to the Ollama runtime. */
  ensureLocalRuntime?: () => Promise<void>
  /** Project permission profiles and approvals. Defaults to an in-memory center (every project `standard`). */
  permissions?: PermissionCenter
  /** Task manager: maps chat requests to core task ids and records agent runs. */
  tasks?: TaskManager
  /** Evidence-backed project memory (recorded after verification). */
  memory?: ProjectMemory
  /** Where isolated tournament workspaces are created. Tournaments are unavailable without it. */
  leasesRoot?: string
  /** Cloud-code consent. Defaults to an empty in-memory store: project code reaches no cloud endpoint. */
  consent?: ConsentStore
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => { const resolved = resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved }
  return normalize(left) === normalize(right)
}

function userPromptOf(request: ChatRequest): string {
  return request.messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
}

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

export class ProviderService {
  private readonly activeRequests = new Map<string, AbortController>()
  private readonly provider = new OpenAiCompatibleProvider()
  private readonly codexAgent = new CodexCliAgent()
  private readonly directors = new Map<string, Director>()
  // Which providers each active request was routed to, and which project it works in.
  private readonly requestProviders = new Map<string, ReadonlySet<ProviderId>>()
  private readonly requestProjects = new Map<string, string>()
  private readonly requestRouters = new Map<string, RoleRouter>()
  private readonly healthPath: string
  readonly runs: RunStore
  readonly models: ModelRegistry
  readonly checkpoints: CheckpointStore
  private readonly events: EventBus | undefined
  private readonly ensureLocalRuntime: () => Promise<void>
  private readonly catalogPath: string
  readonly permissions: PermissionCenter
  private readonly tasks: TaskManager | undefined
  private readonly memory: ProjectMemory | undefined
  private readonly leasesRoot: string | undefined
  readonly consent: ConsentStore

  constructor(private readonly credentialPath: string, stateRoot = join(dirname(dirname(credentialPath)), 'multi-ai'), modelStateRoot = stateRoot, options: ProviderServiceOptions = {}) {
    this.runs = new RunStore(stateRoot)
    this.runs.recover()
    this.models = new ModelRegistry(join(modelStateRoot, 'models.json'))
    this.catalogPath = join(modelStateRoot, 'provider-models.json')
    this.checkpoints = options.checkpoints ?? new CheckpointStore(join(dirname(modelStateRoot), 'core', 'checkpoints'))
    this.events = options.events
    this.permissions = options.permissions ?? new PermissionCenter(null, options.events)
    this.tasks = options.tasks
    this.memory = options.memory
    this.leasesRoot = options.leasesRoot
    this.consent = options.consent ?? new ConsentStore(null)
    this.ensureLocalRuntime = options.ensureLocalRuntime ?? (() => ensureLocalAiServer())
    // Provider health survives restarts: latched states (rejected key, exhausted quota, wrong endpoint)
    // persist until retested; other observations expire and show UNKNOWN instead of a stale state.
    this.healthPath = join(modelStateRoot, 'provider-health.json')
    try { this.provider.requests.importHealth(JSON.parse(readFileSync(this.healthPath, 'utf8')) as Record<string, PersistedProviderHealth>) } catch { /* no saved health yet */ }
    this.provider.requests.setHealthListener(change => {
      try { mkdirSync(dirname(this.healthPath), { recursive: true }); writeFileSync(this.healthPath, JSON.stringify(this.provider.requests.exportHealth()), { mode: 0o600 }) } catch { /* health is re-observed on next use */ }
      const separator = change.key.indexOf(':')
      this.events?.publish('provider.health_changed', { providerId: change.key.slice(0, separator), baseUrl: change.key.slice(separator + 1), state: change.state, previous: change.previous, errorCategory: change.category }, null)
    })
  }

  /** Fill missing key hints once (profiles saved before hints existed), so later status calls never decrypt. */
  private withKeyHints(profiles: StoredProvider[]): StoredProvider[] {
    if (profiles.every(profile => profile.keyHint !== undefined)) return profiles
    const updated = profiles.map(profile => {
      if (profile.keyHint !== undefined) return profile
      if (!providerDefinition(profile.providerId).requiresApiKey) return { ...profile, keyHint: null }
      try { return { ...profile, keyHint: this.decryptApiKey(profile).slice(-4) || null } } catch { return profile }
    })
    const active = this.readStoredProvider()
    try { this.writeProfiles(updated, updated.find(profile => profile.providerId === active?.providerId && profile.baseUrl === active?.baseUrl) ?? updated[0]) } catch { /* retried on the next status call */ }
    return updated
  }

  private recordCatalogMetadata(connection: ProviderRuntimeConnection): void {
    const metadata = (this.provider as { catalogMetadata?: (target: ProviderRuntimeConnection) => DiscoveredModel[] | undefined }).catalogMetadata?.(connection)
    if (metadata?.length) this.models.observeDiscovery(connection, metadata)
  }

  /** True while a chat/agent request is working in this project (restores must wait). */
  isProjectBusy(projectPath: string): boolean {
    return [...this.requestProjects.values()].some(active => samePath(active, projectPath))
  }

  /**
   * Starts the local runtime only when an Ollama request is about to be made (never at app startup).
   * A start failure is not thrown here: the request that follows reports the real connection error.
   */
  private async prepareLocalRuntime(providerId: ProviderId): Promise<void> {
    if (providerId !== 'ollama') return
    try { await this.ensureLocalRuntime() } catch { /* surfaced by the subsequent request */ }
  }

  /** Snapshot the project before a write-capable task. Never blocks the task: failure is reported instead. */
  private async beginCheckpoint(request: ChatRequest, emit: (event: ChatStreamEvent) => void): Promise<string | null> {
    if (request.projectPath === null) return null
    const title = (request.messages.filter(message => message.role === 'user').at(-1)?.content ?? '').trim().split(/\r?\n/, 1)[0] ?? ''
    try {
      const checkpoint = await this.checkpoints.create({ projectPath: request.projectPath, taskId: request.requestId, label: `Before task: ${title}`.slice(0, 200) })
      this.events?.publish('checkpoint.created', checkpoint, this.taskId(request.requestId))
      emit({ requestId: request.requestId, type: 'activity', message: `Checkpoint saved before changes (${checkpoint.fileCount} files).` })
      return checkpoint.checkpointId
    } catch (error) {
      const reason = (error instanceof Error ? error.message : 'The checkpoint could not be created.').slice(0, 1800)
      this.events?.publish('checkpoint.failed', { projectPath: request.projectPath, reason }, this.taskId(request.requestId))
      emit({ requestId: request.requestId, type: 'activity', message: `No checkpoint was created: ${reason} Changes from this task cannot be restored by ALTREX.` })
      return null
    }
  }

  /** Core task id for a chat request (the request id itself when no task manager is attached). */
  private taskId(requestId: string): string {
    return this.tasks?.taskIdFor(requestId) ?? requestId
  }

  /** Start an agent run on the task, if a task manager is attached. */
  private startAgent(requestId: string, role: 'CODER', label: string, endpoint: { providerId?: string | null; model?: string | null } = {}): string | null {
    const taskId = this.tasks?.taskIdFor(requestId)
    if (!taskId || !this.tasks) return null
    try { return this.tasks.agentStarted(taskId, role, label, endpoint) } catch { return null }
  }

  private setEngine(requestId: string, engine: 'altrex' | 'codex' | 'director'): void {
    const taskId = this.tasks?.taskIdFor(requestId)
    if (taskId) this.tasks!.setEngine(taskId, engine)
  }

  /**
   * Evidence-based verification of a change task (Phase 8). Returns null when there is nothing to verify
   * (no task manager, no project, or no file changes).
   */
  private async verifyChangeTask(request: ChatRequest, context: {
    checkpointId: string | null; controller: AbortController; emit: (event: ChatStreamEvent) => void
    coder: { providerId: string; model: string; key: string } | null; router: RoleRouter | null
    repair: ((instructions: string, escalate: boolean, agentId: string | null) => Promise<void>) | null
    reportedFiles?: string[]
  }): Promise<Verdict | null> {
    const taskId = this.tasks?.taskIdFor(request.requestId)
    if (!this.tasks || !taskId || request.projectPath === null) return null
    let changed = context.reportedFiles ?? this.tasks.get(taskId)?.changedFiles ?? []
    if (context.checkpointId) { try { const plan = await this.checkpoints.plan(context.checkpointId, 'all'); changed = [...plan.restore, ...plan.delete] } catch { /* fall back to reported files */ } }
    if (!changed.length) return null
    return verifyTask({
      taskId, projectPath: request.projectPath, requestText: userPromptOf(request), tasks: this.tasks, events: this.events,
      checkpoints: this.checkpoints, checkpointId: context.checkpointId, reportedFiles: changed, profile: this.permissions.profileFor(request.projectPath),
      reviewRouter: context.router, coder: context.coder, repair: context.repair, signal: context.controller.signal,
      ...(this.memory ? { memory: this.memory } : {}),
      activity: message => context.emit({ requestId: request.requestId, type: 'activity', message }),
    })
  }

  /** End the task from its verdict (or as unverified without one) and tell the legacy stream. */
  private finishTask(request: ChatRequest, verdict: Verdict | null, emit: (event: ChatStreamEvent) => void): void {
    const taskId = this.tasks?.taskIdFor(request.requestId)
    if (verdict && taskId) {
      const summary = `Verification: ${verdict.status.replace('_', ' ')}. ${verdict.reasons.join(' ')}`
      emit({ requestId: request.requestId, type: 'activity', message: summary.slice(0, 4000) })
      this.tasks!.end(taskId, endForVerdict(verdict))
      emit(verdict.status === 'FAILED' ? { requestId: request.requestId, type: 'error', message: summary.slice(0, 4000) } : { requestId: request.requestId, type: 'completed' })
      return
    }
    if (taskId && request.mode !== 'ASK' && !verdict) this.tasks!.end(taskId, { state: 'COMPLETED_UNVERIFIED', reason: 'The task made no file changes, so there was nothing to verify.' })
    emit({ requestId: request.requestId, type: 'completed' })
  }

  // ---- cloud-code consent (backend enforcement) ---------------------------------------------------

  /** Local (loopback) endpoints never need consent; cloud and tunnelled endpoints need an explicit grant. */
  private cloudConsented(connection: { providerId: string; baseUrl: string }): boolean {
    return endpointPrivacy(connection.baseUrl) === 'local' || this.consent.has(connection)
  }

  /**
   * Project tasks may only use consented or local endpoints. Throws ConsentRequiredError (before any model
   * request) when consent removes every candidate.
   */
  private withConsent(request: ChatRequest, connections: ProviderRuntimeConnection[]): ProviderRuntimeConnection[] {
    if (request.projectPath === null) return connections
    const allowed = connections.filter(connection => this.cloudConsented(connection))
    if (connections.length && !allowed.length) {
      throw new ConsentRequiredError([...new Map(connections.map(connection => [`${connection.providerId}|${connection.baseUrl}`, { providerId: connection.providerId, baseUrl: connection.baseUrl }])).values()])
    }
    return allowed
  }

  /**
   * The model provider as seen by a request. For project tasks every completion and stream is checked
   * against consent immediately before it is sent — a backstop that holds even if routing were bypassed.
   */
  private providerFor(request: ChatRequest): OpenAiCompatibleProvider {
    if (request.projectPath === null) return this.provider
    const guard = (connection: ProviderRuntimeConnection) => {
      if (!this.cloudConsented(connection)) throw new ConsentRequiredError([{ providerId: connection.providerId, baseUrl: connection.baseUrl }])
    }
    return new Proxy(this.provider, {
      get: (target, property) => {
        if (property === 'complete' || property === 'stream') {
          return async (input: { connection: ProviderRuntimeConnection }) => { guard(input.connection); return (target[property] as (value: unknown) => Promise<unknown>).call(target, input) }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
  }

  /** Cloud endpoints that can receive project code, with the user's consent state. */
  consentEndpoints(): Array<{ providerId: string; baseUrl: string; displayName: string; granted: boolean; grantedAt: string | null }> {
    const endpoints: Array<Endpoint & { displayName: string }> = this.profiles()
      .filter(profile => endpointPrivacy(profile.baseUrl) === 'cloud')
      .map(profile => ({ providerId: profile.providerId, baseUrl: profile.baseUrl, displayName: providerName(profile.providerId) }))
    if (this.codexAgent.getRuntimeInfo().available) endpoints.push({ ...CODEX_CONSENT_ENDPOINT, displayName: CODEX_PROVIDER_LABEL })
    return [...new Map(endpoints.map(endpoint => [`${endpoint.providerId}|${endpoint.baseUrl}`, endpoint])).values()]
      .map(endpoint => ({ ...endpoint, granted: this.consent.has(endpoint), grantedAt: this.consent.get(endpoint)?.grantedAt ?? null }))
  }

  /** Grant consent for a known cloud endpoint (a configured cloud profile or the Codex engine). */
  grantConsent(endpoint: Endpoint): boolean {
    if (!this.consentEndpoints().some(item => item.providerId === endpoint.providerId && item.baseUrl === endpoint.baseUrl)) return false
    this.consent.grant(endpoint)
    return true
  }

  revokeConsent(endpoint: Endpoint): boolean { return this.consent.revoke(endpoint) }

  /**
   * Tournament (AGENT_SPEC.md §8): candidates implement the request in isolated workspaces, each starting
   * from a different endpoint when possible; the Tester runs the project's checks in each; code ranks them
   * and the winner is applied to the project (refused on conflicts with concurrent user edits).
   * Returns the winning endpoint.
   */
  private async tournament(request: ChatRequest, context: {
    connections: ProviderRuntimeConnection[]; routingMode: RoutingMode; routingPrompt: string; repositoryContext: string
    attachments: ResolvedAttachment[]; controller: AbortController; emit: (event: ChatStreamEvent) => void
    progress: (id: string | null) => (round: number, tools: string[], endpoint: { providerId: string; model: string }) => void
  }): Promise<ProviderRuntimeConnection> {
    const projectPath = request.projectPath!, taskId = this.taskId(request.requestId), leasesRoot = this.leasesRoot!
    const intelligence = repositoryIntelligence(projectPath)
    intelligence.refresh()
    const checks = discoverChecks(intelligence.profile()), profile = this.permissions.profileFor(projectPath)
    const winners = new Map<number, ProviderRuntimeConnection>()
    const say = (message: string) => context.emit({ requestId: request.requestId, type: 'activity', message })
    const count = Math.min(3, request.candidates ?? 2)
    say(`Tournament: ${count} candidates implement the task in isolated workspaces; the winner is chosen from check evidence.`)
    const outcome = await runTournament<WorkspaceLease>({
      candidates: count, declared: checks.map(check => check.name), signal: context.controller.signal,
      acquire: () => {
        const lease = acquireWorkspace({ projectPath, leasesRoot })
        // Share installed dependencies read-mostly instead of reinstalling per candidate.
        const modules = join(projectPath, 'node_modules')
        if (existsSync(modules) && !existsSync(join(lease.path, 'node_modules'))) { try { symlinkSync(modules, join(lease.path, 'node_modules'), 'junction') } catch { /* checks install if needed */ } }
        return lease
      },
      implement: async (candidate, lease) => {
        const offset = candidate % context.connections.length
        const rotated = [...context.connections.slice(offset), ...context.connections.slice(0, offset)]
        const start = rotated[0]!
        winners.set(candidate, start)
        const router = this.routerFor(request, rotated, context.routingMode, context.routingPrompt)
        const agentId = this.startAgent(request.requestId, 'CODER', `Candidate ${candidate + 1}`, { providerId: start.providerId, model: start.model })
        const onRound = context.progress(agentId)
        await runCodingAgent({
          provider: this.providerFor(request), connection: start, router, request: { ...request, projectPath: lease.path }, repositoryContext: context.repositoryContext,
          attachments: context.attachments, signal: context.controller.signal, skipSelfVerification: true,
          toolOptions: this.permissions.toolOptions(taskId, projectPath),
          emit: event => { if (event.type === 'activity' && event.message) say(`Candidate ${candidate + 1}: ${event.message}`) },
          onRound: (round, tools, endpoint) => { onRound(round, tools, endpoint); winners.set(candidate, { ...start, providerId: endpoint.providerId as ProviderId, model: endpoint.model }) },
        })
        if (agentId) this.tasks?.agentFinished(agentId, 'completed', 'Candidate implementation finished.')
        const used = winners.get(candidate)!
        return { providerId: used.providerId, model: used.model }
      },
      check: async (_candidate, lease) => (await runChecks({ root: lease.path, checks, signal: context.controller.signal, profile })).evidence,
      changes: lease => {
        const { changed, conflicts } = leaseChanges(lease)
        let changedLines = 0
        for (const path of changed.slice(0, 200)) {
          const read = (root: string) => { try { return readFileSync(join(root, ...path.split('/')), 'utf8') } catch { return null } }
          changedLines += unifiedDiff(path, read(projectPath), read(lease.path)).split('\n').filter(line => /^[+-](?![+-]{2} )/.test(line)).length
        }
        return { changed, conflicts, changedLines }
      },
      apply: lease => applyLease(lease),
      release: lease => releaseWorkspace(lease, leasesRoot),
      onCandidate: result => this.events?.publish('tournament.candidate', {
        candidate: result.candidate, providerId: result.endpoint?.providerId ?? null, model: result.endpoint?.model ?? null, status: result.status,
        changedFiles: result.changedFiles.length, changedLines: result.changedLines, conflicts: result.conflicts.length,
        checks: result.checks.slice(0, 10), ...(result.error ? { error: result.error } : {}),
      }, taskId),
    })
    this.events?.publish('tournament.selected', { winner: outcome.winner, ranking: outcome.ranking.map(item => ({ candidate: item.candidate, eligible: item.eligible, reasons: item.reasons.map(reason => reason.slice(0, 300)).slice(0, 10) })), applied: outcome.applied.slice(0, 1000) }, taskId)
    if (outcome.winner === null) throw new Error(`No tournament candidate produced an applicable change: ${outcome.ranking.map(item => `candidate ${item.candidate + 1}: ${item.reasons.join('; ')}`).join(' | ')}`)
    say(`Tournament winner: candidate ${outcome.winner + 1} (${outcome.ranking[0]!.reasons.join('; ')}). Applied ${outcome.applied.length} file(s).`)
    context.emit({ requestId: request.requestId, type: 'files-changed', files: outcome.applied })
    return winners.get(outcome.winner) ?? context.connections[0]!
  }

  /** A router for reviewing work done by an external engine; null when no provider is usable. */
  private async reviewSetup(request: ChatRequest, prompt: string): Promise<RoleRouter | null> {
    try {
      const connections = this.withoutDisconnected(await this.routedConnections(prompt, 'AUTO', undefined, this.routingModeFor(request)))
      return connections.length ? this.routerFor(request, connections, this.routingModeFor(request), prompt) : null
    } catch { return null }
  }

  /** Record the post-task state so a restore can revert exactly this task's changes, and announce the diff. */
  private async finishCheckpoint(checkpointId: string | null, requestId?: string): Promise<void> {
    if (checkpointId === null) return
    try { await this.checkpoints.finalize(checkpointId) } catch { return /* A full ("all" scope) restore remains available. */ }
    if (!this.events || requestId === undefined) return
    try {
      const files = await this.checkpoints.changes(checkpointId)
      if (files.length) this.events.publish('diff.available', { checkpointId, files: files.slice(0, 1000), truncated: files.length > 1000 }, this.taskId(requestId))
    } catch { /* the checkpoint list still offers the restore */ }
  }

  /** Drops candidates whose provider was disconnected while routing was in progress. */
  private withoutDisconnected(connections: ProviderRuntimeConnection[]): ProviderRuntimeConnection[] {
    const saved = new Set(this.profiles().map(profile => profile.providerId))
    return connections.filter(connection => saved.has(connection.providerId))
  }
  revise(requestId: string, text: string): void { const director = this.directors.get(requestId); if (!director) throw new Error('No active Multi-AI run.'); director.revise(text) }
  private profiles(): StoredProvider[] { try { const profiles = JSON.parse(readFileSync(`${this.credentialPath}.profiles`, 'utf8')) as StoredProvider[]; return profiles.filter(p => (p.version === 1 || p.version === 2) && typeof p.encryptedApiKey === 'string' && providerPresets.some(preset => preset.id === p.providerId)) } catch { const active = this.readStoredProvider(); return active ? [active] : [] } }
  private profileVerified(profile: StoredProvider): boolean {
    if (profile.verification?.ok === true) return true
    return this.models.list().some(record => record.provider === profile.providerId && record.baseUrl === profile.baseUrl && record.supportsChat === true && record.available === true)
  }
  private usableProfiles(): StoredProvider[] { return this.profiles().filter(profile => this.profileVerified(profile) && this.provider.requests.isProviderAvailable(profile)) }
  private profileFor(providerId: ProviderId): StoredProvider | undefined { return this.profiles().find(profile => profile.providerId === providerId) }
  private writeProfiles(profiles: StoredProvider[], active = profiles[0] ?? null): void {
    mkdirSync(dirname(this.credentialPath), { recursive: true })
    if (!active) {
      if (existsSync(this.credentialPath)) unlinkSync(this.credentialPath)
      if (existsSync(`${this.credentialPath}.profiles`)) unlinkSync(`${this.credentialPath}.profiles`)
      return
    }
    writeFileSync(`${this.credentialPath}.tmp`, JSON.stringify(active), { encoding: 'utf8', mode: 0o600 })
    renameSync(`${this.credentialPath}.tmp`, this.credentialPath)
    writeFileSync(`${this.credentialPath}.profiles.tmp`, JSON.stringify(profiles), { encoding: 'utf8', mode: 0o600 })
    renameSync(`${this.credentialPath}.profiles.tmp`, `${this.credentialPath}.profiles`)
  }
  private persistVerification(target: StoredProvider, result: ProviderTestResult): void {
    const verification = { ok: result.ok, category: result.errorCategory ?? null, message: result.message, testedAt: new Date().toISOString() }
    const updated = this.profiles().map(profile => profile.providerId === target.providerId && profile.baseUrl === target.baseUrl ? { ...profile, verification, ...(result.resolvedModel ? { model: result.resolvedModel } : {}) } : profile)
    const active = this.readStoredProvider()
    this.writeProfiles(updated, updated.find(profile => profile.providerId === active?.providerId && profile.baseUrl === active.baseUrl) ?? updated[0])
  }
  private inputWithSavedCredential(input: ProviderConnectionInput): ProviderConnectionInput {
    if (input.apiKey.trim() || !providerDefinition(input.providerId).requiresApiKey) return input
    const saved = this.profileFor(input.providerId)
    if (!saved) return input
    return { ...input, apiKey: this.decryptApiKey(saved), additionalFields: { ...saved.additionalFields, ...input.additionalFields } }
  }
  private catalogKey(provider: Pick<StoredProvider, 'providerId' | 'baseUrl'>): string { return `${provider.providerId}:${provider.baseUrl}` }
  private catalogs(): Record<string, CachedCatalog> { try { return JSON.parse(readFileSync(this.catalogPath, 'utf8')) as Record<string, CachedCatalog> } catch { return {} } }
  private writeCatalogs(catalogs: Record<string, CachedCatalog>): void { mkdirSync(dirname(this.catalogPath), { recursive: true }); writeFileSync(this.catalogPath, JSON.stringify(catalogs), { mode: 0o600 }) }
  private async discoverModels(profile: StoredProvider, force = false): Promise<string[]> {
    const catalogs = this.catalogs(), key = this.catalogKey(profile), cached = catalogs[key]
    if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < 10 * 60_000 && cached.models.length) return cached.models
    const connection = this.runtimeConnection(profile, profile.model)
    try {
      const models = await this.provider.listModels(connection)
      const catalog: CachedCatalog = { providerId: profile.providerId, baseUrl: profile.baseUrl, models, fetchedAt: new Date().toISOString(), errorCategory: null }
      catalogs[key] = catalog; this.writeCatalogs(catalogs)
      for (const model of models) this.models.markDiscovered({ ...connection, model })
      this.models.retainCatalog(connection, models)
      this.recordCatalogMetadata(connection)
      return models
    } catch (error) {
      catalogs[key] = { providerId: profile.providerId, baseUrl: profile.baseUrl, models: cached?.models ?? [], fetchedAt: new Date().toISOString(), errorCategory: error instanceof ProviderFailure ? error.category : 'CONNECTION_ERROR' }
      this.writeCatalogs(catalogs); throw error
    }
  }
  async testConfigured() {
    const results: Array<{ provider: ProviderId; model: string; ok: boolean; message: string; latencyMs: number; modelsDiscovered: number; chat: boolean; streaming: boolean; tools: boolean; errorCategory?: ProviderErrorCategory }> = []
    for (const profile of this.profiles()) {
      await this.prepareLocalRuntime(profile.providerId)
      const connection = this.runtimeConnection(profile, profile.model)
      this.provider.resetProviderHealth(connection)
      let listed: string[]
      try { listed = await this.discoverModels(profile, true) }
      catch (error) {
        const failure = error instanceof ProviderFailure ? error : new ProviderFailure('ALTREX could not connect to the provider.', 'network', true, 0, 0, undefined, 'CONNECTION_ERROR')
        results.push({ provider: profile.providerId, model: profile.model, ok: false, message: failure.message, latencyMs: 0, modelsDiscovered: 0, chat: false, streaming: false, tools: false, errorCategory: failure.category })
        continue
      }
      const candidates = [...new Set([profile.model, ...selectCodingModelCandidates(profile.providerId, 'small coding task with tools', listed, profile.model, 3).models])].slice(0, 3)
      for (const model of candidates) {
        const candidate = { ...connection, model, requestPolicy: { ...connection.requestPolicy, inputTokens: 1024, outputTokens: 64, maxAttempts: 1 } }
        if (listed.length && !listed.includes(model)) {
          this.models.observeFailure(candidate, 'MODEL_NOT_FOUND')
          results.push({ provider: profile.providerId, model, ok: false, message: 'The configured model was not returned by the provider model catalog.', latencyMs: 0, modelsDiscovered: listed.length, chat: false, streaming: false, tools: false, errorCategory: 'MODEL_NOT_FOUND' })
          continue
        }
        const started = Date.now()
        try {
          const capabilities = await this.provider.probeCapabilities(candidate, { chat: true, streaming: true, tools: true }, AbortSignal.timeout(180000))
          this.models.observeCapabilities(candidate, capabilities)
          const chat = capabilities.supportsChat === true, streaming = capabilities.supportsStreaming === true, tools = capabilities.supportsTools === true
          results.push({ provider: profile.providerId, model, ok: chat && streaming && tools, message: chat && streaming && tools ? 'CONNECTED: basic chat, streaming, and tool calling passed.' : `Connected with limited capabilities: chat=${chat ? 'PASS' : 'FAIL'}, streaming=${streaming ? 'PASS' : 'FAIL'}, tools=${tools ? 'PASS' : 'FAIL'}.`, latencyMs: Date.now() - started, modelsDiscovered: listed.length, chat, streaming, tools, ...(!tools ? { errorCategory: 'TOOLS_UNSUPPORTED' as const } : {}) })
        } catch (error) {
          const failure = error instanceof ProviderFailure ? error : new ProviderFailure('ALTREX could not connect to the provider.', 'network', true, 0, 0, undefined, 'CONNECTION_ERROR')
          if (failure.category === 'BAD_REQUEST') this.models.observeCapabilities(candidate, { supportsChat: false, supportsStreaming: false, supportsTools: false })
          else if (failure.category === 'TOOLS_UNSUPPORTED') this.models.observeCapabilities(candidate, { supportsTools: false })
          this.models.observeFailure(candidate, failure.category)
          results.push({ provider: profile.providerId, model, ok: false, message: failure.message, latencyMs: Date.now() - started, modelsDiscovered: listed.length, chat: false, streaming: false, tools: false, errorCategory: failure.category })
          if (['QUOTA_EXHAUSTED', 'RATE_LIMITED', 'AUTH_ERROR', 'INVALID_API_KEY'].includes(failure.category)) break
        }
      }
    }
    return results
  }
  async testWorkflows() {
    const stored = this.readStoredProvider(); if (!stored) throw new Error('No saved provider to test.')
    const requestedMode = process.env.ALTREX_WORKFLOW_MODE
    if (requestedMode === 'LOCAL' && stored.providerId === 'ollama' && isApprovedLocalModel(stored.model)) {
      this.models.observeCapabilities(this.runtimeConnection(stored, stored.model), { supportsChat: true, supportsTools: true, contextWindow: 32_768 })
    } else if (!this.models.list().some(record => record.available === true && record.supportsChat === true && record.supportsTools === true)) await this.testConfigured()
    const results: Array<{ mode: string; task: string; ok: boolean; status: string; testsExitCode: number | null; message: string; fixture: string; files: string[]; providerModels: string[]; fallbacks: string[] }> = []
    const modes = requestedMode === 'AGENT' || requestedMode === 'LOCAL' || requestedMode === 'MULTI' ? [requestedMode] as const : ['AGENT', 'MULTI'] as const
    for (const mode of modes) {
      const fixture = mkdtempSync(join(tmpdir(), `altrex-live-${mode.toLowerCase()}-`)), id = randomUUID()
      const agent = mode === 'AGENT' || mode === 'LOCAL', task = agent ? 'Create a very small interactive webpage.' : 'Build a small todo web app.'
      const test = agent
        ? "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');test('webpage',()=>{const h=fs.readFileSync('index.html','utf8');assert.match(h,/<h1[^>]*>[^<]+<\\/h1>/i);assert.match(h,/<button/i);assert.match(h,/addEventListener/);});\n"
        : "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');test('todo app',()=>{const h=fs.readFileSync('index.html','utf8'),j=fs.readFileSync('app.js','utf8');assert.match(h,/<input/i);assert.match(h,/<button/i);assert.match(j,/addEventListener/);assert.match(j,/(todo|task)/i);});\n"
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: `altrex-${mode.toLowerCase()}-fixture`, private: true, scripts: { test: 'node --test acceptance.test.cjs' } }))
      writeFileSync(join(fixture, 'acceptance.test.cjs'), test)
      let status = 'not started', message = ''
      const metricStart = this.provider.requests.metrics.length, timeout = setTimeout(() => this.cancel(id), 600000)
      try {
        const prompt = agent
          ? 'Create one minimal self-contained index.html under 700 characters total. Include a visible h1, a button, and a short inline script using addEventListener to change the heading when clicked. Use at most one tiny inline style rule. Preserve package.json and acceptance.test.cjs. Run npm test. Do not add dependencies or create other files.'
          : 'Build a small todo web app using index.html, style.css, and app.js. Include an input, add button, todo list, add/delete interactions, and localStorage persistence. Use separate UI and feature work where appropriate. Preserve package.json and acceptance.test.cjs. Run npm test. Do not add dependencies.'
        await this.streamChat({ requestId: id, projectPath: fixture, mode, modelSelection: 'AUTO', attachments: [], messages: [{ role: 'user', content: prompt }] }, buildRepositoryContextForCheck(fixture), [], event => { if (['completed', 'cancelled', 'error'].includes(event.type)) { status = event.type; message = event.message ?? '' } })
        const check = await runProjectCommand({ projectRoot: fixture, command: 'node', args: ['--test', 'acceptance.test.cjs'], timeoutMs: 15000, signal: new AbortController().signal })
        const files = ['index.html', 'style.css', 'app.js'].filter(file => existsSync(join(fixture, file))), metrics = this.provider.requests.metrics.slice(metricStart)
        const requiredFilesExist = agent ? files.includes('index.html') : files.includes('index.html') && files.includes('app.js')
        results.push({ mode, task, ok: status === 'completed' && check.exitCode === 0 && requiredFilesExist, status, testsExitCode: check.exitCode, message, fixture, files, providerModels: [...new Set(metrics.map(metric => `${metric.provider}/${metric.model}`))], fallbacks: metrics.flatMap(metric => metric.fallbackDestination ? [`${metric.provider}/${metric.model} -> ${metric.fallbackDestination}`] : []) })
      } finally { clearTimeout(timeout) }
    }
    return results
  }

  getStatus(): ProviderStatus {
    const stored = this.readStoredProvider()
    if (stored === null || !secureStorageAvailable()) return emptyStatus()
    const catalogs = this.catalogs()
    const storedProfiles = this.withKeyHints(this.profiles())
    const profiles: ProviderProfileStatus[] = storedProfiles.map((profile) => {
      const { providerId, model, baseUrl } = profile
      const catalog = catalogs[this.catalogKey(profile)], health = this.provider.requests.health(profile)
      const records = this.models.list().filter(record => record.provider === providerId && record.baseUrl === baseUrl && catalog?.models.includes(record.id))
      const category = health.lastCategory ?? profile.verification?.category ?? catalog?.errorCategory ?? null
      const verified = this.profileVerified(profile)
      const connectionState = health.state === 'RATE_LIMITED' ? 'RATE_LIMITED'
        : health.state === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED'
        : health.state === 'AUTH_ERROR' ? 'AUTHENTICATION_FAILED'
        : health.state === 'UNSUPPORTED' || category === 'ENDPOINT_NOT_FOUND' ? 'ERROR'
          : category === 'RATE_LIMITED' ? 'RATE_LIMITED'
            : category === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED'
              : category === 'INVALID_API_KEY' || category === 'AUTH_ERROR' ? 'AUTHENTICATION_FAILED'
                : category === 'MODEL_NOT_FOUND' || category === 'MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE'
                  : health.state === 'OFFLINE' || category === 'TIMEOUT' || category === 'CONNECTION_ERROR' || category === 'PROVIDER_SERVER_ERROR' ? 'TEMPORARILY_UNAVAILABLE'
                    : verified ? 'CONNECTED' : 'ERROR'
      let keySuffix: string | null = null
      if (providerDefinition(providerId).requiresApiKey) {
        keySuffix = profile.keyHint ?? null
      }
      return {
        providerId, displayName: providerName(providerId), model, baseUrl, health: health.state,
        modelsDiscovered: catalog?.models.length ?? 0,
        toolCompatibleModels: records.filter(record => record.supportsTools === true && record.available !== false).length,
        lastErrorCategory: category,
        lastCheckedAt: profile.verification?.testedAt ?? catalog?.fetchedAt ?? null,
        connectionState,
        keySuffix,
        statusMessage: health.state === 'UNSUPPORTED' || category === 'ENDPOINT_NOT_FOUND'
          ? 'This address does not provide a compatible model API. Check the provider base URL.'
          : health.state === 'AUTH_ERROR' ? 'The provider rejected this API key. Update the key and test the connection.'
            : profile.verification?.message ?? null,
        additionalFields: profile.additionalFields ?? {},
      }
    })
    const connected = profiles.some(profile => profile.connectionState === 'CONNECTED')
    const primaryStatus = profiles.find(profile => profile.providerId === stored.providerId && profile.baseUrl === stored.baseUrl && profile.connectionState === 'CONNECTED')
      ?? profiles.find(profile => profile.connectionState === 'CONNECTED')
      ?? profiles.find(profile => profile.providerId === stored.providerId && profile.baseUrl === stored.baseUrl)
    const primary = primaryStatus ? storedProfiles.find(profile => profile.providerId === primaryStatus.providerId && profile.baseUrl === primaryStatus.baseUrl) ?? stored : stored
    return {
      connected,
      providerId: primary.providerId,
      displayName: providerName(primary.providerId),
      baseUrl: primary.baseUrl,
      model: primary.model,
      profiles,
    }
  }

  async test(input: ProviderConnectionInput): Promise<ProviderTestResult> {
    const savedProfile = this.profileFor(input.providerId)
    const usingSavedCredential = providerDefinition(input.providerId).requiresApiKey && !input.apiKey.trim() && savedProfile !== undefined
    const finish = (result: ProviderTestResult): ProviderTestResult => {
      if (usingSavedCredential && savedProfile) this.persistVerification(savedProfile, result)
      return result
    }
    let connection: ProviderConnectionInput
    try {
      connection = validateConnection(this.inputWithSavedCredential(input))
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Invalid provider settings.', latencyMs: 0, failureKind: 'invalid-request' }
    }

    await this.prepareLocalRuntime(connection.providerId)
    this.provider.resetProviderHealth(connection)
    let discovered: string[] = []
    try {
      discovered = await this.provider.listModels(connection)
      if (discovered.length) {
        const catalogs = this.catalogs()
        catalogs[this.catalogKey(connection)] = { providerId: connection.providerId, baseUrl: connection.baseUrl, models: discovered, fetchedAt: new Date().toISOString(), errorCategory: null }
        this.writeCatalogs(catalogs)
        for (const model of discovered) this.models.markDiscovered({ ...connection, model })
        this.models.retainCatalog(connection, discovered)
        this.recordCatalogMetadata(connection)
      }
    } catch (error) {
      if (error instanceof ProviderFailure && ['INVALID_API_KEY', 'AUTH_ERROR', 'QUOTA_EXHAUSTED', 'RATE_LIMITED'].includes(error.category)) return finish({ ok: false, message: error.message, latencyMs: 0, failureKind: error.kind, errorCategory: error.category, modelsDiscovered: 0 })
      // Some OpenAI-compatible servers omit /models; the tiny generation below remains authoritative.
    }
    if (discovered.length && (!connection.model || !discovered.includes(connection.model))) {
      connection = { ...connection, model: selectCodingModelCandidates(connection.providerId, 'small coding task', discovered, discovered[0]!, 1).models[0] ?? discovered[0]! }
    }
    if (!connection.model || (connection.providerId === 'ollama' && discovered.length === 0)) return finish({ ok: false, message: connection.providerId === 'ollama' ? 'Ollama is running, but no local models are installed.' : 'No usable model was discovered.', latencyMs: 0, failureKind: 'model-unavailable', errorCategory: 'MODEL_UNAVAILABLE', modelsDiscovered: discovered.length })
    const result = await this.provider.healthCheck(connection)
    if (result.ok) this.models.observeCapabilities(connection, { supportsChat: true })
    else if ('errorCategory' in result && result.errorCategory) {
      if (result.errorCategory === 'BAD_REQUEST') this.models.observeCapabilities(connection, { supportsChat: false })
      this.models.observeFailure(connection, result.errorCategory)
    }
    return finish({ ...result, message: result.ok ? `${providerName(connection.providerId)} is ready for ALTREX.` : result.message, resolvedModel: connection.model, modelsDiscovered: discovered.length, capabilities: { chat: result.ok, streaming: this.models.record(connection).supportsStreaming, tools: this.models.record(connection).supportsTools } })
  }

  async connect(input: ProviderConnectionInput): Promise<ProviderStatus> {
    const connection = validateConnection(this.inputWithSavedCredential(input))
    if (!secureStorageAvailable()) throw new Error('Secure credential storage is unavailable on this system.')
    const result = await this.test(connection)
    if (!result.ok && (result.failureKind === 'authentication' || result.errorCategory === 'INVALID_API_KEY' || result.errorCategory === 'AUTH_ERROR')) throw new Error(result.message)

    const stored: StoredProvider = {
      version: 2,
      providerId: connection.providerId,
      baseUrl: connection.baseUrl,
      model: result.resolvedModel ?? connection.model,
      encryptedApiKey: safeStorage.encryptString(connection.apiKey).toString('base64'),
      keyHint: connection.apiKey ? connection.apiKey.slice(-4) : null,
      ...(connection.additionalFields ? { additionalFields: connection.additionalFields } : {}),
      verification: { ok: result.ok, category: result.errorCategory ?? null, message: result.message, testedAt: new Date().toISOString() },
      requestPolicy: requestPolicy(connection.providerId, connection.requestPolicy),
    }
    const profiles = [stored, ...this.profiles().filter(p => p.providerId !== stored.providerId || p.baseUrl !== stored.baseUrl)]
    this.writeProfiles(profiles, stored)
    const status = this.getStatus()
    return {
      ...status,
      warning: result.ok
        ? null
        : `Connection saved, but the selected model could not be verified: ${result.message} ALTREX AUTO will try available models when you start a task.`,
    }
  }

  disconnect(providerId?: ProviderId): ProviderStatus {
    const removed = this.profiles().filter(profile => providerId === undefined || profile.providerId === providerId)
    if (providerId) {
      const remaining = this.profiles().filter(profile => profile.providerId !== providerId)
      if (remaining.length) {
        this.writeProfiles(remaining)
      } else this.writeProfiles([])
    } else {
      if (existsSync(this.credentialPath)) unlinkSync(this.credentialPath)
      if (existsSync(`${this.credentialPath}.profiles`)) unlinkSync(`${this.credentialPath}.profiles`)
    }
    // Cancel only requests routed to the disconnected provider (all requests when disconnecting everything).
    // Requests on other providers, and Codex tasks, continue. Entries are removed by streamChat's finally.
    // Precise disconnect: a request whose remaining candidates include other providers keeps running (the
    // disconnected provider is excluded from its routing and any in-flight call to it fails over). Only
    // requests that truly depend on the disconnected provider are cancelled.
    for (const [requestId, controller] of this.activeRequests) {
      if (providerId === undefined) { controller.abort(); continue }
      if (!this.requestProviders.get(requestId)?.has(providerId)) continue
      const router = this.requestRouters.get(requestId)
      router?.exclude(providerId)
      if (!router?.hasCandidates()) controller.abort()
    }
    for (const profile of removed) this.provider.requests.abortProvider(profile)
    return providerId ? this.getStatus() : emptyStatus()
  }

  async installLocalModel(modelId: string): Promise<ProviderStatus> {
    await pullLocalModel(modelId)
    if (isApprovedLocalVisionModel(modelId)) {
      const profile = this.profileFor('ollama')
      if (!profile) throw new Error('Install and connect the recommended local coding model first.')
      const discovered = await this.discoverModels(profile, true)
      if (!discovered.includes(modelId)) throw new Error('Ollama finished downloading the vision model, but did not list it as installed.')
      const connection = this.runtimeConnection(profile, modelId)
      const result = await this.provider.healthCheck(connection)
      if (!result.ok) throw new Error(result.message)
      this.models.observeCapabilities(connection, { supportsChat: true, supportsVision: true, supportsTools: false, contextWindow: 125_000 })
      await unloadLocalModel(modelId).catch(() => undefined)
      return this.getStatus()
    }
    return this.connect({
      providerId: 'ollama',
      apiKey: '',
      baseUrl: providerDefinition('ollama').baseUrl,
      model: modelId,
      requestPolicy: requestPolicy('ollama'),
    })
  }

  private async describeLocalImages(profile: StoredProvider, attachments: ResolvedAttachment[], userPrompt: string, signal: AbortSignal, emit: (event: ChatStreamEvent) => void): Promise<ResolvedAttachment[]> {
    const images = attachments.filter(attachment => attachment.kind === 'image' && attachment.imageDataUrl)
    if (!images.length) return attachments
    const available = await this.discoverModels(profile)
    if (!available.includes(recommendedLocalVisionModel.id)) {
      throw new Error(`Local image understanding is not installed. Open Provider settings and install ${recommendedLocalVisionModel.name}.`)
    }

    const baseConnection = this.runtimeConnection(profile, recommendedLocalVisionModel.id)
    const connection = {
      ...baseConnection,
      requestPolicy: { ...baseConnection.requestPolicy, outputTokens: 768, maxAttempts: 1 },
    }
    this.models.observeCapabilities(connection, { supportsChat: true, supportsVision: true, supportsTools: false, contextWindow: 125_000 })
    const descriptions = new Map<string, string>()
    try {
      for (const image of images) {
        signal.throwIfAborted()
        emit({ requestId: '', type: 'activity', model: recommendedLocalVisionModel.id, message: `Reading ${image.name} with Local Vision` })
        const completion = await this.provider.complete({
          connection,
          messages: [
            { role: 'system', content: 'You are the visual inspection stage for a software coding agent. Describe the supplied image accurately and concretely. Transcribe visible text and errors, identify interface layout, colors, controls, spacing, and state. Focus on evidence the coding agent can act on. Do not invent hidden behavior.' },
            { role: 'user', content: [
              { type: 'text', text: `User request: ${userPrompt}\nAnalyze ${image.name} in detail for the coding agent.` },
              { type: 'image_url', image_url: { url: this.prepareLocalVisionImage(image.imageDataUrl!), detail: 'auto' } },
            ] },
          ],
          tools: [],
          signal,
        })
        if (!completion.content.trim()) throw new Error(`${recommendedLocalVisionModel.name} returned no image description.`)
        descriptions.set(image.id, completion.content.trim())
      }
    } finally {
      await unloadLocalModel(recommendedLocalVisionModel.id).catch(() => undefined)
    }

    return attachments.map(attachment => {
      const description = descriptions.get(attachment.id)
      if (!description) return attachment
      const { imageDataUrl: _imageDataUrl, ...withoutImage } = attachment
      return { ...withoutImage, textContent: `<local_vision_analysis>\n${description}\n</local_vision_analysis>` }
    })
  }

  private prepareLocalVisionImage(dataUrl: string): string {
    const source = nativeImage.createFromDataURL(dataUrl)
    if (source.isEmpty()) return dataUrl
    const { width, height } = source.getSize()
    const longestEdge = Math.max(width, height)
    if (longestEdge <= 1536) return dataUrl
    const scale = 1536 / longestEdge
    return source.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'best',
    }).toDataURL()
  }

  cancel(requestId: string): void {
    this.activeRequests.get(requestId)?.abort()
  }
  async stopAll(): Promise<void> { for (const controller of this.activeRequests.values()) controller.abort(); const deadline = Date.now() + 5000; while (this.activeRequests.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25)) }

  getCodexRuntimeInfo() {
    return this.codexAgent.getRuntimeInfo()
  }

  async getModels(providerId?: ProviderId): Promise<string[]> {
    const active = this.readStoredProvider()
    const stored = providerId ? this.profileFor(providerId) ?? null : active && this.profileVerified(active) ? active : this.usableProfiles()[0] ?? active
    if (stored === null) return []
    try {
      return await this.discoverModels(stored)
    } catch {
      const cached = this.catalogs()[this.catalogKey(stored)]?.models ?? []
      return cached.length ? cached : [stored.model]
    }
  }

  /**
   * Candidate pool for a request, ordered by the pure router. Routing never starts a local runtime:
   * an unreachable local server contributes its cached catalog, and the runtime is started only when a
   * selected Ollama endpoint is about to be called (RoleRouter.beforeUse). `offline` uses cached
   * catalogs only (router preview).
   */
  private async routedConnections(prompt: string, selection: string, providerFilter?: ProviderId, mode: RoutingMode = selection === 'AUTO' ? 'AUTO' : 'CUSTOM', offline = false): Promise<ProviderRuntimeConnection[]> {
    const unique = await this.candidatePool(selection, providerFilter, offline)
    if (selection !== 'AUTO') return unique
    const ordered = new RoleRouter(this.provider, unique, this.models, { mode, difficulty: classifyDifficulty(prompt), taskText: prompt, privacyOf: connection => endpointPrivacy(connection.baseUrl) }).candidates('Coding Agent', { chat: true })
    const perProvider = new Map<string, number>()
    return ordered.filter(connection => {
      const key = `${connection.providerId}:${connection.baseUrl}`, count = perProvider.get(key) ?? 0
      if (count >= 8) return false
      perProvider.set(key, count + 1); return true
    })
  }

  /** Every known endpoint of the usable profiles (unordered, unfiltered by routing). */
  private async candidatePool(selection: string, providerFilter: ProviderId | undefined, offline: boolean): Promise<ProviderRuntimeConnection[]> {
    const usable = this.usableProfiles().filter(profile => providerFilter === undefined || profile.providerId === providerFilter), activeStored = this.readStoredProvider(), active = activeStored && usable.find(profile => profile.providerId === activeStored.providerId && profile.baseUrl === activeStored.baseUrl) || usable[0] || null
    // A specific model goes only to a configured provider that actually offers it (the active one first).
    // It is never sent to an unrelated provider: a local model must not be requested from a cloud endpoint.
    const offers = (profile: StoredProvider) => profile.model === selection
      || (this.catalogs()[this.catalogKey(profile)]?.models ?? []).includes(selection)
      || this.models.list().some(record => record.provider === profile.providerId && record.baseUrl === profile.baseUrl && record.id === selection && record.available !== false)
    const owners = [...(active ? [active] : []), ...usable.filter(profile => profile !== active)].filter(offers)
    const profiles = selection === 'AUTO' ? usable : owners.length ? [owners[0]!] : usable.length === 1 ? usable : []
    const pool: ProviderRuntimeConnection[] = []
    for (const profile of profiles) {
      const base = this.runtimeConnection(profile, profile.model)
      if (profile.providerId === 'ollama' && isApprovedLocalModel(profile.model)) {
        this.models.observeCapabilities(base, { supportsChat: true, supportsTools: true, contextWindow: 32_768 })
      }
      if (!this.provider.requests.isProviderAvailable(base)) continue
      let available: string[] = this.catalogs()[this.catalogKey(profile)]?.models ?? []
      if (!offline) { try { available = await this.discoverModels(profile) } catch { /* cached catalog */ } }
      const verified = this.models.list().filter(record => record.provider === profile.providerId && record.baseUrl === profile.baseUrl && record.available === true && record.supportsChat === true && record.health !== 'UNAVAILABLE').map(record => record.id)
      const models = selection === 'AUTO'
        ? [...new Set([...verified, profile.model, ...available])].filter(model => !available.length || available.includes(model))
        : [selection]
      for (const model of models.length ? models : [profile.model]) {
        const candidate = { ...base, model, ...(!base.requestPolicy && /:free\b/.test(model) ? { requestPolicy: { outputTokens: 4096 } } : {}) }; this.models.record(candidate); pool.push(candidate)
      }
    }
    return [...new Map(pool.map(connection => [this.models.key(connection), connection])).values()]
  }

  /** Routing mode for a legacy chat request. */
  private routingModeFor(request: ChatRequest): RoutingMode {
    if (request.mode === 'LOCAL') return 'LOCAL_ONLY'
    if (request.routingMode) return request.routingMode
    const selection = request.modelSelection.trim()
    return !selection || selection === 'AUTO' || selection === 'CODEX' ? 'AUTO' : 'CUSTOM'
  }

  /** A per-request router: mode, difficulty, lazy local start, structured routing events. */
  private routerFor(request: ChatRequest, connections: ProviderRuntimeConnection[], mode: RoutingMode, prompt: string): RoleRouter {
    const router = new RoleRouter(this.providerFor(request), connections, this.models, {
      mode, difficulty: classifyDifficulty(prompt), taskText: prompt,
      privacyOf: connection => endpointPrivacy(connection.baseUrl),
      carriesRepositoryData: request.projectPath !== null,
      consentOf: connection => this.cloudConsented(connection),
      beforeUse: connection => this.prepareLocalRuntime(connection.providerId),
      onRouting: event => this.publishRouting(this.taskId(request.requestId), event),
    })
    this.requestRouters.set(request.requestId, router)
    return router
  }

  private publishRouting(taskId: string, event: RoutingEvent): void {
    if (!this.events) return
    if (event.type === 'model.selected') this.events.publish('model.selected', { provider: providerName(event.providerId as ProviderId), model: event.model, reasons: event.reasons.slice(0, 12), providerId: event.providerId, role: event.role, mode: event.mode }, taskId)
    else if (event.type === 'provider.selected') this.events.publish('provider.selected', { providerId: event.providerId, role: event.role, mode: event.mode, reason: event.reason }, taskId)
    else if (event.type === 'route.changed') this.events.publish('route.changed', { role: event.role, from: event.from, to: event.to, reason: event.reason }, taskId)
    else if (event.type === 'fallback.started') this.events.publish('fallback.started', { role: event.role, from: event.from, to: event.to, reason: event.reason }, taskId)
    else if (event.type === 'fallback.completed') this.events.publish('fallback.completed', { role: event.role, from: event.from, to: event.to }, taskId)
    else this.events.publish('fallback.failed', { role: event.role, from: event.from, reason: event.reason, attempted: event.attempted }, taskId)
  }

  /** Explain what a routing mode would choose right now, without calling any model or network. */
  async previewRoute(input: { mode: RoutingMode; role?: string | undefined; tools?: boolean | undefined; vision?: boolean | undefined; minContext?: number | undefined; prompt?: string | undefined }): Promise<RoutingPreview> {
    const prompt = input.prompt ?? ''
    const pool = await this.candidatePool('AUTO', undefined, true)
    const router = new RoleRouter(this.provider, pool, this.models, { mode: input.mode, difficulty: classifyDifficulty(prompt), taskText: prompt, privacyOf: connection => endpointPrivacy(connection.baseUrl) })
    const decision = router.decide(input.role ?? 'Coding Agent', { chat: true, ...(input.tools ? { tools: true } : {}), ...(input.vision ? { vision: true } : {}), ...(input.minContext ? { adequateContext: input.minContext } : {}) })
    const byKey = new Map(pool.map(connection => [this.models.key(connection), connection]))
    const endpoint = (candidate: { providerId: string; model: string }) => ({ providerId: candidate.providerId, model: candidate.model })
    return {
      mode: input.mode,
      primary: decision.primary ? endpoint(decision.primary) : null,
      fallbacks: decision.fallbacks.slice(0, 3).map(endpoint),
      reasons: decision.reasons.slice(0, 20),
      rejected: decision.rejected.slice(0, 50).flatMap(item => { const connection = byKey.get(item.key); return connection ? [{ ...endpoint(connection), reason: item.reason, detail: item.detail }] : [] }),
    }
  }

  async refreshModels(): Promise<ProviderStatus> {
    for (const profile of this.profiles()) {
      await this.prepareLocalRuntime(profile.providerId)
      try { await this.discoverModels(profile, true); this.provider.resetProviderHealth(this.runtimeConnection(profile, profile.model)) } catch { /* Status retains the real refresh error. */ }
    }
    return this.getStatus()
  }

  diagnostics() { return this.provider.requests.metrics.slice(-200).reverse() }

  /** Contract view of configured providers (no secrets). */
  providerViews(): ProviderView[] {
    const stored = this.withKeyHints(this.profiles())
    return (this.getStatus().profiles ?? []).map(profile => {
      const saved = stored.find(item => item.providerId === profile.providerId && item.baseUrl === profile.baseUrl)
      const connection = { providerId: profile.providerId, baseUrl: profile.baseUrl, ...(saved?.additionalFields ? { additionalFields: saved.additionalFields } : {}) }
      return {
        providerId: profile.providerId, displayName: profile.displayName, baseUrl: profile.baseUrl,
        protocol: wireProtocol(connection), privacy: endpointPrivacy(profile.baseUrl), health: profile.health,
        lastErrorCategory: profile.lastErrorCategory, lastCheckedAt: profile.lastCheckedAt, model: profile.model,
        modelsDiscovered: profile.modelsDiscovered, hasCredential: Boolean(saved?.encryptedApiKey && providerDefinition(profile.providerId).requiresApiKey) || Boolean(saved?.keyHint),
        keyHint: profile.keySuffix, statusMessage: profile.statusMessage,
      }
    })
  }

  /** Contract view of known model endpoints for configured providers. */
  modelViews(providerId?: string): ModelView[] {
    const configured = new Set(this.profiles().map(profile => `${profile.providerId}:${profile.baseUrl}`))
    // Only models the provider's latest catalog lists (a removed model is no longer offered).
    const catalogs = this.catalogs()
    const listed = (record: { provider: string; baseUrl: string; id: string }) => {
      const models = catalogs[this.catalogKey({ providerId: record.provider as ProviderId, baseUrl: record.baseUrl })]?.models ?? []
      return !models.length || models.includes(record.id)
    }
    return this.models.list()
      .filter(record => configured.has(`${record.provider}:${record.baseUrl}`) && (providerId === undefined || record.provider === providerId) && listed(record))
      .map(record => ({
        providerId: record.provider, baseUrl: record.baseUrl, model: record.id, displayName: record.displayName,
        available: record.available, health: record.health, free: record.free ?? null, lastErrorCategory: record.lastErrorCategory,
        capabilities: {
          chat: record.supportsChat, streaming: record.supportsStreaming, tools: record.supportsTools, streamingTools: record.supportsStreamingTools ?? null,
          vision: record.supportsVision, structuredOutput: record.supportsJSON, reasoning: record.supportsReasoning,
          contextWindow: record.contextWindow && record.contextWindow > 0 ? Math.floor(record.contextWindow) : null,
          maxOutput: record.maxOutput && record.maxOutput > 0 ? Math.floor(record.maxOutput) : null,
        },
      }))
  }

  async streamChat(
    request: ChatRequest,
    repositoryContext: string,
    attachments: ResolvedAttachment[],
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    if (this.activeRequests.has(request.requestId)) throw new Error('A request with this ID is already active.')
    const controller = new AbortController()
    this.activeRequests.set(request.requestId, controller)
    if (request.projectPath !== null) this.requestProjects.set(request.requestId, request.projectPath)

    try {
      // Read-only projects never reach a write-capable engine (ALTREX agents, Director, or Codex).
      if (request.projectPath !== null && request.mode !== 'ASK' && this.permissions.profileFor(request.projectPath) === 'read_only') {
        throw new Error('This project is read-only in ALTREX. Use Ask mode, or change the project permission profile to Standard to let agents edit it.')
      }
      const activeStored = this.readStoredProvider()
      const usableForMode = this.usableProfiles().filter(profile => request.mode !== 'LOCAL' || profile.providerId === 'ollama')
      const stored = activeStored && usableForMode.some(profile => profile.providerId === activeStored.providerId && profile.baseUrl === activeStored.baseUrl) && this.profileVerified(activeStored) && this.provider.requests.isProviderAvailable(activeStored)
        ? activeStored
        : usableForMode[0] ?? null
      const selection = request.modelSelection.trim() || 'AUTO'
      // The external Codex engine is a cloud service: never chosen automatically for local-only or free-only routing.
      const cloudEngineAllowed = !['LOCAL_ONLY', 'FREE_ONLY'].includes(this.routingModeFor(request))
      const useCodex = request.mode !== 'LOCAL' && cloudEngineAllowed && (selection === 'CODEX'
        || (selection === 'AUTO' && stored === null && this.codexAgent.getRuntimeInfo().available)
      )

      if (request.mode === 'MULTI') {
        if (!request.projectPath) throw new Error('Open a project folder for Multi-AI.')
        if (attachments.some(attachment => attachment.kind === 'image')) throw new Error('Multi-AI currently accepts text and source attachments. Use Agent mode to work from images.')
        if (!stored || selection === 'CODEX') throw new Error('Multi-AI requires a connected OpenAI-compatible provider with tool calling. Codex remains available in Agent mode.')
        const multiPrompt = request.messages.at(-1)?.content ?? '', routingMode = this.routingModeFor(request)
        const connections = this.withConsent(request, this.withoutDisconnected(await this.routedConnections(multiPrompt, selection, undefined, routingMode)))
        this.requestProviders.set(request.requestId, new Set(connections.map(connection => connection.providerId)))
        if (!connections.length) throw new Error('No configured provider is currently healthy. Test or refresh a provider to reset its session state.')
        controller.signal.throwIfAborted()
        const userRequest = request.messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n')
        const attachmentContext = attachments.map(a => `<attachment name="${a.name}">${a.textContent?.slice(0, 12000) ?? (a.kind === 'image' ? '[Image attachment: use Agent mode for visual input.]' : '[No extractable text]')}</attachment>`).join('\n')
        const directorRouter = this.routerFor(request, connections, routingMode, multiPrompt)
        const director = new Director(this.runs, directorRouter, controller.signal, run => emit({ requestId: request.requestId, type: 'run-state', run }), { id: request.requestId, projectPath: request.projectPath, request: `${userRequest}${attachmentContext ? `\n${attachmentContext}` : ''}` })
        this.directors.set(request.requestId, director)
        emit({ requestId: request.requestId, type: 'started', provider: 'ALTREX Director', model: selection === 'AUTO' ? 'AUTO · per task' : selection })
        const run = await director.execute(request.resumeRunId)
        this.directors.delete(request.requestId)
        if (run.status === 'COMPLETED') {
          emit({ requestId: request.requestId, type: 'files-changed', files: run.filesChanged })
          emit({ requestId: request.requestId, type: 'delta', delta: `Completed ${run.tasks.length} tasks and integrated ${run.filesChanged.length} files.\n\n${run.finalVerification?.summary ?? ''}` })
          // ALTREX's own evidence-based verdict on the integrated tree (no further repair: the Director owns its repairs).
          const verdict = run.filesChanged.length ? await this.verifyChangeTask(request, { checkpointId: null, controller, emit, coder: null, router: directorRouter, repair: null, reportedFiles: run.filesChanged }) : null
          this.finishTask(request, verdict, emit)
        } else emit({ requestId: request.requestId, type: controller.signal.aborted ? 'cancelled' : 'error', message: run.error ?? 'Run did not complete. Inspect the retained task results.' })
        return
      }

      if (request.mode === 'AGENT' && useCodex) {
        if (request.projectPath !== null && !this.consent.has(CODEX_CONSENT_ENDPOINT)) throw new ConsentRequiredError([CODEX_CONSENT_ENDPOINT])
        const checkpointId = await this.beginCheckpoint(request, emit)
        emit({ requestId: request.requestId, type: 'started', provider: CODEX_PROVIDER_LABEL, model: this.codexAgent.getRuntimeInfo().version ?? 'Codex CLI' })
        this.setEngine(request.requestId, 'codex')
        this.startAgent(request.requestId, 'CODER', 'OpenAI Codex (external engine)', { providerId: null, model: this.codexAgent.getRuntimeInfo().version ?? null })
        let verdict: Verdict | null = null
        try {
          await this.codexAgent.run({ request, attachments, signal: controller.signal, emit })
          // ALTREX verifies Codex's work with its own checks and an independent review (no repair by Codex).
          const review = await this.reviewSetup(request, userPromptOf(request))
          verdict = await this.verifyChangeTask(request, { checkpointId, controller, emit, coder: { providerId: 'codex', model: this.codexAgent.getRuntimeInfo().version ?? 'codex', key: 'codex:' }, router: review, repair: null })
        } finally { await this.finishCheckpoint(checkpointId, request.requestId) }
        this.finishTask(request, verdict, emit)
        return
      }

      if (stored === null) {
        throw new Error(request.mode === 'LOCAL'
          ? 'Install Ollama and the recommended local coding model, then detect it in AI Providers.'
          : request.mode === 'AGENT'
          ? 'Connect NVIDIA NIM or another tool-capable provider, or select Codex.'
          : 'Connect AI to continue in Ask mode.')
      }
      const userPrompt = request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''
      const routingPrompt = attachments.length === 0 ? userPrompt : `${userPrompt}\nAttached inputs: ${attachments.map(attachment => `${attachment.name} (${attachment.mimeType})`).join(', ')}`
      const routingMode = this.routingModeFor(request)
      const connections = this.withConsent(request, this.withoutDisconnected(await this.routedConnections(routingPrompt, selection === 'CODEX' ? 'AUTO' : selection, request.mode === 'LOCAL' ? 'ollama' : undefined, routingMode)))
      this.requestProviders.set(request.requestId, new Set(connections.map(connection => connection.providerId)))
      if (!connections.length) throw new Error(selection !== 'AUTO' && selection !== 'CODEX'
        ? `The selected model "${selection}" is not offered by any configured, healthy provider, so nothing was sent. Refresh models or choose another model.`
        : 'No configured provider is currently healthy and compatible. Test or refresh provider status.')
      const router = this.routerFor(request, connections, routingMode, routingPrompt), first = connections[0]!
      const writesWorkspace = request.mode === 'AGENT' || request.mode === 'LOCAL'
      const checkpointId = writesWorkspace ? await this.beginCheckpoint(request, emit) : null
      emit({ requestId: request.requestId, type: 'activity', model: first.model, message: `AUTO filtered configured providers by health, model availability, and required capabilities. ${connections.length} candidate${connections.length === 1 ? '' : 's'} remain.` })
      emit({ requestId: request.requestId, type: 'started', provider: providerName(first.providerId), model: first.model })
      if (writesWorkspace) {
        let verdict: Verdict | null = null
        try {
          const agentAttachments = request.mode === 'LOCAL'
            ? await this.prepareLocalRuntime('ollama').then(() => this.describeLocalImages(stored, attachments, userPrompt, controller.signal, event => emit({ ...event, requestId: request.requestId })))
            : attachments
          this.setEngine(request.requestId, 'altrex')
          const agentId = this.startAgent(request.requestId, 'CODER', request.mode === 'LOCAL' ? 'Local coding agent' : 'Coding agent', { providerId: first.providerId, model: first.model })
          const toolOptions = this.permissions.toolOptions(this.taskId(request.requestId), request.projectPath!, { repo: repositoryIntelligence(request.projectPath!) })
          const progress = (id: string | null) => (round: number, tools: string[], endpoint: { providerId: string; model: string }) => { if (id && this.tasks) { this.tasks.agentEndpoint(id, endpoint.providerId, endpoint.model); this.tasks.agentProgress(id, tools.length ? `Round ${round + 1}: ${tools.join(', ')}` : `Round ${round + 1}: reply without tool calls`, round) } }
          const verifying = this.tasks?.taskIdFor(request.requestId) !== undefined
          let coder = first
          if (request.mode === 'AGENT' && (request.candidates ?? 1) > 1 && this.leasesRoot) {
            if (agentId) this.tasks?.agentFinished(agentId, 'completed', 'Split into tournament candidates.')
            coder = await this.tournament(request, { connections, routingMode, routingPrompt, repositoryContext, attachments: agentAttachments, controller, emit, progress })
          } else {
            await runCodingAgent({ provider: this.providerFor(request), connection: first, router, request, repositoryContext, attachments: agentAttachments, signal: controller.signal, emit, onRound: progress(agentId), toolOptions, skipSelfVerification: verifying })
            if (agentId) this.tasks?.agentFinished(agentId, 'completed', 'Implementation round finished.')
          }
          verdict = await this.verifyChangeTask(request, {
            checkpointId, controller, emit, router, coder: { providerId: coder.providerId, model: coder.model, key: this.models.key(coder) },
            repair: async (instructions, escalate, repairAgentId) => {
              const repairRequest: ChatRequest = { ...request, messages: [...request.messages, { role: 'assistant', content: 'I made the requested changes.' }, { role: 'user', content: instructions }] }
              const repairRouter = escalate ? this.routerFor(request, connections, 'POWERFUL', routingPrompt) : router
              await runCodingAgent({ provider: this.providerFor(request), connection: first, router: repairRouter, request: repairRequest, repositoryContext, attachments: [], signal: controller.signal, emit, onRound: progress(repairAgentId), toolOptions, skipSelfVerification: true })
            },
          })
        } finally { await this.finishCheckpoint(checkpointId, request.requestId) }
        this.finishTask(request, verdict, emit)
        return
      }
      await router.stream('Ask', this.buildMessages(request.messages, repositoryContext, attachments), controller.signal, message => emit({ requestId: request.requestId, type: 'activity', message }), delta => emit({ requestId: request.requestId, type: 'delta', delta }), { vision: attachments.some(attachment => attachment.kind === 'image') })
      emit({ requestId: request.requestId, type: 'completed' })
    } catch (error) {
      const consentTask = error instanceof ConsentRequiredError ? this.tasks?.taskIdFor(request.requestId) : undefined
      if (consentTask) this.tasks!.end(consentTask, { state: 'FAILED', message: (error as ConsentRequiredError).message, code: 'CONSENT_REQUIRED' })
      if (controller.signal.aborted) emit({ requestId: request.requestId, type: 'cancelled' })
      else emit({ requestId: request.requestId, type: 'error', message: error instanceof Error ? error.message : 'Provider request failed.' })
    } finally {
      this.activeRequests.delete(request.requestId)
      this.requestProviders.delete(request.requestId)
      this.requestRouters.delete(request.requestId)
      this.requestProjects.delete(request.requestId)
      this.directors.delete(request.requestId)
      this.permissions.endTask(this.taskId(request.requestId))
      writeFileSync(join(this.runs.root, 'request-metrics.json'), JSON.stringify(this.provider.requests.metrics), { mode: 0o600 })
    }
  }

  private buildMessages(messages: ChatMessage[], repositoryContext: string, attachments: ResolvedAttachment[]): ProviderMessage[] {
    const system = [
      'You are ALTREX, a precise software engineering assistant.',
      'Answer from the supplied repository context. Do not claim to have edited files, executed tools, or run tests.',
      'If context is insufficient, say exactly what additional file or action is needed.',
      repositoryContext.length > 0 ? `Repository context:\n${repositoryContext}` : 'No project is open. Answer without repository context.',
    ].join('\n\n')
    const boundedMessages: ProviderMessage[] = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))
    if (attachments.length > 0 && boundedMessages.length > 0) {
      let latestUserIndex = -1
      for (let index = boundedMessages.length - 1; index >= 0; index -= 1) {
        if (boundedMessages[index]?.role === 'user') {
          latestUserIndex = index
          break
        }
      }
      if (latestUserIndex >= 0) {
        const latest = boundedMessages[latestUserIndex]!
        const fileContext = attachments.map((attachment) => {
          const location = attachment.projectRelativePath === undefined ? '' : ` path="${attachment.projectRelativePath}"`
          const content = attachment.textContent === undefined ? '' : `\n<file_content>\n${attachment.textContent.slice(0, 750_000)}\n</file_content>`
          return `<attachment name="${attachment.name}" type="${attachment.mimeType}"${location}>${content}</attachment>`
        }).join('\n\n')
        const parts: ProviderContentPart[] = [{ type: 'text', text: `${latest.content}\n\n${fileContext}` }]
        for (const attachment of attachments) {
          if (attachment.imageDataUrl !== undefined) parts.push({ type: 'image_url', image_url: { url: attachment.imageDataUrl, detail: 'auto' } })
        }
        boundedMessages[latestUserIndex] = { ...latest, content: parts }
      }
    }
    return [{ role: 'system', content: system }, ...boundedMessages]
  }

  private runtimeConnection(stored: StoredProvider, model: string, apiKey = this.decryptApiKey(stored)): ProviderRuntimeConnection {
    return {
      providerId: stored.providerId,
      baseUrl: stored.baseUrl,
      model,
      apiKey,
      ...(stored.requestPolicy ? { requestPolicy: stored.requestPolicy } : {}),
    }
  }

  private readStoredProvider(): StoredProvider | null {
    if (!existsSync(this.credentialPath)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.credentialPath, 'utf8')) as Partial<StoredProvider>
      if (
        (parsed.version !== 1 && parsed.version !== 2)
        || typeof parsed.providerId !== 'string'
        || typeof parsed.baseUrl !== 'string'
        || typeof parsed.model !== 'string'
        || typeof parsed.encryptedApiKey !== 'string'
      ) return null
      return parsed as StoredProvider
    } catch {
      return null
    }
  }

  private decryptApiKey(stored: StoredProvider): string {
    if (!secureStorageAvailable()) throw new Error('Secure credential storage is unavailable on this system.')
    try {
      return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
    } catch {
      throw new Error('The saved API key could not be unlocked. Reconnect the provider.')
    }
  }
}


