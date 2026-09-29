import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderFailure, RequestManager, type Transport } from './request-manager'
import type { ProviderRuntimeConnection } from './model-provider'

// Characterization of retry, back-off and circuit behaviour in the CURRENT RequestManager, driven by
// fake timers so waits are asserted exactly. PROVIDER_SPEC.md §5.1/§7.3 define the V4 policy; rows
// marked "V4 change" are intentional future differences.

const connection: ProviderRuntimeConnection = {
  providerId: 'openrouter', baseUrl: 'https://fake.invalid/v1', model: 'm', apiKey: 'sk-characterization-key',
  requestPolicy: { maxAttempts: 2, firstTokenMs: 60_000, overallMs: 600_000 },
}
const errorBody = (message: string) => JSON.stringify({ error: { message } })
const respond = (...responses: Array<() => Response>) => {
  const transport = vi.fn<Transport>(async () => (responses.shift() ?? (() => new Response('OK')))())
  return transport
}
const run = (manager: RequestManager, overrides: Partial<ProviderRuntimeConnection> = {}, onStatus?: (message: string) => void) =>
  manager.execute({ connection: { ...connection, ...overrides }, messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, stream: false, consume: response => response.text(), ...(onStatus ? { onStatus } : {}) })
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('RequestManager retry and circuit behaviour (characterization)', () => {
  it('honours Retry-After ≤ 30 s exactly once, then succeeds', async () => {
    const transport = respond(() => new Response(errorBody('Rate limit reached'), { status: 429, headers: { 'Retry-After': '2' } }))
    const pending = settle(run(new RequestManager(transport)))
    await vi.advanceTimersByTimeAsync(1999)
    expect(transport).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).value).toBe('OK')
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('does not wait for a Retry-After longer than 30 s and cools the provider down', async () => {
    const manager = new RequestManager(respond(() => new Response(errorBody('Rate limit reached'), { status: 429, headers: { 'Retry-After': '60' } })))
    const statuses: string[] = []
    const { error } = await settle(run(manager, {}, message => statuses.push(message)))
    expect(error).toMatchObject({ category: 'RATE_LIMITED' })
    expect(statuses.at(-1)).toContain('Falling back without another identical request')
    expect(manager.health(connection).state).toBe('RATE_LIMITED')
    expect(manager.isProviderAvailable(connection)).toBe(false)
    await vi.advanceTimersByTimeAsync(60_001)
    expect(manager.isProviderAvailable(connection)).toBe(true)
  })

  it('retries a transient 503 once after 1.00–1.25 s of jittered back-off', async () => {
    const transport = respond(() => new Response('', { status: 503 }))
    const pending = settle(run(new RequestManager(transport)))
    await vi.advanceTimersByTimeAsync(999)
    expect(transport).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(251)
    expect((await pending).value).toBe('OK')
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('latches quota exhaustion and rejects later requests without contacting the provider', async () => {
    const transport = respond(() => new Response(errorBody('insufficient credits'), { status: 429 }))
    const manager = new RequestManager(transport)
    expect((await settle(run(manager))).error).toMatchObject({ category: 'QUOTA_EXHAUSTED' })
    expect(transport).toHaveBeenCalledTimes(1)
    const later = await settle(run(manager))
    expect(later.error).toMatchObject({ category: 'QUOTA_EXHAUSTED' })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(manager.health(connection).state).toBe('QUOTA_EXHAUSTED')
  })

  it('latches a rejected key as AUTH_ERROR (Phase 3; was shown as OFFLINE) until the provider is retested', async () => {
    const transport = respond(() => new Response(errorBody('Incorrect API key provided'), { status: 401 }))
    const manager = new RequestManager(transport)
    expect(manager.health(connection).state).toBe('UNKNOWN')
    expect((await settle(run(manager))).error).toMatchObject({ category: 'INVALID_API_KEY' })
    expect(transport).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(manager.health(connection).state).toBe('AUTH_ERROR')
    const later = await settle(run(manager))
    expect(later.error).toMatchObject({ category: 'AUTH_ERROR' })
    expect(transport).toHaveBeenCalledTimes(1)
    manager.resetProvider(connection)
    expect(manager.health(connection).state).toBe('UNKNOWN')
    expect((await settle(run(manager))).value).toBe('OK')
    expect(manager.health(connection).state).toBe('HEALTHY')
  })

  it('opens the circuit after 3 consecutive server failures (Phase 3; was 2), half-opens after 30 s, and closes on success', async () => {
    const transport = respond(...Array.from({ length: 3 }, () => () => new Response('', { status: 500 })))
    const manager = new RequestManager(transport)
    const single = { requestPolicy: { ...connection.requestPolicy, maxAttempts: 1 } }
    await settle(run(manager, single))
    await settle(run(manager, single))
    expect(manager.health(connection).state).toBe('DEGRADED')
    await settle(run(manager, single))
    expect(manager.health(connection).state).toBe('OFFLINE')
    await vi.advanceTimersByTimeAsync(30_001)
    expect(manager.health(connection).state).toBe('DEGRADED')
    expect((await settle(run(manager, single))).value).toBe('OK')
    expect(manager.health(connection).state).toBe('HEALTHY')
  })

  it('enforces the overall request deadline even while a response never arrives', async () => {
    const transport = vi.fn<Transport>((_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))))
    const pending = settle(run(new RequestManager(transport), { requestPolicy: { overallMs: 5000, firstTokenMs: 60_000, maxAttempts: 1 } }))
    await vi.advanceTimersByTimeAsync(5000)
    const { error } = await pending
    expect(error).toBeInstanceOf(ProviderFailure)
    expect(error).toMatchObject({ category: 'TIMEOUT', technicalDetails: 'Overall deadline exceeded.' })
  })

  it('records sanitized metrics for every attempt', async () => {
    const manager = new RequestManager(respond(() => new Response(`${connection.apiKey} leaked in body`, { status: 400 })))
    await settle(run(manager))
    expect(manager.metrics).toHaveLength(1)
    expect(manager.metrics[0]).toMatchObject({ provider: 'openrouter', model: 'm', status: 'failed', httpStatus: 400, errorCategory: 'BAD_REQUEST', retries: 0 })
    expect(JSON.stringify(manager.metrics)).not.toContain(connection.apiKey)
  })
})
