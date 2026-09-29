import { describe, expect, it } from 'vitest'
import { EventBus } from '@altrex/core/events/event-bus'
import { parseAltrexEvent, type AltrexEvent } from '@altrex/contracts'
import { LegacyEventBridge } from './legacy-event-bridge'
import type { ChatRequest, ChatStreamEvent } from '../shared/desktop-api'
import type { ProjectRun } from '../shared/multi-ai'

function harness() {
  const bus = new EventBus(), events: AltrexEvent[] = [], errors: unknown[] = []
  bus.subscribe(event => events.push(event))
  return { bridge: new LegacyEventBridge(bus, error => errors.push(error)), events, errors }
}
const request = (mode: ChatRequest['mode'], requestId = 'request-1'): ChatRequest => ({
  requestId, projectPath: mode === 'ASK' ? null : 'C:/work/app', mode, modelSelection: 'AUTO',
  messages: [{ role: 'user', content: 'Fix the login bug\nwith more detail' }], attachments: [],
})
const legacy = (type: ChatStreamEvent['type'], extra: Partial<ChatStreamEvent> = {}): ChatStreamEvent => ({ requestId: 'request-1', type, ...extra })
const summary = (events: AltrexEvent[]) => events.map(event => event.type === 'task.state_changed' ? `${event.type}:${event.payload.to}` : event.type)

describe('LegacyEventBridge', () => {
  it('maps an Agent task to contract-v1 events and never claims verification', () => {
    const { bridge, events } = harness()
    bridge.begin(request('AGENT'))
    for (const event of [
      legacy('activity', { message: 'Checkpoint saved before changes (3 files).' }),
      legacy('started', { provider: 'Google Gemini', model: 'gemini-x' }),
      legacy('delta', { delta: 'Working' }),
      legacy('command-result', { command: 'npm test', exitCode: 0, output: 'ok' }),
      legacy('files-changed', { files: ['src/login.ts'] }),
      legacy('completed'),
    ]) bridge.handle(event)

    expect(summary(events)).toEqual([
      // model.selected comes from the router itself since Phase 4, not from the legacy bridge.
      'task.created', 'task.activity', 'task.state_changed:IMPLEMENTING', 'agent.message_delta',
      'command.exited', 'file.changed', 'task.state_changed:COMPLETED_UNVERIFIED', 'task.completed_unverified',
    ])
    // V4 Phase 7 change: the task id is a core id (uuidv7); the chat request id is kept only for correlation.
    expect(events[0]).toMatchObject({ payload: { state: 'RECEIVED', mode: 'AGENT', intent: 'change', title: 'Fix the login bug', requestId: 'request-1' } })
    expect(events[0]!.taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(new Set(events.map(event => event.taskId)).size).toBe(1)
    expect(events.find(event => event.type === 'task.completed_unverified')?.payload).toMatchObject({ reason: expect.stringContaining('evidence-based verification verdict') })
    expect(events.some(event => event.type === 'task.state_changed' && event.payload.to === 'VERIFIED')).toBe(false)
    for (const event of events) expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
  })

  it('completes an Ask request as answered, not as a change', () => {
    const { bridge, events } = harness()
    bridge.begin(request('ASK'))
    bridge.handle(legacy('started', { provider: 'Groq', model: 'm' }))
    bridge.handle(legacy('completed'))
    expect(summary(events)).toEqual(['task.created', 'task.state_changed:ANSWERING', 'task.state_changed:COMPLETED', 'task.completed'])
  })

  it('reports Codex as an engine without inventing a model selection', () => {
    const { bridge, events } = harness()
    bridge.begin(request('AGENT'))
    bridge.handle(legacy('started', { provider: 'OpenAI Codex', model: 'codex 1.2' }))
    expect(events.some(event => event.type === 'model.selected')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'task.activity', payload: { message: expect.stringContaining('OpenAI Codex engine') } })
  })

  it('maps Director run states for Multi-AI and ignores repeated states', () => {
    const { bridge, events, errors } = harness()
    const run = (status: ProjectRun['status']) => legacy('run-state', { run: { status } as ProjectRun })
    bridge.begin(request('MULTI'))
    for (const event of [legacy('started', { provider: 'ALTREX Director', model: 'AUTO · per task' }), run('PLANNING'), run('RUNNING'), run('RUNNING'), run('VERIFYING'), legacy('error', { message: 'Final QA rejected integration' })]) bridge.handle(event)
    // V4 Phase 7 change: Director phases are agent runs (planner, project checks); failure closes them.
    expect(summary(events)).toEqual(['task.created', 'task.state_changed:PLANNING', 'agent.started', 'task.state_changed:IMPLEMENTING', 'task.state_changed:TESTING', 'agent.started', 'agent.failed', 'agent.failed', 'task.state_changed:FAILED', 'task.failed'])
    expect(events.filter(event => event.type === 'agent.started').map(event => (event.payload as { role: string }).role)).toEqual(['PLANNER', 'TESTER'])
    expect(errors).toEqual([])
  })

  it('stops tracking after a terminal event and ignores unknown requests', () => {
    const { bridge, events } = harness()
    bridge.begin(request('AGENT'))
    bridge.handle(legacy('cancelled'))
    bridge.handle(legacy('delta', { delta: 'late' }))
    bridge.handle({ requestId: 'never-begun', type: 'completed' })
    expect(summary(events)).toEqual(['task.created', 'task.state_changed:CANCELLED', 'task.cancelled'])
    expect(bridge.activeTaskIds()).toEqual([])
  })

  it('bounds oversized legacy payloads instead of dropping or throwing', () => {
    const { bridge, events, errors } = harness()
    bridge.begin(request('AGENT'))
    bridge.handle(legacy('command-result', { command: 'build', exitCode: null, output: 'x'.repeat(20_000) }))
    bridge.handle(legacy('activity', { message: 'y'.repeat(9000) }))
    bridge.handle(legacy('activity', { message: '   ' }))
    expect(errors).toEqual([])
    expect(events.find(event => event.type === 'command.exited')?.payload).toMatchObject({ exitCode: null, output: 'x'.repeat(8192) })
    expect(events.filter(event => event.type === 'task.activity')).toHaveLength(1)
  })
})
