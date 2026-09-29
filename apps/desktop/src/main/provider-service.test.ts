import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const localAiMocks = vi.hoisted(() => ({
  unloadLocalModel: vi.fn(async () => undefined),
  resize: vi.fn(() => ({ toDataURL: () => 'data:image/png;base64,resized' })),
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromDataURL: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1920, height: 1080 }),
      resize: localAiMocks.resize,
    }),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
    getSelectedStorageBackend: () => 'dpapi',
  },
}))

vi.mock('./local-ai-service', () => ({
  ensureLocalAiServer: vi.fn(async () => undefined),
  pullLocalModel: vi.fn(async () => undefined),
  unloadLocalModel: localAiMocks.unloadLocalModel,
}))

import { ProviderService } from './provider-service'
import type { ChatStreamEvent, ProviderConnectionInput, ProviderTestResult } from '../shared/desktop-api'
import type { ProviderCompletionInput } from './providers/model-provider'

const roots: string[] = []
const input: ProviderConnectionInput = {
  providerId: 'nvidia',
  apiKey: 'nvapi-test-key',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  model: 'retired-model',
}

function createService(result: ProviderTestResult): ProviderService {
  const root = mkdtempSync(join(tmpdir(), 'altrex-provider-service-'))
  roots.push(root)
  const service = new ProviderService(join(root, 'provider.json'), join(root, 'runs'))
  const internal = service as unknown as { provider: { healthCheck: (connection: ProviderConnectionInput) => Promise<ProviderTestResult>; listModels: (connection: ProviderConnectionInput) => Promise<string[]> } }
  internal.provider.healthCheck = vi.fn(async () => result)
  internal.provider.listModels = vi.fn(async () => [])
  return service
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('provider connection storage', () => {
  it('saves a credential without falsely marking an unavailable model as connected', async () => {
    const service = createService({
      ok: false,
      message: 'The selected model or endpoint is unavailable.',
      latencyMs: 12,
      failureKind: 'model-unavailable',
      errorCategory: 'MODEL_UNAVAILABLE',
    })

    const status = await service.connect(input)

    expect(status).toMatchObject({ connected: false, providerId: 'nvidia', model: 'retired-model' })
    expect(status.warning).toContain('Connection saved')
    expect(service.getStatus()).toMatchObject({ connected: false, providerId: 'nvidia' })
    expect(service.getStatus().profiles?.[0]?.connectionState).toBe('MODEL_UNAVAILABLE')
  })

  it('does not save a credential rejected by provider authentication', async () => {
    const service = createService({
      ok: false,
      message: 'Authentication failed. Check the API key and provider permissions.',
      latencyMs: 8,
      failureKind: 'authentication',
    })

    await expect(service.connect(input)).rejects.toThrow('Authentication failed')
    expect(service.getStatus().connected).toBe(false)
  })

  it('shows quota and rate failures without calling them invalid credentials', async () => {
    const service = createService({ ok: false, message: 'The provider is temporarily rate limited.', latencyMs: 3, failureKind: 'rate-limit', errorCategory: 'RATE_LIMITED' })
    const status = await service.connect(input)
    expect(status.connected).toBe(false)
    expect(status.profiles?.[0]).toMatchObject({ connectionState: 'RATE_LIMITED', lastErrorCategory: 'RATE_LIMITED' })
    expect(status.warning).not.toContain('Invalid API key')
  })

  it('replaces a retired selected model with a discovered model before validating', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 3 })
    const internal = service as unknown as { provider: { listModels: ReturnType<typeof vi.fn>; healthCheck: ReturnType<typeof vi.fn> } }
    internal.provider.listModels.mockResolvedValue(['nvidia/nemotron-3-super-120b-a12b'])
    const status = await service.connect(input)

    expect(internal.provider.healthCheck).toHaveBeenCalledWith(expect.objectContaining({ model: 'nvidia/nemotron-3-super-120b-a12b' }))
    expect(status).toMatchObject({ connected: true, model: 'nvidia/nemotron-3-super-120b-a12b' })
    expect(status.profiles?.[0]?.connectionState).toBe('CONNECTED')
  })

  it('moves a newly connected Gemini key away from a paid preview model to stable Flash', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 3 })
    const internal = service as unknown as { provider: { listModels: ReturnType<typeof vi.fn>; healthCheck: ReturnType<typeof vi.fn> } }
    internal.provider.listModels.mockResolvedValue([
      'gemini-3.1-pro-preview-customtools',
      'gemini-3.8-flash',
      'gemini-3.1-flash-image',
    ])

    const status = await service.connect({
      providerId: 'google',
      apiKey: 'google-secret-key',
      baseUrl: '',
      model: 'models/gemini-3.1-pro-preview-customtools',
    })

    expect(internal.provider.healthCheck).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.8-flash' }))
    expect(status).toMatchObject({ connected: true, model: 'gemini-3.8-flash' })
  })

  it('requires both Cloudflare fields, pins the account endpoint, and never stores the raw token', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 4 })
    await expect(service.connect({ providerId: 'cloudflare', apiKey: 'cloudflare-secret-token', baseUrl: 'https://attacker.example/v1', model: '@cf/openai/gpt-oss-20b' })).rejects.toThrow('Account ID')

    const status = await service.connect({ providerId: 'cloudflare', apiKey: 'cloudflare-secret-token', baseUrl: 'https://attacker.example/v1', model: '@cf/openai/gpt-oss-20b', additionalFields: { accountId: 'account_1234' } })
    expect(status.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/account_1234/ai/v1')
    const credentialPath = (service as unknown as { credentialPath: string }).credentialPath
    expect(readFileSync(credentialPath, 'utf8')).not.toContain('cloudflare-secret-token')
  })

  it('detects Ollama without an API key and selects only an installed model', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 2 })
    const internal = service as unknown as { provider: { listModels: ReturnType<typeof vi.fn> } }
    internal.provider.listModels.mockResolvedValue(['qwen3:latest'])

    const status = await service.connect({ providerId: 'ollama', apiKey: '', baseUrl: 'https://attacker.example', model: '' })
    expect(status).toMatchObject({ connected: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:latest' })
    expect(status.profiles?.[0]?.keySuffix).toBeNull()
  })

  it('disconnects one provider while retaining another verified provider', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 2 })
    await service.connect({ providerId: 'google', apiKey: 'google-secret-key', baseUrl: '', model: 'gemini-3.8-flash' })
    await service.connect({ providerId: 'cerebras', apiKey: 'cerebras-secret-key', baseUrl: '', model: 'qwen-3.8-27b' })

    const status = service.disconnect('google')
    expect(status.connected).toBe(true)
    expect(status.profiles?.map(profile => profile.providerId)).toEqual(['cerebras'])
  })

  it('reuses an encrypted saved credential for a later connection test', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 2 })
    const internal = service as unknown as { provider: { healthCheck: ReturnType<typeof vi.fn> } }
    await service.connect({ providerId: 'google', apiKey: 'google-secret-key', baseUrl: '', model: 'gemini-3.8-flash' })
    internal.provider.healthCheck.mockClear()

    await service.test({ providerId: 'google', apiKey: '', baseUrl: '', model: 'gemini-3.8-flash' })
    expect(internal.provider.healthCheck).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'google-secret-key' }))
  })

  it('excludes configured but unverified providers from AUTO candidates', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 2 })
    const internal = service as unknown as {
      provider: { healthCheck: ReturnType<typeof vi.fn>; listModels: ReturnType<typeof vi.fn> }
      routedConnections: (prompt: string, selection: string) => Promise<ProviderConnectionInput[]>
    }
    internal.provider.healthCheck.mockImplementation(async (connection: ProviderConnectionInput) => connection.providerId === 'google'
      ? { ok: true, message: 'ready', latencyMs: 2 }
      : { ok: false, message: 'model unavailable', latencyMs: 2, failureKind: 'model-unavailable', errorCategory: 'MODEL_UNAVAILABLE' })
    await service.connect(input)
    await service.connect({ providerId: 'google', apiKey: 'google-secret-key', baseUrl: '', model: 'gemini-3.8-flash' })

    const candidates = await internal.routedConnections('write code', 'AUTO')
    expect([...new Set(candidates.map(candidate => candidate.providerId))]).toEqual(['google'])
  })

  it('routes Local AI mode exclusively through a verified Ollama model', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 2 })
    const internal = service as unknown as {
      provider: { listModels: ReturnType<typeof vi.fn> }
      routedConnections: (prompt: string, selection: string, providerFilter?: ProviderConnectionInput['providerId']) => Promise<ProviderConnectionInput[]>
    }
    internal.provider.listModels.mockImplementation(async (connection: ProviderConnectionInput) => connection.providerId === 'ollama' ? ['qwen2.5-coder:7b-instruct'] : ['gemini-3.8-flash'])
    await service.connect({ providerId: 'google', apiKey: 'google-secret-key', baseUrl: '', model: 'gemini-3.8-flash' })
    await service.connect({ providerId: 'ollama', apiKey: '', baseUrl: '', model: 'qwen2.5-coder:7b-instruct' })

    const candidates = await internal.routedConnections('Fix this repository', 'AUTO', 'ollama')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ providerId: 'ollama', model: 'qwen2.5-coder:7b-instruct' })
  })

  it('completes a local screenshot request using vision analysis and a text-only coding model', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 2 })
    const internal = service as unknown as {
      provider: { listModels: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn>; probeCapabilities: ReturnType<typeof vi.fn> }
    }
    const connection: ProviderConnectionInput = { providerId: 'ollama', apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b-instruct' }
    internal.provider.listModels.mockResolvedValue([connection.model, 'qwen2.5vl:3b'])
    internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsTools: true }))
    internal.provider.complete = vi.fn(async ({ connection: selected }: ProviderCompletionInput) => ({
      content: selected.model === 'qwen2.5vl:3b' ? 'The screenshot says: Model request failed.' : 'The screenshot shows a model routing error.',
      toolCalls: [],
    }))
    await service.connect(connection)
    service.models.observeCapabilities(connection, { supportsVision: false })
    const events: ChatStreamEvent[] = []
    await service.streamChat({
      requestId: 'local-screenshot', projectPath: roots.at(-1)!, mode: 'LOCAL', modelSelection: 'AUTO',
      messages: [{ role: 'user', content: 'What does this screenshot show?' }], attachments: [],
    }, '', [{ id: 'image-1', name: 'error.png', mimeType: 'image/png', size: 1024, kind: 'image', imageDataUrl: 'data:image/png;base64,original' }], event => events.push(event))

    expect(events.filter(event => event.type === 'error')).toEqual([])
    expect(events).toContainEqual({ requestId: 'local-screenshot', type: 'completed' })
    const calls = internal.provider.complete.mock.calls.map(([call]) => call as ProviderCompletionInput)
    expect(calls.map(call => call.connection.model)).toEqual(['qwen2.5vl:3b', connection.model])
    expect(calls.every(call => call.connection.providerId === 'ollama')).toBe(true)
    const codingContent = calls[1]!.messages.find(message => message.role === 'user')!.content
    expect(codingContent).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('The screenshot says: Model request failed.') })])
    expect(calls[1]!.tools.length).toBeGreaterThan(0)
    expect(internal.provider.probeCapabilities).not.toHaveBeenCalled()
  })

  it('converts a local image into vision analysis before the coding agent receives it', async () => {
    const service = createService({ ok: true, message: 'ready', latencyMs: 2 })
    const internal = service as unknown as {
      provider: { listModels: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> }
      describeLocalImages: (profile: unknown, attachments: Array<Record<string, unknown>>, prompt: string, signal: AbortSignal, emit: (event: unknown) => void) => Promise<Array<Record<string, unknown>>>
      readStoredProvider: () => unknown
    }
    internal.provider.listModels.mockResolvedValue(['qwen2.5-coder:7b-instruct', 'qwen2.5vl:3b'])
    internal.provider.complete = vi.fn(async () => ({ content: 'The screenshot shows the exact error: Model request failed.', toolCalls: [] }))
    await service.connect({ providerId: 'ollama', apiKey: '', baseUrl: '', model: 'qwen2.5-coder:7b-instruct' })

    const result = await internal.describeLocalImages(internal.readStoredProvider(), [{
      id: 'image-1', name: 'error.png', mimeType: 'image/png', size: 1024, kind: 'image', imageDataUrl: 'data:image/png;base64,original',
    }], 'Fix this error', new AbortController().signal, vi.fn())

    expect(internal.provider.complete).toHaveBeenCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ model: 'qwen2.5vl:3b', requestPolicy: expect.objectContaining({ outputTokens: 768, maxAttempts: 1 }) }),
      messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
    }))
    expect(localAiMocks.resize).toHaveBeenCalledWith({ width: 1536, height: 864, quality: 'best' })
    expect(result[0]).not.toHaveProperty('imageDataUrl')
    expect(result[0]?.textContent).toContain('Model request failed')
    expect(localAiMocks.unloadLocalModel).toHaveBeenCalledWith('qwen2.5vl:3b')
  })
})
