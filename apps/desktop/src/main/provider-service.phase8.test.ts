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
import { TaskStore } from '@altrex/core/tasks/task-store'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import { parseAltrexEvent, type AltrexEvent, type Verdict } from '@altrex/contracts'
import { ProviderService } from './provider-service'
import { consentGranted } from './test-consent'
import { CoreHost } from './core-host'
import type { ChatRequest, ChatStreamEvent, ProviderConnectionInput } from '../shared/desktop-api'
import type { ProviderCompletionInput, ProviderMessage } from './providers/model-provider'

// Phase 8: evidence-based verification and bounded auto-repair in the real request flow. The project's own
// test script runs for real (npm run test → node test.js); the model is scripted.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const TEST_JS = `const { greet } = require('./greet.js')
if (greet() !== 'hello') { console.error('Error: expected greet() to return hello, got ' + greet()); process.exit(1) }
console.log('# pass 1'); console.log('# fail 0')
`

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'altrex-phase8-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'greeter', version: '1.0.0', scripts: { test: 'node test.js' } }))
  writeFileSync(join(project, 'test.js'), TEST_JS)
  writeFileSync(join(project, 'greet.js'), 'module.exports = { greet: () => "" }\n')
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const tasks = new TaskManager(events, new TaskStore(join(root, 'tasks')))
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, tasks, consent: consentGranted(), checkpoints: new CheckpointStore(join(root, 'checkpoints')) })
  const internal = service as unknown as { provider: Record<string, ReturnType<typeof vi.fn>> }
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.listModels = vi.fn(async () => ['coder-large'])
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  const host = new CoreHost({ events, checkpoints: new CheckpointStore(join(root, 'checkpoints')), tasks, isProjectTrusted: () => true, isProjectBusy: () => false })
  const legacy: ChatStreamEvent[] = []
  const run = async (request: ChatRequest) => {
    const taskId = host.legacy.begin(request)!
    await service.streamChat(request, '', [], event => { legacy.push(event); host.legacy.handle(event) })
    return taskId
  }
  return { project, service, internal, published, tasks, run, legacy }
}

const nvidia: ProviderConnectionInput = { providerId: 'nvidia', apiKey: 'nvapi-secret', baseUrl: '', model: 'coder-large' }
const request = (projectPath: string): ChatRequest => ({ requestId: `req-${Math.random().toString(16).slice(2, 10)}`, projectPath, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content: 'Implement greet() so it returns "hello"' }], attachments: [] })
const call = (name: string, args: unknown) => ({ id: `call-${Math.random().toString(16).slice(2)}`, name, arguments: JSON.stringify(args) })
const text = (message: ProviderMessage) => (typeof message.content === 'string' ? message.content : '')

/** Scripted models: coder writes `first`, debugger writes `fix`, reviewer answers `review`. */
function script(options: { first: string; fix: string; review: string }) {
  const roles: string[] = []
  const complete = vi.fn(async ({ messages }: ProviderCompletionInput) => {
    const isReviewer = text(messages[0]!).includes('independent code REVIEWER')
    const last = messages.at(-1)!
    if (isReviewer) { roles.push('reviewer'); return { content: options.review, toolCalls: [] } }
    if (last.role === 'tool') return { content: 'Done: updated greet.js.', toolCalls: [] }
    const debugging = [...messages].reverse().find(message => message.role === 'user') && text([...messages].reverse().find(message => message.role === 'user')!).includes('DEBUGGER')
    roles.push(debugging ? 'debugger' : 'coder')
    return { content: '', toolCalls: [call('write_file', { path: 'greet.js', content: debugging ? options.fix : options.first })] }
  })
  return { complete, roles }
}
const approve = JSON.stringify({ decision: 'approve', findings: [{ severity: 'nit', category: 'style', description: 'Consider a JSDoc comment.' }], summary: 'Correct.' })

describe('verification and auto-repair in the request flow', () => {
  it('a failing test is repaired by the Debugger, re-tested for real, reviewed, and the task is VERIFIED', async () => {
    const { project, service, internal, published, tasks, run, legacy } = setup()
    await service.connect(nvidia)
    const models = script({ first: 'module.exports = { greet: () => "hi" }\n', fix: 'module.exports = { greet: () => "hello" }\n', review: approve })
    internal.provider.complete = models.complete
    const taskId = await run(request(project))

    expect(models.roles).toEqual(['coder', 'debugger', 'reviewer'])
    expect(readFileSync(join(project, 'greet.js'), 'utf8')).toContain('"hello"')
    const own = published.filter(event => event.taskId === taskId)
    const types = own.map(event => event.type === 'task.state_changed' ? `state:${(event.payload as { to: string }).to}` : event.type)
    expect(types.filter(type => type.startsWith('state:'))).toEqual(['state:IMPLEMENTING', 'state:TESTING', 'state:DEBUGGING', 'state:TESTING', 'state:REVIEWING', 'state:VERIFYING', 'state:VERIFIED'])
    const completed = own.filter(event => event.type === 'test.completed').map(event => (event.payload as { evidence: { status: string } }).evidence.status)
    expect(completed).toEqual(['FAIL', 'PASS'])
    expect(types).toEqual(expect.arrayContaining(['test.started', 'repair.started', 'review.completed', 'verification.completed', 'task.verified']))
    const verdict = (own.find(event => event.type === 'task.verified')!.payload as { verdict: Verdict }).verdict
    expect(verdict).toMatchObject({ status: 'VERIFIED', repairs: { attempts: 1, limitReached: false }, review: { decision: 'approve', independence: 'same-model' } })
    expect(verdict.checks.find(check => check.name === 'test')).toMatchObject({ status: 'PASS', summary: expect.stringContaining('1 passed, 0 failed') })
    expect(tasks.get(taskId)).toMatchObject({ state: 'VERIFIED', verdict: { status: 'VERIFIED' } })
    expect(tasks.get(taskId)!.agents.map(agent => agent.role)).toEqual(['CODER', 'TESTER', 'DEBUGGER', 'TESTER', 'REVIEWER'])
    expect(legacy.at(-1)?.type).toBe('completed')
    for (const event of published) expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
  })

  it('a failure the Debugger cannot fix ends FAILED within the repair limits; the model saying "done" changes nothing', async () => {
    const { project, service, internal, tasks, run, legacy } = setup()
    await service.connect(nvidia)
    const wrong = 'module.exports = { greet: () => "hi" }\n'
    const models = script({ first: wrong, fix: wrong, review: approve })
    internal.provider.complete = models.complete
    const taskId = await run(request(project))
    const task = tasks.get(taskId)!
    expect(task).toMatchObject({ state: 'FAILED', outcome: { code: 'VERIFICATION_FAILED' }, verdict: { status: 'FAILED', repairs: { limitReached: true }, review: { decision: 'not_run' } } })
    // first repair changes nothing → escalated once → then stops
    expect(models.roles).toEqual(['coder', 'debugger', 'debugger'])
    expect(models.roles).not.toContain('reviewer')
    expect(legacy.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('Verification: FAILED') })
  })

  it('a reviewer blocker sends the work back to the Coder; persisting blockers end FAILED', async () => {
    const { project, service, internal, tasks, run } = setup()
    await service.connect(nvidia)
    const blocker = JSON.stringify({ decision: 'approve', findings: [{ severity: 'blocker', category: 'security', file: 'greet.js', description: 'Leaks secrets' }] })
    const models = script({ first: 'module.exports = { greet: () => "hello" }\n', fix: '', review: blocker })
    internal.provider.complete = models.complete
    const taskId = await run(request(project))
    expect(models.roles.filter(role => role === 'reviewer')).toHaveLength(3) // initial + 2 bounded review cycles
    expect(tasks.get(taskId)).toMatchObject({ state: 'FAILED', verdict: { status: 'FAILED', review: { decision: 'request_changes', blockers: 1 } } })
  })
})
