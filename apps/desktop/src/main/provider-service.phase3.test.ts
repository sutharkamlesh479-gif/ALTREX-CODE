import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const crypto = vi.hoisted(() => ({ decrypts: 0 }))
vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toDataURL: () => '' }) }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => { crypto.decrypts++; return value.toString().replace(/^encrypted:/, '') },
    getSelectedStorageBackend: () => 'dpapi',
  },
}))
vi.mock('./local-ai-service', () => ({ ensureLocalAiServer: vi.fn(async () => undefined), pullLocalModel: vi.fn(async () => undefined), unloadLocalModel: vi.fn(async () => undefined) }))

import { EventBus } from '@altrex/core/events/event-bus'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { parseCommandResponse, type AltrexEvent } from '@altrex/contracts'
import { providerDefinitions } from '../shared/provider-registry'
import { ProviderService } from './provider-service'
import { CoreHost } from './core-host'
import type { ProviderConnectionInput } from '../shared/desktop-api'

// Phase 3: provider infrastructure in the desktop host.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); crypto.decrypts = 0 })

function setup(root = mkdtempSync(join(tmpdir(), 'altrex-phase3-'))) {
  if (!roots.includes(root)) roots.push(root)
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, ensureLocalRuntime: async () => undefined })
  const internal = service as unknown as { provider: { healthCheck: ReturnType<typeof vi.fn>; listModels: ReturnType<typeof vi.fn>; catalogMetadata?: unknown; requests: { execute: (input: unknown) => Promise<unknown>; transport: unknown } } }
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.listModels = vi.fn(async () => [])
  return { root, service, internal, published }
}
const groq: ProviderConnectionInput = { providerId: 'groq', apiKey: 'gsk_live_secret_ABCD', baseUrl: '', model: 'model-a' }

describe('credential key hints', () => {
  it('stores a 4-character hint at save time so status never decrypts', async () => {
    const { service } = setup()
    await service.connect(groq)
    crypto.decrypts = 0
    expect(service.getStatus().profiles?.[0]?.keySuffix).toBe('ABCD')
    service.getStatus()
    expect(crypto.decrypts).toBe(0)
  })

  it('migrates legacy profiles (no hint) with a single decryption, then never again', () => {
    const root = mkdtempSync(join(tmpdir(), 'altrex-phase3-'))
    roots.push(root)
    const legacy = { version: 2, providerId: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'm', encryptedApiKey: Buffer.from('encrypted:gsk_legacy_key_WXYZ').toString('base64'), verification: { ok: true, category: null, message: 'ok', testedAt: '2026-09-01T00:00:00.000Z' } }
    mkdirSync(join(root, 'credentials'), { recursive: true })
    writeFileSync(join(root, 'credentials', 'provider.json'), JSON.stringify(legacy))
    writeFileSync(join(root, 'credentials', 'provider.json.profiles'), JSON.stringify([legacy]))
    const { service } = setup(root)
    expect(service.getStatus().profiles?.[0]?.keySuffix).toBe('WXYZ')
    expect(crypto.decrypts).toBe(1)
    service.getStatus(); service.getStatus()
    expect(crypto.decrypts).toBe(1)
    const saved = JSON.parse(readFileSync(join(root, 'credentials', 'provider.json.profiles'), 'utf8')) as Array<{ keyHint: string; encryptedApiKey: string }>
    expect(saved[0]).toMatchObject({ keyHint: 'WXYZ', encryptedApiKey: legacy.encryptedApiKey })
    expect(JSON.stringify(saved)).not.toContain('gsk_legacy_key')
  })
})

describe('provider health persistence', () => {
  async function rejectKey(internal: ReturnType<typeof setup>['internal']) {
    internal.provider.requests.transport = async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 })
    await internal.provider.requests.execute({ connection: { providerId: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'model-a', apiKey: 'k' }, messages: [], signal: new AbortController().signal, stream: false, consume: (response: Response) => response.text() }).catch(() => undefined)
  }

  it('publishes provider.health_changed and keeps AUTH_ERROR after a restart', async () => {
    const first = setup()
    await first.service.connect(groq)
    await rejectKey(first.internal)
    expect(first.published.at(-1)).toMatchObject({ type: 'provider.health_changed', taskId: null, payload: { providerId: 'groq', state: 'AUTH_ERROR', errorCategory: 'INVALID_API_KEY' } })
    const status = first.service.getStatus().profiles![0]!
    expect(status).toMatchObject({ health: 'AUTH_ERROR', connectionState: 'AUTHENTICATION_FAILED' })

    const restarted = setup(first.root)
    expect(restarted.service.getStatus().profiles![0]).toMatchObject({ health: 'AUTH_ERROR', connectionState: 'AUTHENTICATION_FAILED' })
  })

  it('does not restore stale non-latched health after a restart (shows UNKNOWN, not a guess)', async () => {
    const first = setup()
    await first.service.connect(groq)
    writeFileSync(join(first.root, 'multi-ai', 'provider-health.json'), JSON.stringify({ 'groq:https://api.groq.com/openai/v1': { cooldownUntil: 0, openUntil: Date.now() + 30_000, cooldownMs: 60_000, failures: 3, firstFailureAt: 0, latched: null, observed: true, changedAt: Date.now() - 3_600_000, lastCategory: 'PROVIDER_SERVER_ERROR' } }))
    const restarted = setup(first.root)
    expect(restarted.service.getStatus().profiles![0]!.health).toBe('UNKNOWN')
  })
})

describe('provider presets and endpoints', () => {
  it('connects a self-hosted NIM at a user-supplied loopback URL without an API key', async () => {
    const { service, internal } = setup()
    internal.provider.listModels.mockResolvedValue(['meta/llama-3.3-70b-instruct'])
    const status = await service.connect({ providerId: 'nim-local', apiKey: '', baseUrl: 'http://127.0.0.1:8000/v1', model: '' })
    expect(status.profiles?.[0]).toMatchObject({ providerId: 'nim-local', baseUrl: 'http://127.0.0.1:8000/v1', model: 'meta/llama-3.3-70b-instruct' })
    expect(service.providerViews()[0]).toMatchObject({ privacy: 'local', protocol: 'openai-chat', hasCredential: false })
  })

  it('refuses plain HTTP to a non-loopback host', async () => {
    const { service } = setup()
    await expect(service.connect({ providerId: 'nim-local', apiKey: '', baseUrl: 'http://192.168.1.20:8000/v1', model: 'x' })).rejects.toThrow('HTTPS')
  })

  it('treats an ngrok URL as an ordinary custom OpenAI-compatible endpoint in the cloud privacy class', async () => {
    const { service, internal } = setup()
    internal.provider.listModels.mockResolvedValue(['served-model'])
    await service.connect({ providerId: 'custom', apiKey: '', baseUrl: 'https://abc123.ngrok-free.app/v1', model: '' })
    expect(providerDefinitions.some(definition => /ngrok/i.test(`${definition.id} ${definition.name}`))).toBe(false)
    expect(service.providerViews()[0]).toMatchObject({ providerId: 'custom', baseUrl: 'https://abc123.ngrok-free.app/v1', privacy: 'cloud', protocol: 'openai-chat' })
  })

  it('does not depend on a stale default model: an unlisted suggestion is replaced by a discovered model', async () => {
    const { service, internal } = setup()
    internal.provider.listModels.mockResolvedValue(['current-model'])
    const status = await service.connect({ ...groq, model: 'retired-suggested-model' })
    expect(status.model).toBe('current-model')
  })
})

describe('capability discovery and contract views', () => {
  it('records catalog metadata in the registry and exposes schema-valid provider/model views without secrets', async () => {
    const { root, service, internal } = setup()
    internal.provider.listModels.mockResolvedValue(['vendor/coder:free'])
    internal.provider.catalogMetadata = () => [{ id: 'vendor/coder:free', contextWindow: 262144, supportsTools: true, supportsVision: false, free: true }]
    await service.connect({ providerId: 'openrouter', apiKey: 'sk-or-v1-secretvalue-9876', baseUrl: '', model: 'vendor/coder:free' })
    const host = new CoreHost({ events: new EventBus(), checkpoints: new CheckpointStore(join(root, 'cp')), isProjectTrusted: () => true, isProjectBusy: () => false, catalog: { providers: () => service.providerViews(), models: providerId => service.modelViews(providerId) } })
    const providers = parseCommandResponse('provider.list', await host.handle('provider.list', {}))
    const models = parseCommandResponse('model.list', await host.handle('model.list', { providerId: 'openrouter' }))
    expect(providers[0]).toMatchObject({ providerId: 'openrouter', privacy: 'cloud', hasCredential: true, keyHint: '9876' })
    expect(JSON.stringify(providers)).not.toContain('secretvalue')
    expect(models).toContainEqual(expect.objectContaining({ model: 'vendor/coder:free', free: true, capabilities: expect.objectContaining({ tools: true, vision: false, contextWindow: 262144, chat: true }) }))
  })
})
