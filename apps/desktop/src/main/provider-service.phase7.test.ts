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
import { TaskStore } from '@altrex/core/tasks/task-store'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { parseAltrexEvent, type AltrexEvent, type TaskSummary } from '@altrex/contracts'
import { ProviderService } from './provider-service'
import { consentGranted } from './test-consent'
import { CoreHost } from './core-host'
import type { ChatRequest, ProviderConnectionInput } from '../shared/desktop-api'
import type { ProviderCompletionInput } from './providers/model-provider'

// Phase 7: core task ids, agent runs, persisted task history, diff.available, task.* commands.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function setup(root = mkdtempSync(join(tmpdir(), 'altrex-phase7-'))) {
  if (!roots.includes(root)) roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'index.js'), 'console.log("hello")\n')
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const tasks = new TaskManager(events, new TaskStore(join(root, 'tasks')))
  const checkpoints = new CheckpointStore(join(root, 'checkpoints'))
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, checkpoints, tasks, consent: consentGranted() })
  const internal = service as unknown as { provider: Record<string, ReturnType<typeof vi.fn>> }
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.listModels = vi.fn(async () => ['coder-large'])
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  const host = new CoreHost({ events, checkpoints, tasks, isProjectTrusted: () => true, isProjectBusy: () => false, cancelRequest: requestId => service.cancel(requestId) })
  const run = async (request: ChatRequest) => {
    const taskId = host.legacy.begin(request)!
    await service.streamChat(request, '', [], event => host.legacy.handle(event))
    return taskId
  }
  return { root, project, service, internal, published, host, tasks, run }
}
const nvidia: ProviderConnectionInput = { providerId: 'nvidia', apiKey: 'nvapi-secret', baseUrl: '', model: 'coder-large' }
const agentRequest = (projectPath: string, content: string): ChatRequest => ({ requestId: `req-${Math.random().toString(16).slice(2, 10)}`, projectPath, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content }], attachments: [] })
const completion = (content: string, toolCalls: Array<{ name: string; args: unknown }> = []) => ({ content, toolCalls: toolCalls.map((call, index) => ({ id: `call-${index}-${Math.random()}`, name: call.name, arguments: JSON.stringify(call.args) })) })

describe('task engine in the request flow', () => {
  it('an Agent task gets a core id, a CODER agent with round progress, and diff.available; all events share the task id', async () => {
    const { project, service, internal, published, host, run } = setup()
    await service.connect(nvidia)
    let turn = 0
    internal.provider.complete = vi.fn(async (_input: ProviderCompletionInput) => {
      turn += 1
      if (turn === 1) return completion('', [{ name: 'write_file', args: { path: 'src/greet.js', content: 'export const greet = () => "hi"\n' } }])
      if (turn === 2) return completion('', [{ name: 'run_command', args: { command: 'node', args: ['index.js'] } }])
      return completion('Added src/greet.js and ran index.js successfully.')
    })
    const request = agentRequest(project, 'Add a greet helper module')
    const taskId = await run(request)
    expect(taskId).not.toBe(request.requestId)
    const own = published.filter(event => event.taskId !== null)
    expect(new Set(own.map(event => event.taskId))).toEqual(new Set([taskId]))
    const types = own.map(event => event.type)
    for (const type of ['task.created', 'checkpoint.created', 'agent.started', 'agent.progress', 'command.started', 'command.completed', 'diff.available', 'agent.completed', 'task.completed_unverified']) expect(types).toContain(type)
    expect(types.indexOf('diff.available')).toBeLessThan(types.indexOf('task.completed_unverified'))
    const started = own.find(event => event.type === 'agent.started')!.payload as { role: string; providerId: string }
    expect(started).toMatchObject({ role: 'CODER', providerId: 'nvidia' })
    const diff = own.find(event => event.type === 'diff.available')!.payload as { checkpointId: string; files: Array<{ path: string; change: string }> }
    expect(diff.files).toEqual([{ path: 'src/greet.js', change: 'added' }])
    for (const event of published) expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)

    const summary = await host.handle('task.get', { taskId }) as TaskSummary
    expect(summary).toMatchObject({ state: 'COMPLETED_UNVERIFIED', engine: 'altrex', requestId: request.requestId, changedFiles: ['src/greet.js'], checkpointIds: [diff.checkpointId] })
    // Phase 8 adds verification after the coder: here the mocked model never returns a valid review, so the
    // review is recorded as not run and the task stays COMPLETED_UNVERIFIED.
    expect(summary.agents[0]).toMatchObject({ role: 'CODER', status: 'completed' })
    expect(summary.verdict).toMatchObject({ status: 'COMPLETED_UNVERIFIED', review: { decision: 'not_run' } })
    expect(await host.handle('checkpoint.diff', { checkpointId: diff.checkpointId, path: 'src/greet.js' })).toMatchObject({ before: null, current: 'export const greet = () => "hi"\n', changedSinceTask: false })
  })

  it('task history survives a restart, and a task running at the crash comes back INTERRUPTED', async () => {
    const first = setup()
    await first.service.connect(nvidia)
    first.internal.provider.stream = vi.fn(async ({ onDelta }: { onDelta: (text: string) => void }) => { onDelta('Answer text') })
    const askId = await first.run({ requestId: 'req-ask00001', projectPath: null, mode: 'ASK', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'What is ALTREX?' }], attachments: [] })
    const crashed = first.host.legacy.begin(agentRequest(first.project, 'Refactor everything'))! // never finishes

    const second = setup(first.root)
    expect(second.tasks.recover().map(task => task.taskId)).toEqual([crashed])
    const listed = await second.host.handle('task.list', {}) as TaskSummary[]
    expect(listed.map(task => [task.taskId, task.state])).toEqual(expect.arrayContaining([[askId, 'COMPLETED'], [crashed, 'INTERRUPTED']]))
    const history = await second.host.handle('task.events', { taskId: askId }) as { events: AltrexEvent[] }
    expect(history.events.map(event => event.type)).toEqual(expect.arrayContaining(['task.created', 'agent.message_delta', 'task.completed']))
    expect(await second.host.handle('task.cancel', { taskId: crashed })).toEqual({ cancelled: false }) // nothing to resume or cancel
  })

  it('task.cancel stops the engine behind a running task', async () => {
    const { project, service, internal, host, run, tasks } = setup()
    await service.connect(nvidia)
    internal.provider.complete = vi.fn(({ signal }: ProviderCompletionInput) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))) }))
    const request = agentRequest(project, 'Add a feature')
    const pending = run(request)
    await vi.waitFor(() => expect(internal.provider.complete).toHaveBeenCalled())
    const taskId = tasks.taskIdFor(request.requestId)!
    expect(await host.handle('task.cancel', { taskId })).toEqual({ cancelled: true })
    await pending
    expect(tasks.get(taskId)).toMatchObject({ state: 'CANCELLED', agents: [{ status: 'cancelled' }] })
  })
})
