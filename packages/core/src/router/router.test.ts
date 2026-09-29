import { describe, expect, it } from 'vitest'
import { classifyDifficulty, nameTier, route, type RouteCandidate, type RoutingRequest } from './router'

const candidate = (providerId: string, model: string, overrides: Partial<RouteCandidate> = {}): RouteCandidate => ({
  key: `${providerId}:https://${providerId}.test/v1:${model}`, providerId, baseUrl: `https://${providerId}.test/v1`, model,
  privacy: providerId === 'ollama' ? 'local' : 'cloud', providerHealth: 'UNKNOWN', available: null, modelHealth: 'UNKNOWN',
  capabilities: { chat: null, streaming: null, tools: null, vision: null, structuredOutput: null, reasoning: null, contextWindow: null },
  free: null, consent: true, ...overrides,
})
const request = (overrides: Partial<RoutingRequest> = {}): RoutingRequest => ({ role: 'Coder', mode: 'AUTO', requires: { chat: true, tools: true }, difficulty: 'standard', carriesRepositoryData: true, ...overrides })

describe('router hard filters', () => {
  const pool = [
    candidate('openrouter', 'paid-large-70b', { free: false }),
    candidate('openrouter', 'coder:free', { free: true }),
    candidate('ollama', 'qwen-coder-7b'),
    candidate('groq', 'down-model', { providerHealth: 'AUTH_ERROR' }),
    candidate('nvidia', 'no-tools', { capabilities: { chat: true, streaming: true, tools: false, vision: false, structuredOutput: null, reasoning: null, contextWindow: 8000 } }),
    candidate('custom', 'retired', { available: false }),
  ]

  it('LOCAL ONLY never returns a cloud endpoint', () => {
    const decision = route(request({ mode: 'LOCAL_ONLY' }), pool)
    expect(decision.ordered.map(item => item.candidate.providerId)).toEqual(['ollama'])
    expect(decision.rejected.filter(item => item.reason === 'not_local').length).toBeGreaterThan(0)
  })

  it('FREE ONLY admits only known-free or local endpoints (unknown price is not free)', () => {
    const models = route(request({ mode: 'FREE_ONLY' }), [...pool, candidate('groq', 'price-unknown')]).ordered.map(item => item.candidate.model)
    expect(models.sort()).toEqual(['coder:free', 'qwen-coder-7b'])
  })

  it('rejects unhealthy providers, unavailable models and missing capabilities with reasons', () => {
    const decision = route(request(), pool)
    expect(decision.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: pool[3]!.key, reason: 'provider_unavailable', detail: 'groq is AUTH_ERROR' }),
      expect.objectContaining({ key: pool[4]!.key, reason: 'missing_capability', detail: 'tools unsupported' }),
      expect.objectContaining({ key: pool[5]!.key, reason: 'model_unavailable' }),
    ]))
  })

  it('can require confirmed capabilities, context size, and repository-data consent', () => {
    expect(route(request({ allowUnknownCapabilities: false }), pool).primary).toBeNull()
    const small = candidate('groq', 'tiny', { capabilities: { chat: true, streaming: true, tools: true, vision: null, structuredOutput: null, reasoning: null, contextWindow: 4096 } })
    expect(route(request({ requires: { chat: true, minContext: 32000 } }), [small]).rejected[0]).toMatchObject({ reason: 'context_too_small' })
    expect(route(request(), [candidate('openrouter', 'm', { consent: false })]).rejected[0]).toMatchObject({ reason: 'no_repository_consent' })
    expect(route(request({ carriesRepositoryData: false }), [candidate('openrouter', 'm', { consent: false })]).primary).not.toBeNull()
  })

  it('CUSTOM mode uses only the pinned endpoint', () => {
    const decision = route(request({ mode: 'CUSTOM', pinned: pool[0]!.key }), pool)
    expect(decision.ordered.map(item => item.candidate.key)).toEqual([pool[0]!.key])
  })

  it('never routes to excluded endpoints or providers', () => {
    const decision = route(request({ exclude: [pool[0]!.key], excludeProviders: ['ollama'] }), pool)
    expect(decision.ordered.map(item => item.candidate.model)).toEqual(['coder:free'])
  })
})

describe('router scoring', () => {
  it('prefers measured role success over name heuristics', () => {
    const proven = candidate('groq', 'plain-model', { roleStats: { accepted: 9, failed: 1, durationMs: 50_000 } })
    const hyped = candidate('openrouter', 'super-coder-480b')
    expect(route(request(), [hyped, proven]).primary?.model).toBe('plain-model')
  })

  it('FAST prefers small models, POWERFUL large ones', () => {
    const pool = [candidate('a', 'model-8b'), candidate('b', 'model-70b'), candidate('c', 'model-405b')]
    expect(route(request({ mode: 'FAST' }), pool).primary?.model).toBe('model-8b')
    expect(route(request({ mode: 'POWERFUL' }), pool).primary?.model).toBe('model-405b')
  })

  it('AUTO uses a local model for trivial tasks and a larger one for hard tasks', () => {
    const pool = [candidate('ollama', 'coder-7b'), candidate('openrouter', 'coder-480b')]
    expect(route(request({ difficulty: 'trivial' }), pool).primary?.providerId).toBe('ollama')
    expect(route(request({ difficulty: 'hard' }), pool).primary?.providerId).toBe('openrouter')
  })

  it('penalizes load and filters obvious non-chat models unless chat was observed', () => {
    const busy = candidate('groq', 'coder-a', { load: 3 })
    const idle = candidate('nvidia', 'coder-b')
    const embed = candidate('openrouter', 'text-embedding-large')
    const decision = route(request(), [busy, idle, embed])
    expect(decision.ordered.map(item => item.candidate.model)).toEqual(['coder-b', 'coder-a'])
    expect(decision.rejected).toContainEqual(expect.objectContaining({ key: embed.key, reason: 'not_a_chat_model' }))
    const provenChat = { ...embed, capabilities: { ...embed.capabilities, chat: true } }
    expect(route(request(), [provenChat]).primary?.model).toBe('text-embedding-large')
  })

  it('orders fallbacks provider-diverse so one outage does not exhaust the chain', () => {
    const pool = [candidate('groq', 'g1'), candidate('groq', 'g2'), candidate('groq', 'g3'), candidate('nvidia', 'n1'), candidate('openrouter', 'o1')]
    const decision = route(request(), pool)
    expect(decision.ordered.slice(0, 3).map(item => item.candidate.providerId)).toEqual(['groq', 'nvidia', 'openrouter'])
    expect(decision.fallbacks).toHaveLength(3)
  })

  it('prefers a different endpoint for independent review', () => {
    const coder = candidate('groq', 'coder')
    const other = candidate('nvidia', 'other')
    expect(route(request({ role: 'Reviewer', preferDifferentFrom: coder.key }), [coder, other]).primary?.key).toBe(other.key)
  })

  it('is deterministic and keeps input order on exact ties', () => {
    const pool = [candidate('a', 'm'), candidate('b', 'm'), candidate('c', 'm')]
    const first = route(request(), pool), second = route(request(), pool)
    expect(first).toEqual(second)
    expect(first.ordered.map(item => item.candidate.providerId)).toEqual(['a', 'b', 'c'])
  })

  it('explains the decision in plain reasons', () => {
    const decision = route(request(), [candidate('groq', 'x', { providerHealth: 'OFFLINE' }), candidate('nvidia', 'y')])
    expect(decision.reasons[0]).toBe('AUTO: nvidia / y selected for Coder (standard task)')
    expect(decision.reasons).toContain('1 candidate rejected: provider unavailable')
  })
})

describe('router heuristics (labelled priors only)', () => {
  it.each([
    ['qwen2.5-coder:7b-instruct', 'small'], ['llama-3.3-70b', 'medium'], ['qwen3-coder-480b-a35b', 'large'],
    ['gemini-flash-lite', 'small'], ['nemotron-ultra', 'large'], ['mystery-model', null],
  ] as const)('%s → %s', (model, tier) => { expect(nameTier(model)).toBe(tier) })

  it('classifies difficulty from task text until the Planner supplies it', () => {
    expect(classifyDifficulty('Fix the race condition in the job scheduler')).toBe('hard')
    expect(classifyDifficulty('Fix a typo in the README')).toBe('trivial')
    expect(classifyDifficulty('Add a settings page')).toBe('standard')
  })
})
