import type { ProviderHealthState } from '../gateway/request-executor'

// Pure, deterministic model router (PROVIDER_SPEC.md §8). No I/O: callers pass a snapshot of what is
// known (registry, health, catalogs) and get back an ordered decision with reasons. The same inputs
// always produce the same decision, so routing is unit-testable and explainable in the UI.

export type RoutingMode = 'AUTO' | 'FAST' | 'POWERFUL' | 'FREE_ONLY' | 'LOCAL_ONLY' | 'CUSTOM'
export const ROUTING_MODES: readonly RoutingMode[] = ['AUTO', 'FAST', 'POWERFUL', 'FREE_ONLY', 'LOCAL_ONLY', 'CUSTOM']
export type Difficulty = 'trivial' | 'standard' | 'hard'
type Tri = boolean | null

export type RouteCandidate = {
  /** Stable endpoint key: `${providerId}:${baseUrl}:${model}`. */
  key: string
  providerId: string
  baseUrl: string
  model: string
  privacy: 'local' | 'cloud'
  providerHealth: ProviderHealthState
  /** false = known missing/retired; null = unknown. */
  available: Tri
  modelHealth: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'INCOMPATIBLE'
  capabilities: { chat: Tri; streaming: Tri; tools: Tri; vision: Tri; structuredOutput: Tri; reasoning: Tri; contextWindow: number | null }
  free: Tri
  /** Accepted/failed outcomes for the requested role (measured, not guessed). */
  roleStats?: { accepted: number; failed: number; durationMs: number } | undefined
  /** Requests in flight or queued at this provider. */
  load?: number
  /** Cloud endpoints may receive repository content only with consent. */
  consent?: boolean
}

export type RoutingRequirements = { chat?: boolean; tools?: boolean; vision?: boolean; streaming?: boolean; structuredOutput?: boolean; minContext?: number }

export type RoutingRequest = {
  role: string
  mode: RoutingMode
  requires: RoutingRequirements
  difficulty: Difficulty
  carriesRepositoryData: boolean
  /** Endpoint keys already tried (and failed) in this chain. */
  exclude?: readonly string[]
  /** Providers removed from routing for this task (e.g. disconnected). */
  excludeProviders?: readonly string[]
  /** CUSTOM mode: the only endpoint allowed. */
  pinned?: string
  /** Prefer a different endpoint (reviewer independence). */
  preferDifferentFrom?: string
  /** Allow candidates whose required capability is unknown (a probe can confirm it). Default true. */
  allowUnknownCapabilities?: boolean
  /** Optional task text for the weak name prior when nothing measured is known. */
  taskText?: string
}

export type RejectReason =
  | 'excluded' | 'provider_excluded' | 'not_pinned' | 'provider_unavailable' | 'model_unavailable'
  | 'missing_capability' | 'context_too_small' | 'not_local' | 'not_free' | 'no_repository_consent' | 'not_a_chat_model'

export type ScoredCandidate = { candidate: RouteCandidate; score: number; why: string[] }

export type RoutingDecision = {
  mode: RoutingMode
  primary: RouteCandidate | null
  fallbacks: RouteCandidate[]
  /** Every eligible candidate in decision order (primary first, provider-diverse). */
  ordered: ScoredCandidate[]
  /** Human-readable explanation of the primary choice and the filters applied. */
  reasons: string[]
  rejected: Array<{ key: string; reason: RejectReason; detail: string }>
}

const USABLE_PROVIDER: ReadonlySet<ProviderHealthState> = new Set(['UNKNOWN', 'HEALTHY', 'DEGRADED'])

/** Weak prior from the model name (size/role hints). Used only as a tiebreaker; always labelled. */
export function nameTier(model: string): 'small' | 'medium' | 'large' | null {
  const id = model.toLowerCase()
  const params = /(?:^|[^\d.])(\d{1,4}(?:\.\d)?)b(?:\b|-|$)/.exec(id)?.[1]
  if (params) { const size = Number(params); return size <= 14 ? 'small' : size < 100 ? 'medium' : 'large' }
  if (/\b(nano|mini|lite|tiny|small|haiku|instant|flash-lite)\b|-(?:mini|nano|lite)\b/.test(id)) return 'small'
  if (/\b(ultra|opus|large|max|pro)\b|-(?:ultra|large|max|pro)\b/.test(id)) return 'large'
  if (/\b(flash|medium|sonnet|turbo)\b/.test(id)) return 'medium'
  return null
}

function codingPrior(model: string): number {
  const id = model.toLowerCase()
  let score = 0
  if (/coder|coding|\bcode\b|codestral|devstral/.test(id)) score += 6
  if (/\b(instruct|chat|tools?|agent)\b/.test(id)) score += 2
  return score
}

/** Heuristic difficulty until the Planner provides one (Phase 7). */
export function classifyDifficulty(text: string): Difficulty {
  if (/\b(debug|root cause|security|vulnerab|architecture|architect|migration|concurren|race condition|memory leak|performance|optimi[sz]|distributed|refactor|redesign|rewrite)\b/i.test(text)) return 'hard'
  if (text.length < 240 && /\b(rename|typo|comment|readme|format|lint|small|simple|one line|single line)\b/i.test(text)) return 'trivial'
  return 'standard'
}

const NON_CHAT_MODEL = /\b(whisper|speech|audio|tts|embed|embedding|embeddings|guard|moderation|rerank|reranker|image-gen|dall-e|stable-diffusion)\b/i

function reject(candidate: RouteCandidate, request: RoutingRequest): { reason: RejectReason; detail: string } | null {
  const { requires } = request, unknownOk = request.allowUnknownCapabilities !== false
  if (request.exclude?.includes(candidate.key)) return { reason: 'excluded', detail: 'already tried in this chain' }
  if (request.excludeProviders?.includes(candidate.providerId)) return { reason: 'provider_excluded', detail: `${candidate.providerId} removed from routing` }
  if (request.mode === 'CUSTOM' && request.pinned !== undefined && candidate.key !== request.pinned) return { reason: 'not_pinned', detail: 'CUSTOM mode uses only the selected model' }
  if (!USABLE_PROVIDER.has(candidate.providerHealth)) return { reason: 'provider_unavailable', detail: `${candidate.providerId} is ${candidate.providerHealth}` }
  // Name heuristic, overridden by observed chat support.
  if (candidate.capabilities.chat !== true && NON_CHAT_MODEL.test(candidate.model)) return { reason: 'not_a_chat_model', detail: `${candidate.model} looks like a non-chat model (name heuristic)` }
  if (candidate.available === false || candidate.modelHealth === 'UNAVAILABLE') return { reason: 'model_unavailable', detail: `${candidate.model} is unavailable` }
  const checks: Array<[keyof RoutingRequirements, Tri]> = [['chat', candidate.capabilities.chat], ['tools', candidate.capabilities.tools], ['vision', candidate.capabilities.vision], ['streaming', candidate.capabilities.streaming], ['structuredOutput', candidate.capabilities.structuredOutput]]
  for (const [name, actual] of checks) if (requires[name] && (actual === false || (actual === null && !unknownOk))) return { reason: 'missing_capability', detail: `${name} ${actual === false ? 'unsupported' : 'unknown'}` }
  if (requires.minContext && candidate.capabilities.contextWindow !== null && candidate.capabilities.contextWindow < requires.minContext) return { reason: 'context_too_small', detail: `${candidate.capabilities.contextWindow} < ${requires.minContext} tokens` }
  if (request.mode === 'LOCAL_ONLY' && candidate.privacy !== 'local') return { reason: 'not_local', detail: 'LOCAL ONLY excludes cloud endpoints' }
  if (request.mode === 'FREE_ONLY' && candidate.privacy !== 'local' && candidate.free !== true) return { reason: 'not_free', detail: candidate.free === false ? 'paid model' : 'price unknown' }
  if (request.carriesRepositoryData && candidate.privacy === 'cloud' && candidate.consent === false) return { reason: 'no_repository_consent', detail: 'repository data not permitted for this provider' }
  return null
}

function score(candidate: RouteCandidate, request: RoutingRequest): ScoredCandidate {
  const why: string[] = []
  let total = 0
  const stats = candidate.roleStats
  const success = stats && stats.accepted + stats.failed > 0 ? (stats.accepted + 1) / (stats.accepted + stats.failed + 2) : 0.5
  total += success * 100
  if (stats && stats.accepted + stats.failed > 0) why.push(`${stats.accepted}/${stats.accepted + stats.failed} successful ${request.role} runs`)
  const load = candidate.load ?? 0
  total -= load * 25
  if (candidate.providerHealth === 'DEGRADED' || candidate.modelHealth === 'DEGRADED') { total -= 20; why.push('recently degraded') }
  if (candidate.providerHealth === 'HEALTHY') total += 4
  // Known capabilities beat unknown ones (fewer probes, fewer surprises).
  for (const [name, required] of Object.entries(request.requires) as Array<[keyof RoutingRequirements, unknown]>) {
    if (!required || name === 'minContext' || name === 'chat') continue
    if (candidate.capabilities[name as 'tools'] === true) { total += 8; why.push(`${name} confirmed`) }
  }
  const tier = nameTier(candidate.model)
  const context = candidate.capabilities.contextWindow
  const averageMs = stats && stats.accepted ? stats.durationMs / Math.max(1, stats.accepted + stats.failed) : null
  switch (request.mode) {
    case 'FAST':
      total += tier === 'small' ? 25 : tier === 'medium' ? 10 : tier === 'large' ? -20 : 0
      if (candidate.privacy === 'local') total += 5
      if (averageMs !== null) total += Math.max(-20, 20 - averageMs / 3000)
      if (tier) why.push(`${tier} model (name heuristic) preferred for speed`)
      break
    case 'POWERFUL':
      total += tier === 'large' ? 30 : tier === 'medium' ? 8 : tier === 'small' ? -30 : 0
      if (context) total += Math.min(15, context / 20_000)
      if (candidate.capabilities.reasoning === true) total += 6
      if (tier) why.push(`${tier} model (name heuristic) preferred for capability`)
      break
    default: {
      const fit = request.difficulty === 'hard' ? { small: -15, medium: 5, large: 15 } : request.difficulty === 'trivial' ? { small: 12, medium: 6, large: -5 } : { small: -3, medium: 6, large: 4 }
      if (tier) total += fit[tier]
      if (request.difficulty === 'trivial' && candidate.privacy === 'local') { total += 10; why.push('local model is sufficient for a trivial task') }
    }
  }
  if (request.mode === 'FREE_ONLY' && candidate.free === true) why.push('free')
  if (request.mode === 'LOCAL_ONLY') why.push('local')
  total += codingPrior(candidate.model)
  if (request.preferDifferentFrom) {
    if (candidate.key === request.preferDifferentFrom) { total -= 40; why.push('same endpoint as the work under review') }
    else if (candidate.key.split(':')[0] === request.preferDifferentFrom.split(':')[0]) total -= 12
    else why.push('independent provider')
  }
  return { candidate, score: total, why }
}

/** Route one role call. Pure: identical inputs give identical decisions. */
export function route(request: RoutingRequest, candidates: readonly RouteCandidate[], options: { maxFallbacks?: number } = {}): RoutingDecision {
  const rejected: RoutingDecision['rejected'] = []
  const eligible: Array<ScoredCandidate & { index: number }> = []
  candidates.forEach((candidate, index) => {
    const refusal = reject(candidate, request)
    if (refusal) rejected.push({ key: candidate.key, ...refusal })
    else eligible.push({ ...score(candidate, request), index })
  })
  eligible.sort((a, b) => b.score - a.score || a.index - b.index)
  // Provider-diverse order: after the primary, take the best of each other provider before repeats,
  // so one provider outage does not consume the whole fallback chain.
  const ordered: ScoredCandidate[] = []
  const remaining = [...eligible]
  const first = remaining.shift()
  if (first) ordered.push(first)
  while (remaining.length) {
    const used = new Set(ordered.map(item => `${item.candidate.providerId}:${item.candidate.baseUrl}`))
    const fresh = remaining.findIndex(item => !used.has(`${item.candidate.providerId}:${item.candidate.baseUrl}`))
    ordered.push(remaining.splice(fresh >= 0 ? fresh : 0, 1)[0]!)
    if (fresh < 0) { ordered.push(...remaining.splice(0)); break }
  }
  const primary = ordered[0]?.candidate ?? null
  const reasons: string[] = []
  if (primary) {
    reasons.push(`${request.mode}: ${primary.providerId} / ${primary.model} selected for ${request.role} (${request.difficulty} task)`)
    reasons.push(...(ordered[0]!.why.length ? ordered[0]!.why : ['no measured history yet; neutral prior']))
  } else reasons.push(`${request.mode}: no eligible model for ${request.role}`)
  const counts = new Map<RejectReason, number>()
  for (const item of rejected) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1)
  for (const [reason, count] of counts) reasons.push(`${count} candidate${count === 1 ? '' : 's'} rejected: ${reason.replaceAll('_', ' ')}`)
  return { mode: request.mode, primary, fallbacks: ordered.slice(1, 1 + (options.maxFallbacks ?? 3)).map(item => item.candidate), ordered, reasons, rejected }
}
