import { afterEach, describe, expect, it } from 'vitest'
import { reply, startFakeOpenAiServer, type FakeOpenAiServer } from './fake-openai-server'

let server: FakeOpenAiServer | undefined
afterEach(async () => { await server?.close(); server = undefined })

const chat = (body: object, signal?: AbortSignal) => fetch(`${server!.baseUrl}/chat/completions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
})

describe('fake OpenAI-compatible server (test infrastructure)', () => {
  it('lists models and records chat requests', async () => {
    server = await startFakeOpenAiServer({ models: [{ id: 'fake-a' }, { id: 'fake-b' }] })
    expect(await (await fetch(`${server.baseUrl}/models`)).json()).toMatchObject({ data: [{ id: 'fake-a' }, { id: 'fake-b' }] })
    server.enqueue(reply.completion({ content: 'hi' }))
    const response = await chat({ model: 'fake-a', messages: [] })
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'hi' } }] })
    expect(server.requests[0]).toMatchObject({ method: 'POST', json: { model: 'fake-a' } })
    expect(server.requests[0]!.headers.authorization).toBe('Bearer sk-test')
  })

  it('streams SSE frames in order and fails unscripted requests loudly', async () => {
    server = await startFakeOpenAiServer()
    server.enqueue(reply.stream(['a', 'b'], { keepAlive: true, splitFrames: true }))
    const text = await (await chat({ stream: true })).text()
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'))
    expect(text).toContain(': keep-alive')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
    expect((await chat({})).status).toBe(500)
  })

  it('observes client disconnects from hanging responses and closes cleanly', async () => {
    server = await startFakeOpenAiServer()
    server.enqueue(reply.hang())
    const controller = new AbortController()
    const pending = chat({}, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await expect(pending).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.requests[0]!.aborted).toBe(true)
  })
})
