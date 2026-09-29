import { createServer, type Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { OpenAiCompatibleProvider } from './openai-compatible'
import { gzipSync } from 'node:zlib'
const servers: Server[] = []
afterEach(() => servers.splice(0).forEach(server => { server.closeAllConnections(); server.close() }))
it('uses the real native HTTP transport for discovery, tiny generation, SSE and tool completions', async () => {
  const received: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'local-fixture' }] })); return }
    let body = ''; request.on('data', chunk => { body += String(chunk) }); request.on('end', () => {
      const data = JSON.parse(body) as Record<string, unknown>; received.push(data)
      if (data.stream) { response.setHeader('content-type', 'text/event-stream'); response.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'); return }
      response.setHeader('content-type', 'application/json'); response.setHeader('content-encoding', 'gzip'); response.end(gzipSync(JSON.stringify({ choices: [{ message: data.tools ? { content: '', tool_calls: [{ id: 'tool', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.js"}' } }] } : { content: 'OK' } }] })))
    })
  }); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address')
  const connection = { providerId: 'custom' as const, apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local-fixture' }, provider = new OpenAiCompatibleProvider()
  expect(await provider.listModels(connection)).toEqual(['local-fixture'])
  expect((await provider.healthCheck(connection)).ok).toBe(true)
  expect(received[0]?.max_tokens).toBe(64)
  let text = ''; await provider.stream({ connection, messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, onDelta: delta => { text += delta } }); expect(text).toBe('OK')
  const completion = await provider.complete({ connection, messages: [{ role: 'user', content: 'read file' }], signal: new AbortController().signal, tools: [{ type: 'function', function: { name: 'read_file' } }] })
  expect(completion.toolCalls[0]?.name).toBe('read_file')
})
