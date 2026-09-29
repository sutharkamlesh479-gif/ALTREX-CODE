import type { ProviderMessage, ProviderContentPart } from '../messages'
import type { EndpointConnection } from '../connection'
import { estimateTokens } from '../../context/budget'
import type { ProviderToolCall } from '../../tools/types'
import { ProviderFailure } from '../request-executor'
import { SseParser } from '../sse'
import type { DiscoveredModel, FinishReason } from '../stream-types'
import type { ConsumeHooks } from './openai-compatible'

// Native Google Gemini API (generativelanguage.googleapis.com/v1beta). Only this module knows the
// Gemini wire format: contents/parts, systemInstruction, functionDeclarations, functionCall and
// functionResponse, thought parts, usageMetadata, and finishReason values.

/** Gemini API root from a stored base URL (existing profiles store the /openai compatibility path). */
export function geminiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/openai$/, '')
}

export function geminiHeaders(apiKey: string): Record<string, string> {
  // The key goes in a header, never the URL (URLs end up in logs).
  return apiKey ? { 'x-goog-api-key': apiKey } : {}
}

export function geminiEndpoint(connection: Pick<EndpointConnection, 'baseUrl' | 'model'>, stream: boolean): string {
  const model = encodeURIComponent(connection.model.replace(/^models\//, ''))
  return `${geminiRoot(connection.baseUrl)}/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
}

const UNSUPPORTED_SCHEMA_KEYS = new Set(['additionalProperties', '$schema', '$id', 'default', 'examples', 'title'])
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  if (typeof schema !== 'object' || schema === null) return schema
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !UNSUPPORTED_SCHEMA_KEYS.has(key)).map(([key, value]) => [key, sanitizeSchema(value)]))
}

type GeminiPart = { text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string }; functionCall?: { id?: string; name: string; args?: Record<string, unknown> }; functionResponse?: { id?: string; name: string; response: Record<string, unknown> } }
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

function textOf(content: ProviderMessage['content']): string {
  return typeof content === 'string' ? content : (content ?? []).filter((part): part is Extract<ProviderContentPart, { type: 'text' }> => part.type === 'text').map(part => part.text).join('\n')
}

function userParts(content: ProviderMessage['content']): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  return (content ?? []).flatMap((part): GeminiPart[] => {
    if (part.type === 'text') return part.text ? [{ text: part.text }] : []
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url)
    return match ? [{ inlineData: { mimeType: match[1]!, data: match[2]! } }] : [{ text: `[image: ${part.image_url.url.slice(0, 200)}]` }]
  })
}

/** Build a generateContent body from normalized messages and OpenAI-style tool definitions. */
export function buildGeminiBody(input: { messages: ProviderMessage[]; tools: readonly unknown[]; maxOutput: number }): Record<string, unknown> {
  const system: string[] = [], contents: GeminiContent[] = [], callNames = new Map<string, string>()
  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    if (!parts.length) return
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  for (const message of input.messages) {
    if (message.role === 'system') { const text = textOf(message.content); if (text) system.push(text) }
    else if (message.role === 'user') push('user', userParts(message.content))
    else if (message.role === 'assistant') {
      const parts: GeminiPart[] = []
      const text = textOf(message.content); if (text) parts.push({ text })
      for (const call of message.tool_calls ?? []) {
        callNames.set(call.id, call.function.name)
        let args: Record<string, unknown> = {}
        try { const parsed = JSON.parse(call.function.arguments || '{}') as unknown; if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown> } catch { /* invalid historic arguments are sent as {} */ }
        parts.push({ functionCall: { id: call.id, name: call.function.name, args } })
      }
      push('model', parts)
    } else {
      const id = message.tool_call_id ?? ''
      push('user', [{ functionResponse: { id, name: callNames.get(id) ?? 'tool', response: { content: textOf(message.content) } } }])
    }
  }
  const declarations = input.tools.flatMap(tool => {
    const fn = typeof tool === 'object' && tool !== null ? (tool as { function?: { name?: unknown; description?: unknown; parameters?: unknown } }).function : undefined
    return typeof fn?.name === 'string' ? [{ name: fn.name, ...(typeof fn.description === 'string' ? { description: fn.description } : {}), ...(fn.parameters ? { parameters: sanitizeSchema(fn.parameters) } : {}) }] : []
  })
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}),
    ...(declarations.length ? { tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
    generationConfig: { maxOutputTokens: input.maxOutput },
  }
}

type GeminiChunk = {
  error?: { code?: number; message?: string; status?: string }
  promptFeedback?: { blockReason?: string }
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

function mapFinish(reason: string | undefined): FinishReason | undefined {
  if (!reason || reason === 'FINISH_REASON_UNSPECIFIED') return undefined
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(reason)) return 'content_filter'
  return 'unknown'
}

const malformedCall = (detail: string) => new ProviderFailure('The model produced an invalid tool call.', 'invalid-request', false, 0, 0, undefined, 'TOOL_CALL_MALFORMED', detail)
const unreadable = (detail: string) => new ProviderFailure('The provider sent a response ALTREX could not read.', 'invalid-request', true, 0, 0, undefined, 'STREAM_MALFORMED', detail)

/** Accumulates Gemini chunks (stream or single body) into normalized events. */
class GeminiAccumulator {
  private content = false
  private finish: FinishReason | undefined
  private usage: GeminiChunk['usageMetadata']
  private readonly calls: ProviderToolCall[] = []
  constructor(private readonly hooks: ConsumeHooks) {}

  chunk(chunk: GeminiChunk): void {
    if (chunk.error) throw this.hooks.classify(typeof chunk.error.code === 'number' ? chunk.error.code : 500, JSON.stringify({ error: chunk.error }))
    if (chunk.promptFeedback?.blockReason) this.finish = 'content_filter'
    if (chunk.usageMetadata) this.usage = chunk.usageMetadata
    const candidate = chunk.candidates?.[0]
    if (!candidate) return
    if (candidate.finishReason === 'MALFORMED_FUNCTION_CALL') throw malformedCall('Gemini reported MALFORMED_FUNCTION_CALL.')
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall) {
        if (typeof part.functionCall.name !== 'string' || !part.functionCall.name) throw malformedCall('Gemini function call without a name.')
        this.calls.push({ id: part.functionCall.id || `gemini-call-${this.calls.length}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) })
      } else if (typeof part.text === 'string' && part.text) {
        if (part.thought) this.hooks.emit({ type: 'reasoning-delta', text: part.text })
        else { this.content = true; this.hooks.emit({ type: 'text-delta', text: part.text }) }
        this.hooks.deliver(estimateTokens(part.text))
      }
    }
    this.finish = mapFinish(candidate.finishReason) ?? this.finish
  }

  end(): void {
    for (const call of this.calls) if (this.hooks.offeredTools.size && !this.hooks.offeredTools.has(call.name)) throw malformedCall(`Gemini called an unknown tool: ${call.name.slice(0, 80)}`)
    if (!this.content && !this.calls.length && this.finish !== 'content_filter') {
      if (this.finish === 'length') throw new ProviderFailure('Model output reached its limit. Increase output budget or request a smaller edit.', 'invalid-request', false, 0, 0, undefined, 'OUTPUT_TRUNCATED', 'finishReason=MAX_TOKENS')
      throw unreadable('Gemini returned no text and no function call.')
    }
    for (const call of this.calls) this.hooks.emit({ type: 'tool-call', call })
    if (this.usage) this.hooks.emit({ type: 'usage', inputTokens: this.usage.promptTokenCount ?? null, outputTokens: this.usage.candidatesTokenCount ?? null })
    this.hooks.emit({ type: 'finish', reason: this.calls.length && (this.finish === 'stop' || this.finish === undefined) ? 'tool_calls' : this.finish ?? 'stop' })
  }
}

export async function consumeGemini(response: Response, hooks: ConsumeHooks, stream: boolean): Promise<void> {
  if (!response.body) throw unreadable('Gemini returned no response body.')
  const accumulator = new GeminiAccumulator(hooks), reader = response.body.getReader(), decoder = new TextDecoder()
  const parser = new SseParser()
  let body = '', frames = 0, malformed = 0
  const handle = (data: string) => {
    frames++
    let chunk: GeminiChunk
    try { chunk = JSON.parse(data) as GeminiChunk } catch { malformed++; return }
    accumulator.chunk(chunk)
  }
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>
      try { result = await reader.read() } catch (error) {
        throw new ProviderFailure('The provider connection dropped while responding.', 'network', true, 0, 0, undefined, 'STREAM_INTERRUPTED', `Gemini stream ended abnormally: ${error instanceof Error ? error.message.slice(0, 300) : 'read failed'}`)
      }
      if (result.value?.length) hooks.touch()
      const text = decoder.decode(result.value, { stream: !result.done })
      if (stream) for (const event of parser.push(text)) handle(event.data)
      else { body += text; if (body.length > 2_000_000) throw unreadable('Gemini response exceeded 2,000,000 characters.') }
      if (result.done) break
    }
  } finally { reader.releaseLock() }
  if (stream) for (const event of parser.end()) handle(event.data)
  else handle(body)
  if (malformed && malformed === frames) throw unreadable(`${malformed} Gemini frame(s) were not valid JSON.`)
  accumulator.end()
}

/** Parse `GET /v1beta/models`. Only models that support generateContent are returned. */
export function parseGeminiModels(body: unknown): DiscoveredModel[] {
  const models = typeof body === 'object' && body !== null ? (body as { models?: unknown }).models : undefined
  if (!Array.isArray(models)) return []
  return models.flatMap((entry): DiscoveredModel[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const model = entry as { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; outputTokenLimit?: unknown; supportedGenerationMethods?: unknown; thinking?: unknown }
    if (typeof model.name !== 'string') return []
    if (Array.isArray(model.supportedGenerationMethods) && !model.supportedGenerationMethods.includes('generateContent')) return []
    return [{
      id: model.name.replace(/^models\//, ''),
      ...(typeof model.displayName === 'string' ? { displayName: model.displayName } : {}),
      ...(typeof model.inputTokenLimit === 'number' ? { contextWindow: model.inputTokenLimit } : {}),
      ...(typeof model.outputTokenLimit === 'number' ? { maxOutput: model.outputTokenLimit } : {}),
      ...(typeof model.thinking === 'boolean' ? { supportsReasoning: model.thinking } : {}),
    }]
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
