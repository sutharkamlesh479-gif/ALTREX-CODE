import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toDataURL: () => '' }) }) },
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
  unloadLocalModel: vi.fn(async () => undefined),
}))

import { EventBus } from '@altrex/core/events/event-bus'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import type { AltrexEvent } from '@altrex/contracts'
import { ProviderService, type ProviderServiceOptions } from './provider-service'
import { consentGranted } from './test-consent'
import { ProviderFailure } from './providers/request-manager'
import type { ChatRequest, ChatStreamEvent, ProviderConnectionInput } from '../shared/desktop-api'
import type { ProviderCompletionInput, ProviderStreamInput } from './providers/model-provider'

// Regression tests for the Phase 1 fixes in ProviderService (MIGRATION_PLAN.md Phase 1, items 4–6).

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

type Internal = {
  provider: {
    healthCheck: ReturnType<typeof vi.fn>
    listModels: ReturnType<typeof vi.fn>
    probeCapabilities: ReturnType<typeof vi.fn>
    complete: ReturnType<typeof vi.fn>
    stream: ReturnType<typeof vi.fn>
    requests: { abortProvider: (connection: { providerId: string; baseUrl: string }) => void }
  }
  codexAgent: unknown
}

function setup(options: ProviderServiceOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-phase1-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'src', 'app.js'), 'original')
  const events = new EventBus()
  const ensureLocalRuntime = vi.fn(async () => undefined)
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, ensureLocalRuntime, consent: consentGranted(), ...options })
  const internal = service as unknown as Internal
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.listModels = vi.fn(async () => [])
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  const published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  return { root, project: realpathSync(project), service, internal, events, published, ensureLocalRuntime }
}

const request = (overrides: Partial<ChatRequest>): ChatRequest => ({
  requestId: `request-${Math.random().toString(16).slice(2, 10)}`, projectPath: null, mode: 'ASK', modelSelection: 'AUTO',
  messages: [{ role: 'user', content: 'Update the app' }], attachments: [], ...overrides,
})
const google: ProviderConnectionInput = { providerId: 'google', apiKey: 'google-secret-key', baseUrl: '', model: 'gemini-3.8-flash' }
const cerebras: ProviderConnectionInput = { providerId: 'cerebras', apiKey: 'cerebras-secret-key', baseUrl: '', model: 'qwen-3.8-27b' }
const ollama: ProviderConnectionInput = { providerId: 'ollama', apiKey: '', baseUrl: '', model: 'qwen2.5-coder:7b-instruct' }
const until = async (condition: () => boolean) => { for (let index = 0; index < 400 && !condition(); index++) await new Promise(resolve => setTimeout(resolve, 5)); expect(condition()).toBe(true) }

describe('Fix A — local AI runtime starts lazily', () => {
  it('is not started by construction, status, or listing local models', async () => {
    const { service, internal, ensureLocalRuntime } = setup()
    internal.provider.listModels.mockResolvedValue([ollama.model])
    await service.connect(ollama)
    ensureLocalRuntime.mockClear()
    service.getStatus()
    await service.getModels('ollama')
    expect(ensureLocalRuntime).not.toHaveBeenCalled()
  })

  it('is started when a local connection is tested and when a request routes to Ollama', async () => {
    const { service, internal, ensureLocalRuntime } = setup()
    internal.provider.listModels.mockResolvedValue([ollama.model])
    await service.test(ollama)
    expect(ensureLocalRuntime).toHaveBeenCalledTimes(1)
    await service.connect(ollama)
    ensureLocalRuntime.mockClear()
    internal.provider.stream = vi.fn(async ({ onDelta }: ProviderStreamInput) => { onDelta('local answer') })
    const events: ChatStreamEvent[] = []
    await service.streamChat(request({ mode: 'ASK' }), '', [], event => events.push(event))
    expect(events.at(-1)?.type).toBe('completed')
    expect(ensureLocalRuntime).toHaveBeenCalled()
  })

  it('is never started for cloud-only providers', async () => {
    const { service, ensureLocalRuntime } = setup()
    await service.connect(google)
    await service.test(google)
    expect(ensureLocalRuntime).not.toHaveBeenCalled()
  })
})

describe('Fix C — disconnecting a provider cancels only requests routed to it', () => {
  it('cancels only requests that depend solely on the disconnected provider; others fail over and finish (Phase 3 precise disconnect)', async () => {
    const { service, internal } = setup()
    await service.connect(cerebras)
    await service.connect(google) // active profile → explicit-model requests route only to Google
    type Pending = { provider: string; released: boolean; release: () => void; fail: (error: unknown) => void }
    const pending: Pending[] = []
    internal.provider.stream = vi.fn(({ connection, signal, onDelta }: ProviderStreamInput) => new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      const entry: Pending = { provider: connection.providerId, released: false, release: () => { entry.released = true; onDelta('answer'); resolve() }, fail: reject }
      pending.push(entry)
    }))
    // Emulate the executor: in-flight calls to a disconnected provider fail with PROVIDER_DISCONNECTED.
    internal.provider.requests.abortProvider = connection => {
      for (const entry of pending) if (entry.provider === connection.providerId && !entry.released) entry.fail(new ProviderFailure('The provider was disconnected.', 'cancelled', false, 0, 0, undefined, 'PROVIDER_DISCONNECTED'))
    }
    const googleOnly: ChatStreamEvent[] = [], auto: ChatStreamEvent[] = []
    const googleRequest = service.streamChat(request({ modelSelection: google.model }), '', [], event => googleOnly.push(event))
    const autoRequest = service.streamChat(request({ modelSelection: 'AUTO' }), '', [], event => auto.push(event))
    await until(() => pending.length === 2)
    const callsBeforeDisconnect = pending.length

    service.disconnect('google')
    await googleRequest
    expect(googleOnly.at(-1)?.type).toBe('cancelled')

    // AUTO keeps (or fails over to) a Cerebras call and completes; Google is never called again.
    await until(() => pending.some(entry => entry.provider === 'cerebras' && !entry.released))
    for (const entry of pending.filter(item => item.provider === 'cerebras' && !item.released)) entry.release()
    await autoRequest
    expect(auto.at(-1)?.type).toBe('completed')
    expect(pending.slice(callsBeforeDisconnect).every(entry => entry.provider !== 'google')).toBe(true)
  })

  it('still cancels every active request when all providers are disconnected', async () => {
    const { service, internal } = setup()
    await service.connect(cerebras)
    internal.provider.stream = vi.fn(({ signal }: ProviderStreamInput) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
    const events: ChatStreamEvent[] = []
    const pending = service.streamChat(request({ modelSelection: cerebras.model }), '', [], event => events.push(event))
    await until(() => internal.provider.stream.mock.calls.length === 1)
    service.disconnect()
    await pending
    expect(events.at(-1)?.type).toBe('cancelled')
  })
})

describe('Fix B — write-capable tasks are checkpointed before any change', () => {
  it('checkpoints an Agent task first, finalizes it, and can restore exactly its changes', async () => {
    const { service, internal, project, published } = setup()
    await service.connect(google)
    let fileWhenCheckpointed: string | null = null
    internal.provider.complete = vi.fn(async ({ messages }: ProviderCompletionInput) => {
      if (!messages.some(message => message.role === 'tool')) {
        fileWhenCheckpointed = readFileSync(join(project, 'src', 'app.js'), 'utf8')
        return { content: '', toolCalls: [{ id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: 'src/app.js', content: 'changed by agent' }) }] }
      }
      return { content: 'Done.', toolCalls: [] }
    })
    const task = request({ mode: 'AGENT', projectPath: project })
    const events: ChatStreamEvent[] = []
    await service.streamChat(task, '', [], event => events.push(event))

    expect(events.at(-1)?.type).toBe('completed')
    expect(readFileSync(join(project, 'src', 'app.js'), 'utf8')).toBe('changed by agent')
    expect(fileWhenCheckpointed).toBe('original')
    const created = published.find(event => event.type === 'checkpoint.created')
    expect(created).toMatchObject({ taskId: task.requestId, payload: { fileCount: 1, projectPath: project } })
    const checkpointActivity = events.findIndex(event => event.type === 'activity' && event.message?.startsWith('Checkpoint saved before changes'))
    expect(checkpointActivity).toBeGreaterThanOrEqual(0)
    expect(checkpointActivity).toBeLessThan(events.findIndex(event => event.type === 'started'))

    const [checkpoint] = await service.checkpoints.list(project)
    expect(checkpoint).toMatchObject({ taskId: task.requestId, changedByTask: 1 })
    expect(checkpoint!.finalizedAt).not.toBeNull()
    const result = await service.checkpoints.restore(checkpoint!.checkpointId)
    expect(result.restored).toEqual(['src/app.js'])
    expect(readFileSync(join(project, 'src', 'app.js'), 'utf8')).toBe('original')
  })

  it('checkpoints Codex-engine tasks too', async () => {
    const { service, internal, project } = setup()
    internal.codexAgent = {
      getRuntimeInfo: () => ({ available: true, version: 'codex-fixture' }),
      run: vi.fn(async () => { writeFileSync(join(project, 'src', 'codex.js'), 'written by codex') }),
    }
    const events: ChatStreamEvent[] = []
    await service.streamChat(request({ mode: 'AGENT', modelSelection: 'CODEX', projectPath: project }), '', [], event => events.push(event))
    expect(events.at(-1)?.type).toBe('completed')
    const [checkpoint] = await service.checkpoints.list(project)
    expect(checkpoint?.changedByTask).toBe(1)
    expect((await service.checkpoints.plan(checkpoint!.checkpointId)).delete).toEqual(['src/codex.js'])
  })

  it('finalizes the checkpoint even when the task fails', async () => {
    const { service, internal, project } = setup()
    internal.codexAgent = {
      getRuntimeInfo: () => ({ available: true, version: 'codex-fixture' }),
      run: vi.fn(async () => { writeFileSync(join(project, 'src', 'app.js'), 'half done'); throw new Error('engine crashed') }),
    }
    const events: ChatStreamEvent[] = []
    await service.streamChat(request({ mode: 'AGENT', modelSelection: 'CODEX', projectPath: project }), '', [], event => events.push(event))
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'engine crashed' })
    const [checkpoint] = await service.checkpoints.list(project)
    expect(checkpoint?.finalizedAt).not.toBeNull()
    await service.checkpoints.restore(checkpoint!.checkpointId)
    expect(readFileSync(join(project, 'src', 'app.js'), 'utf8')).toBe('original')
  })

  it('reports a checkpoint failure honestly and still runs the task', async () => {
    const { root, service, internal, project, published } = setup()
    const tooSmall = new CheckpointStore(join(root, 'tiny'), { limits: { maxFiles: 0 } })
    ;(service as unknown as { checkpoints: CheckpointStore }).checkpoints = tooSmall
    internal.codexAgent = { getRuntimeInfo: () => ({ available: true, version: 'codex-fixture' }), run: vi.fn(async () => undefined) }
    const events: ChatStreamEvent[] = []
    await service.streamChat(request({ mode: 'AGENT', modelSelection: 'CODEX', projectPath: project }), '', [], event => events.push(event))
    expect(events.at(-1)?.type).toBe('completed')
    expect(events.some(event => event.type === 'activity' && event.message?.startsWith('No checkpoint was created'))).toBe(true)
    expect(published.find(event => event.type === 'checkpoint.failed')?.payload).toMatchObject({ projectPath: project })
  })

  it('does not checkpoint read-only Ask requests', async () => {
    const { service, internal, project, published } = setup()
    await service.connect(google)
    internal.provider.stream = vi.fn(async ({ onDelta }: ProviderStreamInput) => { onDelta('answer') })
    await service.streamChat(request({ mode: 'ASK', projectPath: project }), '', [], () => undefined)
    expect(await service.checkpoints.list(project)).toEqual([])
    expect(published.some(event => event.type.startsWith('checkpoint.'))).toBe(false)
  })

  it('reports the project busy only while a task is running in it', async () => {
    const { service, internal, project } = setup()
    let release!: () => void
    internal.codexAgent = { getRuntimeInfo: () => ({ available: true, version: 'codex-fixture' }), run: vi.fn(() => new Promise<void>(resolve => { release = resolve })) }
    const pending = service.streamChat(request({ mode: 'AGENT', modelSelection: 'CODEX', projectPath: project }), '', [], () => undefined)
    await until(() => release !== undefined)
    expect(service.isProjectBusy(project)).toBe(true)
    expect(service.isProjectBusy(join(project, '..', 'other'))).toBe(false)
    release()
    await pending
    expect(service.isProjectBusy(project)).toBe(false)
  })
})
