import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { commandSchemas, COMMAND_NAMES } from './commands'
import { eventPayloadSchemas, EVENT_TYPES, parseAltrexEvent, type AltrexEvent } from './events'
import { CONTRACT_VERSION } from './version'
import { FakeCore } from './fake-core'

// Contract freeze (Phase 10). The JSON Schema of every event payload and command request/response is
// recorded in contract-v1.snapshot.json. Any schema change fails this test until the snapshot is
// regenerated deliberately (UPDATE_CONTRACT_SNAPSHOT=1), and nothing recorded may ever be removed in v1.

const SNAPSHOT = join(__dirname, '..', `contract-v${CONTRACT_VERSION}.snapshot.json`)
const schema = (value: z.ZodType, io: 'input' | 'output') => z.toJSONSchema(value, { io, unrepresentable: 'any' })

function current() {
  return {
    version: CONTRACT_VERSION,
    events: Object.fromEntries([...EVENT_TYPES].sort().map(type => [type, schema(eventPayloadSchemas[type], 'output')])),
    commands: Object.fromEntries([...COMMAND_NAMES].sort().map(name => [name, { request: schema(commandSchemas[name].request, 'input'), response: schema(commandSchemas[name].response, 'output') }])),
  }
}

describe('contract v1 freeze', () => {
  it('matches the recorded snapshot (regenerate deliberately with UPDATE_CONTRACT_SNAPSHOT=1)', () => {
    const now = current()
    if (process.env.UPDATE_CONTRACT_SNAPSHOT === '1' || !existsSync(SNAPSHOT)) writeFileSync(SNAPSHOT, `${JSON.stringify(now, null, 2)}\n`)
    expect(JSON.parse(JSON.stringify(now))).toEqual(JSON.parse(readFileSync(SNAPSHOT, 'utf8')))
  })

  it('never removes an event type or command that v1 recorded', () => {
    const recorded = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { events: Record<string, unknown>; commands: Record<string, unknown> }
    for (const type of Object.keys(recorded.events)) expect(EVENT_TYPES).toContain(type)
    for (const name of Object.keys(recorded.commands)) expect(COMMAND_NAMES).toContain(name)
  })
})

describe('FakeCore', () => {
  async function runScenario(prompt: string, mode: 'ASK' | 'AGENT' = 'AGENT', setup?: (fake: FakeCore, events: AltrexEvent[]) => void) {
    const fake = new FakeCore({ delayMs: 0 }), events: AltrexEvent[] = []
    fake.onEvent(event => events.push(event))
    setup?.(fake, events)
    const { taskId } = await fake.invoke('task.start', { projectPath: '/demo/demo-app', mode, prompt, history: [], modelSelection: 'AUTO', attachmentIds: [], candidates: 1, sessionId: 'session-demo-1' })
    await fake.idle()
    for (const event of events) expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1))
    return { fake, events, taskId, task: await fake.invoke('task.get', { taskId }) }
  }
  const states = (events: AltrexEvent[]) => events.filter(event => event.type === 'task.state_changed').map(event => (event.payload as { to: string }).to)

  it('scripts a verified change with contract-valid events and responses', async () => {
    const { events, task, fake, taskId } = await runScenario('Add a settings page')
    expect(states(events)).toEqual(['IMPLEMENTING', 'TESTING', 'REVIEWING', 'VERIFYING', 'VERIFIED'])
    expect(task).toMatchObject({ state: 'VERIFIED', verdict: { status: 'VERIFIED' }, sessionId: 'session-demo-1' })
    expect((await fake.invoke('task.events', { taskId, limit: 5000 })).events.length).toBe(events.length)
    expect(await fake.invoke('session.list', { limit: 50 })).toEqual([expect.objectContaining({ sessionId: 'session-demo-1', taskCount: 1, lastState: 'VERIFIED' })])
  })

  it('scripts a failing change that ends FAILED with a verdict', async () => {
    const { events, task } = await runScenario('make it fail please')
    expect(states(events)).toEqual(['IMPLEMENTING', 'TESTING', 'DEBUGGING', 'TESTING', 'VERIFYING', 'FAILED'])
    expect(task).toMatchObject({ state: 'FAILED', verdict: { status: 'FAILED', repairs: { limitReached: true } } })
  })

  it('pauses for approval until permission.respond', async () => {
    const fake = new FakeCore({ delayMs: 0 }), events: AltrexEvent[] = []
    fake.onEvent(event => { events.push(event); if (event.type === 'permission.required') void fake.invoke('permission.respond', { approvalId: (event.payload as { approvalId: string }).approvalId, decision: 'approve', scope: 'once' }) })
    await fake.invoke('task.start', { projectPath: '/demo/demo-app', mode: 'AGENT', prompt: 'needs approval', history: [], modelSelection: 'AUTO', attachmentIds: [], candidates: 1 })
    await fake.idle()
    expect(states(events).slice(0, 3)).toEqual(['IMPLEMENTING', 'AWAITING_APPROVAL', 'IMPLEMENTING'])
    expect(events.find(event => event.type === 'permission.resolved')?.payload).toMatchObject({ decision: 'approved', by: 'user' })
  })

  it('answers questions, cancels, and reports structured errors', async () => {
    const { events } = await runScenario('What is this?', 'ASK')
    expect(states(events)).toEqual(['ANSWERING', 'COMPLETED'])
    const fake = new FakeCore({ delayMs: 5 })
    const { taskId } = await fake.invoke('task.start', { projectPath: '/demo/demo-app', mode: 'AGENT', prompt: 'long work', history: [], modelSelection: 'AUTO', attachmentIds: [], candidates: 1 })
    expect(await fake.invoke('task.cancel', { taskId })).toEqual({ cancelled: true })
    await fake.idle()
    expect((await fake.invoke('task.get', { taskId })).state).toBe('CANCELLED')
    expect(await fake.invokeResult('task.get', { taskId: 'missing' })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown task.', retryable: false } })
    expect(await fake.invokeResult('task.get', {} as never)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    await expect(fake.invoke('terminal.run', { projectPath: '/demo', command: 'ls', args: [], timeoutMs: 1000 })).rejects.toThrow(/^UNAVAILABLE: /)
  })
})
