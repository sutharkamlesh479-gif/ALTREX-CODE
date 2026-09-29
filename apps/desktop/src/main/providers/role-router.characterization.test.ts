import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRegistry, RoleRouter } from './model-registry'
import { ProviderFailure } from './request-manager'
import type { ModelProvider, ProviderCompletion, ProviderCompletionInput, ProviderRuntimeConnection, ProviderStreamInput } from './model-provider'

// Characterization of the CURRENT role router fallback behaviour (replaced by the pure router in
// Phase 4, PROVIDER_SPEC.md §8). Pins ordering, continuation, and stop conditions.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
const registry = () => { const root = mkdtempSync(join(tmpdir(), 'altrex-router-')); roots.push(root); return new ModelRegistry(join(root, 'models.json')) }
const endpoint = (providerId: ProviderRuntimeConnection['providerId'], model: string): ProviderRuntimeConnection => ({ providerId, baseUrl: `https://${providerId}.invalid/v1`, model, apiKey: 'k' })

class ScriptedProvider implements ModelProvider {
  readonly protocol = 'test fixture'
  readonly completeCalls: ProviderCompletionInput[] = []
  readonly streamCalls: ProviderStreamInput[] = []
  readonly recordFallback = vi.fn()
  constructor(private readonly script: (connection: ProviderRuntimeConnection, input: ProviderCompletionInput | ProviderStreamInput) => Promise<ProviderCompletion | void>) {}
  async healthCheck() { return { ok: true, message: 'fixture', latencyMs: 0 } }
  async listModels() { return [] }
  async complete(input: ProviderCompletionInput) { this.completeCalls.push(input); return await this.script(input.connection, input) as ProviderCompletion }
  async stream(input: ProviderStreamInput) { this.streamCalls.push(input); await this.script(input.connection, input) }
}
const serverError = () => new ProviderFailure('The provider is temporarily unavailable.', 'unavailable', true, 503, 0, undefined, 'PROVIDER_SERVER_ERROR')

describe('RoleRouter fallback (characterization)', () => {
  it('falls back to the next candidate with a continuation note and records the fallback', async () => {
    const a = endpoint('openrouter', 'a'), b = endpoint('groq', 'b')
    const provider = new ScriptedProvider(async connection => { if (connection.model === 'a') throw serverError(); return { content: 'done', toolCalls: [] } })
    const models = registry(), statuses: string[] = []
    const result = await new RoleRouter(provider, [a, b], models).complete('Coder', [{ role: 'user', content: 'task' }], [], new AbortController().signal, status => statuses.push(status))
    expect(result.connection.model).toBe('b')
    expect(provider.completeCalls.map(call => call.connection.model)).toEqual(['a', 'b'])
    expect(provider.completeCalls[1]!.messages.at(-1)).toMatchObject({ role: 'system', content: expect.stringContaining('TASK CONTINUATION: openrouter/a failed') })
    expect(statuses).toContain('openrouter / a unavailable (PROVIDER_SERVER_ERROR). Switching to groq / b.')
    expect(provider.recordFallback).toHaveBeenCalledWith(a, b)
    expect(models.record(a).roleHistory.Coder).toMatchObject({ accepted: 0, failed: 1 })
    expect(models.record(b).roleHistory.Coder).toMatchObject({ accepted: 1, failed: 0 })
  })

  it('ranks candidates by per-role success history, keeping input order on ties', () => {
    const a = endpoint('openrouter', 'a'), b = endpoint('groq', 'b'), c = endpoint('nvidia', 'c')
    const models = registry()
    for (let index = 0; index < 3; index++) models.observe(c, 'Reviewer', true, 10)
    models.observe(a, 'Reviewer', false, 10)
    const router = new RoleRouter(new ScriptedProvider(async () => ({ content: '', toolCalls: [] })), [a, b, c], models)
    expect(router.candidates('Reviewer').map(candidate => candidate.model)).toEqual(['c', 'b', 'a'])
    expect(router.candidates('Planner').map(candidate => candidate.model)).toEqual(['a', 'b', 'c'])
  })

  it('stops the chain immediately on cancellation', async () => {
    const controller = new AbortController()
    const provider = new ScriptedProvider(async () => { controller.abort(); throw new ProviderFailure('cancelled', 'cancelled', false) })
    await expect(new RoleRouter(provider, [endpoint('openrouter', 'a'), endpoint('groq', 'b')], registry()).complete('Coder', [], [], controller.signal, () => undefined)).rejects.toMatchObject({ category: 'CANCELLED' })
    expect(provider.completeCalls).toHaveLength(1)
  })

  it('marks a missing model unavailable so later requests skip it', async () => {
    const a = endpoint('openrouter', 'gone'), b = endpoint('openrouter', 'ok')
    const provider = new ScriptedProvider(async connection => {
      if (connection.model === 'gone') throw new ProviderFailure('missing', 'model-unavailable', false, 404, 0, undefined, 'MODEL_NOT_FOUND')
      return { content: 'fine', toolCalls: [] }
    })
    const router = new RoleRouter(provider, [a, b], registry())
    await router.complete('Coder', [], [], new AbortController().signal, () => undefined)
    await router.complete('Coder', [], [], new AbortController().signal, () => undefined)
    expect(provider.completeCalls.map(call => call.connection.model)).toEqual(['gone', 'ok', 'ok'])
  })

  it('never moves a stream to another model once text has been delivered', async () => {
    const provider = new ScriptedProvider(async (_connection, input) => { (input as ProviderStreamInput).onDelta('partial'); throw serverError() })
    const models = registry(), a = endpoint('openrouter', 'a'), b = endpoint('groq', 'b')
    for (const target of [a, b]) models.observeCapabilities(target, { supportsChat: true, supportsStreaming: true })
    const deltas: string[] = []
    await expect(new RoleRouter(provider, [a, b], models).stream('Ask', [], new AbortController().signal, () => undefined, delta => deltas.push(delta))).rejects.toMatchObject({ category: 'PROVIDER_SERVER_ERROR' })
    expect(provider.streamCalls).toHaveLength(1)
    expect(deltas).toEqual(['partial'])
  })

  it('throws the last failure when every candidate fails', async () => {
    const provider = new ScriptedProvider(async () => { throw serverError() })
    await expect(new RoleRouter(provider, [endpoint('openrouter', 'a'), endpoint('groq', 'b')], registry()).complete('Coder', [], [], new AbortController().signal, () => undefined)).rejects.toMatchObject({ category: 'PROVIDER_SERVER_ERROR' })
    expect(provider.completeCalls).toHaveLength(2)
  })
})
