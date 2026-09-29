import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelRegistry, RoleRouter } from './model-registry'
import { ProviderFailure } from './request-manager'
import type { ModelProvider, ProviderCompletionInput, ProviderRuntimeConnection } from './model-provider'

// Phase 2: model turns stream by default. A model whose streamed tool calls are unreadable is
// recorded (supportsStreamingTools=false) and switched to non-streamed tool turns explicitly.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
const registry = () => { const root = mkdtempSync(join(tmpdir(), 'altrex-router-stream-')); roots.push(root); return new ModelRegistry(join(root, 'models.json')) }
const endpoint = (providerId: ProviderRuntimeConnection['providerId'], model: string): ProviderRuntimeConnection => ({ providerId, baseUrl: `https://${providerId}.invalid/v1`, model, apiKey: 'k' })
const tools = [{ type: 'function', function: { name: 'read_file' } }]
const call = { id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }

function provider(behaviour: (input: ProviderCompletionInput) => Promise<{ content: string; toolCalls: typeof call[] }>) {
  const calls: ProviderCompletionInput[] = []
  const fake: ModelProvider = {
    protocol: 'test', healthCheck: async () => ({ ok: true, message: '', latencyMs: 0 }), listModels: async () => [], stream: async () => undefined,
    complete: async input => { calls.push(input); return behaviour(input) },
  }
  return { fake, calls }
}

describe('RoleRouter streaming turns', () => {
  it('streams tool turns by default and records working streamed tool calls', async () => {
    const models = registry(), target = endpoint('groq', 'm')
    const { fake, calls } = provider(async () => ({ content: '', toolCalls: [call] }))
    await new RoleRouter(fake, [target], models).complete('Coder', [], tools, new AbortController().signal, () => undefined)
    expect(calls.map(input => input.stream)).toEqual([true])
    expect(models.record(target).supportsStreamingTools).toBe(true)
  })

  it('records unreadable streamed tool calls and repeats the turn non-streamed on the same model', async () => {
    const models = registry(), target = endpoint('openrouter', 'm'), statuses: string[] = []
    const { fake, calls } = provider(async input => {
      if (input.stream) throw new ProviderFailure('bad', 'invalid-request', false, 0, 0, undefined, 'TOOL_CALL_MALFORMED')
      return { content: '', toolCalls: [call] }
    })
    const router = new RoleRouter(fake, [target], models)
    const result = await router.complete('Coder', [], tools, new AbortController().signal, status => statuses.push(status))
    expect(result.completion.toolCalls).toEqual([call])
    expect(calls.map(input => input.stream)).toEqual([true, undefined])
    expect(models.record(target).supportsStreamingTools).toBe(false)
    expect(statuses.some(status => status.includes('non-streamed tool turns'))).toBe(true)

    await router.complete('Coder', [], tools, new AbortController().signal, () => undefined)
    expect(calls.at(-1)!.stream).toBeUndefined()
  })

  it('uses non-streamed tool turns for providers whose adapter declares the limitation (Ollama)', async () => {
    const models = registry(), target = endpoint('ollama', 'qwen')
    const { fake, calls } = provider(async () => ({ content: '', toolCalls: [call] }))
    await new RoleRouter(fake, [target], models).complete('Coder', [], tools, new AbortController().signal, () => undefined)
    expect(calls[0]!.stream).toBeUndefined()
    expect(models.record(target).supportsStreamingTools).toBe(false)
  })

  it('does not stream when a model is recorded as unable to stream at all', async () => {
    const models = registry(), target = endpoint('custom', 'm')
    models.observeCapabilities(target, { supportsChat: true, supportsStreaming: false })
    const { fake, calls } = provider(async () => ({ content: 'ok', toolCalls: [] }))
    await new RoleRouter(fake, [target], models).complete('Coder', [], [], new AbortController().signal, () => undefined)
    expect(calls[0]!.stream).toBeUndefined()
  })

  it('does not retry non-streamed for failures unrelated to stream readability', async () => {
    const models = registry(), target = endpoint('groq', 'm')
    const { fake, calls } = provider(async () => { throw new ProviderFailure('down', 'unavailable', true, 503, 0, undefined, 'PROVIDER_SERVER_ERROR') })
    await expect(new RoleRouter(fake, [target], models).complete('Coder', [], tools, new AbortController().signal, () => undefined)).rejects.toMatchObject({ category: 'PROVIDER_SERVER_ERROR' })
    expect(calls).toHaveLength(1)
    expect(models.record(target).supportsStreamingTools).toBeNull()
  })
})
