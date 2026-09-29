import { providerPresets } from '../../shared/desktop-api'
import { ModelGateway } from '@altrex/core/gateway/gateway'
import type { DiscoveredModel } from '@altrex/core/gateway/stream-types'
import { RequestManager, nativeTransport, ProviderFailure, type Transport } from './request-manager'
import type { CapabilityRequirement, ModelCapabilities, ModelProvider, ProviderCompletion, ProviderCompletionInput, ProviderRuntimeConnection, ProviderStreamInput } from './model-provider'

const probeBudget = { inputTokens: 1024, outputTokens: 64, maxAttempts: 1 }
const echoTool = { type: 'function', function: { name: 'echo', description: 'Echo a value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }

/**
 * Desktop-facing provider over the core Universal Model Gateway. All wire formats, streaming, tool-call
 * assembly and error normalization live in @altrex/core/gateway; this class adapts the gateway to the
 * existing ModelProvider interface used by the router, agent loop and Director.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly protocol = 'openai-chat-completions'
  readonly gateway: ModelGateway
  constructor(private readonly timeoutMs?: number, readonly requests = new RequestManager(), transport: Transport = nativeTransport) {
    this.gateway = new ModelGateway(requests, transport)
  }
  providerHealth(connection: ProviderRuntimeConnection) { const health = this.requests.health(connection); return { state: health.state, active: health.active, queued: health.queued } }
  resetProviderHealth(connection: ProviderRuntimeConnection): void { this.requests.resetProvider(connection) }
  recordFallback(from: ProviderRuntimeConnection, to: ProviderRuntimeConnection): void { this.requests.recordFallback(from, to) }

  private get timeoutOverrides() {
    return this.timeoutMs ? { overrides: { firstTokenMs: this.timeoutMs, overallMs: this.timeoutMs, maxAttempts: 1 } } : {}
  }

  private readonly catalogs = new Map<string, DiscoveredModel[]>()

  async listModels(connection: ProviderRuntimeConnection): Promise<string[]> {
    return (await this.discoverModels(connection)).map(model => model.id)
  }

  /** Model catalog with whatever metadata the provider exposes. */
  async discoverModels(connection: ProviderRuntimeConnection): Promise<DiscoveredModel[]> {
    const models = await this.gateway.listModels(connection)
    this.catalogs.set(this.requests.providerKey(connection), models)
    return models
  }

  /** Metadata from the most recent catalog listing of this provider (undefined if never listed here). */
  catalogMetadata(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): DiscoveredModel[] | undefined {
    return this.catalogs.get(this.requests.providerKey(connection))
  }

  /** Abort in-flight and queued requests to a provider (it was disconnected). */
  cancelProvider(connection: Pick<ProviderRuntimeConnection, 'providerId' | 'baseUrl'>): void {
    this.gateway.cancelProvider(connection)
  }

  async healthCheck(connection: ProviderRuntimeConnection) {
    const started = Date.now()
    try {
      await this.gateway.run({ connection, messages: [{ role: 'user', content: 'Reply only with: OK' }], signal: new AbortController().signal, stream: false, overrides: { ...probeBudget, overallMs: 120000, firstTokenMs: 90000 } })
      return { ok: true, message: `Connected to ${providerPresets.find(p => p.id === connection.providerId)?.displayName ?? 'provider'}.`, latencyMs: Date.now() - started }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Provider connection failed.',
        latencyMs: Date.now() - started,
        ...(error instanceof ProviderFailure ? { failureKind: error.kind, errorCategory: error.category } : { failureKind: 'network' as const, errorCategory: 'CONNECTION_ERROR' as const }),
      }
    }
  }

  async probeCapabilities(connection: ProviderRuntimeConnection, requirement: CapabilityRequirement, signal: AbortSignal): Promise<Partial<ModelCapabilities>> {
    const probe = { ...connection, requestPolicy: { ...connection.requestPolicy, ...probeBudget } }
    const capabilities: Partial<ModelCapabilities> = {}
    if (requirement.chat || requirement.tools) {
      await this.complete({ connection: probe, messages: [{ role: 'user', content: 'Reply only with: OK' }], tools: [], signal })
      capabilities.supportsChat = true
    }
    if (requirement.streaming) {
      let received = false
      await this.stream({ connection: probe, messages: [{ role: 'user', content: 'Reply only with: OK' }], signal, onDelta: () => { received = true } })
      capabilities.supportsStreaming = received
    }
    if (requirement.tools) {
      try {
        const result = await this.complete({ connection: probe, messages: [{ role: 'user', content: 'Call the echo tool exactly once with value "OK".' }], tools: [echoTool], signal })
        capabilities.supportsTools = result.toolCalls.some(call => call.name === 'echo')
        capabilities.supportsParallelTools = null
      } catch (error) {
        if (error instanceof ProviderFailure && ['TOOLS_UNSUPPORTED', 'BAD_REQUEST'].includes(error.category)) capabilities.supportsTools = false
        else throw error
      }
    }
    return capabilities
  }

  /** Streams text only (Ask mode). */
  async stream({ connection, messages, signal, onDelta, onStatus }: ProviderStreamInput): Promise<void> {
    await this.gateway.run({
      connection, messages, signal, stream: true,
      ...(onStatus ? { onStatus } : {}), ...this.timeoutOverrides,
      onEvent: event => { if (event.type === 'text-delta') onDelta(event.text) },
    })
  }

  /**
   * One model turn with tools. Non-streamed by default (compatibility); `stream: true` streams the turn,
   * with tool calls reassembled from fragments and returned only when complete and valid.
   */
  async complete({ connection, messages, tools, signal, onStatus, stream, onDelta }: ProviderCompletionInput): Promise<ProviderCompletion> {
    const response = await this.gateway.run({
      connection, messages, tools, signal, stream: stream === true,
      ...(onStatus ? { onStatus } : {}), ...this.timeoutOverrides,
      ...(onDelta ? { onEvent: event => { if (event.type === 'text-delta') onDelta(event.text) } } : {}),
    })
    if (response.finish === 'length' && response.toolCalls.length === 0) throw new ProviderFailure('Model output reached its limit. Increase output budget or request a smaller edit.', 'invalid-request', false, 0, 0, undefined, 'OUTPUT_TRUNCATED', 'finish_reason=length')
    return { content: response.text, toolCalls: response.toolCalls }
  }
}
