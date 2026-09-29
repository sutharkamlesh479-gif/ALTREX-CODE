import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CapabilityRequirement, ModelCapabilities, ProviderRuntimeConnection, ModelProvider, ProviderMessage, ProviderCompletion } from './model-provider'
import { ProviderFailure, isUsableHealth } from './request-manager'
import { capabilityHints } from '@altrex/core/gateway/adapters/capability-hints'
import type { DiscoveredModel } from '@altrex/core/gateway/stream-types'
import type { ProviderErrorCategory } from '../../shared/provider-errors'
import { route, type Difficulty, type RouteCandidate, type RoutingDecision, type RoutingMode } from '@altrex/core/router/router'

export type ModelHealthState = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'INCOMPATIBLE'
export type ModelRecord = ModelCapabilities & {
  id: string
  provider: string
  baseUrl: string
  displayName: string
  available: boolean | null
  health: ModelHealthState
  lastErrorCategory: ProviderErrorCategory | null
  lastCheckedAt: string | null
  roleHistory: Record<string, { accepted: number; failed: number; durationMs: number }>
  /** Free to use (provider pricing or local). null = unknown. */
  free: boolean | null
  recommendedFirstTokenMs: number
  concurrency: number
}
const withHints = (record: ModelRecord): ModelRecord => {
  for (const [field, value] of Object.entries(capabilityHints(record.provider)) as Array<[keyof ModelCapabilities, boolean]>) if (record[field] === null) Object.assign(record, { [field]: value })
  return record
}
const unknownCapabilities = (): ModelCapabilities => ({ supportsChat: null, supportsStreaming: null, supportsTools: null, supportsStreamingTools: null, supportsParallelTools: null, supportsVision: null, supportsJSON: null, supportsReasoning: null, contextWindow: null, maxOutput: null })

export class ModelRegistry {
  private records: Record<string, ModelRecord> = {}
  constructor(private readonly path: string) { try { if (existsSync(path)) this.records = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ModelRecord> } catch { this.records = {} } }
  key(connection: ProviderRuntimeConnection): string { return `${connection.providerId}:${connection.baseUrl}:${connection.model}` }
  private save(): void { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.records), { mode: 0o600 }) }
  record(connection: ProviderRuntimeConnection): ModelRecord {
    const key = this.key(connection), old = this.records[key] as (Partial<ModelRecord> & { streaming?: boolean | null; tools?: boolean | null; vision?: boolean | null; structuredOutput?: boolean | null; reasoning?: boolean | null }) | undefined
    if (old) {
      const migrated: ModelRecord = { ...unknownCapabilities(), id: connection.model, provider: connection.providerId, displayName: connection.model, available: null, health: 'UNKNOWN', lastErrorCategory: null, lastCheckedAt: null, roleHistory: {}, free: null, recommendedFirstTokenMs: connection.requestPolicy?.firstTokenMs ?? 180000, concurrency: connection.requestPolicy?.concurrency ?? 1, ...old, baseUrl: connection.baseUrl,
        supportsStreaming: old.supportsStreaming ?? old.streaming ?? null, supportsTools: old.supportsTools ?? old.tools ?? null, supportsStreamingTools: old.supportsStreamingTools ?? null, supportsVision: old.supportsVision ?? old.vision ?? null, supportsJSON: old.supportsJSON ?? old.structuredOutput ?? null, supportsReasoning: old.supportsReasoning ?? old.reasoning ?? null }
      this.records[key] = withHints(migrated); return this.records[key]!
    }
    return this.records[key] = withHints({ ...unknownCapabilities(), id: connection.model, provider: connection.providerId, baseUrl: connection.baseUrl, displayName: connection.model, available: null, health: 'UNKNOWN', lastErrorCategory: null, lastCheckedAt: null, roleHistory: {}, free: null, recommendedFirstTokenMs: connection.requestPolicy?.firstTokenMs ?? 180000, concurrency: connection.requestPolicy?.concurrency ?? 1 })
  }
  observeCapabilities(connection: ProviderRuntimeConnection, capabilities: Partial<ModelCapabilities>): void { const record = this.record(connection); Object.assign(record, capabilities); record.lastCheckedAt = new Date().toISOString(); if (capabilities.supportsChat) { record.available = true; record.health = 'HEALTHY'; record.lastErrorCategory = null } this.save() }
  observe(connection: ProviderRuntimeConnection, role: string, accepted: boolean, durationMs: number, usedTools = false): void {
    const record = this.record(connection), history = record.roleHistory[role] ??= { accepted: 0, failed: 0, durationMs: 0 }; history[accepted ? 'accepted' : 'failed']++; history.durationMs += durationMs; record.lastCheckedAt = new Date().toISOString()
    if (accepted) { record.available = true; record.supportsChat = true; if (usedTools) record.supportsTools = true; record.health = 'HEALTHY'; record.lastErrorCategory = null }
    else if (record.health === 'HEALTHY') record.health = 'DEGRADED'
    this.save()
  }
  observeFailure(connection: ProviderRuntimeConnection, category: ProviderErrorCategory): void {
    const record = this.record(connection); record.lastCheckedAt = new Date().toISOString(); record.lastErrorCategory = category
    if (category === 'MODEL_NOT_FOUND' || category === 'MODEL_UNAVAILABLE') { record.available = false; record.health = 'UNAVAILABLE' }
    else if (category === 'TOOLS_UNSUPPORTED') { record.supportsTools = false; record.health = 'INCOMPATIBLE' }
    else if (category === 'BAD_REQUEST') record.health = 'DEGRADED'
    this.save()
  }
  markDiscovered(connection: ProviderRuntimeConnection): void { const record = this.record(connection); if (record.available === false && ['MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE'].includes(record.lastErrorCategory ?? '')) { record.available = null; record.health = 'UNKNOWN' } this.save() }
  /**
   * Apply catalog metadata. Discovery only fills unknown fields; observed facts (probes, real use)
   * are never overwritten. One disk write per catalog.
   */
  observeDiscovery(base: ProviderRuntimeConnection, models: readonly DiscoveredModel[]): void {
    for (const model of models) {
      const record = this.record({ ...base, model: model.id })
      const fill = (field: 'contextWindow' | 'maxOutput' | 'supportsTools' | 'supportsVision' | 'supportsJSON' | 'supportsReasoning', value: number | boolean | undefined) => { if (value !== undefined && record[field] === null) Object.assign(record, { [field]: value }) }
      fill('contextWindow', model.contextWindow); fill('maxOutput', model.maxOutput); fill('supportsTools', model.supportsTools)
      fill('supportsVision', model.supportsVision); fill('supportsJSON', model.supportsStructuredOutput); fill('supportsReasoning', model.supportsReasoning)
      if (model.free !== undefined) record.free = model.free
      if (model.displayName) record.displayName = model.displayName
      if (record.available === false && ['MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE'].includes(record.lastErrorCategory ?? '')) { record.available = null; record.health = 'UNKNOWN' }
    }
    this.save()
  }
  /**
   * A fresh catalog is authoritative: models of this endpoint that it no longer lists become unavailable
   * (they return automatically if a later catalog lists them again).
   */
  retainCatalog(base: ProviderRuntimeConnection, models: readonly string[]): void {
    if (!models.length) return
    const listed = new Set(models)
    let changed = false
    for (const record of Object.values(this.records)) {
      if (record.provider !== base.providerId || record.baseUrl !== base.baseUrl || listed.has(record.id) || record.available === false) continue
      record.available = false; record.health = 'UNAVAILABLE'; record.lastErrorCategory = 'MODEL_NOT_FOUND'; changed = true
    }
    if (changed) this.save()
  }
  meets(record: ModelRecord, requirement: CapabilityRequirement, unknownAllowed = false): boolean {
    const check = (required: boolean | undefined, actual: boolean | null) => !required || actual === true || (unknownAllowed && actual === null)
    return record.available !== false && check(requirement.chat, record.supportsChat) && check(requirement.streaming, record.supportsStreaming) && check(requirement.tools, record.supportsTools) && check(requirement.vision, record.supportsVision) && check(requirement.json, record.supportsJSON) && (!requirement.adequateContext || record.contextWindow === null || record.contextWindow >= requirement.adequateContext)
  }
  list(): ModelRecord[] { return Object.values(this.records) }
}


export type RoutingEndpoint = { providerId: string; model: string }
/** Structured routing events (mapped to contract events by the host). */
export type RoutingEvent =
  | { type: 'model.selected'; role: string; mode: RoutingMode; providerId: string; model: string; reasons: string[] }
  | { type: 'provider.selected'; role: string; mode: RoutingMode; providerId: string; reason: string }
  | { type: 'route.changed'; role: string; from: RoutingEndpoint; to: RoutingEndpoint; reason: string }
  | { type: 'fallback.started'; role: string; from: RoutingEndpoint; to: RoutingEndpoint; reason: string }
  | { type: 'fallback.completed'; role: string; from: RoutingEndpoint; to: RoutingEndpoint }
  | { type: 'fallback.failed'; role: string; from: RoutingEndpoint; reason: string; attempted: number }

export type RoleRouterOptions = {
  mode?: RoutingMode
  difficulty?: Difficulty
  /** Whether requests carry repository content (cloud endpoints then need consent). Default true. */
  carriesRepositoryData?: boolean
  /** Whether the user allowed this endpoint to receive project code (checked for cloud endpoints only). Default true. */
  consentOf?: (connection: ProviderRuntimeConnection) => boolean
  /** Weak-prior task text (used only when nothing measured distinguishes candidates). */
  taskText?: string
  privacyOf?: (connection: ProviderRuntimeConnection) => 'local' | 'cloud'
  /** Called immediately before a selected endpoint is first used (e.g. start a local runtime lazily). */
  beforeUse?: (connection: ProviderRuntimeConnection) => Promise<void>
  onRouting?: (event: RoutingEvent) => void
}

const loopback = (connection: ProviderRuntimeConnection): 'local' | 'cloud' => {
  try { const host = new URL(connection.baseUrl).hostname.replace(/^\[|\]$/g, ''); return ['localhost', '127.0.0.1', '::1'].includes(host) ? 'local' : 'cloud' } catch { return 'cloud' }
}
const endpointOf = (connection: ProviderRuntimeConnection): RoutingEndpoint => ({ providerId: connection.providerId, model: connection.model })
const categoryOf = (error: unknown) => (error instanceof ProviderFailure ? error.category : 'UNKNOWN')

/**
 * Executes a role's model calls: the pure router (@altrex/core/router) orders candidates for each call;
 * this class probes unknown capabilities, streams turns where supported, falls back on failure, and
 * reports every routing decision as a structured event. Roles ask for capabilities, never model IDs.
 */
export class RoleRouter {
  private readonly excluded = new Set<string>()
  private readonly lastSelected = new Map<string, ProviderRuntimeConnection>()
  readonly options: RoleRouterOptions
  constructor(readonly provider: ModelProvider, readonly connections: ProviderRuntimeConnection[], readonly registry: ModelRegistry, options: RoleRouterOptions = {}) {
    this.options = options
  }
  /** Stop routing to a provider for the rest of this task (e.g. it was disconnected). */
  exclude(providerId: string): void { this.excluded.add(providerId) }
  /** Whether any candidate remains after exclusions. */
  hasCandidates(): boolean { return this.connections.some(connection => !this.excluded.has(connection.providerId)) }

  /** The pure routing decision for one role call (no I/O). */
  decide(role: string, requirement: CapabilityRequirement = {}, preferDifferentFrom?: string): RoutingDecision {
    const byKey = new Map(this.connections.map(connection => [this.registry.key(connection), connection]))
    const candidates: RouteCandidate[] = [...byKey].map(([key, connection]) => {
      const record = this.registry.record(connection), health = this.provider.providerHealth?.(connection)
      return {
        key, providerId: connection.providerId, baseUrl: connection.baseUrl, model: connection.model,
        privacy: (this.options.privacyOf ?? loopback)(connection), providerHealth: health?.state ?? 'UNKNOWN',
        available: record.available, modelHealth: record.health, free: record.free ?? null, consent: this.options.consentOf?.(connection) ?? true,
        capabilities: { chat: record.supportsChat, streaming: record.supportsStreaming, tools: record.supportsTools, vision: record.supportsVision, structuredOutput: record.supportsJSON, reasoning: record.supportsReasoning, contextWindow: record.contextWindow },
        roleStats: record.roleHistory[role], load: (health?.active ?? 0) + (health?.queued ?? 0),
      }
    })
    return route({
      role, mode: this.options.mode ?? 'AUTO', difficulty: this.options.difficulty ?? 'standard',
      carriesRepositoryData: this.options.carriesRepositoryData ?? true,
      requires: { chat: requirement.chat ?? true, ...(requirement.tools ? { tools: true } : {}), ...(requirement.vision ? { vision: true } : {}), ...(requirement.streaming ? { streaming: true } : {}), ...(requirement.json ? { structuredOutput: true } : {}), ...(requirement.adequateContext ? { minContext: requirement.adequateContext } : {}) },
      excludeProviders: [...this.excluded],
      ...(preferDifferentFrom ? { preferDifferentFrom } : {}),
      ...(this.options.taskText ? { taskText: this.options.taskText } : {}),
    }, candidates, { maxFallbacks: 11 })
  }

  candidates(role: string, requirement: CapabilityRequirement = {}): ProviderRuntimeConnection[] {
    const byKey = new Map(this.connections.map(connection => [this.registry.key(connection), connection]))
    return this.decide(role, requirement).ordered.map(item => byKey.get(item.candidate.key)!)
  }

  private boundedCandidates(role: string, requirement: CapabilityRequirement): { list: ProviderRuntimeConnection[]; decision: RoutingDecision } {
    const byKey = new Map(this.connections.map(connection => [this.registry.key(connection), connection]))
    const decision = this.decide(role, requirement, requirement.differentFrom)
    const perProvider = new Map<string, number>()
    const list = decision.ordered.map(item => byKey.get(item.candidate.key)!).filter(connection => {
      const key = `${connection.providerId}:${connection.baseUrl}`, count = perProvider.get(key) ?? 0
      if (count >= 3) return false
      perProvider.set(key, count + 1); return true
    }).slice(0, 12)
    return { list, decision }
  }

  private emit(event: RoutingEvent): void {
    try { this.options.onRouting?.(event) } catch { /* routing telemetry never breaks a task */ }
  }

  /** Report the endpoint about to be used for a role call. */
  private selected(role: string, connection: ProviderRuntimeConnection, reasons: string[], afterFailure: boolean): void {
    const previous = this.lastSelected.get(role), mode = this.options.mode ?? 'AUTO'
    if (previous && this.registry.key(previous) === this.registry.key(connection)) return
    if (previous && !afterFailure) this.emit({ type: 'route.changed', role, from: endpointOf(previous), to: endpointOf(connection), reason: 'Re-ranked with current health and measured results.' })
    if (!previous || previous.providerId !== connection.providerId || previous.baseUrl !== connection.baseUrl) {
      this.emit({ type: 'provider.selected', role, mode, providerId: connection.providerId, reason: reasons[0] ?? `${mode} routing` })
    }
    this.emit({ type: 'model.selected', role, mode, providerId: connection.providerId, model: connection.model, reasons })
    this.lastSelected.set(role, connection)
  }

  /** The connection with the model's known limits, so the request budget is sized from its real context window. */
  private sized(connection: ProviderRuntimeConnection): ProviderRuntimeConnection {
    const record = this.registry.record(connection)
    return { ...connection, ...(record.contextWindow ? { contextWindow: record.contextWindow } : {}), ...(record.maxOutput ? { maxOutput: record.maxOutput } : {}) }
  }

  private usable(connection: ProviderRuntimeConnection): boolean {
    return !this.excluded.has(connection.providerId) && (!this.provider.providerHealth || isUsableHealth(this.provider.providerHealth(connection).state))
  }

  async complete(role: string, messages: ProviderMessage[], tools: readonly unknown[], signal: AbortSignal, status: (text: string) => void, prefer?: string, extraRequirement: CapabilityRequirement = {}): Promise<{ completion: ProviderCompletion; connection: ProviderRuntimeConnection }> {
    const requirement: CapabilityRequirement = { chat: true, tools: tools.length > 0, ...extraRequirement }
    const bounded = this.boundedCandidates(role, requirement)
    let candidates = bounded.list
    if (prefer) candidates = [...candidates.filter(c => this.registry.key(c) === prefer), ...candidates.filter(c => this.registry.key(c) !== prefer)]
    let failure: unknown = new Error('No configured model meets the required capabilities.')
    let previous: ProviderRuntimeConnection | undefined
    for (const connection of candidates) {
      signal.throwIfAborted()
      if (!this.usable(connection)) continue
      await this.options.beforeUse?.(connection)
      const record = this.registry.record(connection)
      if (!this.registry.meets(record, requirement) && this.provider.probeCapabilities) {
        try { this.registry.observeCapabilities(connection, await this.provider.probeCapabilities(connection, requirement, signal)) }
        catch (error) { failure = error; if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category); continue }
      } else if (requirement.tools && record.supportsTools === null && this.provider.probeCapabilities) {
        try { this.registry.observeCapabilities(connection, await this.provider.probeCapabilities(connection, requirement, signal)) }
        catch (error) { failure = error; if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category); continue }
      }
      if (!this.registry.meets(this.registry.record(connection), requirement, !this.provider.probeCapabilities)) continue
      if (previous) {
        this.provider.recordFallback?.(previous, connection)
        this.emit({ type: 'fallback.started', role, from: endpointOf(previous), to: endpointOf(connection), reason: categoryOf(failure) })
      }
      this.selected(role, connection, previous ? [`Fallback after ${previous.providerId} / ${previous.model} failed (${categoryOf(failure)}).`] : bounded.decision.reasons, previous !== undefined)
      const started = Date.now()
      try {
        const continuation = previous ? [...messages, { role: 'system' as const, content: `TASK CONTINUATION: ${previous.providerId}/${previous.model} failed. Preserve completed tool results and file changes already recorded in this conversation. Continue the remaining objective; do not restart completed work.` }] : messages
        const current = this.registry.record(connection)
        // Turns stream by default; a model whose capability record says streaming (or streamed tool calls)
        // does not work uses a non-streamed turn instead.
        const streamTurn = current.supportsStreaming !== false && current.supportsStreamingTools !== false
        let completion: ProviderCompletion, streamed = streamTurn
        try {
          completion = await this.provider.complete({ connection: this.sized(connection), messages: continuation, tools, signal, onStatus: status, ...(streamTurn ? { stream: true } : {}) })
        } catch (error) {
          // Unreadable streamed tool calls/frames: record the limitation explicitly, then repeat this turn
          // once without streaming on the same model before falling back to another model.
          if (!streamTurn || !tools.length || signal.aborted || !(error instanceof ProviderFailure) || !['TOOL_CALL_MALFORMED', 'STREAM_MALFORMED'].includes(error.category)) throw error
          streamed = false
          this.registry.observeCapabilities(connection, { supportsStreamingTools: false })
          status(`${connection.providerId} / ${connection.model} returned an unreadable streamed tool call; this model now uses non-streamed tool turns.`)
          completion = await this.provider.complete({ connection: this.sized(connection), messages: continuation, tools, signal, onStatus: status })
        }
        if (streamed && completion.toolCalls.length && current.supportsStreamingTools === null) this.registry.observeCapabilities(connection, { supportsStreamingTools: true })
        this.registry.observe(connection, role, true, Date.now() - started, completion.toolCalls.length > 0)
        if (previous) this.emit({ type: 'fallback.completed', role, from: endpointOf(previous), to: endpointOf(connection) })
        return { completion, connection }
      } catch (error) {
        failure = error
        // A disconnected provider is a routing event, not a model or provider fault.
        if (!(error instanceof ProviderFailure && error.category === 'PROVIDER_DISCONNECTED')) {
          this.registry.observe(connection, role, false, Date.now() - started)
          if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category)
        }
        if (signal.aborted || (error instanceof ProviderFailure && error.category === 'CANCELLED')) throw error
        previous = connection
        const remaining = candidates.find(candidate => candidate !== connection && this.usable(candidate))
        if (remaining) status(`${connection.providerId} / ${connection.model} unavailable (${categoryOf(error)}). Switching to ${remaining.providerId} / ${remaining.model}.`)
      }
    }
    if (previous) this.emit({ type: 'fallback.failed', role, from: endpointOf(previous), reason: categoryOf(failure), attempted: candidates.length })
    throw failure
  }

  async stream(role: string, messages: ProviderMessage[], signal: AbortSignal, status: (text: string) => void, onDelta: (delta: string) => void, extraRequirement: CapabilityRequirement = {}): Promise<ProviderRuntimeConnection> {
    const requirement: CapabilityRequirement = { chat: true, streaming: true, ...extraRequirement }
    const { list: candidates, decision } = this.boundedCandidates(role, requirement)
    let failure: unknown = new Error('No configured model supports streaming for this request.'), previous: ProviderRuntimeConnection | undefined
    for (const connection of candidates) {
      signal.throwIfAborted()
      if (this.excluded.has(connection.providerId)) continue
      await this.options.beforeUse?.(connection)
      const record = this.registry.record(connection)
      if ((!this.registry.meets(record, requirement) || record.supportsStreaming === null) && this.provider.probeCapabilities) {
        try { this.registry.observeCapabilities(connection, await this.provider.probeCapabilities(connection, requirement, signal)) }
        catch (error) { failure = error; if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category); continue }
      }
      if (!this.registry.meets(this.registry.record(connection), requirement, !this.provider.probeCapabilities)) continue
      if (previous) {
        this.provider.recordFallback?.(previous, connection)
        this.emit({ type: 'fallback.started', role, from: endpointOf(previous), to: endpointOf(connection), reason: categoryOf(failure) })
      }
      this.selected(role, connection, previous ? [`Fallback after ${previous.providerId} / ${previous.model} failed (${categoryOf(failure)}).`] : decision.reasons, previous !== undefined)
      let received = false; const started = Date.now()
      try {
        await this.provider.stream({ connection: this.sized(connection), messages: previous ? [...messages, { role: 'system', content: 'Continue the requested answer after the previous provider failed before returning any text.' }] : messages, signal, onStatus: status, onDelta: delta => { received = true; onDelta(delta) } })
        this.registry.observe(connection, role, true, Date.now() - started); this.registry.observeCapabilities(connection, { supportsChat: true, supportsStreaming: true })
        if (previous) this.emit({ type: 'fallback.completed', role, from: endpointOf(previous), to: endpointOf(connection) })
        return connection
      } catch (error) {
        failure = error
        if (!(error instanceof ProviderFailure && error.category === 'PROVIDER_DISCONNECTED')) { this.registry.observe(connection, role, false, Date.now() - started); if (error instanceof ProviderFailure) this.registry.observeFailure(connection, error.category) }
        if (received || signal.aborted || (error instanceof ProviderFailure && error.category === 'CANCELLED')) throw error
        previous = connection
        const next = candidates.find(candidate => candidate !== connection && this.usable(candidate))
        if (next) status(`${connection.providerId} / ${connection.model} unavailable. Switching to ${next.providerId} / ${next.model}.`)
      }
    }
    if (previous) this.emit({ type: 'fallback.failed', role, from: endpointOf(previous), reason: categoryOf(failure), attempted: candidates.length })
    throw failure
  }
}
