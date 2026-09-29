import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toDataURL: () => '' }) }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`encrypted:${value}`), decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''), getSelectedStorageBackend: () => 'dpapi' },
}))
vi.mock('./local-ai-service', () => ({ ensureLocalAiServer: vi.fn(async () => undefined), pullLocalModel: vi.fn(async () => undefined), unloadLocalModel: vi.fn(async () => undefined) }))

import { EventBus } from '@altrex/core/events/event-bus'
import { TaskManager } from '@altrex/core/orchestrator/task-manager'
import { ConsentStore } from '@altrex/core/security/consent'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { reply, startFakeOpenAiServer, type FakeOpenAiServer, type FakeReply } from '@altrex/core/testing/fake-openai-server'
import type { AltrexEvent, ModelView, ProviderView } from '@altrex/contracts'
import { ProviderService } from './provider-service'
import { CoreHost } from './core-host'
import { endpointPrivacy, providerDefinition } from '../shared/provider-registry'
import type { ChatRequest } from '../shared/desktop-api'

// crax-gpt native provider patch: deterministic tests over a real loopback HTTP server that speaks the
// crax-gpt catalog shape. No real crax-gpt key or network access is used.

const KEY = 'crax-test-key-9876'
const roots: string[] = []
const servers: FakeOpenAiServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

type CatalogModel = { id: string; name?: string; free?: boolean; context?: number }
/** A crax-gpt /v1/models entry (fields observed in the crax-gpt web client). */
const craxEntry = (model: CatalogModel) => ({ id: model.id, object: 'model', name: model.name ?? model.id, provider: 'upstream', context_length: model.context ?? 128_000, inRate: model.free ? 0 : 1.5, outRate: model.free ? 0 : 6 })

type Body = { messages: Array<{ role: string; content: unknown }>; stream?: boolean; model?: string; tools?: Array<{ function: { name: string } }> }
/** Scripted model: answers text, or writes a file when asked to build, then finishes. */
const brain = (text = 'Hello from crax-gpt.'): FakeReply => (request, response) => {
  const body = request.json as Body, last = body.messages.at(-1)!
  const send = (content: string | null, call?: { name: string; arguments: unknown }) => (body.stream
    ? (call ? reply.streamToolCall(call) : reply.stream([content ?? '']))
    : reply.completion({ content, ...(call ? { toolCalls: [call] } : {}) }))(request, response)
  if (body.tools?.length === 1 && body.tools[0]!.function.name === 'echo') return send(null, { name: 'echo', arguments: { value: 'ok' } })
  if (String(body.messages[0]?.content ?? '').includes('independent code REVIEWER')) return send(JSON.stringify({ decision: 'approve', findings: [] }))
  if (last.role === 'tool') return send('Done.')
  if (body.messages.some(message => String(message.content ?? '').includes('Create hello.txt'))) return send(null, { name: 'write_file', arguments: { path: 'hello.txt', content: 'hi\n' } })
  return send(text)
}

async function setup(options: { catalog?: CatalogModel[]; modelsStatus?: number; policy?: Record<string, number>; consent?: ConsentStore } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-crax-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), '# demo\n')
  let catalog = options.catalog ?? [{ id: 'glm-5.3', name: 'GLM-5.3', free: true }, { id: 'vendor/big-coder', name: 'Big Coder' }]
  const authHeaders: string[] = []
  const server = await startFakeOpenAiServer({
    routes: {
      'GET /v1/models': (request, response) => {
        authHeaders.push(String(request.headers.authorization ?? ''))
        if (options.modelsStatus) return reply.json({ error: { message: 'Authentication required — log in at the site to get an access key.', type: 'auth_required', code: options.modelsStatus } }, options.modelsStatus)(request, response)
        return reply.json({ object: 'list', data: catalog.map(craxEntry) })(request, response)
      },
    },
  })
  servers.push(server)
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const tasks = new TaskManager(events)
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, tasks, checkpoints: new CheckpointStore(join(root, 'cp')), ensureLocalRuntime: vi.fn(async () => undefined), ...(options.consent ? { consent: options.consent } : {}) })
  const host = new CoreHost({
    events, tasks, checkpoints: new CheckpointStore(join(root, 'cp2')), isProjectTrusted: () => true, isProjectBusy: () => false,
    catalog: { providers: () => service.providerViews(), models: providerId => service.modelViews(providerId) },
    routing: { preview: request => service.previewRoute(request) },
    consent: { list: () => service.consentEndpoints(), grant: endpoint => service.grantConsent(endpoint), revoke: endpoint => service.revokeConsent(endpoint) },
  })
  const policy = { maxAttempts: 1, firstTokenMs: 1500, idleMs: 1500, connectionMs: 3000, ...options.policy }
  const connect = async (apiKey = KEY) => {
    server.enqueue(brain('OK')) // the connection check's tiny generation
    return service.connect({ providerId: 'crax-gpt', apiKey, baseUrl: server.baseUrl, model: '', requestPolicy: policy })
  }
  const run = async (request: ChatRequest) => {
    const taskId = host.legacy.begin(request)!
    await service.streamChat(request, '', [], event => host.legacy.handle(event))
    return taskId
  }
  const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({ requestId: `req-${Math.random().toString(16).slice(2, 10)}`, projectPath: null, mode: 'ASK', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Say hello' }], attachments: [], ...overrides })
  const models = async () => await host.handle('model.list', { providerId: 'crax-gpt' }) as ModelView[]
  const providers = async () => await host.handle('provider.list', {}) as ProviderView[]
  return { root, project, server, service, host, tasks, published, authHeaders, connect, run, request, models, providers, setCatalog: (next: CatalogModel[]) => { catalog = next } }
}
const fill = (server: FakeOpenAiServer, count = 12, text?: string) => server.enqueue(...Array.from({ length: count }, () => brain(text)))

describe('crax-gpt preset', () => {
  it('is a built-in cloud preset with the official base URL and no hard-coded model', () => {
    const preset = providerDefinition('crax-gpt')
    expect(preset).toMatchObject({ name: 'crax-gpt', baseUrl: 'https://gpt.crax.lol/v1', requiresApiKey: true, defaultModel: '', approvedHosts: ['gpt.crax.lol'] })
    expect(endpointPrivacy(preset.baseUrl)).toBe('cloud')
    expect(new URL(preset.apiKeyUrl!).hostname).toBe('gpt.crax.lol')
  })
})

describe('guided connection: key validation and model discovery', () => {
  it('validates the key with Bearer auth, discovers /v1/models and records catalog metadata', async () => {
    const h = await setup({ catalog: [{ id: 'glm-5.3', name: 'GLM-5.3', free: true, context: 200_000 }, { id: 'vendor/big-coder', name: 'Big Coder', context: 64_000 }] })
    await h.connect()
    expect(h.authHeaders.every(header => header === `Bearer ${KEY}`)).toBe(true)
    const [provider] = await h.providers()
    expect(provider).toMatchObject({ providerId: 'crax-gpt', health: 'HEALTHY', modelsDiscovered: 2, hasCredential: true, keyHint: '9876', privacy: 'local' /* loopback test server */ })
    const models = await h.models()
    expect(models.map(model => model.model).sort()).toEqual(['glm-5.3', 'vendor/big-coder'])
    expect(models.find(model => model.model === 'glm-5.3')).toMatchObject({ displayName: 'GLM-5.3', free: true, capabilities: { contextWindow: 200_000 } })
    expect(models.find(model => model.model === 'vendor/big-coder')).toMatchObject({ free: false, capabilities: { contextWindow: 64_000 } })
  })

  it('rejects an invalid key (401) with the provider message and stores nothing', async () => {
    const h = await setup({ modelsStatus: 401 })
    await expect(h.connect('wrong-key-0000')).rejects.toThrow()
    expect(await h.providers()).toEqual([])
    expect(existsSync(join(h.root, 'credentials', 'provider.json')) && readFileSync(join(h.root, 'credentials', 'provider.json'), 'utf8').includes('wrong-key-0000')).toBe(false)
  })

  it('never uses a hard-coded model id: whatever the live catalog lists is used', async () => {
    const id = `live-${Math.random().toString(36).slice(2, 8)}`
    const h = await setup({ catalog: [{ id }] })
    await h.connect()
    expect((await h.providers())[0]!.model).toBe(id)
  })
})

describe('model refresh follows the live catalog', () => {
  it('adds new models and stops offering removed ones', async () => {
    const h = await setup({ catalog: [{ id: 'glm-5.3', free: true }, { id: 'old-model' }] })
    await h.connect()
    h.setCatalog([{ id: 'glm-5.3', free: true }, { id: 'new-model' }])
    await h.service.refreshModels()
    expect((await h.models()).map(model => model.model).sort()).toEqual(['glm-5.3', 'new-model'])
    const preview = await h.host.handle('router.preview', { mode: 'AUTO', role: 'Coding Agent', tools: false }) as { primary: { model: string } | null; fallbacks: Array<{ model: string }> }
    expect([preview.primary?.model, ...preview.fallbacks.map(item => item.model)]).not.toContain('old-model')
  })
})

describe('chat, streaming and tools through crax-gpt', () => {
  it('streams an answer (Bearer auth, streaming request, discovered model)', async () => {
    const h = await setup()
    await h.connect()
    fill(h.server)
    const taskId = await h.run(h.request())
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED')
    const chat = h.server.requests.at(-1)!
    expect(chat.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(chat.json).toMatchObject({ stream: true })
    expect(['glm-5.3', 'vendor/big-coder']).toContain((chat.json as Body).model)
    expect(h.published.filter(event => event.type === 'agent.message_delta').map(event => (event.payload as { text: string }).text).join('')).toContain('Hello from crax-gpt.')
  })

  it('executes streamed tool calls in a Build task', async () => {
    const h = await setup()
    await h.connect()
    fill(h.server, 20)
    await h.run(h.request({ mode: 'AGENT', projectPath: h.server ? h.project : null, messages: [{ role: 'user', content: 'Create hello.txt with hi' }] }))
    expect(readFileSync(join(h.project, 'hello.txt'), 'utf8')).toBe('hi\n')
  })

  it('retries a malformed stream without streaming on the same model', async () => {
    const h = await setup()
    await h.connect()
    h.server.enqueue(reply.malformed()); fill(h.server)
    const taskId = await h.run(h.request())
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED')
  })
})

describe('errors, rate limits and fallback', () => {
  it('401 during a task latches AUTH_ERROR health', async () => {
    const h = await setup()
    await h.connect()
    h.server.enqueue(reply.status(401, 'invalid key'))
    const taskId = await h.run(h.request())
    expect(h.tasks.get(taskId)!.state).toBe('FAILED')
    expect((await h.providers())[0]!.health).toBe('AUTH_ERROR')
  })

  it('404 for one model falls back to another crax-gpt model', async () => {
    const h = await setup()
    await h.connect()
    h.server.enqueue(reply.status(404, 'The model does not exist')); fill(h.server)
    const taskId = await h.run(h.request())
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED')
    expect(h.published.some(event => event.type === 'fallback.started')).toBe(true)
  })

  it('429 with Retry-After is retried after the wait and reported as RATE_LIMITED', async () => {
    const h = await setup({ policy: { maxAttempts: 2 } })
    await h.connect()
    h.server.enqueue(reply.status(429, 'Too many requests', { 'Retry-After': '1' })); fill(h.server)
    const started = Date.now()
    const taskId = await h.run(h.request())
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED')
    expect(Date.now() - started).toBeGreaterThanOrEqual(900) // Retry-After respected, no hammering
    expect(h.published.some(event => event.type === 'provider.health_changed' && (event.payload as { state: string }).state === 'RATE_LIMITED')).toBe(true)
  }, 30_000)

  for (const status of [500, 503]) {
    it(`${status} falls back to another eligible provider`, async () => {
      const h = await setup({ catalog: [{ id: 'glm-5.3' }] })
      await h.connect()
      const other = await startFakeOpenAiServer(); servers.push(other)
      other.enqueue(...Array.from({ length: 12 }, () => brain('from the other provider')))
      await h.service.connect({ providerId: 'custom', apiKey: '', baseUrl: other.baseUrl, model: 'fake-coder', requestPolicy: { maxAttempts: 1 } })
      h.server.enqueue(...Array.from({ length: 4 }, () => reply.status(status, 'upstream down')))
      const taskId = await h.run(h.request())
      expect(h.tasks.get(taskId)!.state).toBe('COMPLETED')
      expect(h.published.some(event => event.type === 'fallback.completed')).toBe(true)
    }, 30_000)
  }

  it('a timeout (no first token) fails over instead of hanging', async () => {
    const h = await setup({ policy: { firstTokenMs: 700 } })
    await h.connect()
    h.server.enqueue(reply.hang()); fill(h.server)
    const taskId = await h.run(h.request())
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED')
    expect(h.published.find(event => event.type === 'fallback.started')?.payload).toMatchObject({ reason: 'TIMEOUT' })
  }, 30_000)
})

/** crax-gpt on its official (cloud) URL with a mocked transport: routing decisions only, no network. */
async function cloudCrax(catalog: Array<{ id: string; free?: boolean }>) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-crax-cloud-')); roots.push(root)
  const events = new EventBus()
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'm'), join(root, 'm'), { events, consent: new ConsentStore(null), checkpoints: new CheckpointStore(join(root, 'cp')) })
  const internal = service as unknown as { provider: Record<string, unknown>; codexAgent: { getRuntimeInfo: () => { available: boolean; version: null } } }
  internal.codexAgent.getRuntimeInfo = () => ({ available: false, version: null })
  internal.provider.listModels = vi.fn(async () => catalog.map(model => model.id))
  internal.provider.catalogMetadata = () => catalog.map(model => ({ id: model.id, free: model.free === true }))
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  await service.connect({ providerId: 'crax-gpt', apiKey: KEY, baseUrl: '', model: '' })
  return service
}

describe('routing modes', () => {
  it('LOCAL ONLY never routes to crax-gpt (a cloud provider)', async () => {
    const service = await cloudCrax([{ id: 'glm-5.3', free: true }])
    const preview = await service.previewRoute({ mode: 'LOCAL_ONLY', role: 'Coding Agent', prompt: 'hi' })
    expect(preview.primary).toBeNull()
    expect(preview.rejected.every(item => item.providerId === 'crax-gpt' && item.reason === 'not_local')).toBe(true)
  })

  it('AUTO may choose a crax-gpt model', async () => {
    const service = await cloudCrax([{ id: 'glm-5.3' }])
    expect((await service.previewRoute({ mode: 'AUTO', role: 'Coding Agent', prompt: 'hi' })).primary).toMatchObject({ providerId: 'crax-gpt', model: 'glm-5.3' })
  })

  it('FREE ONLY uses crax-gpt models the catalog marks free, never paid ones', async () => {
    const service = await cloudCrax([{ id: 'free-model', free: true }, { id: 'paid-model' }])
    const preview = await service.previewRoute({ mode: 'FREE_ONLY', role: 'Coding Agent', prompt: 'hi' })
    expect(preview.primary).toMatchObject({ providerId: 'crax-gpt', model: 'free-model' })
    expect(preview.fallbacks.map(item => item.model)).not.toContain('paid-model')
    expect(preview.rejected.find(item => item.model === 'paid-model')?.reason).toBe('not_free')
  })

  it('a disconnected crax-gpt is no longer eligible', async () => {
    const h = await setup()
    await h.connect()
    h.service.disconnect('crax-gpt')
    const preview = await h.host.handle('router.preview', { mode: 'AUTO', role: 'Coding Agent' }) as { primary: unknown; fallbacks: unknown[] }
    expect(preview.primary).toBeNull()
    expect(await h.models()).toEqual([])
  })
})

describe('security', () => {
  it('cloud consent blocks project code to crax-gpt until granted (official cloud URL)', async () => {
    // Mocked transport with the real preset URL (no network): project code must not be sent without consent.
    const root = mkdtempSync(join(tmpdir(), 'altrex-crax-consent-')); roots.push(root)
    const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'secret.js'), 'const SECRET_MARKER = 1\n')
    const events = new EventBus(), tasks = new TaskManager(events)
    const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'm'), join(root, 'm'), { events, tasks, consent: new ConsentStore(null), checkpoints: new CheckpointStore(join(root, 'cp')) })
    const internal = service as unknown as { provider: Record<string, ReturnType<typeof vi.fn>>; codexAgent: { getRuntimeInfo: () => { available: boolean; version: null } } }
    internal.codexAgent.getRuntimeInfo = () => ({ available: false, version: null })
    const sent: string[] = []
    internal.provider.listModels = vi.fn(async () => ['glm-5.3'])
    internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
    internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
    internal.provider.complete = vi.fn(async ({ messages }: { messages: unknown }) => { sent.push(JSON.stringify(messages)); return { content: 'x', toolCalls: [] } })
    internal.provider.stream = vi.fn(async ({ messages }: { messages: unknown }) => { sent.push(JSON.stringify(messages)) })
    await service.connect({ providerId: 'crax-gpt', apiKey: KEY, baseUrl: '', model: '' })
    expect(service.consentEndpoints()).toEqual([expect.objectContaining({ providerId: 'crax-gpt', baseUrl: 'https://gpt.crax.lol/v1', granted: false })])
    const host = new CoreHost({ events, tasks, checkpoints: new CheckpointStore(join(root, 'cp2')), isProjectTrusted: () => true, isProjectBusy: () => false })
    const request: ChatRequest = { requestId: 'req-crax-consent', projectPath: project, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Explain secret.js' }], attachments: [] }
    const taskId = host.legacy.begin(request)!
    await service.streamChat(request, 'Repository context:\nconst SECRET_MARKER = 1', [], event => host.legacy.handle(event))
    expect(tasks.get(taskId)!.outcome?.code).toBe('CONSENT_REQUIRED')
    expect(sent).toEqual([])
  })

  it('the API key never reaches renderer-facing responses, events or the model list', async () => {
    const h = await setup()
    await h.connect()
    fill(h.server)
    await h.run(h.request())
    const surfaces = JSON.stringify([await h.providers(), await h.models(), await h.host.handle('consent.list', {}), h.published, await h.host.handle('task.list', {})])
    expect(surfaces).not.toContain(KEY)
    expect(surfaces).toContain('9876') // only the 4-character hint
  })
})
