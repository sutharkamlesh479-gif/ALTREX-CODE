import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestManager, classifyFailure, type Transport } from './request-manager'
import { budgetContext } from './context-manager'
import { OpenAiCompatibleProvider } from './openai-compatible'
const connection = { providerId: 'groq' as const, baseUrl: 'https://example.invalid/v1', model: 'configured-model', apiKey: 'never-log-this', requestPolicy: { inputTokens: 6000 } }
const messages = [{ role: 'system' as const, content: `Required architecture.\nRepository context:\n${'optional code '.repeat(6000)}` }, { role: 'user' as const, content: 'Fix cart. Preserve authentication.' }]
afterEach(() => vi.useRealTimers())
describe('request reliability', () => {
  it('compacts before sending and changes a 413 payload before retrying', async () => {
    const bodies: string[] = []
    const transport: Transport = async (_url, init) => { bodies.push(String(init.body)); return bodies.length < 2 ? new Response('context limit 6,000 tokens', { status: 413 }) : new Response('OK') }
    const manager = new RequestManager(transport)
    await manager.execute({ connection, messages, signal: new AbortController().signal, stream: false, consume: r => r.text() })
    expect(bodies).toHaveLength(2)
    expect(new Set(bodies).size).toBe(2)
    expect(bodies[1]!.length).toBeLessThan(bodies[0]!.length)
    expect(bodies[0]).toContain('Preserve authentication')
    expect(JSON.stringify(manager.metrics)).not.toContain(connection.apiKey)
    expect(manager.metrics[0]?.retries).toBe(1)
  })
  it('never silently drops a mandatory oversized contract', () => {
    expect(() => budgetContext([{ role: 'user', content: 'requirement '.repeat(3000) }], [], 1024)).toThrow('requirements were not silently discarded')
  })
  it('classifies failures and honors cancellation during Retry-After', async () => {
    expect(classifyFailure(429, '', '60').retryAfterMs).toBe(60000)
    expect(classifyFailure(401, 'secret', null).retryable).toBe(false)
    expect(classifyFailure(503, '', null).kind).toBe('unavailable')
    expect(classifyFailure(410, '', null).kind).toBe('model-unavailable')
    expect(classifyFailure(400, 'custom-secret-value echoed', null, { apiKey: 'custom-secret-value' }).technicalDetails).not.toContain('custom-secret-value')
    const controller = new AbortController(), transport = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }))
    const manager = new RequestManager(transport)
    const pending = manager.execute({ connection, messages: [{ role: 'user', content: 'hi' }], signal: controller.signal, stream: false, consume: r => r.text(), onStatus: () => controller.abort() })
    await expect(pending).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(manager.metrics[0]?.status).toBe('cancelled')
  })
  it('keeps a valid stream alive beyond 45 seconds and observes idle timeout', async () => {
    vi.useFakeTimers()
    const transport: Transport = async (_url, init) => new Response(new ReadableStream({ start(stream) {
      const first = setTimeout(() => stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')), 50000)
      const end = setTimeout(() => { stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); stream.close() }, 65000)
      init.signal?.addEventListener('abort', () => { clearTimeout(first); clearTimeout(end); stream.error(init.signal?.reason) })
    } }))
    const provider = new OpenAiCompatibleProvider(undefined, new RequestManager(transport))
    const onDelta = vi.fn()
    const pending = provider.stream({ connection, messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, onDelta })
    await vi.advanceTimersByTimeAsync(65001)
    await pending
    expect(onDelta).toHaveBeenCalledWith('Hello')
  })
  it('serializes provider requests and cancels queued work', async () => {
    const controllers = [new AbortController(), new AbortController()]
    const transport = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))))
    const manager = new RequestManager(transport)
    const pending = controllers.map(controller => manager.execute({ connection, messages: [{ role: 'user', content: 'hi' }], signal: controller.signal, stream: false, consume: r => r.text() }).catch(() => undefined))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(transport).toHaveBeenCalledTimes(1)
    controllers.forEach(controller => controller.abort())
    await Promise.all(pending)
    expect(manager.health(`${connection.providerId}:${connection.baseUrl}`).active).toBe(0)
  })
})
