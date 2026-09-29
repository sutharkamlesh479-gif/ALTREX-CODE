import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reply, startFakeOpenAiServer, type FakeOpenAiServer } from '../testing/fake-openai-server'
import { errorFrame, finish, reasoning, text, toolArgs, toolCallFrames, toolStart, usage } from '../testing/openai-frames'
import { ModelGateway } from './gateway'
import type { EndpointConnection } from './connection'
import type { RequestPolicy } from './request-policy'
import type { GatewayStreamEvent } from './stream-types'

// Universal Model Gateway over real loopback HTTP: normalized streaming, streamed tool calls,
// malformed/interrupted streams, cancellation, redaction.

const apiKey = 'sk-gateway-secret-key-0123456789'
const tools = ['read_file', 'write_file', 'list_files'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }))
let server: FakeOpenAiServer
beforeEach(async () => { server = await startFakeOpenAiServer() })
afterEach(async () => { await server.close() })

const connection = (policy: Partial<RequestPolicy> = {}): EndpointConnection => ({
  providerId: 'custom', baseUrl: server.baseUrl, model: 'fake-coder', apiKey,
  requestPolicy: { connectionMs: 2000, firstTokenMs: 1500, idleMs: 1000, overallMs: 15_000, maxAttempts: 1, ...policy },
})
async function run(policy: Partial<RequestPolicy> = {}, signal = new AbortController().signal) {
  const events: GatewayStreamEvent[] = []
  const response = await new ModelGateway().run({ connection: connection(policy), messages: [{ role: 'user', content: 'go' }], tools, signal, onEvent: event => events.push(event) })
  return { response, events }
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected failure') }, (error: unknown) => error as { category: string; message: string })

describe('ModelGateway streaming', () => {
  it('streams text as normalized events and reports finish and usage', async () => {
    server.enqueue(reply.frames([text('Hel'), text('lo'), finish('stop'), usage(12, 3)]))
    const { response, events } = await run()
    // Text may be coalesced: the redactor holds back (key length − 1) characters so a secret split
    // across chunks is still caught. Order and content are what the contract guarantees.
    expect(events.filter(event => event.type === 'text-delta').map(event => event.text).join('')).toBe('Hello')
    expect(events.slice(-2)).toEqual([{ type: 'usage', inputTokens: 12, outputTokens: 3 }, { type: 'finish', reason: 'stop' }])
    expect(response).toMatchObject({ text: 'Hello', toolCalls: [], finish: 'stop', streamed: true, usage: { inputTokens: 12, outputTokens: 3, source: 'provider' } })
    expect(server.requests[0]!.json).toMatchObject({ stream: true, tool_choice: 'auto' })
  })

  it('reassembles a streamed tool call whose JSON arguments arrive in many fragments', async () => {
    const args = { path: 'src/deeply/nested/file.ts', start_line: 10, end_line: 80 }
    server.enqueue(reply.frames([...toolCallFrames(0, 'call_abc', 'read_file', args, 7), finish('tool_calls')], { splitFrames: true }))
    const { response, events } = await run()
    expect(response.toolCalls).toEqual([{ id: 'call_abc', name: 'read_file', arguments: JSON.stringify(args) }])
    expect(events.map(event => event.type)).toEqual(['tool-call', 'finish'])
    expect(response.finish).toBe('tool_calls')
  })

  it('handles text followed by multiple interleaved tool calls', async () => {
    server.enqueue(reply.frames([
      text('I will read both files.'),
      toolStart(0, 'c0', 'read_file'), toolStart(1, 'c1', 'read_file'),
      toolArgs(1, '{"path":'), toolArgs(0, '{"path":'), toolArgs(0, '"a.ts"}'), toolArgs(1, '"b.ts"}'),
      finish('tool_calls'),
    ]))
    const { response, events } = await run()
    expect(response.text).toBe('I will read both files.')
    expect(response.toolCalls).toEqual([{ id: 'c0', name: 'read_file', arguments: '{"path":"a.ts"}' }, { id: 'c1', name: 'read_file', arguments: '{"path":"b.ts"}' }])
    expect(events.map(event => event.type)).toEqual(['text-delta', 'tool-call', 'tool-call', 'finish'])
  })

  it('separates reasoning from answer text', async () => {
    server.enqueue(reply.frames([reasoning('thinking…'), text('answer'), finish('stop')]))
    const { response } = await run()
    expect(response).toMatchObject({ text: 'answer', reasoning: 'thinking…' })
  })

  it('rejects a malformed streamed tool call and never emits a partial call', async () => {
    server.enqueue(reply.frames([toolStart(0, 'c0', 'write_file'), toolArgs(0, '{"path":"a.ts","content":"unterminated'), finish('tool_calls')]))
    const events: GatewayStreamEvent[] = []
    const error = await failure(new ModelGateway().run({ connection: connection({ maxAttempts: 3 }), messages: [], tools, signal: new AbortController().signal, onEvent: event => events.push(event) }))
    expect(error.category).toBe('TOOL_CALL_MALFORMED')
    expect(events.filter(event => event.type === 'tool-call')).toEqual([])
    expect(server.requests).toHaveLength(1)
  })

  it('rejects calls to tools that were not offered', async () => {
    server.enqueue(reply.frames([...toolCallFrames(0, 'c0', 'delete_everything', {}), finish('tool_calls')]))
    expect((await failure(run())).category).toBe('TOOL_CALL_MALFORMED')
  })

  it('classifies unparsable frames as STREAM_MALFORMED and retries once before failing', async () => {
    server.enqueue(reply.malformed(), reply.malformed())
    expect((await failure(run({ maxAttempts: 2 }))).category).toBe('STREAM_MALFORMED')
    expect(server.requests).toHaveLength(2)
  })

  it('treats an empty stream as STREAM_MALFORMED, not success', async () => {
    server.enqueue(reply.frames([finish('stop')]))
    expect((await failure(run())).category).toBe('STREAM_MALFORMED')
  })

  it('retries a disconnect that happened before anything was delivered (mid tool call)', async () => {
    server.enqueue(
      reply.frames([toolStart(0, 'c0', 'read_file'), toolArgs(0, '{"pa')], { end: 'disconnect' }),
      reply.frames([...toolCallFrames(0, 'c0', 'read_file', { path: 'a.ts' }), finish('tool_calls')]),
    )
    const { response } = await run({ maxAttempts: 2 })
    expect(response.toolCalls).toEqual([{ id: 'c0', name: 'read_file', arguments: '{"path":"a.ts"}' }])
    expect(server.requests).toHaveLength(2)
  })

  it('does not replay after text was delivered; reports STREAM_INTERRUPTED', async () => {
    server.enqueue(reply.frames([text('partial answer')], { end: 'disconnect' }), reply.frames([text('replayed')]))
    expect((await failure(run({ maxAttempts: 2 }))).category).toBe('STREAM_INTERRUPTED')
    expect(server.requests).toHaveLength(1)
  })

  it('cancels mid tool-call stream without emitting the call', async () => {
    server.enqueue(reply.frames([toolStart(0, 'c0', 'write_file'), toolArgs(0, '{"path":"a')], { end: 'stall' }))
    const controller = new AbortController(), events: GatewayStreamEvent[] = []
    const pending = new ModelGateway().run({ connection: connection({ idleMs: 10_000 }), messages: [], tools, signal: controller.signal, onEvent: event => events.push(event) })
    await new Promise(resolve => setTimeout(resolve, 100))
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(events).toEqual([])
    expect(server.requests[0]!.aborted).toBe(true)
  })

  it('maps provider error frames embedded in a stream', async () => {
    server.enqueue(reply.frames([errorFrame('Rate limit exceeded for requests per minute', 429)]))
    expect((await failure(run())).category).toBe('RATE_LIMITED')
  })

  it('reports a text stream cut at the output limit as finish=length', async () => {
    server.enqueue(reply.frames([text('long…'), finish('length')]))
    expect((await run()).response.finish).toBe('length')
  })

  it('redacts the API key from streamed text even when split across chunks, and from tool arguments', async () => {
    const half = Math.floor(apiKey.length / 2)
    server.enqueue(reply.frames([text(`key=${apiKey.slice(0, half)}`), text(`${apiKey.slice(half)} end`), ...toolCallFrames(0, 'c', 'write_file', { content: apiKey }), finish('tool_calls')]))
    const { response, events } = await run()
    expect(JSON.stringify(events)).not.toContain(apiKey)
    expect(response.text).toBe('key=[REDACTED] end')
    expect(response.toolCalls[0]!.arguments).toBe('{"content":"[REDACTED]"}')
  })

  it('exposes the same normalized stream as an async iterable', async () => {
    server.enqueue(reply.frames([text('a'), ...toolCallFrames(0, 'c', 'list_files', {}), finish('tool_calls')]))
    const seen: string[] = []
    for await (const event of new ModelGateway().stream({ connection: connection(), messages: [], tools, signal: new AbortController().signal })) seen.push(event.type)
    expect(seen).toEqual(['text-delta', 'tool-call', 'finish'])
  })

  it('normalizes a non-streamed completion into the same shape when streaming is explicitly disabled', async () => {
    server.enqueue(reply.completion({ content: 'done', toolCalls: [{ id: 'c', name: 'list_files', arguments: {} }] }))
    const response = await new ModelGateway().run({ connection: connection(), messages: [], tools, signal: new AbortController().signal, stream: false })
    expect(response).toMatchObject({ text: 'done', toolCalls: [{ id: 'c', name: 'list_files', arguments: '{}' }], finish: 'tool_calls', streamed: false })
    expect(server.requests[0]!.json).toMatchObject({ stream: false })
  })
})
