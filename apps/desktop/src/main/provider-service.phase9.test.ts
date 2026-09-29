import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toDataURL: () => '' }) }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`encrypted:${value}`), decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ''), getSelectedStorageBackend: () => 'dpapi' },
}))
vi.mock('./local-ai-service', () => ({ ensureLocalAiServer: vi.fn(async () => undefined), pullLocalModel: vi.fn(async () => undefined), unloadLocalModel: vi.fn(async () => undefined) }))

import { EventBus } from '@altrex/core/events/event-bus'
import { ProjectMemory } from '@altrex/core/memory/project-memory'
import { TaskManager } from '@altrex/core/orchestrator/task-manager'
import { TaskStore } from '@altrex/core/tasks/task-store'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { parseAltrexEvent, type AltrexEvent, type MemoryFact } from '@altrex/contracts'
import { ProviderService } from './provider-service'
import { consentGranted } from './test-consent'
import { CoreHost } from './core-host'
import type { ChatRequest } from '../shared/desktop-api'
import type { ProviderCompletionInput, ProviderMessage } from './providers/model-provider'

// Phase 9: tournament candidates in isolated workspaces, evidence ranking, and evidence-backed memory.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'altrex-phase9-'))
  roots.push(root)
  const project = join(root, 'project'), leasesRoot = join(root, 'leases')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'greeter', version: '1.0.0', scripts: { test: 'node test.js' } }))
  writeFileSync(join(project, 'test.js'), "const { greet } = require('./greet.js')\nif (greet() !== 'hello') { console.error('Error: wrong greeting'); process.exit(1) }\nconsole.log('# pass 1')\n")
  writeFileSync(join(project, 'greet.js'), 'module.exports = { greet: () => "" }\n')
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const tasks = new TaskManager(events, new TaskStore(join(root, 'tasks')))
  const memory = new ProjectMemory(join(root, 'projects'))
  const checkpoints = new CheckpointStore(join(root, 'checkpoints'))
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, tasks, memory, leasesRoot, checkpoints, consent: consentGranted() })
  const internal = service as unknown as { provider: Record<string, ReturnType<typeof vi.fn>> }
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.listModels = vi.fn(async () => ['coder-large'])
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  const host = new CoreHost({ events, checkpoints, tasks, memory, isProjectTrusted: () => true, isProjectBusy: () => false })
  const run = async (request: ChatRequest) => {
    const taskId = host.legacy.begin(request)!
    await service.streamChat(request, '', [], event => host.legacy.handle(event))
    return taskId
  }
  return { project, leasesRoot, service, internal, published, tasks, host, run }
}

const text = (message: ProviderMessage) => (typeof message.content === 'string' ? message.content : '')
const call = (name: string, args: unknown) => ({ id: `call-${Math.random().toString(16).slice(2)}`, name, arguments: JSON.stringify(args) })

describe('tournament and memory in the request flow', () => {
  it('two candidates work in isolation; the one whose checks pass is applied, verified, and remembered', async () => {
    const { project, leasesRoot, service, internal, published, tasks, host, run } = setup()
    await service.connect({ providerId: 'nvidia', apiKey: 'nvapi-secret', baseUrl: '', model: 'coder-large' })
    await service.connect({ providerId: 'groq', apiKey: 'gsk-secret', baseUrl: '', model: 'coder-large' })
    const writers: string[] = []
    internal.provider.complete = vi.fn(async ({ messages, connection }: ProviderCompletionInput) => {
      if (text(messages[0]!).includes('independent code REVIEWER')) return { content: JSON.stringify({ decision: 'approve', findings: [] }), toolCalls: [] }
      if (messages.at(-1)!.role === 'tool') return { content: 'Done.', toolCalls: [] }
      writers.push(connection.providerId)
      const greeting = connection.providerId === 'groq' ? 'hello' : 'hi'
      return { content: '', toolCalls: [call('write_file', { path: 'greet.js', content: `module.exports = { greet: () => "${greeting}" }\n` })] }
    })
    const request: ChatRequest = { requestId: 'req-tourney1', projectPath: project, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Implement greet() returning "hello"' }], attachments: [], candidates: 2 }
    const taskId = await run(request)

    expect(new Set(writers)).toEqual(new Set(['nvidia', 'groq'])) // each candidate started on a different provider
    expect(readFileSync(join(project, 'greet.js'), 'utf8')).toContain('"hello"')
    const own = published.filter(event => event.taskId === taskId)
    const candidates = own.filter(event => event.type === 'tournament.candidate').map(event => event.payload as { providerId: string; checks: Array<{ status: string }> })
    expect(candidates).toHaveLength(2)
    expect(candidates.find(item => item.providerId === 'groq')!.checks).toEqual([{ name: 'test', status: 'PASS' }])
    const selected = own.find(event => event.type === 'tournament.selected')!.payload as { winner: number; applied: string[]; ranking: Array<{ eligible: boolean }> }
    expect(selected.applied).toEqual(['greet.js'])
    expect(tasks.get(taskId)).toMatchObject({ state: 'VERIFIED', verdict: { status: 'VERIFIED' } })
    expect(existsSync(leasesRoot) ? readdirSync(leasesRoot).filter(name => name !== 'leases.json') : []).toEqual([]) // every lease released

    expect(own.some(event => event.type === 'memory.updated')).toBe(true)
    const facts = await host.handle('memory.list', { projectPath: project }) as MemoryFact[]
    expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'check.test', value: expect.stringContaining('→ PASS'), source: 'evidence' })]))
    expect(await host.handle('memory.remember', { projectPath: project, key: 'style', value: 'Prefer small modules' })).toEqual({ key: 'user.style' })
    expect(await host.handle('memory.forget', { projectPath: project, key: 'user.style' })).toEqual({ removed: true })
    for (const event of published) expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
  })

  it('when no candidate produces an applicable change the task fails and the project is untouched', async () => {
    const { project, service, internal, tasks, run } = setup()
    await service.connect({ providerId: 'nvidia', apiKey: 'nvapi-secret', baseUrl: '', model: 'coder-large' })
    internal.provider.complete = vi.fn(async () => ({ content: 'I would change greet.js.', toolCalls: [] }))
    const taskId = await run({ requestId: 'req-tourney2', projectPath: project, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Implement greet() returning "hello"' }], attachments: [], candidates: 3 })
    expect(tasks.get(taskId)).toMatchObject({ state: 'FAILED', outcome: { reason: expect.stringContaining('No tournament candidate produced an applicable change') } })
    expect(readFileSync(join(project, 'greet.js'), 'utf8')).toBe('module.exports = { greet: () => "" }\n')
  })
})
