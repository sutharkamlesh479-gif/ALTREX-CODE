import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gemini, startFakeGeminiServer, type FakeGeminiServer } from '../testing/fake-gemini-server'
import { ModelGateway, wireProtocol } from './gateway'
import { buildGeminiBody, geminiRoot } from './adapters/gemini'
import type { EndpointConnection } from './connection'
import type { GatewayStreamEvent } from './stream-types'

// Native Gemini adapter conformance over real loopback HTTP.

const apiKey = 'AIza-gemini-secret-key-0123456789'
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }]
let server: FakeGeminiServer
beforeEach(async () => { server = await startFakeGeminiServer() })
afterEach(async () => { await server.close() })
const connection = (): EndpointConnection => ({ providerId: 'google', baseUrl: server.baseUrl, model: 'gemini-fake', apiKey, requestPolicy: { firstTokenMs: 2000, idleMs: 1000, overallMs: 10_000, maxAttempts: 1 } })
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected failure') }, (error: unknown) => error as { category: string })

describe('Gemini native adapter', () => {
  it('uses the native protocol for Google profiles unless the OpenAI-compatibility layer is requested', () => {
    expect(wireProtocol({ providerId: 'google' })).toBe('gemini')
    expect(wireProtocol({ providerId: 'google', additionalFields: { api: 'openai-compatible' } })).toBe('openai-chat')
    expect(wireProtocol({ providerId: 'openrouter' })).toBe('openai-chat')
    expect(geminiRoot('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  it('streams text with the key in a header, never in the URL', async () => {
    server.enqueue(gemini.stream([gemini.text('Hel'), gemini.text('lo', 'STOP'), gemini.usage(9, 2)]))
    const events: GatewayStreamEvent[] = []
    const response = await new ModelGateway().run({ connection: connection(), messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }], signal: new AbortController().signal, onEvent: event => events.push(event) })
    expect(response).toMatchObject({ text: 'Hello', finish: 'stop', usage: { inputTokens: 9, outputTokens: 2 } })
    const request = server.requests[0]!
    expect(request.path).toBe('/v1beta/models/gemini-fake:streamGenerateContent')
    expect(request.query).toBe('alt=sse')
    expect(request.headers['x-goog-api-key']).toBe(apiKey)
    expect(request.query).not.toContain(apiKey)
    expect(request.json).toMatchObject({ systemInstruction: { parts: [{ text: 'Be brief.' }] }, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
  })

  it('returns function calls as normalized tool calls and sanitizes the tool schema', async () => {
    server.enqueue(gemini.stream([gemini.text('Reading.'), gemini.call('read_file', { path: 'src/a.ts' }, 'fc-1')]))
    const response = await new ModelGateway().run({ connection: connection(), messages: [{ role: 'user', content: 'read' }], tools, signal: new AbortController().signal })
    expect(response.toolCalls).toEqual([{ id: 'fc-1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }])
    expect(response.finish).toBe('tool_calls')
    const declaration = (server.requests[0]!.json as { tools: Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }> }).tools[0]!.functionDeclarations[0]!
    expect(declaration.parameters).not.toHaveProperty('additionalProperties')
  })

  it('maps tool results back to functionResponse parts by call id', () => {
    const body = buildGeminiBody({
      maxOutput: 100, tools: [],
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'file text' },
        { role: 'user', content: 'thanks' },
      ],
    }) as { contents: Array<{ role: string; parts: unknown[] }> }
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'read it' }] },
      { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read_file', args: { path: 'a' } } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'read_file', response: { content: 'file text' } } }, { text: 'thanks' }] },
    ])
  })

  it('separates thought parts as reasoning', async () => {
    server.enqueue(gemini.stream([gemini.thought('planning'), gemini.text('answer', 'STOP')]))
    expect(await new ModelGateway().run({ connection: connection(), messages: [], signal: new AbortController().signal })).toMatchObject({ reasoning: 'planning', text: 'answer' })
  })

  it('classifies an invalid key (HTTP 400 API_KEY_INVALID) as INVALID_API_KEY', async () => {
    server.enqueue(gemini.error(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID'))
    expect((await failure(new ModelGateway().run({ connection: connection(), messages: [], signal: new AbortController().signal }))).category).toBe('INVALID_API_KEY')
  })

  it('reports MALFORMED_FUNCTION_CALL as TOOL_CALL_MALFORMED and unknown tools likewise', async () => {
    server.enqueue(gemini.stream([gemini.finish('MALFORMED_FUNCTION_CALL')]), gemini.stream([gemini.call('rm_rf', {})]))
    expect((await failure(new ModelGateway().run({ connection: connection(), messages: [], tools, signal: new AbortController().signal }))).category).toBe('TOOL_CALL_MALFORMED')
    expect((await failure(new ModelGateway().run({ connection: connection(), messages: [], tools, signal: new AbortController().signal }))).category).toBe('TOOL_CALL_MALFORMED')
  })

  it('maps safety blocks to finish=content_filter and empty output to STREAM_MALFORMED', async () => {
    server.enqueue(gemini.stream([gemini.finish('SAFETY')]), gemini.stream([gemini.usage(1, 0)]))
    expect((await new ModelGateway().run({ connection: connection(), messages: [], signal: new AbortController().signal })).finish).toBe('content_filter')
    expect((await failure(new ModelGateway().run({ connection: connection(), messages: [], signal: new AbortController().signal }))).category).toBe('STREAM_MALFORMED')
  })

  it('reports a dropped stream as STREAM_INTERRUPTED after content was delivered', async () => {
    server.enqueue(gemini.stream([gemini.text('partial')], { disconnect: true }))
    expect((await failure(new ModelGateway().run({ connection: connection(), messages: [], signal: new AbortController().signal }))).category).toBe('STREAM_INTERRUPTED')
  })

  it('uses generateContent for non-streamed calls', async () => {
    server.enqueue(gemini.json(gemini.call('read_file', { path: 'b' })))
    const response = await new ModelGateway().run({ connection: connection(), messages: [], tools, signal: new AbortController().signal, stream: false })
    expect(server.requests[0]!.path).toBe('/v1beta/models/gemini-fake:generateContent')
    expect(response.toolCalls[0]).toMatchObject({ name: 'read_file', arguments: '{"path":"b"}' })
  })

  it('lists only generateContent models with their token limits', async () => {
    await server.close()
    server = await startFakeGeminiServer([
      { name: 'models/gemini-a', displayName: 'Gemini A', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'], thinking: true },
      { name: 'models/embedding-b', supportedGenerationMethods: ['embedContent'] },
    ])
    expect(await new ModelGateway().listModels(connection())).toEqual([{ id: 'gemini-a', displayName: 'Gemini A', contextWindow: 1_048_576, maxOutput: 65_536, supportsReasoning: true }])
  })
})
