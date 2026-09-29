import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toDataURL: () => '' }) }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`encrypted:${value}`), decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''), getSelectedStorageBackend: () => 'dpapi' },
}))
vi.mock('./local-ai-service', () => ({ ensureLocalAiServer: vi.fn(async () => undefined), pullLocalModel: vi.fn(async () => undefined), unloadLocalModel: vi.fn(async () => undefined) }))

import { EventBus } from '@altrex/core/events/event-bus'
import { TaskManager } from '@altrex/core/orchestrator/task-manager'
import { CODEX_CONSENT_ENDPOINT, ConsentRequiredError, ConsentStore } from '@altrex/core/security/consent'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import type { AltrexEvent, CloudConsent } from '@altrex/contracts'
import { ProviderService } from './provider-service'
import { CoreHost } from './core-host'
import type { ChatRequest, ProviderConnectionInput } from '../shared/desktop-api'
import type { ProviderCompletionInput, ProviderStreamInput } from './providers/model-provider'

// M4 (final audit): cloud-code consent is enforced by the backend. Every task path that could carry project
// code to a cloud endpoint is refused before any model request unless the user granted consent.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const SECRET_CODE = 'const PROJECT_SECRET_MARKER = 42'

function setup(consentPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-consent-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'index.js'), `${SECRET_CODE}\n`)
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const tasks = new TaskManager(events)
  const consent = new ConsentStore(consentPath ?? join(root, 'consent.json'))
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, tasks, consent, checkpoints: new CheckpointStore(join(root, 'cp')), leasesRoot: join(root, 'leases'), ensureLocalRuntime: vi.fn(async () => undefined) })
  const internal = service as unknown as {
    provider: Record<string, ReturnType<typeof vi.fn>>
    codexAgent: { getRuntimeInfo: () => { available: boolean; version: string | null }; run: ReturnType<typeof vi.fn> }
    providerFor(request: ChatRequest): { complete(input: unknown): Promise<unknown>; stream(input: unknown): Promise<unknown> }
  }
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  internal.provider.listModels = vi.fn(async (connection: ProviderConnectionInput) => [connection.providerId === 'ollama' ? 'local-coder' : 'cloud-coder'])
  // Everything sent to any model is recorded, so tests can prove project code never left.
  const sent: Array<{ providerId: string; body: string }> = []
  internal.provider.complete = vi.fn(async ({ connection, messages }: ProviderCompletionInput) => { sent.push({ providerId: connection.providerId, body: JSON.stringify(messages) }); return { content: 'Done: nothing to change.', toolCalls: [] } })
  internal.provider.stream = vi.fn(async ({ connection, messages, onDelta }: ProviderStreamInput) => { sent.push({ providerId: connection.providerId, body: JSON.stringify(messages) }); onDelta('Answer.') })
  internal.codexAgent.getRuntimeInfo = () => ({ available: false, version: null })
  internal.codexAgent.run = vi.fn(async () => { sent.push({ providerId: 'codex', body: 'project' }) })
  const host = new CoreHost({
    events, tasks, checkpoints: new CheckpointStore(join(root, 'cp2')), isProjectTrusted: () => true, isProjectBusy: () => false,
    consent: { list: () => service.consentEndpoints(), grant: endpoint => service.grantConsent(endpoint), revoke: endpoint => service.revokeConsent(endpoint) },
  })
  const run = async (request: ChatRequest) => {
    const taskId = host.legacy.begin(request)!
    await service.streamChat(request, request.projectPath ? `Repository context:\n${SECRET_CODE}` : '', [], event => host.legacy.handle(event))
    return taskId
  }
  const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({ requestId: `req-${Math.random().toString(16).slice(2, 10)}`, projectPath: project, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Explain index.js' }], attachments: [], ...overrides })
  const cloud = async () => { await service.connect({ providerId: 'groq', apiKey: 'gsk-test', baseUrl: '', model: 'cloud-coder' }) }
  const grantCloud = async () => { for (const endpoint of await host.handle('consent.list', {}) as CloudConsent[]) await host.handle('consent.grant', { providerId: endpoint.providerId, baseUrl: endpoint.baseUrl }) }
  const leaked = () => sent.some(item => item.body.includes('PROJECT_SECRET_MARKER'))
  return { root, project, service, internal, tasks, host, published, sent, run, request, cloud, grantCloud, leaked }
}

describe('cloud provider without consent is blocked', () => {
  it('fails the task with CONSENT_REQUIRED before any model request; no project code is sent', async () => {
    const h = setup()
    await h.cloud()
    const taskId = await h.run(h.request())
    expect(h.tasks.get(taskId)).toMatchObject({ state: 'FAILED', outcome: { code: 'CONSENT_REQUIRED', reason: expect.stringContaining('consent') } })
    expect(h.sent).toEqual([])
    expect(h.leaked()).toBe(false)
  })

  it('lists the endpoint as needing consent', async () => {
    const h = setup()
    await h.cloud()
    expect(await h.host.handle('consent.list', {})).toEqual([expect.objectContaining({ providerId: 'groq', granted: false, grantedAt: null })])
  })
})

describe('cloud provider with consent is allowed', () => {
  it('runs after consent is granted and blocks again after it is revoked', async () => {
    const h = setup()
    await h.cloud()
    await h.grantCloud()
    const allowed = await h.run(h.request())
    expect(h.tasks.get(allowed)!.state).not.toBe('FAILED')
    expect(h.sent.length).toBeGreaterThan(0)
    const [endpoint] = await h.host.handle('consent.list', {}) as CloudConsent[]
    expect(endpoint).toMatchObject({ granted: true, grantedAt: expect.any(String) })
    expect(await h.host.handle('consent.revoke', endpoint!)).toEqual({ revoked: true })
    h.sent.length = 0
    const blocked = await h.run(h.request())
    expect(h.tasks.get(blocked)!.outcome?.code).toBe('CONSENT_REQUIRED')
    expect(h.sent).toEqual([])
  })

  it('consent persists across a restart (stored by the backend)', async () => {
    const first = setup()
    await first.cloud()
    await first.grantCloud()
    const path = join(first.root, 'consent.json')
    expect(JSON.parse(readFileSync(path, 'utf8')).grants).toHaveLength(1)
    expect(new ConsentStore(path).has({ providerId: 'groq', baseUrl: (await first.host.handle('consent.list', {}) as CloudConsent[])[0]!.baseUrl })).toBe(true)
  })

  it('only configured cloud endpoints can be granted', async () => {
    const h = setup()
    expect(await h.host.handle('consent.grant', { providerId: 'groq', baseUrl: 'https://attacker.example/v1' })).toEqual({ granted: false })
  })
})

describe('local endpoints and tasks without project code', () => {
  it('a local-only provider needs no cloud consent', async () => {
    const h = setup()
    await h.service.connect({ providerId: 'ollama', apiKey: '', baseUrl: '', model: 'local-coder' })
    const taskId = await h.run(h.request({ mode: 'LOCAL' }))
    expect(h.tasks.get(taskId)!.outcome?.code).not.toBe('CONSENT_REQUIRED')
    expect(h.sent.map(item => item.providerId)).toEqual(expect.arrayContaining(['ollama']))
    expect(h.sent.every(item => item.providerId === 'ollama')).toBe(true)
  })

  it('with a local and a non-consented cloud provider, project code goes only to the local one', async () => {
    const h = setup()
    await h.cloud()
    await h.service.connect({ providerId: 'ollama', apiKey: '', baseUrl: '', model: 'local-coder' })
    // The local model fails, so routing must decide about the cloud fallback: it may not use it.
    const mock = h.internal.provider.complete!, complete = mock.getMockImplementation()!
    mock.mockImplementation(async (input: ProviderCompletionInput) => {
      await complete(input)
      if (input.connection.providerId === 'ollama') throw new Error('local model crashed')
      return { content: 'Done.', toolCalls: [] }
    })
    await h.run(h.request())
    expect(h.sent.length).toBeGreaterThan(0)
    expect(h.sent.every(item => item.providerId === 'ollama')).toBe(true)
    expect(h.leaked() && h.sent.some(item => item.providerId === 'groq')).toBe(false)
  })

  it('a question without a project sends no project code and needs no consent', async () => {
    const h = setup()
    await h.cloud()
    const taskId = await h.run(h.request({ mode: 'ASK', projectPath: null }))
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED')
  })
})

describe('consent cannot be bypassed through another task path', () => {
  const blocked = async (h: ReturnType<typeof setup>, overrides: Partial<ChatRequest>) => {
    const taskId = await h.run(h.request(overrides))
    expect(h.tasks.get(taskId)!.outcome?.code).toBe('CONSENT_REQUIRED')
    expect(h.sent).toEqual([])
    expect(h.leaked()).toBe(false)
  }
  it('Ask mode with a project (repository context)', async () => { const h = setup(); await h.cloud(); await blocked(h, { mode: 'ASK' }) })
  it('Multi-AI Director', async () => { const h = setup(); await h.cloud(); await blocked(h, { mode: 'MULTI' }) })
  it('tournament candidates', async () => { const h = setup(); await h.cloud(); await blocked(h, { candidates: 3 }) })
  it('Custom model selection', async () => { const h = setup(); await h.cloud(); await blocked(h, { modelSelection: 'cloud-coder', routingMode: 'CUSTOM' }) })

  it('the external Codex engine needs its own consent', async () => {
    const h = setup()
    h.internal.codexAgent.getRuntimeInfo = () => ({ available: true, version: 'codex-test' })
    await blocked(h, {})
    expect(h.internal.codexAgent.run).not.toHaveBeenCalled()
    expect(await h.host.handle('consent.list', {})).toEqual([expect.objectContaining(CODEX_CONSENT_ENDPOINT)])
    await h.grantCloud()
    await h.run(h.request())
    expect(h.internal.codexAgent.run).toHaveBeenCalledTimes(1)
  })

  it('explicitly choosing ChatGPT Codex runs the Codex engine even when API providers are configured', async () => {
    const h = setup()
    await h.cloud()
    h.internal.codexAgent.getRuntimeInfo = () => ({ available: true, version: 'codex-test' })
    await h.host.handle('consent.grant', { providerId: 'codex', baseUrl: 'codex-cli' })
    const taskId = await h.run(h.request({ modelSelection: 'CODEX', routingMode: 'AUTO' }))
    expect(h.internal.codexAgent.run).toHaveBeenCalledTimes(1)
    expect(h.tasks.get(taskId)!.engine).toBe('codex')
    expect(h.sent.filter(item => item.providerId === 'groq')).toEqual([]) // no project code to the unconsented API provider
  })

  it('the core task.start command path', async () => {
    const h = setup()
    await h.cloud()
    // The host shares the service's task manager, as in the app.
    const events = new EventBus(), tasks = h.tasks
    const host: CoreHost = new CoreHost({
      events, tasks, checkpoints: new CheckpointStore(join(h.root, 'cp3')), isProjectTrusted: () => true, isProjectBusy: () => false,
      startTask: async (start): Promise<string> => {
        const request = h.request({ mode: start.mode, messages: [{ role: 'user', content: start.prompt }] })
        const taskId: string = host.legacy.begin(request)!
        await h.service.streamChat(request, `Repository context:\n${SECRET_CODE}`, [], event => host.legacy.handle(event))
        return taskId
      },
    })
    const result = await host.handle('task.start', { projectPath: h.project, mode: 'AGENT', prompt: 'Change index.js' }) as { taskId: string }
    expect(tasks.get(result.taskId)).toMatchObject({ state: 'FAILED', outcome: { code: 'CONSENT_REQUIRED' } })
    expect(h.sent).toEqual([])
  })

  it('backstop: even a request routed around the filter is refused at the provider boundary', async () => {
    const h = setup()
    await h.cloud()
    const guarded = h.internal.providerFor(h.request())
    const connection = { providerId: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'cloud-coder', apiKey: 'gsk-test' }
    await expect(guarded.complete({ connection, messages: [{ role: 'user', content: SECRET_CODE }], tools: [], signal: new AbortController().signal })).rejects.toBeInstanceOf(ConsentRequiredError)
    await expect(guarded.stream({ connection, messages: [{ role: 'user', content: SECRET_CODE }], signal: new AbortController().signal, onDelta: () => undefined })).rejects.toBeInstanceOf(ConsentRequiredError)
    expect(h.sent).toEqual([])
  })
})
