import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskStateSchema, parseAltrexEvent, type AltrexEvent, type TaskState } from '@altrex/contracts'
import { EventBus } from '../events/event-bus'
import { TaskStore } from '../tasks/task-store'
import { TaskManager } from './task-manager'
import { IllegalTransitionError, assertTransition, canTransition, isTerminal, successors } from './transitions'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
function storeRoot() { const root = mkdtempSync(join(tmpdir(), 'altrex-tasks-')); roots.push(root); return root }
function harness(root: string | null = null) {
  const bus = new EventBus(), events: AltrexEvent[] = [], errors: unknown[] = []
  bus.subscribe(event => events.push(event))
  const store = root ? new TaskStore(root) : null
  return { bus, events, errors, store, tasks: new TaskManager(bus, store, error => errors.push(error)) }
}
const begin = (tasks: TaskManager, overrides: Partial<Parameters<TaskManager['begin']>[0]> = {}) =>
  tasks.begin({ requestId: 'req-12345678', mode: 'AGENT', intent: 'change', projectPath: 'C:/work/app', title: 'Add login', modelSelection: 'AUTO', routingMode: 'AUTO', ...overrides })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const types = (events: AltrexEvent[]) => events.map(event => event.type === 'task.state_changed' ? `state:${(event.payload as { to: string }).to}` : event.type)

describe('task state machine', () => {
  const states = TaskStateSchema.options as TaskState[]
  it('terminal states have no successors and every non-terminal state can fail, cancel or be interrupted', () => {
    for (const state of states) {
      if (isTerminal(state)) expect(successors(state)).toEqual([])
      else for (const end of ['FAILED', 'CANCELLED', 'INTERRUPTED'] as const) expect(canTransition(state, end)).toBe(true)
    }
  })
  it('only VERIFYING reaches VERIFIED and only ANSWERING reaches COMPLETED', () => {
    for (const state of states) {
      expect(canTransition(state, 'VERIFIED')).toBe(state === 'VERIFYING')
      expect(canTransition(state, 'COMPLETED')).toBe(state === 'ANSWERING')
    }
  })
  it('every state is reachable from RECEIVED', () => {
    const seen = new Set<TaskState>(['RECEIVED']), queue: TaskState[] = ['RECEIVED']
    while (queue.length) for (const next of successors(queue.shift()!)) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    expect([...seen].sort()).toEqual([...states].sort())
  })
  it('rejects illegal transitions', () => {
    expect(() => assertTransition('RECEIVED', 'VERIFIED')).toThrow(IllegalTransitionError)
    expect(() => assertTransition('COMPLETED', 'FAILED')).toThrow(/COMPLETED → FAILED/)
    expect(canTransition('IMPLEMENTING', 'IMPLEMENTING')).toBe(false)
  })
})

describe('TaskManager', () => {
  it('creates core task ids (not chat request ids) and maps requests to them', () => {
    const { tasks, events } = harness()
    const taskId = begin(tasks)
    expect(taskId).not.toBe('req-12345678')
    expect(taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(tasks.taskIdFor('req-12345678')).toBe(taskId)
    expect(events[0]).toMatchObject({ type: 'task.created', taskId, payload: { requestId: 'req-12345678', state: 'RECEIVED' } })
  })

  it('runs a task through validated transitions, agent runs and a terminal event', () => {
    const { tasks, events } = harness()
    const taskId = begin(tasks)
    tasks.transition(taskId, 'IMPLEMENTING')
    const coder = tasks.agentStarted(taskId, 'CODER', 'Coding agent', { providerId: 'nvidia', model: 'm1' })
    tasks.agentProgress(coder, 'Round 1: read_file', 0)
    tasks.agentEndpoint(coder, 'google', 'gemini')
    expect(() => tasks.transition(taskId, 'VERIFIED')).toThrow(IllegalTransitionError)
    tasks.end(taskId, { state: 'COMPLETED_UNVERIFIED', reason: 'No verification ran.' })
    expect(types(events)).toEqual(['task.created', 'state:IMPLEMENTING', 'agent.started', 'agent.progress', 'agent.completed', 'state:COMPLETED_UNVERIFIED', 'task.completed_unverified'])
    const task = tasks.get(taskId)!
    expect(task).toMatchObject({ state: 'COMPLETED_UNVERIFIED', outcome: { reason: 'No verification ran.' }, agents: [{ role: 'CODER', status: 'completed', providerId: 'google', model: 'gemini' }] })
    expect(task.finishedAt).not.toBeNull()
    expect(tasks.taskIdFor('req-12345678')).toBeUndefined()
    for (const event of events) expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
  })

  it('cancellation and failure close running agents with the right codes', () => {
    const { tasks, events } = harness()
    const a = begin(tasks, { requestId: 'req-aaaaaaaa' }), b = begin(tasks, { requestId: 'req-bbbbbbbb' })
    tasks.transition(a, 'IMPLEMENTING'); tasks.transition(b, 'IMPLEMENTING')
    tasks.agentStarted(a, 'CODER', 'x'); tasks.agentStarted(b, 'CODER', 'y')
    tasks.end(a, { state: 'CANCELLED' })
    tasks.end(b, { state: 'FAILED', message: 'Provider offline', code: 'PROVIDER_OFFLINE' })
    const failures = events.filter(event => event.type === 'agent.failed').map(event => event.payload as { code: string | null })
    expect(failures.map(failure => failure.code)).toEqual(['CANCELLED', 'PROVIDER_OFFLINE'])
    expect(tasks.get(a)!.agents[0]!.status).toBe('cancelled')
    expect(tasks.get(b)!.outcome).toEqual({ reason: 'Provider offline', code: 'PROVIDER_OFFLINE' })
  })

  it('records completion from a state without a direct edge honestly, never as a plain success', () => {
    const { tasks } = harness()
    const worked = begin(tasks, { requestId: 'req-worked00' })
    tasks.transition(worked, 'IMPLEMENTING')
    tasks.end(worked, { state: 'COMPLETED' }) // IMPLEMENTING → COMPLETED is not an edge
    expect(tasks.get(worked)).toMatchObject({ state: 'COMPLETED_UNVERIFIED', outcome: { reason: expect.stringContaining('no verification ran') } })
    const neverStarted = begin(tasks, { requestId: 'req-never000' })
    tasks.end(neverStarted, { state: 'COMPLETED' })
    expect(tasks.get(neverStarted)).toMatchObject({ state: 'FAILED', outcome: { code: 'ENGINE_PROTOCOL' } })
  })

  it('pauses in AWAITING_APPROVAL while a permission is pending and resumes the previous state', async () => {
    const { tasks, bus, events } = harness()
    const taskId = begin(tasks)
    tasks.transition(taskId, 'IMPLEMENTING')
    bus.publish('permission.required', { approvalId: 'ap1', taskId, tool: 'run_command', summary: 'npx x', risk: 'HIGH', capability: 'package.execute', reason: 'r', requestedAt: new Date().toISOString() }, taskId)
    await flush()
    expect(tasks.state(taskId)).toBe('AWAITING_APPROVAL')
    bus.publish('permission.resolved', { approvalId: 'ap1', decision: 'approved', scope: 'once', by: 'user', note: 'ok' }, taskId)
    await flush()
    expect(tasks.state(taskId)).toBe('IMPLEMENTING')
    // events stay in sequence order: the derived transition follows the event that caused it
    expect(types(events).slice(-4)).toEqual(['permission.required', 'state:AWAITING_APPROVAL', 'permission.resolved', 'state:IMPLEMENTING'])
  })

  it('tracks checkpoints and changed files from events', () => {
    const { tasks, bus } = harness()
    const taskId = begin(tasks)
    bus.publish('checkpoint.created', { checkpointId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', projectPath: 'C:/work/app', taskId, label: 'Before', kind: 'snapshot', createdAt: new Date().toISOString(), fileCount: 3, totalBytes: 10, finalizedAt: null, changedByTask: null }, taskId)
    bus.publish('file.changed', { paths: ['a.ts', 'b.ts'], cumulative: true }, taskId)
    expect(tasks.get(taskId)).toMatchObject({ checkpointIds: ['0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'], changedFiles: ['a.ts', 'b.ts'] })
  })
})

describe('TaskManager persistence', () => {
  it('keeps task records and event history across a restart', () => {
    const root = storeRoot()
    const first = harness(root)
    const taskId = begin(first.tasks, { mode: 'ASK', intent: 'question' })
    first.tasks.transition(taskId, 'ANSWERING')
    first.bus.publish('agent.message_delta', { text: 'The answer' }, taskId)
    first.tasks.end(taskId, { state: 'COMPLETED' })

    const second = harness(root) // new process: new stream id
    expect(second.tasks.recover()).toEqual([])
    expect(second.tasks.get(taskId)).toMatchObject({ state: 'COMPLETED', mode: 'ASK' })
    const history = second.tasks.events(taskId)
    expect(types(history.events)).toEqual(['task.created', 'state:ANSWERING', 'agent.message_delta', 'state:COMPLETED', 'task.completed'])
    expect(history.events[0]!.streamId).toBe(first.bus.streamId)
    expect(second.tasks.list({ projectPath: 'C:/work/app' }).map(task => task.taskId)).toEqual([taskId])
  })

  it('marks tasks that were running at a crash INTERRUPTED and never resumes them', () => {
    const root = storeRoot()
    const first = harness(root)
    const taskId = begin(first.tasks)
    first.tasks.transition(taskId, 'IMPLEMENTING')
    first.tasks.agentStarted(taskId, 'CODER', 'Coding agent')
    // crash: no end()

    const second = harness(root)
    const interrupted = second.tasks.recover()
    expect(interrupted.map(task => task.taskId)).toEqual([taskId])
    expect(second.tasks.get(taskId)).toMatchObject({ state: 'INTERRUPTED', outcome: { code: 'INTERRUPTED' }, agents: [{ status: 'cancelled' }] })
    expect(types(second.events)).toEqual(['state:INTERRUPTED', 'task.interrupted'])
    expect(second.tasks.isActive(taskId)).toBe(false)
    expect(types(second.tasks.events(taskId).events).slice(-2)).toEqual(['state:INTERRUPTED', 'task.interrupted'])
    expect(harness(root).tasks.recover()).toEqual([]) // idempotent
  })

  it('caps per-task history: drops high-volume events first and flags the task', () => {
    const root = storeRoot()
    const bus = new EventBus(), store = new TaskStore(root, { maxEventBytes: 64_000 }), tasks = new TaskManager(bus, store)
    const taskId = begin(tasks)
    tasks.transition(taskId, 'IMPLEMENTING')
    for (let index = 0; index < 100; index++) bus.publish('agent.message_delta', { text: 'x'.repeat(1000) }, taskId)
    tasks.end(taskId, { state: 'CANCELLED' })
    const history = store.events(taskId)
    expect(types(history.events).slice(-2)).toEqual(['state:CANCELLED', 'task.cancelled'])
    expect(history.events.filter(event => event.type === 'agent.message_delta').length).toBeLessThan(100)
    expect(store.get(taskId)!.eventsTruncated).toBe(true)
  })

  it('skips torn lines and never reads outside the store', () => {
    const root = storeRoot()
    const { tasks, store } = harness(root)
    const taskId = begin(tasks)
    const file = readdirSync(root).find(name => name.endsWith('.events.jsonl'))!
    require('node:fs').appendFileSync(join(root, file), '{"torn":')
    expect(store!.events(taskId).events.map(event => event.type)).toEqual(['task.created'])
    expect(store!.events('../../etc/passwd')).toEqual({ events: [], truncated: false })
    expect(store!.get('..\\..\\x')).toBeNull()
    expect(readFileSync(join(root, `${taskId}.json`), 'utf8')).toContain('"state":"RECEIVED"')
  })

  it('prunes old finished tasks beyond retention but keeps unfinished ones', () => {
    const root = storeRoot()
    const bus = new EventBus(), store = new TaskStore(root, { retention: 10 }), tasks = new TaskManager(bus, store)
    const running = begin(tasks, { requestId: 'req-running0' })
    for (let index = 0; index < 14; index++) { const id = begin(tasks, { requestId: `req-${String(index).padStart(8, '0')}` }); tasks.end(id, { state: 'CANCELLED' }) }
    const kept = store.list()
    expect(kept.length).toBeLessThanOrEqual(11)
    expect(kept.some(task => task.taskId === running)).toBe(true)
  })
})
