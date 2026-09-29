import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

/**
 * A real loopback HTTP server that speaks the OpenAI chat-completions protocol, scripted per test.
 * Used to exercise transports and adapters against real sockets, real SSE framing and real failures
 * without network access, API keys, or quota. Test infrastructure only.
 */

export type RecordedRequest = {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: string
  /** Parsed JSON body, or null. */
  json: Record<string, unknown> | null
  /** True once the client closed the connection before the response finished. */
  aborted: boolean
}

export type FakeReply = (request: RecordedRequest, response: ServerResponse) => Promise<void> | void

export type FakeOpenAiServer = {
  /** e.g. http://127.0.0.1:53211/v1 */
  baseUrl: string
  /** Every /chat/completions request received, in order. */
  requests: RecordedRequest[]
  /** Queue replies for successive /chat/completions requests (FIFO). */
  enqueue(...replies: FakeReply[]): void
  setModels(models: Array<Record<string, unknown>>): void
  close(): Promise<void>
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function frame(data: unknown, crlf = false): string {
  const newline = crlf ? '\r\n' : '\n'
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}${newline}${newline}`
}

function sseHeaders(response: ServerResponse): void {
  response.socket?.setNoDelay(true)
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
}

const textDelta = (content: string) => ({ choices: [{ index: 0, delta: { content } }] })

/** Reply builders. Each returns a FakeReply for `enqueue`. */
export const reply = {
  json: (body: unknown, status = 200, headers: Record<string, string> = {}): FakeReply => (_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    response.end(JSON.stringify(body))
  },

  completion: (options: { content?: string | null; toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>; finishReason?: string } = {}): FakeReply => reply.json({
    id: 'chatcmpl-fake', object: 'chat.completion',
    choices: [{
      index: 0,
      finish_reason: options.finishReason ?? (options.toolCalls?.length ? 'tool_calls' : 'stop'),
      message: {
        role: 'assistant',
        content: options.content === undefined ? (options.toolCalls?.length ? null : 'OK') : options.content,
        ...(options.toolCalls?.length ? { tool_calls: options.toolCalls.map((call, index) => ({ id: call.id ?? `call_${index}`, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) } })) } : {}),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }),

  /** Streams text deltas. `splitFrames` writes each SSE frame in two TCP writes split mid-JSON. */
  stream: (chunks: string[], options: { crlf?: boolean; keepAlive?: boolean; splitFrames?: boolean; done?: boolean; delayMs?: number } = {}): FakeReply => async (_request, response) => {
    sseHeaders(response)
    for (const chunk of chunks) {
      if (options.keepAlive) response.write(': keep-alive\n\n')
      const data = frame(textDelta(chunk), options.crlf)
      if (options.splitFrames) {
        const middle = Math.floor(data.length / 2)
        response.write(data.slice(0, middle)); await pause(options.delayMs ?? 15); response.write(data.slice(middle))
      } else response.write(data)
      await pause(options.delayMs ?? 5)
    }
    if (options.done !== false) response.write(frame('[DONE]', options.crlf))
    response.end()
  },

  /** Streams one tool call with its JSON arguments split across `splitArgsInto` deltas. */
  streamToolCall: (call: { id?: string; name: string; arguments: unknown }, splitArgsInto = 2): FakeReply => async (_request, response) => {
    sseHeaders(response)
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
    const size = Math.ceil(args.length / splitArgsInto)
    response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id ?? 'call_0', type: 'function', function: { name: call.name, arguments: '' } }] } }] }))
    for (let offset = 0; offset < args.length; offset += size) {
      await pause(5)
      response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(offset, offset + size) } }] } }] }))
    }
    response.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
    response.write(frame('[DONE]'))
    response.end()
  },

  /**
   * Raw SSE frames (objects are JSON-encoded). `end`: 'done' sends [DONE]; 'eof' just closes;
   * 'disconnect' destroys the socket; 'stall' goes silent. Frames split mid-frame when `splitFrames`.
   */
  frames: (frames: Array<unknown>, options: { end?: 'done' | 'eof' | 'disconnect' | 'stall'; delayMs?: number; splitFrames?: boolean } = {}): FakeReply => async (_request, response) => {
    sseHeaders(response)
    for (const data of frames) {
      const encoded = frame(data)
      if (options.splitFrames) { const middle = Math.floor(encoded.length / 2); response.write(encoded.slice(0, middle)); await pause(options.delayMs ?? 5); response.write(encoded.slice(middle)) }
      else response.write(encoded)
      await pause(options.delayMs ?? 5)
    }
    const end = options.end ?? 'done'
    if (end === 'done') { response.write(frame('[DONE]')); response.end() }
    else if (end === 'eof') response.end()
    else if (end === 'disconnect') { await pause(10); response.socket?.destroy() }
    else await new Promise<void>(() => undefined)
  },

  /** An error response with an OpenAI-style error body. */
  status: (status: number, message = `HTTP ${status}`, headers: Record<string, string> = {}): FakeReply =>
    reply.json({ error: { message, type: 'fake_error', code: String(status) } }, status, headers),

  /** Accepts the request and never sends headers. */
  hang: (): FakeReply => () => new Promise<void>(() => undefined),

  /** Sends some deltas, then goes silent without ending the response. */
  stallAfter: (chunks: string[]): FakeReply => async (_request, response) => {
    sseHeaders(response)
    for (const chunk of chunks) { response.write(frame(textDelta(chunk))); await pause(5) }
    await new Promise<void>(() => undefined)
  },

  /** Sends frames whose data is not valid JSON, then [DONE]. */
  malformed: (): FakeReply => (_request, response) => {
    sseHeaders(response)
    response.write('data: {"choices": [ {"delta": \n\n')
    response.write('data: not-json-at-all\n\n')
    response.write(frame('[DONE]'))
    response.end()
  },

  /** Sends some deltas, then destroys the socket mid-stream. */
  disconnectAfter: (chunks: string[]): FakeReply => async (_request, response) => {
    sseHeaders(response)
    for (const chunk of chunks) { response.write(frame(textDelta(chunk))); await pause(5) }
    await pause(10)
    response.socket?.destroy()
  },
}

export async function startFakeOpenAiServer(options: { models?: Array<Record<string, unknown>>; routes?: Record<string, FakeReply>; modelsStatus?: number } = {}): Promise<FakeOpenAiServer> {
  let models = options.models ?? [{ id: 'fake-coder', object: 'model' }]
  const queue: FakeReply[] = []
  const requests: RecordedRequest[] = []
  const sockets = new Set<Socket>()

  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let json: Record<string, unknown> | null = null
      try { json = body ? JSON.parse(body) as Record<string, unknown> : null } catch { json = null }
      const path = (incoming.url ?? '/').split('?')[0]!
      const recorded: RecordedRequest = { method: incoming.method ?? 'GET', path, headers: incoming.headers, body, json, aborted: false }
      response.on('close', () => { if (!response.writableFinished) recorded.aborted = true })

      const custom = options.routes?.[`${recorded.method} ${path}`]
      if (custom) { void Promise.resolve(custom(recorded, response)).catch(() => response.destroy()); return }
      if (recorded.method === 'GET' && path === '/v1/models') {
        if (options.modelsStatus) reply.status(options.modelsStatus, 'Not Found')(recorded, response)
        else reply.json({ object: 'list', data: models })(recorded, response)
        return
      }
      if (recorded.method === 'POST' && path === '/v1/chat/completions') {
        requests.push(recorded)
        const next = queue.shift() ?? reply.status(500, 'No scripted reply for this request.')
        void Promise.resolve(next(recorded, response)).catch(() => response.destroy())
        return
      }
      reply.status(404, `Unknown path ${path}`)(recorded, response)
    })
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fake server did not bind a TCP port.')

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    enqueue: (...replies) => { queue.push(...replies) },
    setModels: value => { models = value },
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}
