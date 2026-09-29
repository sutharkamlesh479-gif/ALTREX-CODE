import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reply, startFakeOpenAiServer, type FakeOpenAiServer } from '@altrex/core/testing/fake-openai-server'
import { OpenAiCompatibleProvider } from './openai-compatible'
import { ProviderFailure } from './request-manager'
import type { ProviderRuntimeConnection } from './model-provider'
import type { RequestPolicy } from '../../shared/request-policy'

// Conformance characterization of the CURRENT OpenAI-compatible provider over real loopback HTTP
// (native transport, real SSE framing, real socket failures). PROVIDER_SPEC.md §12 lists the full
// suite that the Phase 2 gateway must pass; `it.fails` marks today's known gaps.

const apiKey = 'sk-conformance-secret-key-0123456789'
let server: FakeOpenAiServer
beforeEach(async () => { server = await startFakeOpenAiServer({ models: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] }) })
afterEach(async () => { await server.close() })

const connection = (policy: Partial<RequestPolicy> = {}): ProviderRuntimeConnection => ({
  providerId: 'custom', baseUrl: server.baseUrl, model: 'fake-coder', apiKey,
  requestPolicy: { connectionMs: 2000, firstTokenMs: 1500, idleMs: 1000, overallMs: 15_000, maxAttempts: 1, ...policy },
})
const user = (content: string) => [{ role: 'user' as const, content }]
const streamText = async (provider: OpenAiCompatibleProvider, target: ProviderRuntimeConnection, signal = new AbortController().signal) => {
  const deltas: string[] = []
  await provider.stream({ connection: target, messages: user('hi'), signal, onDelta: delta => deltas.push(delta) })
  return deltas.join('')
}
const failureOf = async (pending: Promise<unknown>): Promise<ProviderFailure> => {
  try { await pending } catch (error) { if (error instanceof ProviderFailure) return error; throw error }
  throw new Error('Expected the request to fail.')
}

describe('OpenAI-compatible provider conformance (current implementation)', () => {
  it('lists, de-duplicates and sorts discovered models', async () => {
    expect(await new OpenAiCompatibleProvider().listModels(connection())).toEqual(['a-model', 'z-model'])
  })

  it('reassembles text from SSE frames split across TCP writes, with CRLF and keep-alive comments', async () => {
    server.enqueue(reply.stream(['Hel', 'lo, ', 'world'], { splitFrames: true, keepAlive: true, crlf: true }))
    expect(await streamText(new OpenAiCompatibleProvider(), connection())).toBe('Hello, world')
    expect(server.requests[0]!.json).toMatchObject({ model: 'fake-coder', stream: true })
  })

  it('parses non-streaming tool calls', async () => {
    server.enqueue(reply.completion({ toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'src/a.ts' } }] }))
    const result = await new OpenAiCompatibleProvider().complete({ connection: connection(), messages: user('read it'), tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }], signal: new AbortController().signal })
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }])
    expect(server.requests[0]!.json).toMatchObject({ tool_choice: 'auto', stream: false })
  })

  it('sends the key only in the Authorization header and redacts it from message content', async () => {
    server.enqueue(reply.completion({ content: 'done' }))
    await new OpenAiCompatibleProvider().complete({ connection: connection(), messages: user(`my key is ${apiKey}`), tools: [], signal: new AbortController().signal })
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${apiKey}`)
    expect(server.requests[0]!.body).not.toContain(apiKey)
    expect(server.requests[0]!.body).toContain('[REDACTED]')
  })

  it.each([
    [401, 'Incorrect API key provided', 'INVALID_API_KEY'],
    [404, 'The model `fake-coder` does not exist', 'MODEL_NOT_FOUND'],
    [400, 'This model does not support function calling', 'TOOLS_UNSUPPORTED'],
  ] as const)('HTTP %i is classified once and never retried', async (status, message, category) => {
    server.enqueue(reply.status(status, message), reply.completion())
    const failure = await failureOf(new OpenAiCompatibleProvider().complete({ connection: connection({ maxAttempts: 3 }), messages: user('x'), tools: [], signal: new AbortController().signal }))
    expect(failure.category).toBe(category)
    expect(server.requests).toHaveLength(1)
    expect(failure.technicalDetails).not.toContain(apiKey)
  })

  it('shrinks the request after HTTP 413 and succeeds on the second attempt', async () => {
    server.enqueue(reply.status(413, 'context limit 6,000 tokens'), reply.completion({ content: 'fits now' }))
    const messages = [{ role: 'system' as const, content: `Rules.\nRepository context:\n${'source line\n'.repeat(3000)}` }, ...user('Fix it.')]
    const result = await new OpenAiCompatibleProvider().complete({ connection: connection({ maxAttempts: 2 }), messages, tools: [], signal: new AbortController().signal })
    expect(result.content).toBe('fits now')
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1]!.body.length).toBeLessThan(server.requests[0]!.body.length)
  })

  it('waits for Retry-After on 429 and then succeeds', async () => {
    server.enqueue(reply.status(429, 'Rate limit reached for requests per minute', { 'Retry-After': '1' }), reply.completion({ content: 'after wait' }))
    const started = Date.now()
    const result = await new OpenAiCompatibleProvider().complete({ connection: connection({ maxAttempts: 2 }), messages: user('x'), tools: [], signal: new AbortController().signal })
    expect(result.content).toBe('after wait')
    expect(Date.now() - started).toBeGreaterThanOrEqual(950)
    expect(server.requests).toHaveLength(2)
  })

  it('retries a 5xx within the attempt budget, then reports PROVIDER_SERVER_ERROR', async () => {
    server.enqueue(reply.status(500), reply.status(503))
    const failure = await failureOf(new OpenAiCompatibleProvider().complete({ connection: connection({ maxAttempts: 2 }), messages: user('x'), tools: [], signal: new AbortController().signal }))
    expect(failure.category).toBe('PROVIDER_SERVER_ERROR')
    expect(server.requests).toHaveLength(2)
  })

  it('times out a server that never sends headers (first-token deadline)', async () => {
    server.enqueue(reply.hang())
    const started = Date.now()
    const failure = await failureOf(streamText(new OpenAiCompatibleProvider(), connection({ firstTokenMs: 400 })))
    expect(failure.category).toBe('TIMEOUT')
    expect(failure.technicalDetails).toContain('First-token deadline')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('times out a stream that stalls after content and does not replay delivered output', async () => {
    server.enqueue(reply.stallAfter(['partial']), reply.stream(['should never be requested']))
    const provider = new OpenAiCompatibleProvider(), deltas: string[] = []
    const failure = await failureOf(provider.stream({ connection: connection({ idleMs: 400, maxAttempts: 2 }), messages: user('x'), signal: new AbortController().signal, onDelta: delta => deltas.push(delta) }))
    expect(failure.technicalDetails).toContain('Stream idle deadline')
    expect(server.requests).toHaveLength(1)
  })

  it('does not replay a stream after the server disconnects mid-response', async () => {
    server.enqueue(reply.disconnectAfter(['half']), reply.stream(['second']))
    await expect(streamText(new OpenAiCompatibleProvider(), connection({ maxAttempts: 2 }))).rejects.toThrow()
    expect(server.requests).toHaveLength(1)
  })

  it('classifies a stream with no parsable frames as STREAM_MALFORMED (fixed in Phase 2)', async () => {
    server.enqueue(reply.malformed())
    const failure = await failureOf(streamText(new OpenAiCompatibleProvider(), connection()))
    expect(failure.category).toBe('STREAM_MALFORMED')
  })

  it('reports an output-length stop as a non-retryable failure', async () => {
    server.enqueue(reply.completion({ content: 'trunc', finishReason: 'length' }), reply.completion())
    const failure = await failureOf(new OpenAiCompatibleProvider().complete({ connection: connection({ maxAttempts: 2 }), messages: user('x'), tools: [], signal: new AbortController().signal }))
    expect(failure.message).toContain('output reached its limit')
    expect(server.requests).toHaveLength(1)
  })

  it('cancels an in-flight stream and closes the socket', async () => {
    server.enqueue(reply.stallAfter(['working']))
    const controller = new AbortController()
    const pending = streamText(new OpenAiCompatibleProvider(), connection({ idleMs: 10_000 }), controller.signal)
    await new Promise(resolve => setTimeout(resolve, 150))
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(server.requests[0]!.aborted).toBe(true)
  })

  // Phase 2 fix: tool calls streamed in fragments are reassembled and returned only when complete.
  it('surfaces tool calls delivered in a streamed response (Phase 2)', async () => {
    server.enqueue(reply.streamToolCall({ name: 'read_file', arguments: { path: 'src/a.ts' } }, 3))
    const result = await new OpenAiCompatibleProvider().complete({ connection: connection(), messages: user('read it'), tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }], signal: new AbortController().signal, stream: true })
    expect(result.toolCalls).toEqual([{ id: 'call_0', name: 'read_file', arguments: '{"path":"src/a.ts"}' }])
    expect(server.requests[0]!.json).toMatchObject({ stream: true })
  })

  it('streams text deltas live during a streamed tool turn', async () => {
    server.enqueue(reply.stream(['Checking ', 'the file now, then I will report back.']))
    const deltas: string[] = []
    const result = await new OpenAiCompatibleProvider().complete({ connection: connection(), messages: user('x'), tools: [], signal: new AbortController().signal, stream: true, onDelta: delta => deltas.push(delta) })
    expect(deltas.join('')).toBe(result.content)
    expect(result.content).toBe('Checking the file now, then I will report back.')
  })
})
