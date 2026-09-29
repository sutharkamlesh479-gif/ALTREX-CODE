import type { AltrexCoreBridge, CoreInvokeResult } from './bridge'
import { isCommandName, parseCommandRequest, parseCommandResponse, type CommandName, type CommandRequest, type CommandResponse, type ParsedCommandRequest } from './commands'
import { eventPayloadSchemas, type AltrexEvent, type EventPayload, type EventType } from './events'
import type { CoreError, CoreErrorCode, ProjectSummary } from './platform'
import type { ApprovalRequestView } from './permissions'
import type { ProviderView, ModelView } from './provider'
import type { TaskSummary } from './tasks'
import type { Evidence, Verdict } from './verification'
import { CONTRACT_VERSION } from './version'

/**
 * A scripted, in-memory implementation of `window.altrexCore` for building and testing the UI without
 * Electron, providers or a project. Every event and response is validated against the contract, so a UI
 * that works against FakeCore speaks the real protocol. It is a development tool: its data is labelled as
 * demo data and it must never be shipped in place of the real core.
 *
 * Scenarios (chosen from the prompt of `task.start`):
 *  - mode ASK → streamed answer → COMPLETED
 *  - prompt containing "approval" → a HIGH-risk command waits for `permission.respond`
 *  - prompt containing "fail" → checks fail, one repair, still failing → FAILED with a verdict
 *  - otherwise → coder, command, diff, checks pass, review approves → VERIFIED
 */
export type FakeCoreOptions = { delayMs?: number; interactiveApprovals?: boolean }

class FakeCommandError extends Error {
  constructor(readonly code: CoreErrorCode, message: string) { super(message) }
}

const uuid = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-7000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`)
const now = () => new Date().toISOString()
const PROJECT: ProjectSummary = { name: 'demo-app', path: '/demo/demo-app', branch: 'main', markers: ['package.json'] }

export class FakeCore implements AltrexCoreBridge {
  readonly contractVersion = CONTRACT_VERSION
  readonly streamId = uuid()
  private seq = 0
  private readonly buffer: AltrexEvent[] = []
  private readonly listeners = new Set<(event: AltrexEvent) => void>()
  private readonly tasks = new Map<string, TaskSummary>()
  private readonly history = new Map<string, AltrexEvent[]>()
  private readonly approvals = new Map<string, { request: ApprovalRequestView; resolve: (approved: boolean) => void }>()
  private readonly cancelled = new Set<string>()
  private readonly running = new Set<Promise<void>>()
  private interactive: boolean
  private readonly consents = new Map<string, string>()
  private readonly delay: number

  constructor(options: FakeCoreOptions = {}) {
    this.delay = options.delayMs ?? 150
    this.interactive = options.interactiveApprovals ?? true
  }

  onEvent(listener: (event: AltrexEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async invoke<N extends CommandName>(name: N, request: CommandRequest<N>): Promise<CommandResponse<N>> {
    const result = await this.invokeResult(name, request)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  async invokeResult<N extends CommandName>(name: N, request: CommandRequest<N>): Promise<CoreInvokeResult<N>> {
    try {
      if (!isCommandName(name)) throw new FakeCommandError('UNKNOWN_COMMAND', 'Unknown ALTREX core command.')
      let parsed: ParsedCommandRequest<N>
      try { parsed = parseCommandRequest(name, request) } catch { throw new FakeCommandError('INVALID_REQUEST', 'The request does not match the contract.') }
      return { ok: true, value: parseCommandResponse(name, await this.dispatch(name, parsed)) }
    } catch (error) {
      const coreError: CoreError = error instanceof FakeCommandError ? { code: error.code, message: error.message, retryable: false } : { code: 'INTERNAL', message: error instanceof Error ? error.message : 'FakeCore failed.', retryable: false }
      return { ok: false, error: coreError }
    }
  }

  /** Resolves when every scripted task has finished (for tests). */
  async idle(): Promise<void> { while (this.running.size) await Promise.all([...this.running]) }

  // ---- commands ---------------------------------------------------------------------------------

  private async dispatch(name: CommandName, request: unknown): Promise<unknown> {
    const req = request as Record<string, unknown>
    switch (name) {
      case 'events.replay': {
        const afterSeq = req.afterSeq as number, oldestSeq = this.buffer[0]?.seq ?? null
        return { streamId: this.streamId, events: this.buffer.filter(event => event.seq > afterSeq), oldestSeq, latestSeq: this.seq, gap: false }
      }
      case 'project.open': return PROJECT
      case 'project.list': return [PROJECT]
      case 'project.permissions': return { projectPath: req.projectPath, profile: req.profile ?? 'standard' }
      case 'provider.list': return FAKE_PROVIDERS
      case 'provider.connect': case 'provider.disconnect': case 'provider.test': return FAKE_PROVIDERS
      case 'provider.refresh': case 'model.list': return FAKE_MODELS
      // A development fake never opens external pages.
      case 'provider.openLink': return { opened: false }
      case 'router.preview': return { mode: req.mode ?? 'AUTO', primary: { providerId: 'nvidia', model: 'demo-coder-large' }, fallbacks: [], reasons: ['FakeCore demo routing'], rejected: [{ providerId: 'groq', model: 'demo-fast', reason: 'provider_unhealthy', detail: 'provider health AUTH_ERROR (demo)' }] }
      case 'permission.configure': this.interactive = req.interactive as boolean; return { interactive: this.interactive }
      case 'permission.pending': return [...this.approvals.values()].map(entry => entry.request)
      case 'permission.respond': {
        const entry = this.approvals.get(req.approvalId as string)
        if (!entry) return { accepted: false }
        this.approvals.delete(req.approvalId as string)
        entry.resolve(req.decision === 'approve')
        return { accepted: true }
      }
      case 'task.start': return { taskId: this.start(request as ParsedCommandRequest<'task.start'>) }
      case 'task.cancel': {
        const task = this.tasks.get(req.taskId as string)
        if (!task || task.finishedAt) return { cancelled: false }
        this.cancelled.add(task.taskId)
        return { cancelled: true }
      }
      case 'task.list': return [...this.tasks.values()].filter(task => (!req.projectPath || task.projectPath === req.projectPath) && (!req.sessionId || task.sessionId === req.sessionId)).reverse().slice(0, req.limit as number)
      case 'task.get': {
        const task = this.tasks.get(req.taskId as string)
        if (!task) throw new FakeCommandError('NOT_FOUND', 'Unknown task.')
        return task
      }
      case 'task.events': return { taskId: req.taskId, events: (this.history.get(req.taskId as string) ?? []).slice(-(req.limit as number)), truncated: false }
      case 'session.list': {
        const groups = new Map<string, TaskSummary[]>()
        for (const task of this.tasks.values()) if (task.sessionId) groups.set(task.sessionId, [...(groups.get(task.sessionId) ?? []), task])
        return [...groups].map(([sessionId, tasks]) => ({ sessionId, projectPath: tasks[0]!.projectPath, title: tasks[0]!.title, taskCount: tasks.length, lastState: tasks.at(-1)!.state, createdAt: tasks[0]!.createdAt, updatedAt: tasks.at(-1)!.updatedAt }))
      }
      case 'consent.list':
        return FAKE_PROVIDERS.filter(provider => provider.privacy === 'cloud').map(provider => ({ providerId: provider.providerId, baseUrl: provider.baseUrl, displayName: provider.displayName, granted: this.consents.has(`${provider.providerId}|${provider.baseUrl}`), grantedAt: this.consents.get(`${provider.providerId}|${provider.baseUrl}`) ?? null }))
      case 'consent.grant': {
        const known = FAKE_PROVIDERS.some(provider => provider.privacy === 'cloud' && provider.providerId === req.providerId && provider.baseUrl === req.baseUrl)
        if (known) this.consents.set(`${req.providerId}|${req.baseUrl}`, now())
        return { granted: known }
      }
      case 'consent.revoke':
        return { revoked: this.consents.delete(`${req.providerId}|${req.baseUrl}`) }
      case 'tool.list': return [{ name: 'read_file', description: 'Read a file (demo)', risk: 'LOW' }, { name: 'edit_file', description: 'Edit a file (demo)', risk: 'MEDIUM' }, { name: 'run_command', description: 'Run a command (demo)', risk: 'CLASSIFIED' }]
      case 'memory.list': return [{ key: 'check.test', value: 'pnpm run test → PASS', source: 'evidence', evidenceId: 'demo', confidence: 'confirmed', lastVerifiedAt: now() }]
      case 'checkpoint.list': return []
      case 'checks.discover': return [{ name: 'test', argv: ['pnpm', 'run', 'test'], source: 'package.json scripts.test (demo)' }]
      case 'git.status': return { isRepository: true, branch: 'main', head: 'demo', entries: [] }
      default: throw new FakeCommandError('UNAVAILABLE', `FakeCore does not simulate ${name}.`)
    }
  }

  // ---- scripted tasks ---------------------------------------------------------------------------

  private start(request: ParsedCommandRequest<'task.start'>): string {
    const taskId = uuid(), created = now()
    const task: TaskSummary = {
      taskId, requestId: null, sessionId: request.sessionId ?? null, mode: request.mode, intent: request.mode === 'ASK' ? 'question' : 'change',
      projectPath: request.projectPath, title: request.prompt.split('\n')[0]!.slice(0, 200), modelSelection: request.modelSelection, routingMode: request.routingMode ?? null,
      engine: request.mode === 'ASK' ? null : 'altrex', state: 'RECEIVED', createdAt: created, updatedAt: created, finishedAt: null,
      checkpointIds: [], changedFiles: [], agents: [], outcome: null, eventsTruncated: false, verdict: null,
    }
    this.tasks.set(taskId, task)
    this.emit('task.created', { state: 'RECEIVED', mode: task.mode, intent: task.intent, projectPath: task.projectPath, title: task.title, modelSelection: task.modelSelection }, taskId)
    const prompt = request.prompt.toLowerCase()
    const script = task.mode === 'ASK' ? this.ask(task) : prompt.includes('approval') ? this.change(task, { approval: true }) : prompt.includes('fail') ? this.change(task, { fail: true }) : this.change(task, {})
    const run = script.catch(() => undefined).finally(() => { this.running.delete(run) })
    this.running.add(run)
    return taskId
  }

  private async ask(task: TaskSummary): Promise<void> {
    await this.step(task, 'ANSWERING')
    this.emit('model.selected', { provider: 'Fake NVIDIA (demo)', model: 'demo-coder-large', reasons: ['FakeCore demo routing'], providerId: 'nvidia', role: 'Ask', mode: 'AUTO' }, task.taskId)
    for (const text of ['This is a ', 'FakeCore demo answer. ', 'No model was called.']) { await this.pause(task); this.emit('agent.message_delta', { text }, task.taskId) }
    await this.finish(task, 'COMPLETED')
  }

  private async change(task: TaskSummary, options: { approval?: boolean; fail?: boolean }): Promise<void> {
    const checkpointId = uuid()
    this.emit('checkpoint.created', { checkpointId, projectPath: task.projectPath ?? PROJECT.path, taskId: task.taskId, label: `Before task: ${task.title}`.slice(0, 200), kind: 'snapshot', createdAt: now(), fileCount: 42, totalBytes: 123456, finalizedAt: null, changedByTask: null }, task.taskId)
    task.checkpointIds = [checkpointId]
    await this.step(task, 'IMPLEMENTING')
    const coder = this.agent(task, 'CODER', 'Coding agent (demo)')
    this.emit('model.selected', { provider: 'Fake NVIDIA (demo)', model: 'demo-coder-large', reasons: ['FakeCore demo routing'], providerId: 'nvidia', role: 'Coding Agent', mode: 'AUTO' }, task.taskId)
    await this.pause(task)
    this.emit('agent.progress', { agentId: coder, role: 'CODER', round: 0, message: 'Round 1: read_file, search_files' }, task.taskId)
    if (options.approval) {
      const approvalId = uuid()
      const request: ApprovalRequestView = { approvalId, taskId: task.taskId, tool: 'run_command', summary: 'npx create-vite demo', risk: 'HIGH', capability: 'package.execute', reason: 'npx downloads and executes a package (demo)', requestedAt: now() }
      // Register before announcing, so an immediate answer is never lost.
      const answer = this.interactive ? new Promise<boolean>(resolve => this.approvals.set(approvalId, { request, resolve })) : Promise.resolve(false)
      this.emit('permission.required', request, task.taskId)
      await this.step(task, 'AWAITING_APPROVAL')
      const approved = await answer
      this.emit('permission.resolved', { approvalId, decision: approved ? 'approved' : 'denied', scope: 'once', by: this.interactive ? 'user' : 'policy', note: approved ? 'Approved by the user.' : 'Denied.' }, task.taskId)
      await this.step(task, 'IMPLEMENTING')
      if (!approved) this.emit('tool.denied', { tool: 'run_command', summary: 'npx create-vite demo', risk: 'HIGH', reason: 'Denied by the user.' }, task.taskId)
    }
    const commandId = uuid()
    this.emit('command.started', { commandId, command: 'pnpm run build' }, task.taskId)
    await this.pause(task)
    this.emit('command.output', { commandId, stream: 'stdout', text: 'vite v7 building for production…\n✓ built in 1.2s (demo)\n' }, task.taskId)
    this.emit('command.completed', { commandId, command: 'pnpm run build', exitCode: 0, timedOut: false, durationMs: 1200 }, task.taskId)
    task.changedFiles = ['src/settings/SettingsPage.tsx', 'src/App.tsx']
    this.emit('file.changed', { paths: task.changedFiles, cumulative: true }, task.taskId)
    this.emit('agent.completed', { agentId: coder, role: 'CODER', summary: 'Implemented the change (demo).' }, task.taskId)
    this.finishAgent(task, coder, 'completed')
    this.emit('diff.available', { checkpointId, files: [{ path: 'src/settings/SettingsPage.tsx', change: 'added' }, { path: 'src/App.tsx', change: 'modified' }], truncated: false }, task.taskId)

    const evidence: Evidence[] = []
    const test = async (status: Evidence['status']) => {
      await this.step(task, 'TESTING')
      const tester = this.agent(task, 'TESTER', 'Project checks (demo)'), testId = uuid()
      this.emit('test.started', { testId, name: 'test', command: 'pnpm run test' }, task.taskId)
      await this.pause(task)
      const item: Evidence = { evidenceId: testId, name: 'test', argv: ['pnpm', 'run', 'test'], status, exitCode: status === 'PASS' ? 0 : 1, timedOut: false, durationMs: 2400, treeHash: 'snap:demo', parsed: status === 'PASS' ? { passed: 12, failed: 0 } : { passed: 11, failed: 1, failingTests: ['SettingsPage > saves (demo)'] }, outputTail: status === 'PASS' ? 'Tests 12 passed (12)' : 'FAIL SettingsPage > saves (demo)', at: now() }
      evidence.push(item)
      this.emit('test.completed', { testId, evidence: item }, task.taskId)
      this.emit('agent.completed', { agentId: tester, role: 'TESTER', summary: `test: ${status}` }, task.taskId)
      this.finishAgent(task, tester, 'completed')
      return item
    }
    const first = await test(options.fail ? 'FAIL' : 'PASS')
    if (first.status !== 'PASS') {
      await this.step(task, 'DEBUGGING')
      this.emit('repair.started', { attempt: 1, limit: 6, reason: 'check_failed', signature: 'test:SettingsPage > saves (demo)', escalated: false }, task.taskId)
      const debuggerId = this.agent(task, 'DEBUGGER', 'Debugger (repair 1, demo)')
      await this.pause(task)
      this.emit('agent.completed', { agentId: debuggerId, role: 'DEBUGGER', summary: 'Repair round finished (demo).' }, task.taskId)
      this.finishAgent(task, debuggerId, 'completed')
      await test('FAIL')
      await this.step(task, 'VERIFYING')
      const verdict: Verdict = { status: 'FAILED', treeHash: 'snap:demo', checks: [{ name: 'test', status: 'FAIL', evidenceId: evidence.at(-1)!.evidenceId, summary: 'pnpm run test: 11 passed, 1 failed' }, { name: 'build', status: 'NOT_AVAILABLE' }, { name: 'typecheck', status: 'NOT_AVAILABLE' }, { name: 'lint', status: 'NOT_AVAILABLE' }], review: { decision: 'not_run', independence: 'none', reviewer: null, blockers: 0, majors: 0, findings: [], note: 'Checks were still failing (demo).' }, repairs: { attempts: 1, limitReached: true }, reasons: ['test failed on the final tree after the repair limit was reached (demo).'] }
      return this.finish(task, 'FAILED', verdict)
    }
    await this.step(task, 'REVIEWING')
    const reviewer = this.agent(task, 'REVIEWER', 'Independent reviewer (demo)')
    await this.pause(task)
    const review = { decision: 'approve' as const, independence: 'different-provider' as const, reviewer: { providerId: 'google', model: 'demo-reviewer' }, blockers: 0, majors: 0, findings: [{ severity: 'nit' as const, category: 'style' as const, file: 'src/App.tsx', description: 'Consider extracting the route table (demo).' }] }
    this.emit('review.completed', review, task.taskId)
    this.emit('agent.completed', { agentId: reviewer, role: 'REVIEWER', summary: 'approve (demo)' }, task.taskId)
    this.finishAgent(task, reviewer, 'completed')
    await this.step(task, 'VERIFYING')
    const verdict: Verdict = { status: 'VERIFIED', treeHash: 'snap:demo', checks: [{ name: 'test', status: 'PASS', evidenceId: first.evidenceId, summary: 'pnpm run test: 12 passed, 0 failed' }, { name: 'build', status: 'NOT_AVAILABLE' }, { name: 'typecheck', status: 'NOT_AVAILABLE' }, { name: 'lint', status: 'NOT_AVAILABLE' }], review, repairs: { attempts: 0, limitReached: false }, reasons: ['All declared checks passed on the final tree and the independent reviewer approved (demo).'] }
    await this.finish(task, 'VERIFIED', verdict)
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private agent(task: TaskSummary, role: 'CODER' | 'TESTER' | 'DEBUGGER' | 'REVIEWER', label: string): string {
    const agentId = uuid()
    task.agents = [...task.agents, { agentId, role, label, status: 'running', providerId: role === 'TESTER' ? null : 'nvidia', model: role === 'TESTER' ? null : 'demo-coder-large', startedAt: now(), finishedAt: null, summary: null }]
    this.emit('agent.started', { agentId, role, label, providerId: role === 'TESTER' ? null : 'nvidia', model: role === 'TESTER' ? null : 'demo-coder-large' }, task.taskId)
    return agentId
  }

  private finishAgent(task: TaskSummary, agentId: string, status: 'completed' | 'failed' | 'cancelled'): void {
    task.agents = task.agents.map(agent => agent.agentId === agentId ? { ...agent, status, finishedAt: now(), summary: agent.summary ?? status } : agent)
  }

  private async step(task: TaskSummary, to: TaskSummary['state']): Promise<void> {
    await this.pause(task)
    if (task.state === to) return
    this.emit('task.state_changed', { from: task.state, to }, task.taskId)
    task.state = to
    task.updatedAt = now()
  }

  private async pause(task: TaskSummary): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.delay))
    if (this.cancelled.has(task.taskId)) {
      this.cancelled.delete(task.taskId)
      for (const agent of task.agents.filter(item => item.status === 'running')) { this.emit('agent.failed', { agentId: agent.agentId, role: agent.role, message: 'The task was cancelled.', code: 'CANCELLED' }, task.taskId); this.finishAgent(task, agent.agentId, 'cancelled') }
      this.emit('task.state_changed', { from: task.state, to: 'CANCELLED' }, task.taskId)
      task.state = 'CANCELLED'; task.finishedAt = now(); task.updatedAt = task.finishedAt
      this.emit('task.cancelled', {}, task.taskId)
      throw new Error('cancelled')
    }
  }

  private async finish(task: TaskSummary, state: 'COMPLETED' | 'VERIFIED' | 'FAILED', verdict?: Verdict): Promise<void> {
    await this.pause(task)
    if (verdict) { task.verdict = verdict; this.emit('verification.completed', verdict, task.taskId) }
    this.emit('task.state_changed', { from: task.state, to: state }, task.taskId)
    task.state = state; task.finishedAt = now(); task.updatedAt = task.finishedAt
    if (state === 'COMPLETED') this.emit('task.completed', {}, task.taskId)
    else if (state === 'VERIFIED') this.emit('task.verified', { verdict: verdict! }, task.taskId)
    else { task.outcome = { reason: verdict?.reasons.join(' ') ?? 'Failed (demo).', code: 'VERIFICATION_FAILED' }; this.emit('task.failed', { message: task.outcome.reason, code: 'VERIFICATION_FAILED' }, task.taskId) }
  }

  private emit<T extends EventType>(type: T, payload: EventPayload<T>, taskId: string | null): void {
    const event = { v: CONTRACT_VERSION, streamId: this.streamId, seq: ++this.seq, id: uuid(), ts: now(), taskId, type, payload: eventPayloadSchemas[type].parse(payload) } as AltrexEvent
    this.buffer.push(event)
    if (this.buffer.length > 5000) this.buffer.shift()
    if (taskId) this.history.set(taskId, [...(this.history.get(taskId) ?? []), event])
    for (const listener of this.listeners) { try { listener(event) } catch { /* listeners never break the fake */ } }
  }
}

const FAKE_PROVIDERS: ProviderView[] = [
  { providerId: 'nvidia', displayName: 'Fake NVIDIA (demo)', baseUrl: 'https://integrate.api.nvidia.com/v1', protocol: 'openai-chat', privacy: 'cloud', health: 'HEALTHY', lastErrorCategory: null, lastCheckedAt: new Date(0).toISOString(), model: 'demo-coder-large', modelsDiscovered: 12, hasCredential: true, keyHint: 'demo', statusMessage: 'FakeCore demo provider' },
  { providerId: 'groq', displayName: 'Fake Groq (demo)', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai-chat', privacy: 'cloud', health: 'AUTH_ERROR', lastErrorCategory: 'AUTH_ERROR', lastCheckedAt: new Date(0).toISOString(), model: 'demo-fast', modelsDiscovered: 0, hasCredential: true, keyHint: 'dmo2', statusMessage: 'The API key was rejected (demo).' },
  { providerId: 'ollama', displayName: 'Fake Ollama (demo)', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai-chat', privacy: 'local', health: 'UNKNOWN', lastErrorCategory: null, lastCheckedAt: null, model: 'demo-local', modelsDiscovered: 1, hasCredential: false, keyHint: null, statusMessage: null },
]
const FAKE_MODELS: ModelView[] = [
  { providerId: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'demo-coder-large', displayName: 'Demo Coder Large', available: true, health: 'HEALTHY', free: false, lastErrorCategory: null, capabilities: { chat: true, streaming: true, tools: true, streamingTools: true, vision: false, structuredOutput: true, reasoning: null, contextWindow: 128000, maxOutput: 8192 } },
  { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'demo-local', displayName: 'Demo Local', available: null, health: 'UNKNOWN', free: true, lastErrorCategory: null, capabilities: { chat: true, streaming: true, tools: null, streamingTools: false, vision: null, structuredOutput: null, reasoning: null, contextWindow: null, maxOutput: null } },
]
