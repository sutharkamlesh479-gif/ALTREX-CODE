import { randomUUID } from 'node:crypto'
import type { ProviderToolCall } from '../../tools/types'
import { estimateTokens } from '../../context/budget'
import { ProviderFailure } from '../request-executor'
import { SseParser } from '../sse'
import type { DiscoveredModel, FinishReason, GatewayStreamEvent } from '../stream-types'
import { ToolCallAssembler, type ToolCallDelta } from '../tool-call-assembler'

// Wire format of the OpenAI Chat Completions protocol (streamed and non-streamed). Used by OpenAI,
// OpenRouter, NVIDIA NIM (hosted and self-hosted), Groq, Ollama /v1, vLLM, LM Studio, and any custom
// endpoint, including one exposed through a tunnel such as ngrok. Only this module parses its JSON.

export type ConsumeHooks = {
  /** Deliver a normalized event to the gateway. */
  emit: (event: GatewayStreamEvent) => void
  /** Any bytes arrived (resets the idle deadline). */
  touch: () => void
  /** Content was delivered to the consumer (disables transparent retry of this request). */
  deliver: (tokens: number) => void
  /** Tool names offered in the request (empty = no validation of names). */
  offeredTools: ReadonlySet<string>
  /** Classify an error object embedded in a stream or body. */
  classify: (status: number, body: string) => ProviderFailure
  providerId: string
}

const streamFailure = (category: 'STREAM_MALFORMED' | 'STREAM_INTERRUPTED' | 'OUTPUT_TRUNCATED', detail: string) => new ProviderFailure(
  category === 'STREAM_MALFORMED' ? 'The provider sent a response ALTREX could not read.'
    : category === 'STREAM_INTERRUPTED' ? 'The provider connection dropped while responding.'
      : 'Model output reached its limit. Increase output budget or request a smaller edit.',
  category === 'STREAM_INTERRUPTED' ? 'network' : 'invalid-request', category !== 'OUTPUT_TRUNCATED', 0, 0, undefined, category, detail)

function normalizeFinish(value: unknown): FinishReason | undefined {
  if (value === null || value === undefined) return undefined
  if (value === 'stop' || value === 'eos' || value === 'end_turn') return 'stop'
  if (value === 'tool_calls' || value === 'function_call' || value === 'tool_use') return 'tool_calls'
  if (value === 'length' || value === 'max_tokens') return 'length'
  if (value === 'content_filter') return 'content_filter'
  return 'unknown'
}

function embeddedError(error: unknown, hooks: ConsumeHooks): ProviderFailure {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown; status?: unknown }).code ?? (error as { status?: unknown }).status : undefined
  const status = typeof code === 'number' && code >= 400 && code < 600 ? code : typeof code === 'string' && /^[45]\d\d$/.test(code) ? Number(code) : 500
  return hooks.classify(status, JSON.stringify({ error }))
}

type Chunk = {
  error?: unknown
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  choices?: Array<{ delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>
}

/** Consume an SSE chat-completions stream into normalized events. */
export async function consumeOpenAiStream(response: Response, hooks: ConsumeHooks): Promise<void> {
  if (!response.body) throw streamFailure('STREAM_MALFORMED', 'Provider returned no response body for a stream.')
  const reader = response.body.getReader(), decoder = new TextDecoder(), parser = new SseParser(), assembler = new ToolCallAssembler()
  let done = false, content = false, malformedFrames = 0, frames = 0
  let finish: FinishReason | undefined
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined

  const handle = (data: string) => {
    if (data.trim() === '[DONE]') { done = true; return }
    frames++
    let chunk: Chunk
    try { chunk = JSON.parse(data) as Chunk } catch { malformedFrames++; return }
    if (typeof chunk !== 'object' || chunk === null) { malformedFrames++; return }
    if (chunk.error) throw embeddedError(chunk.error, hooks)
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) return
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content) { content = true; hooks.emit({ type: 'text-delta', text: delta.content }); hooks.deliver(estimateTokens(delta.content)) }
    const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
    if (reasoning) { hooks.emit({ type: 'reasoning-delta', text: reasoning }); hooks.deliver(estimateTokens(reasoning)) }
    if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) if (typeof call === 'object' && call !== null) assembler.add(call as ToolCallDelta)
    finish = normalizeFinish(choice.finish_reason) ?? finish
  }

  try {
    while (!done) {
      let result: ReadableStreamReadResult<Uint8Array>
      try { result = await reader.read() } catch (error) {
        throw streamFailure('STREAM_INTERRUPTED', `Stream ended abnormally after ${frames} frames: ${error instanceof Error ? error.message.slice(0, 300) : 'read failed'}`)
      }
      if (result.value?.length) hooks.touch()
      for (const event of parser.push(decoder.decode(result.value, { stream: !result.done }))) handle(event.data)
      if (result.done) { for (const event of parser.end()) handle(event.data); break }
    }
    if (done) await reader.cancel().catch(() => undefined)
  } finally { reader.releaseLock() }

  const toolCalls = assembler.size ? assembler.finish(hooks.offeredTools) : []
  if (!content && !toolCalls.length) {
    if (finish === 'length') throw streamFailure('OUTPUT_TRUNCATED', 'The stream ended at the output limit without content.')
    throw streamFailure('STREAM_MALFORMED', malformedFrames ? `${malformedFrames} of ${frames} stream frames were not valid JSON and no usable content arrived.` : 'The stream ended without any content or tool call.')
  }
  for (const call of toolCalls) hooks.emit({ type: 'tool-call', call })
  if (usage) hooks.emit({ type: 'usage', inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null })
  hooks.emit({ type: 'finish', reason: finish ?? (toolCalls.length ? 'tool_calls' : 'stop') })
}

/**
 * Some local models (notably through Ollama) return a tool call as JSON text in `content` instead of
 * `tool_calls`. Recognized only in non-streamed responses and only for offered tool names.
 */
export function contentEncodedToolCalls(content: string, offered: ReadonlySet<string>): ProviderToolCall[] {
  if (!offered.size) return []
  const trimmed = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^<tool_call>\s*/i, '')
    .replace(/\s*<\/tool_call>$/i, '')
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    return candidates.flatMap(candidate => {
      if (typeof candidate !== 'object' || candidate === null) return []
      const value = candidate as { name?: unknown; arguments?: unknown; parameters?: unknown; function?: { name?: unknown; arguments?: unknown } }
      const name = typeof value.name === 'string' ? value.name : typeof value.function?.name === 'string' ? value.function.name : ''
      if (!offered.has(name)) return []
      const supplied = value.arguments ?? value.parameters ?? value.function?.arguments ?? {}
      let args: string
      if (typeof supplied === 'string') {
        const checked = JSON.parse(supplied) as unknown
        if (typeof checked !== 'object' || checked === null || Array.isArray(checked)) return []
        args = supplied
      } else {
        if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) return []
        args = JSON.stringify(supplied)
      }
      return [{ id: `ollama-tool-${randomUUID()}`, name, arguments: args }]
    })
  } catch {
    return []
  }
}

/** Consume a non-streamed chat completion into normalized events. */
export async function consumeOpenAiCompletion(response: Response, hooks: ConsumeHooks & { redactBody: (text: string) => string }): Promise<void> {
  if (!response.body) throw streamFailure('STREAM_MALFORMED', 'Provider returned no response body.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      hooks.touch()
      text += decoder.decode(value, { stream: true })
      if (text.length > 2_000_000) throw streamFailure('STREAM_MALFORMED', 'Completion exceeded the 2,000,000 character response limit.')
    }
    text += decoder.decode()
  } finally { reader.releaseLock() }
  let body: { error?: unknown; usage?: Chunk['usage']; choices?: Array<{ finish_reason?: string; message?: { content?: string | null; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> }
  try { body = JSON.parse(hooks.redactBody(text)) as typeof body } catch { throw streamFailure('STREAM_MALFORMED', `Completion body was not valid JSON (${text.length} characters).`) }
  if (body.error) throw embeddedError(body.error, hooks)
  const choice = body.choices?.[0], message = choice?.message
  if (!message) throw streamFailure('STREAM_MALFORMED', 'Completion contained no message.')
  if (choice?.finish_reason === 'length') throw streamFailure('OUTPUT_TRUNCATED', 'finish_reason=length')
  let toolCalls: ProviderToolCall[] = (message.tool_calls ?? []).flatMap(call => typeof call.id === 'string' && call.type === 'function' && typeof call.function?.name === 'string' && typeof call.function.arguments === 'string'
    ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }] : [])
  const emulated = toolCalls.length === 0 && hooks.providerId === 'ollama' && typeof message.content === 'string'
  if (emulated) toolCalls = contentEncodedToolCalls(message.content!, hooks.offeredTools)
  const content = toolCalls.length > 0 && emulated ? '' : typeof message.content === 'string' ? message.content : ''
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning : typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  hooks.deliver(estimateTokens(message))
  if (reasoning) hooks.emit({ type: 'reasoning-delta', text: reasoning })
  if (content) hooks.emit({ type: 'text-delta', text: content })
  for (const call of toolCalls) hooks.emit({ type: 'tool-call', call })
  if (body.usage) hooks.emit({ type: 'usage', inputTokens: body.usage.prompt_tokens ?? null, outputTokens: body.usage.completion_tokens ?? null })
  hooks.emit({ type: 'finish', reason: normalizeFinish(choice?.finish_reason) ?? (toolCalls.length ? 'tool_calls' : 'stop') })
}

type CatalogEntry = {
  id?: unknown; name?: unknown; active?: unknown
  context_length?: unknown; context_window?: unknown; max_model_len?: unknown; max_completion_tokens?: unknown
  top_provider?: { max_completion_tokens?: unknown; context_length?: unknown }
  supported_parameters?: unknown
  architecture?: { input_modalities?: unknown }
  pricing?: { prompt?: unknown; completion?: unknown }
  /** crax-gpt style per-model rates and flags. */
  inRate?: unknown; outRate?: unknown; input_rate?: unknown; output_rate?: unknown; reasoning?: unknown; available?: unknown
}
const positive = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined)

/** Metadata an OpenAI-style catalog entry exposes (OpenRouter, Groq, vLLM…). Absent means unknown. */
function catalogMetadata(entry: CatalogEntry): Omit<DiscoveredModel, 'id'> {
  const metadata: Omit<DiscoveredModel, 'id'> = {}
  const context = positive(entry.context_length) ?? positive(entry.context_window) ?? positive(entry.max_model_len) ?? positive(entry.top_provider?.context_length)
  if (context) metadata.contextWindow = context
  const maxOutput = positive(entry.top_provider?.max_completion_tokens) ?? positive(entry.max_completion_tokens)
  if (maxOutput) metadata.maxOutput = maxOutput
  if (typeof entry.name === 'string') metadata.displayName = entry.name
  if (Array.isArray(entry.supported_parameters)) {
    const parameters = new Set(entry.supported_parameters.filter((value): value is string => typeof value === 'string'))
    metadata.supportsTools = parameters.has('tools')
    metadata.supportsStructuredOutput = parameters.has('response_format') || parameters.has('structured_outputs')
    metadata.supportsReasoning = parameters.has('reasoning') || parameters.has('include_reasoning')
  }
  if (Array.isArray(entry.architecture?.input_modalities)) metadata.supportsVision = entry.architecture.input_modalities.includes('image')
  if (entry.pricing && (typeof entry.pricing.prompt === 'string' || typeof entry.pricing.prompt === 'number')) {
    metadata.free = Number(entry.pricing.prompt) === 0 && Number(entry.pricing.completion ?? 0) === 0
  }
  // Gateways that publish flat per-model rates (crax-gpt: inRate/outRate). Free only when both are known and zero.
  const rateIn = entry.inRate ?? entry.input_rate, rateOut = entry.outRate ?? entry.output_rate
  if (metadata.free === undefined && (typeof rateIn === 'number' || typeof rateIn === 'string') && (typeof rateOut === 'number' || typeof rateOut === 'string')) {
    metadata.free = Number(rateIn) === 0 && Number(rateOut) === 0
  }
  if (typeof entry.reasoning === 'boolean' && metadata.supportsReasoning === undefined) metadata.supportsReasoning = entry.reasoning
  return metadata
}

/** Parse an OpenAI-style `/models` catalog, keeping any metadata the provider exposes. */
export function parseModelCatalog(providerId: string, body: unknown): DiscoveredModel[] {
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined
  if (!Array.isArray(data)) return []
  const models = new Map<string, DiscoveredModel>()
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as { id?: unknown }).id !== 'string') continue
    if ((entry as CatalogEntry).active === false || (entry as CatalogEntry).available === false) continue
    // Gemini's compatibility catalog returns resource names ("models/gemini-…"); chat expects plain IDs.
    const id = providerId === 'google' ? (entry as { id: string }).id.replace(/^models\//, '') : (entry as { id: string }).id
    const metadata = catalogMetadata(entry as CatalogEntry)
    if (/:free$/.test(id)) metadata.free = true
    models.set(id, { id, ...metadata })
  }
  return [...models.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 500)
}
