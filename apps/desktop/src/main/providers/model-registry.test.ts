import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelRegistry, RoleRouter } from './model-registry'
import { ProviderFailure, type ProviderHealthState } from './request-manager'
import type { ModelProvider, ProviderCompletionInput, ProviderRuntimeConnection } from './model-provider'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const connection = (providerId: 'groq' | 'nvidia' | 'openrouter', model: string): ProviderRuntimeConnection => ({ providerId, model, baseUrl: `https://${providerId}.example/v1`, apiKey: 'secret' })

describe('capability-first cross-provider routing', () => {
  it('filters a tool-incompatible model before sending the request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-models-')); roots.push(root)
    const registry = new ModelRegistry(join(root, 'models.json')), incompatible = connection('groq', 'text-only'), capable = connection('nvidia', 'tool-model')
    registry.observeCapabilities(incompatible, { supportsChat: true, supportsTools: false })
    registry.observeCapabilities(capable, { supportsChat: true, supportsTools: true })
    const complete = vi.fn(async (input: ProviderCompletionInput) => ({ content: input.connection.model, toolCalls: [] }))
    const provider = { protocol: 'test', complete, stream: vi.fn(), healthCheck: vi.fn(), listModels: vi.fn() } as unknown as ModelProvider
    const result = await new RoleRouter(provider, [incompatible, capable], registry).complete('Coding Agent', [{ role: 'user', content: 'edit' }], [{}], new AbortController().signal, () => undefined)
    expect(result.connection.model).toBe('tool-model')
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('marks quota exhausted provider-wide and continues on another provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-fallback-')); roots.push(root)
    const registry = new ModelRegistry(join(root, 'models.json')), groqA = connection('groq', 'a'), groqB = connection('groq', 'b'), nvidia = connection('nvidia', 'c')
    for (const item of [groqA, groqB, nvidia]) registry.observeCapabilities(item, { supportsChat: true, supportsTools: true })
    let groqState: ProviderHealthState = 'HEALTHY'
    const complete = vi.fn(async (input: ProviderCompletionInput) => {
      if (input.connection.providerId === 'groq') { groqState = 'QUOTA_EXHAUSTED'; throw new ProviderFailure('Quota exhausted.', 'quota-exhausted', false, 429, 0, undefined, 'QUOTA_EXHAUSTED', 'fixture', input.connection) }
      return { content: 'continued', toolCalls: [] }
    })
    const recordFallback = vi.fn()
    const provider = { protocol: 'test', complete, stream: vi.fn(), healthCheck: vi.fn(), listModels: vi.fn(), recordFallback, providerHealth: (item: ProviderRuntimeConnection) => ({ state: item.providerId === 'groq' ? groqState : 'HEALTHY' as ProviderHealthState, active: 0, queued: 0 }) } as unknown as ModelProvider
    const result = await new RoleRouter(provider, [groqA, groqB, nvidia], registry).complete('Coding Agent', [{ role: 'user', content: 'continue task' }], [{}], new AbortController().signal, () => undefined)
    expect(result.connection.providerId).toBe('nvidia')
    expect(complete.mock.calls.map(call => call[0].connection.model)).toEqual(['a', 'c'])
    expect(recordFallback).toHaveBeenCalledWith(groqA, nvidia)
  })

  it('keeps later providers in a bounded fallback set even when earlier providers have many models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-diverse-')); roots.push(root)
    const registry = new ModelRegistry(join(root, 'models.json'))
    const candidates = [...Array.from({ length: 6 }, (_, index) => connection('groq', `g${index}`)), ...Array.from({ length: 6 }, (_, index) => connection('nvidia', `n${index}`)), connection('openrouter', 'working')]
    for (const item of candidates) registry.observeCapabilities(item, { supportsChat: true, supportsTools: true })
    const complete = vi.fn(async (input: ProviderCompletionInput) => {
      if (input.connection.providerId !== 'openrouter') throw new ProviderFailure('Unavailable.', 'unavailable', false, 503, 0, undefined, 'PROVIDER_SERVER_ERROR', 'fixture', input.connection)
      return { content: 'done', toolCalls: [] }
    })
    const provider = { protocol: 'test', complete, stream: vi.fn(), healthCheck: vi.fn(), listModels: vi.fn(), providerHealth: () => ({ state: 'HEALTHY' as ProviderHealthState, active: 0, queued: 0 }) } as unknown as ModelProvider
    const result = await new RoleRouter(provider, candidates, registry).complete('Coding Agent', [{ role: 'user', content: 'edit' }], [{}], new AbortController().signal, () => undefined)
    expect(result.connection.providerId).toBe('openrouter')
    // Phase 4: fallbacks are provider-diverse (best model of each other provider first), so the working
    // provider is reached after one attempt per failing provider instead of exhausting three of each.
    expect(complete.mock.calls.map(call => call[0].connection.providerId)).toEqual(['groq', 'nvidia', 'openrouter'])
    expect(complete.mock.calls.filter(call => call[0].connection.providerId === 'groq').length).toBeLessThanOrEqual(3)
  })
})
