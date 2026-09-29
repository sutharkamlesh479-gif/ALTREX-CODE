import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toDataURL: () => '' }) }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`encrypted:${value}`), decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''), getSelectedStorageBackend: () => 'dpapi' },
}))
vi.mock('./local-ai-service', () => ({ ensureLocalAiServer: vi.fn(async () => undefined), pullLocalModel: vi.fn(async () => undefined), unloadLocalModel: vi.fn(async () => undefined) }))

import { EventBus } from '@altrex/core/events/event-bus'
import { TaskManager } from '@altrex/core/orchestrator/task-manager'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { ProviderService } from './provider-service'
import { consentGranted } from './test-consent'
import { CoreHost } from './core-host'
import type { ChatRequest, ChatStreamEvent, ProviderConnectionInput } from '../shared/desktop-api'
import type { ProviderStreamInput } from './providers/model-provider'

// Regression tests for the final independent audit (docs/FINAL_CLAUDE_AUDIT.md): H1, H2, M2.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'altrex-audit-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), '# demo\n')
  const events = new EventBus()
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, consent: consentGranted(), checkpoints: new CheckpointStore(join(root, 'cp')), ensureLocalRuntime: vi.fn(async () => undefined) })
  const internal = service as unknown as {
    provider: Record<string, ReturnType<typeof vi.fn>>
    codexAgent: { getRuntimeInfo: () => { available: boolean; version: string | null }; run: ReturnType<typeof vi.fn> }
  }
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  internal.provider.listModels = vi.fn(async (connection: ProviderConnectionInput) => connection.providerId === 'ollama' ? ['local-coder'] : ['cloud-pro'])
  const used: string[] = []
  internal.provider.stream = vi.fn(async ({ connection, onDelta }: ProviderStreamInput) => { used.push(`${connection.providerId}/${connection.model}`); onDelta('ok') })
  const run = async (request: ChatRequest) => { const out: ChatStreamEvent[] = []; await service.streamChat(request, '', [], event => out.push(event)); return out }
  return { root, project, events, service, internal, used, run }
}
const ask = (overrides: Partial<ChatRequest>): ChatRequest => ({ requestId: `req-${Math.random().toString(16).slice(2, 10)}`, projectPath: null, mode: 'ASK', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Explain the project' }], attachments: [], ...overrides })

describe('H1: a Custom model goes only to the provider that offers it', () => {
  it('routes a local model to Ollama even when a cloud provider is the active profile', async () => {
    const h = setup()
    await h.service.connect({ providerId: 'ollama', apiKey: '', baseUrl: '', model: 'local-coder' })
    await h.service.connect({ providerId: 'google', apiKey: 'google-secret', baseUrl: '', model: 'cloud-pro' }) // becomes active
    const out = await h.run(ask({ modelSelection: 'local-coder', routingMode: 'CUSTOM' }))
    expect(out.at(-1)?.type).toBe('completed')
    expect(h.used).toEqual(['ollama/local-coder'])
  })

  it('refuses a model no configured provider offers, sending nothing', async () => {
    const h = setup()
    await h.service.connect({ providerId: 'ollama', apiKey: '', baseUrl: '', model: 'local-coder' })
    await h.service.connect({ providerId: 'google', apiKey: 'google-secret', baseUrl: '', model: 'cloud-pro' })
    const out = await h.run(ask({ modelSelection: 'unknown-model', routingMode: 'CUSTOM' }))
    expect(out.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('not offered by any configured') })
    expect(h.used).toEqual([])
  })

  it('keeps the single-provider behaviour for models the provider does not list', async () => {
    const h = setup()
    await h.service.connect({ providerId: 'google', apiKey: 'google-secret', baseUrl: '', model: 'cloud-pro' })
    await h.run(ask({ modelSelection: 'typed-model', routingMode: 'CUSTOM' }))
    expect(h.used).toEqual(['google/typed-model'])
  })
})

describe('H2: local-only and free-only routing never fall back to the Codex cloud engine', () => {
  for (const routingMode of ['LOCAL_ONLY', 'FREE_ONLY'] as const) {
    it(`${routingMode} with no provider configured does not start Codex`, async () => {
      const h = setup()
      h.internal.codexAgent.getRuntimeInfo = () => ({ available: true, version: 'codex-test' })
      h.internal.codexAgent.run = vi.fn(async () => undefined)
      const out = await h.run(ask({ mode: 'AGENT', projectPath: h.project, routingMode }))
      expect(h.internal.codexAgent.run).not.toHaveBeenCalled()
      expect(out.at(-1)?.type).toBe('error')
    })
  }

  it('AUTO still uses Codex when it is the only engine (unchanged)', async () => {
    const h = setup()
    h.internal.codexAgent.getRuntimeInfo = () => ({ available: true, version: 'codex-test' })
    h.internal.codexAgent.run = vi.fn(async () => undefined)
    await h.run(ask({ mode: 'AGENT', projectPath: h.project, routingMode: 'AUTO' }))
    expect(h.internal.codexAgent.run).toHaveBeenCalledTimes(1)
  })
})

describe('M2: one write-capable task per project', () => {
  it('task.start refuses a second write task in a busy project but allows Ask', async () => {
    const h = setup()
    const started: string[] = []
    const host = new CoreHost({
      events: h.events, tasks: new TaskManager(h.events), checkpoints: new CheckpointStore(join(h.root, 'cp2')),
      isProjectTrusted: () => true, isProjectBusy: () => true,
      startTask: async request => { started.push(request.mode); return 'task-id' },
    })
    const base = { projectPath: h.project, prompt: 'Change something' }
    expect(await host.handleResult('task.start', { ...base, mode: 'AGENT' })).toMatchObject({ ok: false, error: { code: 'PROJECT_BUSY', retryable: true } })
    expect(await host.handleResult('task.start', { ...base, mode: 'ASK' })).toMatchObject({ ok: true })
    expect(started).toEqual(['ASK'])
  })
})
