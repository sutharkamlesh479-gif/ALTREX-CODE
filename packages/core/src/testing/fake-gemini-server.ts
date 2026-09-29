import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

// A real loopback HTTP server speaking the Gemini v1beta REST API (models.list, generateContent,
// streamGenerateContent?alt=sse), scripted per test. Test infrastructure only.

export type GeminiRequest = { method: string; path: string; query: string; headers: Record<string, string | string[] | undefined>; json: Record<string, unknown> | null }
export type GeminiReply = (response: ServerResponse) => Promise<void> | void
export type FakeGeminiServer = { baseUrl: string; requests: GeminiRequest[]; enqueue(...replies: GeminiReply[]): void; close(): Promise<void> }

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const gemini = {
  text: (text: string, finishReason?: string) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] }),
  thought: (text: string) => ({ candidates: [{ content: { role: 'model', parts: [{ text, thought: true }] } }] }),
  call: (name: string, args: Record<string, unknown>, id?: string, finishReason = 'STOP') => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args, ...(id ? { id } : {}) } }] }, finishReason }] }),
  finish: (finishReason: string) => ({ candidates: [{ content: { role: 'model', parts: [] }, finishReason }] }),
  usage: (prompt: number, output: number) => ({ candidates: [], usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: output } }),

  /** SSE stream of GenerateContentResponse chunks (no [DONE]; the stream simply ends). */
  stream: (chunks: unknown[], options: { disconnect?: boolean } = {}): GeminiReply => async response => {
    response.socket?.setNoDelay(true)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const chunk of chunks) { response.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`); await pause(5) }
    if (options.disconnect) { await pause(10); response.socket?.destroy(); return }
    response.end()
  },
  json: (body: unknown, status = 200): GeminiReply => response => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) },
  error: (status: number, message: string, statusText = 'INVALID_ARGUMENT', reason?: string): GeminiReply =>
    gemini.json({ error: { code: status, message, status: statusText, ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } : {}) } }, status),
}

export async function startFakeGeminiServer(models: unknown[] = [{ name: 'models/gemini-fake', inputTokenLimit: 1_000_000, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] }]): Promise<FakeGeminiServer> {
  const queue: GeminiReply[] = [], requests: GeminiRequest[] = [], sockets = new Set<Socket>()
  const server = createServer((incoming, response) => {
    let body = ''
    incoming.on('data', chunk => { body += String(chunk) })
    incoming.on('end', () => {
      const [path = '/', query = ''] = (incoming.url ?? '/').split('?')
      let json: Record<string, unknown> | null = null
      try { json = body ? JSON.parse(body) as Record<string, unknown> : null } catch { json = null }
      const recorded: GeminiRequest = { method: incoming.method ?? 'GET', path, query, headers: incoming.headers, json }
      if (recorded.method === 'GET' && path === '/v1beta/models') { gemini.json({ models })(response); return }
      requests.push(recorded)
      void Promise.resolve((queue.shift() ?? gemini.error(500, 'No scripted reply.', 'INTERNAL'))(response)).catch(() => response.destroy())
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fake Gemini server did not bind.')
  return {
    // Stored like real profiles: the OpenAI-compatibility path, from which the native root is derived.
    baseUrl: `http://127.0.0.1:${address.port}/v1beta/openai`,
    requests,
    enqueue: (...replies) => { queue.push(...replies) },
    close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }),
  }
}
