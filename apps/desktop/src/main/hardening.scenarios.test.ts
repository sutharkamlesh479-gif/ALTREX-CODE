import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import { reply, startFakeOpenAiServer, type FakeOpenAiServer, type FakeReply } from '@altrex/core/testing/fake-openai-server'
import { parseAltrexEvent, type AltrexEvent, type TaskSummary } from '@altrex/contracts'
import { ProviderService } from './provider-service'
import { CoreHost } from './core-host'
import type { ChatRequest, ProviderConnectionInput } from '../shared/desktop-api'

// Phase 11 hardening: end-to-end scenarios through the real stack — loopback HTTP providers, the gateway
// (SSE, deadlines, retries, breaker), the router (fallback), the coding agent and tools, verification,
// task events and persistence. No external API is called; the "model" is a scripted responder.

const roots: string[] = []
const servers: FakeOpenAiServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

type Body = { messages: Array<{ role: string; content: unknown }>; stream?: boolean }
type Brain = { first?: string; fix?: string; path?: string; unknownToolFirst?: boolean }

/** A scripted model: reviewer → approve; after a tool result → finish; otherwise → write a file. */
function brain(options: Brain = {}): FakeReply {
  return (request, response) => {
    const body = request.json as Body
    const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))
    const send = (content: string | null, call?: { name: string; arguments: unknown }) => (body.stream
      ? (call ? reply.streamToolCall(call) : reply.stream([content ?? '']))
      : reply.completion({ content, ...(call ? { toolCalls: [call] } : {}) }))(request, response)
    const messages = body.messages, last = messages.at(-1)!
    if (text(messages[0]?.content).includes('independent code REVIEWER')) return send(JSON.stringify({ decision: 'approve', findings: [] }))
    if (options.unknownToolFirst && !messages.some(message => message.role === 'tool')) return send(null, { name: 'launch_rockets', arguments: {} })
    if (last.role === 'tool' && !text(last.content).includes('Unknown tool')) return send('Done: the change is implemented.')
    const debugging = text([...messages].reverse().find(message => message.role === 'user')?.content).includes('DEBUGGER')
    return send(null, { name: 'write_file', arguments: { path: options.path ?? 'src/feature.js', content: debugging ? options.fix ?? 'export const fixed = true\n' : options.first ?? 'export const feature = true\n' } })
  }
}

async function harness(options: { policy?: ProviderConnectionInput['requestPolicy']; project?: Record<string, string>; root?: string } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'altrex-scenario-'))
  if (!roots.includes(root)) roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  for (const [path, content] of Object.entries(options.project ?? { 'README.md': '# demo\n' })) { mkdirSync(join(project, path, '..'), { recursive: true }); writeFileSync(join(project, path), content) }
  const [a, b] = await Promise.all([startFakeOpenAiServer(), startFakeOpenAiServer()])
  servers.push(a, b)
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const tasks = new TaskManager(events, new TaskStore(join(root, 'tasks')))
  const checkpoints = new CheckpointStore(join(root, 'checkpoints'))
  const ensureLocalRuntime = vi.fn(async () => undefined)
  const service = new ProviderService(join(root, 'credentials', 'provider.json'), join(root, 'multi-ai'), join(root, 'multi-ai'), { events, tasks, checkpoints, ensureLocalRuntime })
  const internal = service as unknown as { provider: Record<string, unknown> }
  // Connect-time probes are stubbed; every model request below goes over HTTP to the fake servers.
  internal.provider.healthCheck = vi.fn(async () => ({ ok: true, message: 'ready', latencyMs: 1 }))
  internal.provider.listModels = vi.fn(async () => ['fake-coder'])
  internal.provider.probeCapabilities = vi.fn(async () => ({ supportsChat: true, supportsStreaming: true, supportsTools: true }))
  const policy = { maxAttempts: 1, firstTokenMs: 1500, idleMs: 1500, connectionMs: 3000, ...options.policy }
  await service.connect({ providerId: 'custom', apiKey: '', baseUrl: a.baseUrl, model: 'fake-coder', requestPolicy: policy })
  await service.connect({ providerId: 'nim-local', apiKey: '', baseUrl: b.baseUrl, model: 'fake-coder', requestPolicy: policy })
  const host = new CoreHost({ events, tasks, checkpoints, isProjectTrusted: () => true, isProjectBusy: projectPath => service.isProjectBusy(projectPath), cancelRequest: requestId => service.cancel(requestId) })
  const byProvider: Record<string, FakeOpenAiServer> = { custom: a, 'nim-local': b }
  const route = async (prompt: string) => {
    const preview = await service.previewRoute({ mode: 'AUTO', role: 'Coding Agent', tools: true, prompt })
    const primary = preview.primary!.providerId
    return { primary: byProvider[primary]!, secondary: byProvider[primary === 'custom' ? 'nim-local' : 'custom']!, primaryId: primary }
  }
  const run = async (request: ChatRequest) => {
    const taskId = host.legacy.begin(request)!
    await service.streamChat(request, '', [], event => host.legacy.handle(event))
    return taskId
  }
  const agent = (content = 'Add a feature module', overrides: Partial<ChatRequest> = {}): ChatRequest => ({ requestId: `req-${Math.random().toString(16).slice(2, 10)}`, projectPath: project, mode: 'AGENT', modelSelection: 'AUTO', messages: [{ role: 'user', content }], attachments: [], ...overrides })
  const own = (taskId: string) => published.filter(event => event.taskId === taskId)
  return { root, project, a, b, service, host, tasks, published, run, agent, route, own, ensureLocalRuntime }
}
const fill = (server: FakeOpenAiServer, count: number, options?: Brain) => server.enqueue(...Array.from({ length: count }, () => brain(options)))
function readdirRecursive(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap(name => { const path = join(root, name); return statSync(path).isDirectory() ? readdirRecursive(path) : [path] })
}
const types = (events: AltrexEvent[]) => events.map(event => event.type)
function assertTerminalLast(events: AltrexEvent[]) {
  const terminal = ['task.completed', 'task.completed_unverified', 'task.verified', 'task.failed', 'task.cancelled', 'task.interrupted']
  const index = events.findIndex(event => terminal.includes(event.type))
  expect(index).toBeGreaterThan(-1)
  expect(events.slice(index + 1)).toEqual([])
  for (const event of events) expect(parseAltrexEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
}

describe('provider failures during an agent task', () => {
  it.each([500, 502, 503, 504])('HTTP %i on the primary falls back to the other provider and the task completes', async status => {
    const h = await harness()
    const { primary, secondary } = await h.route('Add a feature module')
    primary.enqueue(reply.status(status, `upstream ${status}`)); fill(primary, 10); fill(secondary, 10)
    const taskId = await h.run(h.agent())
    const events = h.own(taskId)
    expect(types(events)).toEqual(expect.arrayContaining(['fallback.started', 'fallback.completed']))
    expect(events.find(event => event.type === 'fallback.started')!.payload).toMatchObject({ reason: 'PROVIDER_SERVER_ERROR' })
    expect(readFileSync(join(h.project, 'src/feature.js'), 'utf8')).toContain('feature')
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED_UNVERIFIED') // no test suite in this project
    expect(h.published.some(event => event.type === 'provider.health_changed' && event.taskId === null)).toBe(true)
    assertTerminalLast(events)
  })

  it('HTTP 429 with Retry-After is retried on the same provider without falling back', async () => {
    const h = await harness({ policy: { maxAttempts: 2 } })
    const { primary, secondary } = await h.route('Add a feature module')
    primary.enqueue(reply.status(429, 'slow down', { 'Retry-After': '1' })); fill(primary, 10); fill(secondary, 10)
    const taskId = await h.run(h.agent())
    expect(types(h.own(taskId))).not.toContain('fallback.started')
    expect(primary.requests.length).toBeGreaterThanOrEqual(2)
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED_UNVERIFIED')
  }, 30_000)

  it('HTTP 413 shrinks the request and retries', async () => {
    const h = await harness({ policy: { maxAttempts: 2 } })
    const { primary, secondary } = await h.route('Add a feature module')
    primary.enqueue(reply.status(413, 'Request too large')); fill(primary, 10); fill(secondary, 10)
    const request = h.agent('Add a feature module')
    const taskId = h.host.legacy.begin(request)!
    await h.service.streamChat(request, `Repository context:\n${'const filler = 1 // padding line for context budget tests\n'.repeat(1500)}`, [], event => h.host.legacy.handle(event))
    // The retry is sent with budgets reduced to 65%: max_tokens drops and the input never grows.
    expect(primary.requests.length).toBeGreaterThanOrEqual(2)
    expect(primary.requests[1]!.json!.max_tokens as number).toBeLessThan(primary.requests[0]!.json!.max_tokens as number)
    expect(primary.requests[1]!.body.length).toBeLessThanOrEqual(primary.requests[0]!.body.length)
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED_UNVERIFIED')
  }, 30_000)

  it('a provider that never answers times out (first-token deadline) and the task falls back', async () => {
    const h = await harness({ policy: { firstTokenMs: 800 } })
    const { primary, secondary } = await h.route('Add a feature module')
    primary.enqueue(reply.hang()); fill(primary, 10); fill(secondary, 10)
    const taskId = await h.run(h.agent())
    expect(h.own(taskId).find(event => event.type === 'fallback.started')!.payload).toMatchObject({ reason: 'TIMEOUT' })
    expect(primary.requests[0]!.aborted).toBe(true) // the stalled request was actually closed
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED_UNVERIFIED')
  }, 30_000)

  it('a malformed stream is retried without streaming on the same model', async () => {
    const h = await harness()
    const { primary, secondary } = await h.route('Add a feature module')
    primary.enqueue(reply.malformed()); fill(primary, 10); fill(secondary, 10)
    const taskId = await h.run(h.agent())
    expect(primary.requests[1]!.json!.stream).toBeFalsy()
    expect(types(h.own(taskId))).not.toContain('fallback.started')
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED_UNVERIFIED')
  })

  it('a connection dropped mid-stream falls back and keeps the work', async () => {
    const h = await harness()
    const { primary, secondary } = await h.route('Add a feature module')
    primary.enqueue(reply.disconnectAfter(['Thinking…'])); fill(primary, 10); fill(secondary, 10)
    const taskId = await h.run(h.agent())
    expect(h.own(taskId).find(event => event.type === 'fallback.started')!.payload).toMatchObject({ reason: expect.stringMatching(/STREAM_INTERRUPTED|NETWORK|PROVIDER/) })
    expect(existsSync(join(h.project, 'src/feature.js'))).toBe(true)
  })

  it('every provider failing ends the task FAILED with fallback.failed and a real reason', async () => {
    const h = await harness()
    for (const server of [h.a, h.b]) server.enqueue(...Array.from({ length: 6 }, () => reply.status(503, 'down')))
    const taskId = await h.run(h.agent())
    expect(types(h.own(taskId))).toContain('fallback.failed')
    expect(h.tasks.get(taskId)).toMatchObject({ state: 'FAILED', outcome: { reason: expect.any(String) } })
    assertTerminalLast(h.own(taskId))
  })
})

describe('agent and tool behaviour', () => {
  it('an unsupported tool call is returned to the model as an error and the agent recovers', async () => {
    const h = await harness()
    fill(h.a, 10, { unknownToolFirst: true }); fill(h.b, 10, { unknownToolFirst: true })
    const taskId = await h.run(h.agent())
    const toolReplies = [...h.a.requests, ...h.b.requests].flatMap(request => (request.json as Body).messages.filter(message => message.role === 'tool').map(message => String(message.content)))
    expect(toolReplies.some(content => content.includes('Unknown tool: launch_rockets'))).toBe(true)
    expect(existsSync(join(h.project, 'src/feature.js'))).toBe(true)
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED_UNVERIFIED')
  })

  it('a failing test is repaired through the real gateway and the task is VERIFIED', async () => {
    const h = await harness({ project: {
      'package.json': JSON.stringify({ name: 'g', version: '1.0.0', scripts: { test: 'node test.js' } }),
      'test.js': "const { greet } = require('./greet.js')\nif (greet() !== 'hello') { console.error('Error: wrong greeting'); process.exit(1) }\nconsole.log('# pass 1')\n",
      'greet.js': 'module.exports = { greet: () => "" }\n',
    } })
    const options = { path: 'greet.js', first: 'module.exports = { greet: () => "hi" }\n', fix: 'module.exports = { greet: () => "hello" }\n' }
    fill(h.a, 20, options); fill(h.b, 20, options)
    const taskId = await h.run(h.agent('Make greet() return "hello"'))
    const task = h.tasks.get(taskId)!
    expect(task).toMatchObject({ state: 'VERIFIED', verdict: { status: 'VERIFIED', repairs: { attempts: 1 } } })
    expect(task.agents.map(agent => agent.role)).toEqual(expect.arrayContaining(['CODER', 'TESTER', 'DEBUGGER', 'REVIEWER']))
    assertTerminalLast(h.own(taskId))
  }, 60_000)

  it('a build that keeps failing ends FAILED after bounded repairs (never VERIFIED on the model\'s word)', async () => {
    const h = await harness({ project: {
      'package.json': JSON.stringify({ name: 'b', version: '1.0.0', scripts: { build: 'node build.js', test: 'node test.js' } }),
      'build.js': "require('./broken.js')\n", 'test.js': "console.log('# pass 1')\n", 'broken.js': 'syntax error here(\n',
    } })
    const options = { path: 'notes.md', first: 'I fixed everything!\n', fix: 'Definitely fixed now!\n' }
    fill(h.a, 30, options); fill(h.b, 30, options)
    const taskId = await h.run(h.agent('Fix the build'))
    expect(h.tasks.get(taskId)).toMatchObject({ state: 'FAILED', verdict: { status: 'FAILED', repairs: { limitReached: true } } })
  }, 90_000)
})

describe('lifecycle scenarios', () => {
  it('cancellation mid-request stops the provider call, cancels agents, and nothing follows the terminal event', async () => {
    const h = await harness({ policy: { firstTokenMs: 60_000, idleMs: 60_000 } })
    h.a.enqueue(reply.hang()); h.b.enqueue(reply.hang())
    const request = h.agent()
    const pending = h.run(request)
    await vi.waitFor(() => expect(h.a.requests.length + h.b.requests.length).toBeGreaterThan(0), { timeout: 5000 })
    const taskId = h.tasks.taskIdFor(request.requestId)!
    expect(await h.host.handle('task.cancel', { taskId })).toEqual({ cancelled: true })
    await pending
    expect(h.tasks.get(taskId)).toMatchObject({ state: 'CANCELLED', agents: [expect.objectContaining({ status: 'cancelled' })] })
    await vi.waitFor(() => expect([...h.a.requests, ...h.b.requests].every(item => item.aborted)).toBe(true))
    assertTerminalLast(h.own(taskId))
  })

  it('restart: history survives, the running task becomes INTERRUPTED, and nothing is re-sent', async () => {
    const first = await harness()
    fill(first.a, 10); fill(first.b, 10)
    const done = await first.run(first.agent())
    const crashed = first.host.legacy.begin(first.agent('Refactor the module'))!
    const before = first.a.requests.length + first.b.requests.length
    const second = await harness({ root: first.root })
    expect(second.tasks.recover().map(task => task.taskId)).toEqual([crashed])
    expect(second.tasks.get(done)!.state).toBe('COMPLETED_UNVERIFIED')
    expect(second.tasks.events(done).events.length).toBeGreaterThan(5)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(first.a.requests.length + first.b.requests.length + second.a.requests.length + second.b.requests.length).toBe(before)
  })

  it('checkpoint restore after a task reverts exactly its changes', async () => {
    const h = await harness({ project: { 'README.md': '# demo\n', 'keep.txt': 'user file\n' } })
    fill(h.a, 10); fill(h.b, 10)
    const taskId = await h.run(h.agent())
    const task = h.tasks.get(taskId) as TaskSummary
    writeFileSync(join(h.project, 'later.txt'), 'user edit after the task\n')
    const result = await h.host.handle('checkpoint.restore', { checkpointId: task.checkpointIds[0]!, scope: 'task' }) as { deleted: string[] }
    expect(result.deleted).toEqual(['src/feature.js'])
    expect(existsSync(join(h.project, 'src'))).toBe(false)
    expect(readFileSync(join(h.project, 'keep.txt'), 'utf8')).toBe('user file\n')
    expect(readFileSync(join(h.project, 'later.txt'), 'utf8')).toBe('user edit after the task\n')
  })

  it('long conversations are compacted to the input budget', async () => {
    const h = await harness({ policy: { inputTokens: 6000 } }) // instructions + tools fit; the ~16k-token history does not
    fill(h.a, 10); fill(h.b, 10)
    const history = Array.from({ length: 40 }, (_, index) => ({ role: (index % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `Earlier turn ${index}: ${'details '.repeat(200)}` }))
    const taskId = await h.run(h.agent('Add a feature module', { messages: [...history, { role: 'user', content: 'Add a feature module' }] }))
    const sizes = [...h.a.requests, ...h.b.requests].map(request => request.body.length)
    const raw = JSON.stringify(history).length
    expect(Math.max(...sizes)).toBeLessThan(raw)
    expect(h.tasks.get(taskId)!.outcome?.reason).not.toMatch(/budget/)
    const coder = [...h.a.requests, ...h.b.requests].find(request => !request.body.includes('independent code REVIEWER'))!.body
    expect(coder).toContain('shortened to fit')
    expect(coder).toContain('Add a feature module')
    expect(h.tasks.get(taskId)!.state).toBe('COMPLETED_UNVERIFIED')
  })

  it('concurrent tasks in two projects stay isolated', async () => {
    const h = await harness()
    const other = join(h.root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'README.md'), '# other\n')
    fill(h.a, 30); fill(h.b, 30)
    const [first, second] = await Promise.all([h.run(h.agent()), h.run({ ...h.agent(), projectPath: other })])
    expect(first).not.toBe(second)
    expect(existsSync(join(h.project, 'src/feature.js')) && existsSync(join(other, 'src/feature.js'))).toBe(true)
    for (const taskId of [first, second]) {
      assertTerminalLast(h.own(taskId))
      const task = h.tasks.get(taskId)!
      expect(task.changedFiles).toEqual(['src/feature.js'])
      expect(new Set(h.own(taskId).filter(event => event.type === 'checkpoint.created').map(event => (event.payload as { projectPath: string }).projectPath)).size).toBe(1)
    }
  }, 30_000)

  it('API keys never appear in events, task history, contract responses or request bodies', async () => {
    const secret = 'sk-altrex-SECRET-0123456789abcdef'
    const h = await harness()
    await h.service.connect({ providerId: 'custom', apiKey: secret, baseUrl: h.a.baseUrl, model: 'fake-coder', requestPolicy: { maxAttempts: 1, firstTokenMs: 1500 } })
    h.a.enqueue(reply.status(401, `invalid key ${secret}`)); fill(h.a, 10); fill(h.b, 10)
    const taskId = await h.run(h.agent(`Add a feature module`))
    const surfaces = [
      JSON.stringify(h.published),
      JSON.stringify(h.tasks.get(taskId)),
      JSON.stringify(h.tasks.events(taskId)),
      JSON.stringify(await h.host.handle('task.list', {})),
      ...[...h.a.requests, ...h.b.requests].map(request => request.body),
      ...readdirRecursive(join(h.root, 'tasks')).map(path => readFileSync(path, 'utf8')),
      ...readdirRecursive(join(h.root, 'multi-ai')).filter(path => !path.endsWith('provider.json')).map(path => readFileSync(path, 'utf8')),
    ]
    for (const surface of surfaces) expect(surface).not.toContain(secret)
    expect(h.a.requests.some(request => request.headers.authorization === `Bearer ${secret}`)).toBe(true) // sent only as a header
    expect(readFileSync(join(h.root, 'credentials', 'provider.json'), 'utf8')).not.toContain(secret) // stored encrypted
  })

  it('LOCAL mode with Ollama unavailable fails clearly and never falls back to a cloud provider', async context => {
    // Occupy Ollama's port with a server that drops every connection; skip if a real Ollama is running.
    const dead: Server = createServer(socket => socket.destroy())
    const bound = await new Promise<boolean>(resolve => { dead.once('error', () => resolve(false)); dead.listen(11434, '127.0.0.1', () => resolve(true)) })
    if (!bound) { context.skip(); return }
    try {
      const h = await harness()
      await h.service.connect({ providerId: 'ollama', apiKey: '', baseUrl: '', model: 'fake-coder', requestPolicy: { maxAttempts: 1, firstTokenMs: 1500, connectionMs: 1500 } })
      h.ensureLocalRuntime.mockRejectedValue(new Error('Ollama is not installed.'))
      const taskId = await h.run(h.agent('Add a feature module', { mode: 'LOCAL' }))
      expect(h.tasks.get(taskId)).toMatchObject({ state: 'FAILED' })
      expect(h.a.requests.length + h.b.requests.length).toBe(0) // no cloud endpoint was contacted
      expect(h.ensureLocalRuntime).toHaveBeenCalled()
    } finally { await new Promise(resolve => dead.close(resolve)) }
  }, 30_000)
})
