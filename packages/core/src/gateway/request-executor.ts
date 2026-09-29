import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { RequestPolicy } from './request-policy'
import { requestPolicy } from './request-policy'
import { classifyProviderHttpError, type ProviderErrorCategory } from './http-errors'
import type { EndpointConnection as ProviderRuntimeConnection } from './connection'
import type { ProviderMessage } from './messages'
import { budgetContext, estimateTokens } from '../context/budget'
import { abortableDelay } from '../util/abort'
export { abortableDelay }

export type FailureKind = 'authentication' | 'too-large' | 'rate-limit' | 'quota-exhausted' | 'timeout' | 'unavailable' | 'model-unavailable' | 'tools-unsupported' | 'invalid-request' | 'network' | 'cancelled'
const legacyCategory: Record<FailureKind, ProviderErrorCategory> = {
  authentication: 'AUTH_ERROR', 'too-large': 'CONTEXT_TOO_LARGE', 'rate-limit': 'RATE_LIMITED', 'quota-exhausted': 'QUOTA_EXHAUSTED', timeout: 'TIMEOUT', unavailable: 'PROVIDER_SERVER_ERROR', 'model-unavailable': 'MODEL_UNAVAILABLE', 'tools-unsupported': 'TOOLS_UNSUPPORTED', 'invalid-request': 'BAD_REQUEST', network: 'CONNECTION_ERROR', cancelled: 'CANCELLED',
}
function legacyKind(category: ProviderErrorCategory): FailureKind {
  if (category === 'AUTH_ERROR' || category === 'INVALID_API_KEY') return 'authentication'
  if (category === 'CONTEXT_TOO_LARGE') return 'too-large'
  if (category === 'RATE_LIMITED') return 'rate-limit'
  if (category === 'QUOTA_EXHAUSTED') return 'quota-exhausted'
  if (category === 'TIMEOUT') return 'timeout'
  if (category === 'PROVIDER_SERVER_ERROR') return 'unavailable'
  if (category === 'MODEL_NOT_FOUND' || category === 'MODEL_UNAVAILABLE') return 'model-unavailable'
  if (category === 'TOOLS_UNSUPPORTED') return 'tools-unsupported'
  if (category === 'CONNECTION_ERROR' || category === 'STREAM_INTERRUPTED') return 'network'
  if (category === 'CANCELLED') return 'cancelled'
  return 'invalid-request'
}

export class ProviderFailure extends Error {
  readonly category: ProviderErrorCategory
  readonly technicalDetails: string
  readonly provider: string | undefined
  readonly model: string | undefined
  constructor(message: string, readonly kind: FailureKind, readonly retryable: boolean, readonly status = 0, readonly retryAfterMs = 0, readonly tokenLimit?: number, category = legacyCategory[kind], technicalDetails = '', context?: { provider?: string; model?: string }) {
    super(message); this.category = category; this.technicalDetails = technicalDetails; this.provider = context?.provider; this.model = context?.model
  }
}
export function classifyFailure(status: number, body: string, retryAfter: string | null, context?: { provider?: string; model?: string; apiKey?: string }): ProviderFailure {
  const result = classifyProviderHttpError(status, body, retryAfter)
  const technicalDetails = context?.apiKey ? result.technicalDetails.replaceAll(context.apiKey, '[REDACTED]') : result.technicalDetails
  return new ProviderFailure(result.message, legacyKind(result.category), result.retryable, status, result.retryAfterMs, result.tokenLimit, result.category, technicalDetails, context)
}

/**
 * Request budget for a call. Defaults are conservative (a few thousand tokens) only when the model's
 * limits are unknown; when the registry knows the context window/output limit, the budget is sized from
 * them. Budgets the user set explicitly, and per-call overrides (probes), always win.
 */
export function effectivePolicy(connection: ProviderRuntimeConnection, overrides: Partial<RequestPolicy> = {}): RequestPolicy {
  const policy = requestPolicy(connection.providerId, { ...connection.requestPolicy, ...overrides })
  const defaults = requestPolicy(connection.providerId), configured = connection.requestPolicy
  const outputFixed = overrides.outputTokens !== undefined || (configured?.outputTokens !== undefined && configured.outputTokens !== defaults.outputTokens)
  const inputFixed = overrides.inputTokens !== undefined || (configured?.inputTokens !== undefined && configured.inputTokens !== defaults.inputTokens)
  if (!outputFixed && connection.maxOutput && connection.maxOutput > 0) policy.outputTokens = Math.max(policy.outputTokens, Math.min(8192, Math.floor(connection.maxOutput)))
  // Output limit unknown but a large context window is known: allow a full file edit (one eighth of the window, up to 8192).
  else if (!outputFixed && connection.contextWindow && connection.contextWindow >= 32_768) policy.outputTokens = Math.max(policy.outputTokens, Math.min(8192, Math.floor(connection.contextWindow / 8)))
  if (!inputFixed && connection.contextWindow && connection.contextWindow > 0) {
    policy.inputTokens = Math.max(1024, Math.min(128_000, Math.floor(connection.contextWindow * 0.75) - policy.outputTokens))
  }
  return policy
}

function disconnected(context: { providerId: string; model?: string }): ProviderFailure {
  return new ProviderFailure('The provider was disconnected.', 'cancelled', false, 0, 0, undefined, 'PROVIDER_DISCONNECTED', 'The provider was disconnected while this request was pending or in flight.', { provider: context.providerId, ...(context.model ? { model: context.model } : {}) })
}

export type Transport = (url: string, init: RequestInit, connectionMs: number) => Promise<Response>
export const nativeTransport: Transport = (url, init, connectionMs) => new Promise((resolve, reject) => {
  const parsed = new URL(url)
  const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed, { method: init.method ?? 'GET', headers: init.headers as Record<string, string>, signal: init.signal ?? undefined }, response => {
    clearTimeout(connectTimer); const headers = new Headers()
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
    const decoded: Readable = encoding === 'gzip' ? response.pipe(createGunzip()) : encoding === 'deflate' ? response.pipe(createInflate()) : encoding === 'br' ? response.pipe(createBrotliDecompress()) : response
    if (encoding) { headers.delete('content-encoding'); headers.delete('content-length') }
    resolve(new Response(Readable.toWeb(decoded) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers }))
  })
  const connectTimer = setTimeout(() => request.destroy(new ProviderFailure('Provider connection timed out.', 'timeout', true, 0, 0, undefined, 'TIMEOUT', 'Connection deadline exceeded.')), connectionMs)
  request.on('socket', socket => { if (!socket.connecting) clearTimeout(connectTimer); else socket.once(parsed.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer)) })
  request.on('error', error => { clearTimeout(connectTimer); reject(error) })
  request.end(typeof init.body === 'string' ? init.body : undefined)
})

/**
 * Provider (profile) health (PROVIDER_SPEC.md §7). UNKNOWN until real traffic or a probe is observed.
 * AUTH_ERROR, QUOTA_EXHAUSTED and UNSUPPORTED are latched until the provider is retested/reconnected.
 */
export type ProviderHealthState = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'AUTH_ERROR' | 'OFFLINE' | 'UNSUPPORTED'
const USABLE_STATES: ReadonlySet<ProviderHealthState> = new Set(['UNKNOWN', 'HEALTHY', 'DEGRADED'])
/** States in which a provider may receive requests. */
export function isUsableHealth(state: ProviderHealthState): boolean { return USABLE_STATES.has(state) }

export type RequestMetric = { id: string; startedAt: string; provider: string; model: string; durationMs: number; inputTokens: number; outputTokens: number; retries: number; status: 'complete' | 'failed' | 'cancelled'; httpStatus?: number; errorCategory?: ProviderErrorCategory; retryable?: boolean; retryAfterMs?: number; technicalDetails?: string; fallbackDestination?: string }
type LatchedState = 'QUOTA_EXHAUSTED' | 'AUTH_ERROR' | 'UNSUPPORTED'
type ProviderQueue = {
  active: number; queued: number; completed: number; latencyMs: number
  /** Rate-limit cooldown end (ms epoch). */
  cooldownUntil: number
  /** Circuit open until (ms epoch); a passed, non-zero value means half-open (one trial allowed). */
  openUntil: number
  /** Next cooldown length when the circuit (re)opens: 30 s doubling to 5 min. */
  cooldownMs: number
  /** Consecutive breaker-counted failures within the current window. */
  failures: number
  firstFailureAt: number
  latched: LatchedState | null
  observed: boolean
  lastCategory: ProviderErrorCategory | undefined
  changedAt: number
  /** Incremented when the provider is disconnected; requests from an older epoch are refused. */
  epoch: number
}
export type PersistedProviderHealth = Pick<ProviderQueue, 'cooldownUntil' | 'openUntil' | 'cooldownMs' | 'failures' | 'firstFailureAt' | 'latched' | 'observed' | 'changedAt'> & { lastCategory: ProviderErrorCategory | null }
export type HealthListener = (change: { key: string; state: ProviderHealthState; previous: ProviderHealthState; category: ProviderErrorCategory | null }) => void

const BREAKER_THRESHOLD = 3, BREAKER_WINDOW_MS = 60_000, BASE_COOLDOWN_MS = 30_000, MAX_COOLDOWN_MS = 300_000
const BREAKER_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set(['CONNECTION_ERROR', 'PROVIDER_SERVER_ERROR', 'TIMEOUT', 'STREAM_MALFORMED', 'STREAM_INTERRUPTED'])
const freshQueue = (): ProviderQueue => ({ active: 0, queued: 0, completed: 0, latencyMs: 0, cooldownUntil: 0, openUntil: 0, cooldownMs: BASE_COOLDOWN_MS, failures: 0, firstFailureAt: 0, latched: null, observed: false, lastCategory: undefined, changedAt: 0, epoch: 0 })

export class RequestManager {
  private queues = new Map<string, ProviderQueue>()
  private readonly inflight = new Map<string, Set<AbortController>>()
  private healthListener: HealthListener | undefined
  readonly metrics: RequestMetric[] = []
  constructor(private readonly transport: Transport = nativeTransport, private readonly metricSink?: (metric: RequestMetric) => void) {}
  providerKey(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): string { return `${connection.providerId}:${connection.baseUrl}` }
  private stateOf(q: ProviderQueue, now = Date.now()): ProviderHealthState {
    return q.latched ?? (q.cooldownUntil > now ? 'RATE_LIMITED' : q.openUntil > now ? 'OFFLINE' : q.failures ? 'DEGRADED' : q.observed ? 'HEALTHY' : 'UNKNOWN')
  }
  health(keyOrConnection: string | Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>) {
    const key = typeof keyOrConnection === 'string' ? keyOrConnection : this.providerKey(keyOrConnection), q = this.queues.get(key) ?? freshQueue()
    return { ...q, offlineUntil: q.openUntil, state: this.stateOf(q) }
  }
  /** Clears health (used by an explicit retest or reconnect). Keeps the disconnect epoch. */
  resetProvider(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): void {
    const key = this.providerKey(connection), previous = this.queues.get(key)
    this.queues.set(key, { ...freshQueue(), epoch: previous?.epoch ?? 0 })
    if (previous && this.stateOf(previous) !== 'UNKNOWN') this.healthListener?.({ key, state: 'UNKNOWN', previous: this.stateOf(previous), category: null })
  }
  isProviderAvailable(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): boolean { return isUsableHealth(this.health(connection).state) }
  recordFallback(from: ProviderRuntimeConnection, to: ProviderRuntimeConnection): void { const metric = [...this.metrics].reverse().find(item => item.provider === from.providerId && item.model === from.model && item.status === 'failed' && !item.fallbackDestination); if (metric) metric.fallbackDestination = `${to.providerId}/${to.model}` }
  setHealthListener(listener: HealthListener | undefined): void { this.healthListener = listener }

  /** Health snapshot for persistence (no secrets). */
  exportHealth(): Record<string, PersistedProviderHealth> {
    return Object.fromEntries([...this.queues].filter(([, q]) => q.observed || q.latched).map(([key, q]) => [key, {
      cooldownUntil: q.cooldownUntil, openUntil: q.openUntil, cooldownMs: q.cooldownMs, failures: q.failures, firstFailureAt: q.firstFailureAt,
      latched: q.latched, observed: q.observed, changedAt: q.changedAt, lastCategory: q.lastCategory ?? null,
    }]))
  }

  /**
   * Restore persisted health. Latched states (AUTH_ERROR, QUOTA_EXHAUSTED, UNSUPPORTED) survive until
   * retested; other observations older than `maxAgeMs` are dropped, so the provider shows UNKNOWN rather
   * than a stale HEALTHY/OFFLINE after a restart.
   */
  importHealth(records: Record<string, PersistedProviderHealth>, now = Date.now(), maxAgeMs = 15 * 60_000): void {
    for (const [key, record] of Object.entries(records)) {
      if (typeof record !== 'object' || record === null) continue
      const q = freshQueue()
      if (record.latched === 'AUTH_ERROR' || record.latched === 'QUOTA_EXHAUSTED' || record.latched === 'UNSUPPORTED') { q.latched = record.latched; q.observed = true; q.changedAt = record.changedAt; q.lastCategory = record.lastCategory ?? undefined }
      else if (now - record.changedAt <= maxAgeMs) {
        Object.assign(q, { cooldownUntil: record.cooldownUntil > now ? record.cooldownUntil : 0, openUntil: record.openUntil, cooldownMs: record.cooldownMs || BASE_COOLDOWN_MS, failures: record.failures, firstFailureAt: record.firstFailureAt, observed: record.observed, changedAt: record.changedAt, lastCategory: record.lastCategory ?? undefined })
      } else continue
      this.queues.set(key, q)
    }
  }

  /**
   * Refuse and abort every request to this provider (it was disconnected). In-flight attempts fail with
   * PROVIDER_DISCONNECTED, which the router treats as "fall back", not as a model or provider fault.
   */
  abortProvider(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): void {
    const key = this.providerKey(connection), q = this.queues.get(key) ?? freshQueue()
    q.epoch++; this.queues.set(key, q)
    for (const controller of this.inflight.get(key) ?? []) controller.abort(disconnected(connection))
  }

  private queue(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): ProviderQueue { const key = this.providerKey(connection), queue = this.queues.get(key) ?? freshQueue(); this.queues.set(key, queue); return queue }
  private circuitFailure(connection: ProviderRuntimeConnection): ProviderFailure | null {
    const health = this.health(connection)
    if (health.state === 'QUOTA_EXHAUSTED') return new ProviderFailure('The provider account quota or credits are exhausted.', 'quota-exhausted', false, 429, 0, undefined, 'QUOTA_EXHAUSTED', 'Circuit breaker: quota exhaustion is latched until the provider is retested.', connection)
    if (health.state === 'AUTH_ERROR') return new ProviderFailure('The provider rejected this credential. Update the API key and test the connection.', 'authentication', false, 401, 0, undefined, 'AUTH_ERROR', 'Circuit breaker: the credential was rejected; latched until the provider is retested.', connection)
    if (health.state === 'UNSUPPORTED') return new ProviderFailure('This address does not provide a compatible model API. Check the provider base URL.', 'invalid-request', false, 404, 0, undefined, 'ENDPOINT_NOT_FOUND', 'Circuit breaker: the endpoint did not expose the API; latched until the provider is retested.', connection)
    if (health.state === 'RATE_LIMITED') return new ProviderFailure('The provider is temporarily rate limited.', 'rate-limit', false, 429, Math.max(0, health.cooldownUntil - Date.now()), undefined, 'RATE_LIMITED', 'Circuit breaker cooldown is active.', connection)
    if (health.state === 'OFFLINE') return new ProviderFailure('The provider is temporarily offline.', 'network', false, 0, Math.max(0, health.openUntil - Date.now()), undefined, 'CONNECTION_ERROR', 'Circuit breaker is open after repeated failures.', connection)
    return null
  }
  private updateCircuit(connection: ProviderRuntimeConnection, failure?: ProviderFailure): void {
    if (failure && (failure.category === 'PROVIDER_DISCONNECTED' || failure.category === 'CANCELLED')) return
    const key = this.providerKey(connection), queue = this.queue(connection), now = Date.now(), previous = this.stateOf(queue, now)
    queue.observed = true; queue.changedAt = now
    if (!failure) {
      Object.assign(queue, { failures: 0, firstFailureAt: 0, cooldownUntil: 0, openUntil: 0, cooldownMs: BASE_COOLDOWN_MS, latched: null, lastCategory: undefined })
      queue.completed++
    } else {
      queue.lastCategory = failure.category
      if (failure.category === 'QUOTA_EXHAUSTED') queue.latched = 'QUOTA_EXHAUSTED'
      else if (failure.category === 'INVALID_API_KEY' || failure.category === 'AUTH_ERROR') queue.latched = 'AUTH_ERROR'
      else if (failure.category === 'ENDPOINT_NOT_FOUND') queue.latched = 'UNSUPPORTED'
      else if (failure.category === 'RATE_LIMITED') queue.cooldownUntil = now + Math.max(1000, failure.retryAfterMs || 30_000)
      else if (BREAKER_CATEGORIES.has(failure.category)) {
        const halfOpenTrial = queue.openUntil > 0 && queue.openUntil <= now
        if (!halfOpenTrial && (!queue.failures || now - queue.firstFailureAt > BREAKER_WINDOW_MS)) { queue.failures = 0; queue.firstFailureAt = now }
        queue.failures++
        if (halfOpenTrial || queue.failures >= BREAKER_THRESHOLD) { queue.openUntil = now + queue.cooldownMs; queue.cooldownMs = Math.min(queue.cooldownMs * 2, MAX_COOLDOWN_MS) }
      }
      // Model-level failures (missing model, bad request, tool/context limits) do not change provider health.
    }
    const state = this.stateOf(queue, now)
    if (state !== previous) this.healthListener?.({ key, state, previous, category: failure?.category ?? null })
  }
  private async acquire(connection: ProviderRuntimeConnection, policy: RequestPolicy, signal: AbortSignal, epoch: number): Promise<() => void> {
    const blocked = this.circuitFailure(connection); if (blocked) throw blocked
    const queue = this.queue(connection); queue.queued++
    try {
      while (queue.active >= (queue.failures ? 1 : policy.concurrency)) await abortableDelay(50, signal)
      signal.throwIfAborted()
      if (queue.epoch !== epoch) throw disconnected(connection)
      const afterWait = this.circuitFailure(connection); if (afterWait) throw afterWait
      queue.active++; return () => { queue.active-- }
    }
    finally { queue.queued-- }
  }
  async execute<T>({ connection, messages, tools = [], signal, stream, consume, onStatus, overrides = {}, bodyExtras = {}, requestHeaders = {}, buildBody, endpointUrl }: { connection: ProviderRuntimeConnection; messages: ProviderMessage[]; tools?: readonly unknown[]; signal: AbortSignal; stream: boolean; consume: (response: Response, touch: () => void, progress: (tokens: number) => void) => Promise<T>; onStatus?: (message: string) => void; overrides?: Partial<RequestPolicy>; bodyExtras?: Record<string, unknown>; requestHeaders?: Record<string, string>; buildBody?: (input: { messages: ProviderMessage[]; tools: readonly unknown[]; stream: boolean; maxOutput: number }) => Record<string, unknown>; endpointUrl?: string }): Promise<T> {
    const key = this.providerKey(connection), epoch = this.queue(connection).epoch
    const policy = effectivePolicy(connection, overrides), root = new AbortController(), parentAbort = () => root.abort(signal.reason)
    signal.addEventListener('abort', parentAbort, { once: true }); if (signal.aborted) parentAbort()
    const overall = setTimeout(() => root.abort(new ProviderFailure('Provider overall request deadline exceeded.', 'timeout', true, 0, 0, undefined, 'TIMEOUT', 'Overall deadline exceeded.', connection)), policy.overallMs)
    const started = Date.now(), startedAt = new Date(started).toISOString(), requestId = crypto.randomUUID()
    let attempts = 0, recovery = 0, budget = policy.inputTokens, outputBudget = policy.outputTokens, outputTokens = 0, inputTokens = 0, delivered = false, finalFailure: ProviderFailure | undefined
    const metric = (status: RequestMetric['status'], failure?: ProviderFailure) => { const entry: RequestMetric = { id: requestId, startedAt, provider: connection.providerId, model: connection.model, durationMs: Date.now() - started, inputTokens, outputTokens, retries: Math.max(0, attempts - 1), status, ...(failure?.status ? { httpStatus: failure.status } : {}), ...(failure ? { errorCategory: failure.category, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs, technicalDetails: failure.technicalDetails } : {}) }; this.metrics.push(entry); if (this.metrics.length > 500) this.metrics.shift(); this.metricSink?.(entry) }
    try {
      for (attempts = 1; attempts <= policy.maxAttempts; attempts++) {
        root.signal.throwIfAborted()
        const safeMessages = connection.apiKey ? JSON.parse(JSON.stringify(messages).replaceAll(JSON.stringify(connection.apiKey).slice(1, -1), '[REDACTED]')) as ProviderMessage[] : messages
        const context = budgetContext(safeMessages, tools, budget, recovery); inputTokens = context.estimatedTokens
        const release = await this.acquire(connection, policy, root.signal, epoch), attempt = new AbortController(), abort = () => attempt.abort(root.signal.reason)
        root.signal.addEventListener('abort', abort, { once: true }); if (root.signal.aborted) abort()
        const inflight = this.inflight.get(key) ?? new Set<AbortController>(); inflight.add(attempt); this.inflight.set(key, inflight)
        let timer = setTimeout(() => attempt.abort(new ProviderFailure('Provider first-token deadline exceeded.', 'timeout', true, 0, 0, undefined, 'TIMEOUT', 'First-token deadline exceeded.', connection)), policy.firstTokenMs)
        const touch = () => { clearTimeout(timer); timer = setTimeout(() => attempt.abort(new ProviderFailure('Provider stream became idle.', 'timeout', true, 0, 0, undefined, 'TIMEOUT', 'Stream idle deadline exceeded.', connection)), policy.idleMs) }
        let failure: ProviderFailure | undefined
        try {
          const maxOutput = Math.min(outputBudget, Math.max(64, Math.floor(budget / 2)))
          const payload = buildBody ? buildBody({ messages: context.messages, tools, stream, maxOutput }) : { model: connection.model, stream, messages: context.messages, max_tokens: maxOutput, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }
          const response = await this.transport(endpointUrl ?? `${connection.baseUrl}/chat/completions`, { method: 'POST', signal: attempt.signal, headers: { ...requestHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, ...bodyExtras }) }, policy.connectionMs)
          if (!response.ok) { const body = (await response.text()).slice(0, 8000); throw classifyFailure(response.status, body, response.headers.get('retry-after'), { provider: connection.providerId, model: connection.model, apiKey: connection.apiKey }) }
          const result = await consume(response, touch, tokens => { delivered = true; outputTokens += tokens })
          const queue = this.queue(connection); queue.latencyMs = Date.now() - started; this.updateCircuit(connection); metric('complete'); return result
        } catch (error) {
          if (root.signal.aborted) throw root.signal.reason
          failure = attempt.signal.reason instanceof ProviderFailure ? attempt.signal.reason : error instanceof ProviderFailure ? error : new ProviderFailure('ALTREX could not connect to the provider.', 'network', true, 0, 0, undefined, 'CONNECTION_ERROR', error instanceof Error ? error.message.slice(0, 1200) : 'Network transport failed.', connection)
          finalFailure = failure; this.updateCircuit(connection, failure)
        } finally { clearTimeout(timer); root.signal.removeEventListener('abort', abort); inflight.delete(attempt); release() }
        if (!failure || delivered || attempts === policy.maxAttempts) throw failure ?? new Error('Request failed')
        const retryRateLimit = failure.category === 'RATE_LIMITED' && failure.retryAfterMs <= 30_000, retryTransient = failure.category === 'TIMEOUT' || failure.category === 'CONNECTION_ERROR' || failure.category === 'PROVIDER_SERVER_ERROR' || failure.category === 'STREAM_MALFORMED' || failure.category === 'STREAM_INTERRUPTED'
        if (failure.category === 'CONTEXT_TOO_LARGE') {
          recovery++; outputBudget = Math.max(64, Math.floor(outputBudget * .65)); const limitBudget = failure.tokenLimit ? Math.floor(failure.tokenLimit * .7) - outputBudget : budget; budget = Math.floor(Math.min(budget * .65, limitBudget))
          if (budget < 1024) throw new ProviderFailure('Provider token limit is too small for the required task and tools.', 'too-large', false, failure.status, 0, failure.tokenLimit, 'CONTEXT_TOO_LARGE', failure.technicalDetails, connection)
          onStatus?.(`Request was too large; retrying once with ${budget} estimated input tokens.`); continue
        }
        if (!retryRateLimit && !retryTransient) { onStatus?.(`${failure.message} Falling back without another identical request.`); throw failure }
        const wait = failure.category === 'RATE_LIMITED' ? Math.max(1000, failure.retryAfterMs) : Math.max(failure.retryAfterMs, 1000 + Math.floor(Math.random() * 250))
        onStatus?.(`${failure.message} Waiting once before fallback.`); await abortableDelay(wait, root.signal)
        if (failure.category === 'RATE_LIMITED') this.queue(connection).cooldownUntil = 0
        else if (!this.isProviderAvailable(connection)) throw failure
      }
      throw finalFailure ?? new Error('Provider attempt limit reached.')
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof ProviderFailure && error.category === 'CANCELLED'), failure = error instanceof ProviderFailure ? error : cancelled ? new ProviderFailure('Provider request was cancelled.', 'cancelled', false, 0, 0, undefined, 'CANCELLED') : finalFailure
      metric(cancelled ? 'cancelled' : 'failed', failure); throw error
    } finally { clearTimeout(overall); signal.removeEventListener('abort', parentAbort) }
  }
}
export { estimateTokens }
