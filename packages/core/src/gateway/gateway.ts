import type { ProviderMessage } from './messages'
import type { EndpointConnection } from './connection'
import type { RequestPolicy } from './request-policy'
import { RequestManager, classifyFailure, nativeTransport, type Transport } from './request-executor'
import { providerAdapter } from './adapters/openai-dialects'
import { consumeOpenAiCompletion, consumeOpenAiStream, parseModelCatalog } from './adapters/openai-compatible'
import { offeredToolNames } from './tool-call-assembler'
import { buildGeminiBody, consumeGemini, geminiEndpoint, geminiHeaders, geminiRoot, parseGeminiModels } from './adapters/gemini'

export type WireProtocol = 'openai-chat' | 'gemini'

/**
 * Which wire protocol an endpoint speaks. Google profiles use the native Gemini API unless the profile
 * explicitly opts into Google's OpenAI-compatibility layer (additionalFields.api = 'openai-compatible').
 */
export function wireProtocol(connection: Pick<EndpointConnection, 'providerId' | 'additionalFields'>): WireProtocol {
  return connection.providerId === 'google' && connection.additionalFields?.api !== 'openai-compatible' ? 'gemini' : 'openai-chat'
}
import type { DiscoveredModel, GatewayResponse, GatewayStreamEvent } from './stream-types'

export type GatewayCall = {
  connection: EndpointConnection
  messages: ProviderMessage[]
  tools?: ReadonlyArray<unknown>
  signal: AbortSignal
  /** Stream the response (default). Set false only when a capability record says streaming is unsupported. */
  stream?: boolean
  /** Normalized events in order. Tool calls arrive only when complete and valid. */
  onEvent?: (event: GatewayStreamEvent) => void
  onStatus?: (message: string) => void
  overrides?: Partial<RequestPolicy>
}

/**
 * Holds back the last `secret.length - 1` characters of streamed text so a secret split across
 * chunks can still be redacted before anything reaches a consumer.
 */
class StreamRedactor {
  private pending = ''
  constructor(private readonly secret: string) {}
  push(text: string): string {
    if (!this.secret) return text
    this.pending = (this.pending + text).replaceAll(this.secret, '[REDACTED]')
    const safe = Math.max(0, this.pending.length - (this.secret.length - 1))
    const out = this.pending.slice(0, safe)
    this.pending = this.pending.slice(safe)
    return out
  }
  flush(): string {
    const out = this.secret ? this.pending.replaceAll(this.secret, '[REDACTED]') : this.pending
    this.pending = ''
    return out
  }
}

/**
 * The Universal Model Gateway: the single path by which ALTREX talks to models.
 *   caller → ModelGateway.run/stream → RequestManager (budget, queue, deadlines, retries, circuit)
 *          → dialect (headers/body) → transport → adapter (wire → GatewayStreamEvent)
 * Streaming is the default. Tool calls are reassembled from streamed fragments and released only
 * when complete and valid. Secrets are redacted from outbound messages and from every inbound event.
 */
export class ModelGateway {
  constructor(readonly executor: RequestManager = new RequestManager(), private readonly transport: Transport = nativeTransport) {}

  async run(call: GatewayCall): Promise<GatewayResponse> {
    const { connection } = call
    const dialect = providerAdapter(connection.providerId), wire = wireProtocol(connection)
    const tools = call.tools ?? []
    const offered = offeredToolNames(tools)
    const stream = call.stream !== false
    const secret = connection.apiKey
    const redactSecret = (text: string) => (secret ? text.replaceAll(secret, '[REDACTED]') : text)

    return this.executor.execute({
      connection,
      messages: call.messages,
      tools,
      signal: call.signal,
      stream,
      requestHeaders: wire === 'gemini' ? geminiHeaders(connection.apiKey) : dialect.headers(connection.apiKey),
      ...(wire === 'gemini' ? { endpointUrl: geminiEndpoint(connection, stream) } : {}),
      ...(call.onStatus ? { onStatus: call.onStatus } : {}),
      ...(call.overrides ? { overrides: call.overrides } : {}),
      buildBody: ({ messages, tools: safeTools, stream: streaming, maxOutput }) => wire === 'gemini' ? buildGeminiBody({ messages, tools: safeTools, maxOutput }) : dialect.build({ model: connection.model, messages, tools: safeTools, stream: streaming, maxOutput }),
      consume: async (response, touch, progress) => {
        const result: GatewayResponse = { text: '', reasoning: '', toolCalls: [], finish: 'unknown', usage: { inputTokens: null, outputTokens: null, source: 'none' }, streamed: stream }
        const textRedactor = new StreamRedactor(secret), reasoningRedactor = new StreamRedactor(secret)
        const forward = (event: GatewayStreamEvent) => {
          if (event.type === 'text-delta') result.text += event.text
          else if (event.type === 'reasoning-delta') result.reasoning += event.text
          else if (event.type === 'tool-call') result.toolCalls.push(event.call)
          else if (event.type === 'usage') result.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, source: 'provider' }
          else if (event.type === 'finish') result.finish = event.reason
          call.onEvent?.(event)
        }
        const flushText = () => {
          const text = textRedactor.flush(); if (text) forward({ type: 'text-delta', text })
          const reasoning = reasoningRedactor.flush(); if (reasoning) forward({ type: 'reasoning-delta', text: reasoning })
        }
        const hooks = {
          emit: (event: GatewayStreamEvent) => {
            if (event.type === 'text-delta') { const text = textRedactor.push(event.text); if (text) forward({ type: 'text-delta', text }); return }
            if (event.type === 'reasoning-delta') { const text = reasoningRedactor.push(event.text); if (text) forward({ type: 'reasoning-delta', text }); return }
            flushText()
            forward(event.type === 'tool-call' ? { type: 'tool-call', call: { ...event.call, arguments: redactSecret(event.call.arguments) } } : event)
          },
          touch,
          deliver: progress,
          offeredTools: offered,
          classify: (status: number, body: string) => classifyFailure(status, body, null, { provider: connection.providerId, model: connection.model, apiKey: connection.apiKey }),
          providerId: connection.providerId,
        }
        if (wire === 'gemini') await consumeGemini(response, hooks, stream)
        else if (stream) await consumeOpenAiStream(response, hooks)
        else await consumeOpenAiCompletion(response, { ...hooks, redactBody: text => (secret ? text.replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]') : text) })
        flushText()
        return result
      },
    })
  }

  /** Async-iterable view of `run`. The iterator ends after `finish`; failures are thrown from the iterator. */
  stream(call: Omit<GatewayCall, 'onEvent' | 'stream'>): AsyncIterable<GatewayStreamEvent> {
    const queue: GatewayStreamEvent[] = []
    let wake: (() => void) | null = null, finished = false, failure: unknown
    const signal = () => { const resume = wake; wake = null; resume?.() }
    void this.run({ ...call, stream: true, onEvent: event => { queue.push(event); signal() } })
      .then(() => { finished = true; signal() }, (error: unknown) => { failure = error; finished = true; signal() })
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<GatewayStreamEvent>> => {
          while (!queue.length && !finished) await new Promise<void>(resolve => { wake = resolve })
          if (queue.length) return { value: queue.shift()!, done: false }
          if (failure !== undefined) throw failure
          return { value: undefined, done: true }
        },
      }),
    }
  }

  /** The provider's model catalog, with whatever metadata it exposes. Unreachable/unauthorized → ProviderFailure. */
  async listModels(connection: EndpointConnection): Promise<DiscoveredModel[]> {
    const gemini = wireProtocol(connection) === 'gemini'
    const url = gemini ? `${geminiRoot(connection.baseUrl)}/models?pageSize=1000` : `${connection.baseUrl}/models`
    const headers = gemini ? geminiHeaders(connection.apiKey) : providerAdapter(connection.providerId).headers(connection.apiKey)
    const response = await this.transport(url, { headers, signal: AbortSignal.timeout(20000) }, 15000)
    if (!response.ok) throw classifyFailure(response.status, (await response.text().catch(() => '')).slice(0, 4000), response.headers.get('retry-after'), { provider: connection.providerId, model: connection.model, apiKey: connection.apiKey })
    let body: unknown
    try { body = await response.json() } catch { throw classifyFailure(404, '', null, { provider: connection.providerId, model: connection.model, apiKey: connection.apiKey }) }
    const models = gemini ? parseGeminiModels(body) : parseModelCatalog(connection.providerId, body)
    return connection.providerId === 'ollama' ? this.enrichOllama(connection, models) : models
  }

  /**
   * Credential check: the cheapest authenticated call (catalog listing). Returns the normalized failure
   * category instead of throwing.
   */
  async validateCredentials(connection: EndpointConnection): Promise<{ ok: true; models: number } | { ok: false; category: string; message: string }> {
    try { return { ok: true, models: (await this.listModels(connection)).length } }
    catch (error) {
      const failure = error instanceof Error && 'category' in error ? error as Error & { category: string } : null
      return { ok: false, category: failure?.category ?? 'CONNECTION_ERROR', message: error instanceof Error ? error.message : 'Could not reach the provider.' }
    }
  }

  /** Abort in-flight and queued requests to a provider (it was disconnected). */
  cancelProvider(connection: Pick<EndpointConnection, 'providerId' | 'baseUrl'>): void {
    this.executor.abortProvider(connection)
  }

  /** Ollama's native /api/show exposes tool/vision support and context length per installed model. */
  private async enrichOllama(connection: EndpointConnection, models: DiscoveredModel[]): Promise<DiscoveredModel[]> {
    const root = connection.baseUrl.replace(/\/v1\/?$/, '')
    return Promise.all(models.slice(0, 25).map(async model => {
      try {
        const response = await this.transport(`${root}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.id }), signal: AbortSignal.timeout(5000) }, 3000)
        if (!response.ok) return model
        const show = await response.json() as { capabilities?: unknown; model_info?: Record<string, unknown> }
        const enriched: DiscoveredModel = { ...model }
        if (Array.isArray(show.capabilities)) { enriched.supportsTools = show.capabilities.includes('tools'); enriched.supportsVision = show.capabilities.includes('vision'); if (show.capabilities.includes('thinking')) enriched.supportsReasoning = true }
        const context = Object.entries(show.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1]
        if (typeof context === 'number' && context > 0) enriched.contextWindow = context
        return enriched
      } catch { return model }
    })).then(enriched => [...enriched, ...models.slice(25)])
  }
}
