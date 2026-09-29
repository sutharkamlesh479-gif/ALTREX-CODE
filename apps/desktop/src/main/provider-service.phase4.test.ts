import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toDataURL: () => '' }) }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`encrypted:${value}`), decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''), getSelectedStorageBackend: () => 'dpapi' },
}))
vi.mock('./local-ai-service', () => ({ ensureLocalAiServer: vi.fn(async () => undefined), pullLocalModel: vi.fn(async () => undefined), unloadLocalModel: vi.fn(async () => undefined) }))

import { EventBus } from '@altrex/core/events/event-bus'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { parseAltrexEvent, parseCommandResponse, type AltrexEvent } from '@altrex/contracts'
import { ProviderService } from './provider-service'
import { CoreHost } from './core-host'
import { ProviderFailure } from './providers/request-manager'
import type { ChatRequest, ChatStreamEvent, ProviderConnectionInput } from '../shared/desktop-api'
import type { ProviderStreamInput } from './providers/model-provider'

// Phase 4: smart router integration — modes, lazy local runtime, structured routing events, preview.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'altrex-phase4-'))
  roots.push(root)
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const ensureLocalRuntime = vi.fn(async () => undefined)
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, ensureLocalRuntime })
  const internal = service as unknown as { provider: { healthCheck: ReturnType<typeof vi.fn>; listModels: ReturnType<typeof vi.fn>; probeCapabilities: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn>; catalogMetadata?: unknown } }
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.listModels = vi.fn(async () => [])
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  return { root, service, internal, published, ensureLocalRuntime }
}
const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({ requestId: `req-${Math.random().toString(16).slice(2, 10)}`, projectPath: null, mode: 'ASK', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Add a settings page to the app' }], attachments: [], ...overrides })
const google: ProviderConnectionInput = { providerId: 'google', apiKey: 'google-secret-key', baseUrl: '', model: 'gemini-pro-large' }
const ollama: ProviderConnectionInput = { providerId: 'ollama', apiKey: '', baseUrl: '', model: 'qwen2.5-coder:7b-instruct' }

describe('lazy local runtime under AUTO (Phase 1 issue #5)', () => {
  it('does not start Ollama merely because an Ollama profile exists when routing selects a cloud model', async () => {
    const { service, internal, ensureLocalRuntime } = setup()
    internal.provider.listModels.mockImplementation(async (connection: ProviderConnectionInput) => connection.providerId === 'ollama' ? [ollama.model] : [google.model])
    await service.connect(ollama)
    await service.connect(google)
    ensureLocalRuntime.mockClear()
    const used: string[] = []
    internal.provider.stream = vi.fn(async ({ connection, onDelta }: ProviderStreamInput) => { used.push(connection.providerId); onDelta('ok') })
    const events: ChatStreamEvent[] = []
    await service.streamChat(request({ messages: [{ role: 'user', content: 'Design the architecture for a distributed job scheduler' }] }), '', [], event => events.push(event))
    expect(events.at(-1)?.type).toBe('completed')
    expect(used).toEqual(['google'])
    expect(ensureLocalRuntime).not.toHaveBeenCalled()
  })

  it('starts Ollama only when a local model is actually selected (LOCAL mode)', async () => {
    const { service, internal, ensureLocalRuntime } = setup()
    internal.provider.listModels.mockImplementation(async (connection: ProviderConnectionInput) => connection.providerId === 'ollama' ? [ollama.model] : [google.model])
    await service.connect(google)
    await service.connect(ollama)
    ensureLocalRuntime.mockClear()
    internal.provider.stream = vi.fn(async ({ onDelta }: ProviderStreamInput) => { onDelta('local') })
    await service.streamChat(request({ mode: 'LOCAL' }), '', [], () => undefined)
    expect(ensureLocalRuntime).toHaveBeenCalled()
  })
})

describe('routing modes', () => {
  it('FREE_ONLY routes only to models known to be free', async () => {
    const { service, internal } = setup()
    internal.provider.listModels.mockResolvedValue(['paid/coder-70b', 'open/coder-70b:free'])
    internal.provider.catalogMetadata = () => [{ id: 'paid/coder-70b', free: false }, { id: 'open/coder-70b:free', free: true }]
    await service.connect({ providerId: 'openrouter', apiKey: 'sk-or-v1-secret', baseUrl: '', model: 'paid/coder-70b' })
    const used: string[] = []
    internal.provider.stream = vi.fn(async ({ connection, onDelta }: ProviderStreamInput) => { used.push(connection.model); onDelta('ok') })
    await service.streamChat(request({ routingMode: 'FREE_ONLY' }), '', [], () => undefined)
    expect(used).toEqual(['open/coder-70b:free'])
  })

  it('an explicit model selection is CUSTOM: only that model is used', async () => {
    const { service, internal } = setup()
    internal.provider.listModels.mockResolvedValue(['a-model', 'b-model'])
    await service.connect({ providerId: 'groq', apiKey: 'gsk_secret_1234', baseUrl: '', model: 'a-model' })
    const used: string[] = []
    internal.provider.stream = vi.fn(async ({ connection, onDelta }: ProviderStreamInput) => { used.push(connection.model); onDelta('ok') })
    await service.streamChat(request({ modelSelection: 'b-model' }), '', [], () => undefined)
    expect(used).toEqual(['b-model'])
  })
})

describe('structured routing events', () => {
  it('reports selection and fallback as contract events, not only as progress text', async () => {
    const { service, internal, published } = setup()
    internal.provider.listModels.mockImplementation(async (connection: ProviderConnectionInput) => [connection.model])
    await service.connect({ providerId: 'groq', apiKey: 'gsk_secret_1234', baseUrl: '', model: 'coder-a' })
    await service.connect({ providerId: 'nvidia', apiKey: 'nvapi-secret-5678', baseUrl: '', model: 'coder-b' })
    let calls = 0
    internal.provider.stream = vi.fn(async ({ onDelta }: ProviderStreamInput) => {
      if (calls++ === 0) throw new ProviderFailure('The provider is temporarily unavailable.', 'unavailable', true, 503, 0, undefined, 'PROVIDER_SERVER_ERROR')
      onDelta('recovered')
    })
    const task = request()
    const events: ChatStreamEvent[] = []
    await service.streamChat(task, '', [], event => events.push(event))
    expect(events.at(-1)?.type).toBe('completed')
    const routing = published.filter(event => event.taskId === task.requestId).map(event => event.type)
    expect(routing).toEqual(['provider.selected', 'model.selected', 'fallback.started', 'provider.selected', 'model.selected', 'fallback.completed'])
    const fallback = published.find(event => event.type === 'fallback.started')!
    expect(fallback.payload).toMatchObject({ role: 'Ask', reason: 'PROVIDER_SERVER_ERROR' })
    for (const event of published) expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
  })

  it('reports exhaustion as fallback.failed with a clear task error', async () => {
    const { service, internal, published } = setup()
    internal.provider.listModels.mockImplementation(async (connection: ProviderConnectionInput) => [connection.model])
    await service.connect({ providerId: 'groq', apiKey: 'gsk_secret_1234', baseUrl: '', model: 'coder-a' })
    await service.connect({ providerId: 'nvidia', apiKey: 'nvapi-secret-5678', baseUrl: '', model: 'coder-b' })
    internal.provider.stream = vi.fn(async () => { throw new ProviderFailure('The provider is temporarily unavailable.', 'unavailable', true, 503, 0, undefined, 'PROVIDER_SERVER_ERROR') })
    const events: ChatStreamEvent[] = []
    await service.streamChat(request(), '', [], event => events.push(event))
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'The provider is temporarily unavailable.' })
    expect(published.find(event => event.type === 'fallback.failed')?.payload).toMatchObject({ reason: 'PROVIDER_SERVER_ERROR', attempted: 2 })
  })
})

describe('router preview', () => {
  it('explains the AUTO choice and rejections through the core bridge without calling a model', async () => {
    const { root, service, internal } = setup()
    internal.provider.listModels.mockResolvedValue(['coder-70b', 'text-embedding-3'])
    await service.connect({ providerId: 'groq', apiKey: 'gsk_secret_1234', baseUrl: '', model: 'coder-70b' })
    internal.provider.stream = vi.fn()
    const host = new CoreHost({ events: new EventBus(), checkpoints: new CheckpointStore(join(root, 'cp')), isProjectTrusted: () => true, isProjectBusy: () => false, routing: { preview: input => service.previewRoute(input) } })
    const preview = parseCommandResponse('router.preview', await host.handle('router.preview', { mode: 'AUTO', tools: true }))
    expect(preview.primary).toEqual({ providerId: 'groq', model: 'coder-70b' })
    expect(preview.reasons[0]).toMatch(/^AUTO: groq \/ coder-70b selected/)
    expect(preview.rejected).toContainEqual(expect.objectContaining({ model: 'text-embedding-3', reason: 'not_a_chat_model' }))
    expect(internal.provider.stream).not.toHaveBeenCalled()
    const local = parseCommandResponse('router.preview', await host.handle('router.preview', { mode: 'LOCAL_ONLY' }))
    expect(local.primary).toBeNull()
  })
})
