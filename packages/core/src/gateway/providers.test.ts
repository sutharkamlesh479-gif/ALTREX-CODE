import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reply, startFakeOpenAiServer } from '../testing/fake-openai-server'
import { parseModelCatalog } from './adapters/openai-compatible'
import { providerAdapter } from './adapters/openai-dialects'
import { ModelGateway } from './gateway'
import { RequestManager, type HealthListener, type Transport } from './request-executor'
import type { EndpointConnection } from './connection'

// Phase 3 provider infrastructure: catalog metadata, provider health model, circuit breaker,
// health persistence, precise disconnect, credential validation.

describe('catalog metadata', () => {
  it('reads OpenRouter context, output limit, tools, vision, structured output and free pricing', () => {
    expect(parseModelCatalog('openrouter', { data: [
      { id: 'vendor/coder:free', name: 'Coder (free)', context_length: 262144, top_provider: { max_completion_tokens: 32768 }, supported_parameters: ['tools', 'tool_choice', 'response_format'], architecture: { input_modalities: ['text', 'image'] }, pricing: { prompt: '0', completion: '0' } },
      { id: 'vendor/big', context_length: 128000, supported_parameters: ['temperature'], architecture: { input_modalities: ['text'] }, pricing: { prompt: '0.000003', completion: '0.000015' } },
    ] })).toEqual([
      { id: 'vendor/big', contextWindow: 128000, supportsTools: false, supportsStructuredOutput: false, supportsReasoning: false, supportsVision: false, free: false },
      { id: 'vendor/coder:free', displayName: 'Coder (free)', contextWindow: 262144, maxOutput: 32768, supportsTools: true, supportsStructuredOutput: true, supportsReasoning: false, supportsVision: true, free: true },
    ])
  })

  it('reads Groq context windows and drops inactive models; plain catalogs stay unknown', () => {
    expect(parseModelCatalog('groq', { data: [{ id: 'a', context_window: 131072, max_completion_tokens: 8192 }, { id: 'b', active: false }] })).toEqual([{ id: 'a', contextWindow: 131072, maxOutput: 8192 }])
    expect(parseModelCatalog('nvidia', { data: [{ id: 'x' }] })).toEqual([{ id: 'x' }])
    expect(parseModelCatalog('custom', { data: [{ id: 'vllm-model', max_model_len: 32768 }] })).toEqual([{ id: 'vllm-model', contextWindow: 32768 }])
  })

  it('enriches Ollama models from /api/show (tools, vision, context)', async () => {
    const server = await startFakeOpenAiServer({
      models: [{ id: 'qwen-tools' }, { id: 'plain' }],
      routes: {
        'POST /api/show': (request, response) => {
          const model = (request.json as { model: string }).model
          reply.json(model === 'qwen-tools' ? { capabilities: ['completion', 'tools', 'vision'], model_info: { 'qwen2.context_length': 32768 } } : { capabilities: ['completion'] })(request, response)
        },
      },
    })
    try {
      expect(await new ModelGateway().listModels({ providerId: 'ollama', baseUrl: server.baseUrl, model: 'x', apiKey: '' })).toEqual([
        { id: 'plain', supportsTools: false, supportsVision: false },
        { id: 'qwen-tools', supportsTools: true, supportsVision: true, contextWindow: 32768 },
      ])
    } finally { await server.close() }
  })

  it('treats a base URL without the API as ENDPOINT_NOT_FOUND (not "model unavailable")', async () => {
    const server = await startFakeOpenAiServer({ modelsStatus: 404 })
    try {
      const result = await new ModelGateway().validateCredentials({ providerId: 'custom', baseUrl: server.baseUrl, model: 'x', apiKey: '' })
      expect(result).toMatchObject({ ok: false, category: 'ENDPOINT_NOT_FOUND' })
    } finally { await server.close() }
  })

  it('sends OpenRouter attribution headers and uses the NIM dialect for self-hosted NIM', () => {
    expect(providerAdapter('openrouter').headers('k')).toEqual({ Authorization: 'Bearer k', 'X-Title': 'ALTREX CODE' })
    expect(providerAdapter('nim-local').build({ model: 'nvidia/nemotron-3-ultra-x', messages: [], tools: [], stream: true, maxOutput: 10 })).toHaveProperty('chat_template_kwargs')
    expect(providerAdapter('unknown-provider').headers('k')).toEqual({ Authorization: 'Bearer k' })
  })
})

describe('provider health and circuit breaker', () => {
  const connection: EndpointConnection = { providerId: 'groq', baseUrl: 'https://groq.invalid/v1', model: 'm', apiKey: 'gsk_secret_value_123', requestPolicy: { maxAttempts: 1 } }
  const respond = (...statuses: number[]) => vi.fn<Transport>(async () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: statuses.shift() ?? 200 }))
  const run = (manager: RequestManager) => manager.execute({ connection, messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, stream: false, consume: response => response.text() }).catch((error: unknown) => error)
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts UNKNOWN (never assumed healthy) and becomes HEALTHY only after real success', async () => {
    const manager = new RequestManager(respond(200))
    expect(manager.health(connection).state).toBe('UNKNOWN')
    expect(manager.isProviderAvailable(connection)).toBe(true)
    await run(manager)
    expect(manager.health(connection).state).toBe('HEALTHY')
  })

  it('latches UNSUPPORTED for a wrong endpoint and refuses further requests until retested', async () => {
    const transport = vi.fn<Transport>(async () => new Response('404 page not found', { status: 404 }))
    const manager = new RequestManager(transport)
    expect(await run(manager)).toMatchObject({ category: 'ENDPOINT_NOT_FOUND' })
    expect(manager.health(connection).state).toBe('UNSUPPORTED')
    expect(await run(manager)).toMatchObject({ category: 'ENDPOINT_NOT_FOUND' })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('does not let model-level failures degrade the provider', async () => {
    const manager = new RequestManager(vi.fn<Transport>(async () => new Response(JSON.stringify({ error: { message: 'The model `m` does not exist' } }), { status: 404 })))
    await run(manager)
    expect(manager.health(connection).state).toBe('HEALTHY')
  })

  it('doubles the cooldown when a half-open trial fails (30 s → 60 s)', async () => {
    const manager = new RequestManager(respond(500, 500, 500, 500, 200))
    for (let index = 0; index < 3; index++) await run(manager)
    expect(manager.health(connection).state).toBe('OFFLINE')
    await vi.advanceTimersByTimeAsync(30_001)
    await run(manager) // half-open trial fails
    expect(manager.health(connection).state).toBe('OFFLINE')
    await vi.advanceTimersByTimeAsync(30_001)
    expect(manager.health(connection).state).toBe('OFFLINE')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(manager.health(connection).state).toBe('DEGRADED')
    await run(manager)
    expect(manager.health(connection).state).toBe('HEALTHY')
  })

  it('reports each state change to the health listener', async () => {
    const changes: Parameters<HealthListener>[0][] = []
    const manager = new RequestManager(respond(200, 401))
    manager.setHealthListener(change => changes.push(change))
    await run(manager)
    await run(manager)
    expect(changes.map(change => [change.previous, change.state, change.category])).toEqual([['UNKNOWN', 'HEALTHY', null], ['HEALTHY', 'AUTH_ERROR', 'AUTH_ERROR']])
  })

  it('persists latched states across restarts and expires stale observations to UNKNOWN', async () => {
    const first = new RequestManager(respond(401))
    const rateLimited: EndpointConnection = { ...connection, providerId: 'openrouter', baseUrl: 'https://or.invalid/v1' }
    await run(first)
    await first.execute({ connection: rateLimited, messages: [], signal: new AbortController().signal, stream: false, consume: response => response.text() }).catch(() => undefined)
    const saved = JSON.parse(JSON.stringify(first.exportHealth()))
    expect(JSON.stringify(saved)).not.toContain(connection.apiKey)

    const restarted = new RequestManager()
    restarted.importHealth(saved, Date.now() + 20 * 60_000)
    expect(restarted.health(connection).state).toBe('AUTH_ERROR')
    expect(restarted.health(rateLimited).state).toBe('UNKNOWN')
  })

  it('aborts in-flight requests to a disconnected provider with PROVIDER_DISCONNECTED and refuses queued ones', async () => {
    vi.useRealTimers()
    const transport = vi.fn<Transport>((_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))))
    const manager = new RequestManager(transport)
    const inflight = run(manager)
    await new Promise(resolve => setTimeout(resolve, 20))
    manager.abortProvider(connection)
    expect(await inflight).toMatchObject({ category: 'PROVIDER_DISCONNECTED' })
    expect(manager.health(connection).state).toBe('UNKNOWN')
  })
})
