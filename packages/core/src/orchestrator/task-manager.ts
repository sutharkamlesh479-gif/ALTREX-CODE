import type { AgentRole, AgentRun, AltrexEvent, RoutingMode, SessionSummary, TaskIntent, TaskMode, TaskState, TaskSummary, Verdict } from '@altrex/contracts'
import type { EventBus } from '../events/event-bus'
import type { TaskStore } from '../tasks/task-store'
import { uuidv7 } from '../util/uuid'
import { assertTransition, canTransition, isTerminal } from './transitions'

export type TaskBeginInput = {
  requestId: string | null
  mode: TaskMode
  intent: TaskIntent
  projectPath: string | null
  title: string
  modelSelection: string
  routingMode?: RoutingMode | null
  sessionId?: string | null
}

export type TaskEnd =
  | { state: 'COMPLETED' }
  | { state: 'VERIFIED'; verdict: Verdict }
  | { state: 'COMPLETED_UNVERIFIED'; reason: string; verdict?: Verdict }
  | { state: 'FAILED'; message: string; code?: string | null; verdict?: Verdict }
  | { state: 'CANCELLED' }

/** The terminal task end that corresponds to a verdict. */
export function endForVerdict(verdict: Verdict): TaskEnd {
  const reason = verdict.reasons.join(' ') || 'Verification finished.'
  if (verdict.status === 'VERIFIED') return { state: 'VERIFIED', verdict }
  if (verdict.status === 'FAILED') return { state: 'FAILED', message: reason, code: 'VERIFICATION_FAILED', verdict }
  return { state: 'COMPLETED_UNVERIFIED', reason, verdict }
}

type Active = TaskSummary & { resumeState: TaskState | null }

const APPROVAL_PAUSABLE: ReadonlySet<TaskState> = new Set(['PLANNING', 'IMPLEMENTING', 'TESTING', 'DEBUGGING'])

/**
 * The Manager (AGENT_SPEC.md §3): deterministic owner of task identity, lifecycle and agent runs.
 * - Task ids are core ids (uuidv7), never chat request ids; `taskIdFor(requestId)` maps legacy requests.
 * - Every transition is checked against the state table; illegal transitions throw.
 * - Records and each task's events are persisted (TaskStore), so history survives restarts.
 * - Tasks found unfinished at startup become INTERRUPTED. Nothing is resumed automatically.
 */
export class TaskManager {
  private readonly active = new Map<string, Active>()
  private readonly byRequest = new Map<string, string>()
  private readonly agentTask = new Map<string, string>()
  private readonly knownFinished = new Map<string, boolean>()
  /** Recently finished tasks (the only record when no store is attached). */
  private readonly finished = new Map<string, TaskSummary>()

  constructor(private readonly bus: EventBus, private readonly store: TaskStore | null = null, private readonly onError: (error: unknown) => void = () => undefined) {
    bus.subscribe(event => { try { this.observe(event) } catch (error) { this.onError(error) } })
  }

  /** Mark tasks left unfinished by a previous run as INTERRUPTED. Call once at startup, before new tasks. */
  recover(): TaskSummary[] {
    if (!this.store) return []
    const interrupted: TaskSummary[] = []
    for (const task of this.store.list()) {
      if (isTerminal(task.state)) continue
      const now = this.now()
      const record: Active = { ...task, resumeState: null, agents: task.agents.map(agent => agent.status === 'running' ? { ...agent, status: 'cancelled', finishedAt: now, summary: agent.summary ?? 'Stopped when ALTREX closed.' } : agent) }
      this.active.set(task.taskId, record)
      const reason = 'ALTREX stopped while this task was running. Commands it started were stopped and are not resumed automatically. Review its changes, restore its checkpoint, or start the task again.'
      this.bus.publish('task.state_changed', { from: task.state, to: 'INTERRUPTED' }, task.taskId)
      record.state = 'INTERRUPTED'
      this.finalize(record, { reason, code: 'INTERRUPTED' })
      this.bus.publish('task.interrupted', { reason }, task.taskId)
      this.active.delete(task.taskId)
      interrupted.push(this.view(record))
    }
    this.store.prune()
    return interrupted
  }

  begin(input: TaskBeginInput): string {
    const taskId = uuidv7(), now = this.now()
    const record: Active = {
      taskId, requestId: input.requestId, sessionId: input.sessionId ?? null, mode: input.mode, intent: input.intent, projectPath: input.projectPath,
      title: input.title.slice(0, 200), modelSelection: input.modelSelection.slice(0, 200), routingMode: input.routingMode ?? null,
      engine: null, state: 'RECEIVED', createdAt: now, updatedAt: now, finishedAt: null, checkpointIds: [], changedFiles: [],
      agents: [], outcome: null, eventsTruncated: false, verdict: null, resumeState: null,
    }
    this.active.set(taskId, record)
    if (input.requestId) this.byRequest.set(input.requestId, taskId)
    this.save(record)
    this.bus.publish('task.created', {
      state: 'RECEIVED', mode: input.mode, intent: input.intent, projectPath: input.projectPath, title: record.title, modelSelection: record.modelSelection,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    }, taskId)
    return taskId
  }

  taskIdFor(requestId: string): string | undefined { return this.byRequest.get(requestId) }
  requestIdFor(taskId: string): string | null { return this.active.get(taskId)?.requestId ?? null }
  isActive(taskId: string): boolean { return this.active.has(taskId) }
  state(taskId: string): TaskState | null { return this.active.get(taskId)?.state ?? this.store?.get(taskId)?.state ?? null }

  get(taskId: string): TaskSummary | null {
    const live = this.active.get(taskId)
    return live ? this.view(live) : this.store?.get(taskId) ?? this.finished.get(taskId) ?? null
  }

  list(filter: { projectPath?: string | undefined; sessionId?: string | undefined; limit?: number } = {}): TaskSummary[] {
    if (filter.sessionId !== undefined) {
      const { sessionId, limit, ...rest } = filter
      return this.list(rest).filter(task => task.sessionId === sessionId).slice(0, limit ?? Number.MAX_SAFE_INTEGER)
    }
    const stored = this.store?.list(filter) ?? []
    const merged = new Map(stored.map(task => [task.taskId, task]))
    if (!this.store) for (const task of this.finished.values()) if (filter.projectPath === undefined || task.projectPath === filter.projectPath) merged.set(task.taskId, task)
    for (const task of this.active.values()) if (filter.projectPath === undefined || merged.has(task.taskId) || task.projectPath === filter.projectPath) merged.set(task.taskId, this.view(task))
    return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.taskId.localeCompare(a.taskId)).slice(0, filter.limit ?? merged.size)
  }

  /** Conversations: tasks grouped by sessionId, newest activity first. */
  sessions(filter: { projectPath?: string | undefined; limit?: number } = {}): SessionSummary[] {
    const groups = new Map<string, TaskSummary[]>()
    for (const task of this.list({ projectPath: filter.projectPath })) if (task.sessionId) groups.set(task.sessionId, [...(groups.get(task.sessionId) ?? []), task])
    return [...groups].map(([sessionId, tasks]) => {
      const ordered = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const last = ordered.at(-1)!
      return { sessionId, projectPath: ordered[0]!.projectPath, title: ordered[0]!.title, taskCount: ordered.length, lastState: last.state, createdAt: ordered[0]!.createdAt, updatedAt: ordered.reduce((max, task) => (task.updatedAt > max ? task.updatedAt : max), last.updatedAt) }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, filter.limit ?? Number.MAX_SAFE_INTEGER)
  }

  events(taskId: string, limit?: number): { events: AltrexEvent[]; truncated: boolean } {
    return this.store?.events(taskId, limit) ?? { events: [], truncated: false }
  }

  setEngine(taskId: string, engine: TaskSummary['engine']): void {
    const task = this.active.get(taskId)
    if (task && task.engine !== engine) { task.engine = engine; this.touch(task) }
  }

  /** Validated transition. Same-state is a no-op; an illegal transition throws IllegalTransitionError. */
  transition(taskId: string, to: TaskState): void {
    const task = this.require(taskId)
    if (task.state === to) return
    assertTransition(task.state, to)
    const from = task.state
    task.state = to
    this.touch(task)
    this.bus.publish('task.state_changed', { from, to }, taskId)
  }

  /** Move to a terminal state, close running agents, and publish the terminal event. */
  end(taskId: string, end: TaskEnd): void {
    const task = this.active.get(taskId)
    if (!task) return
    if (!canTransition(task.state, end.state)) {
      // An engine reported completion from a state with no such edge. Record it honestly: unverified when
      // the task did work, otherwise a protocol failure (it never started working). Never a false success.
      if (end.state === 'COMPLETED' && canTransition(task.state, 'COMPLETED_UNVERIFIED')) return this.end(taskId, { state: 'COMPLETED_UNVERIFIED', reason: `The engine finished while the task was ${task.state}; no verification ran.` })
      if (end.state === 'COMPLETED' || end.state === 'COMPLETED_UNVERIFIED' || end.state === 'VERIFIED') return this.end(taskId, { state: 'FAILED', message: `The engine reported completion while the task was ${task.state}, before any work started. The result was not accepted.`, code: 'ENGINE_PROTOCOL' })
      return
    }
    const code = end.state === 'FAILED' ? end.code ?? null : end.state === 'CANCELLED' ? 'CANCELLED' : null
    const verdict = 'verdict' in end ? end.verdict ?? null : null
    if (verdict) { task.verdict = verdict; this.bus.publish('verification.completed', verdict, taskId) }
    for (const agent of task.agents) {
      if (agent.status !== 'running') continue
      if (end.state === 'COMPLETED' || end.state === 'COMPLETED_UNVERIFIED' || end.state === 'VERIFIED') this.agentFinished(agent.agentId, 'completed', 'Finished with the task.')
      else this.agentFinished(agent.agentId, end.state === 'CANCELLED' ? 'cancelled' : 'failed', end.state === 'FAILED' ? end.message : 'The task was cancelled.', code)
    }
    this.transition(taskId, end.state)
    const outcome = end.state === 'FAILED' ? { reason: end.message.slice(0, 4000), code } : end.state === 'COMPLETED_UNVERIFIED' ? { reason: end.reason.slice(0, 4000), code: null } : null
    this.finalize(task, outcome)
    if (end.state === 'COMPLETED') this.bus.publish('task.completed', {}, taskId)
    else if (end.state === 'VERIFIED') this.bus.publish('task.verified', { verdict: end.verdict }, taskId)
    else if (end.state === 'COMPLETED_UNVERIFIED') this.bus.publish('task.completed_unverified', { reason: end.reason.slice(0, 2000) }, taskId)
    else if (end.state === 'FAILED') this.bus.publish('task.failed', { message: end.message.slice(0, 4000), code }, taskId)
    else this.bus.publish('task.cancelled', {}, taskId)
    this.active.delete(taskId)
    this.finished.set(taskId, this.view(task))
    if (this.finished.size > 200) this.finished.delete(this.finished.keys().next().value as string)
    if (task.requestId) this.byRequest.delete(task.requestId)
    this.knownFinished.set(taskId, true)
    for (const agent of task.agents) this.agentTask.delete(agent.agentId)
    this.store?.prune()
  }

  // ---- agents ---------------------------------------------------------------------------------

  agentStarted(taskId: string, role: AgentRole, label: string, endpoint: { providerId?: string | null; model?: string | null } = {}): string {
    const task = this.require(taskId), agentId = uuidv7()
    const agent: AgentRun = { agentId, role, label: label.slice(0, 200), status: 'running', providerId: endpoint.providerId ?? null, model: endpoint.model ?? null, startedAt: this.now(), finishedAt: null, summary: null }
    task.agents = [...task.agents, agent].slice(-200)
    this.agentTask.set(agentId, taskId)
    this.touch(task)
    this.bus.publish('agent.started', { agentId, role, label: agent.label, providerId: agent.providerId, model: agent.model }, taskId)
    return agentId
  }

  agentProgress(agentId: string, message: string, round: number | null = null): void {
    const found = this.agent(agentId)
    if (!found || found.agent.status !== 'running') return
    this.bus.publish('agent.progress', { agentId, role: found.agent.role, round, message: message.slice(0, 2000) }, found.task.taskId)
  }

  /** Update the endpoint an agent is using (after a fallback). */
  agentEndpoint(agentId: string, providerId: string, model: string): void {
    const found = this.agent(agentId)
    if (!found) return
    found.agent.providerId = providerId; found.agent.model = model
    this.touch(found.task)
  }

  agentFinished(agentId: string, status: 'completed' | 'failed' | 'cancelled', text: string, code: string | null = null): void {
    const found = this.agent(agentId)
    if (!found || found.agent.status !== 'running') return
    const { task, agent } = found
    agent.status = status; agent.finishedAt = this.now(); agent.summary = text.slice(0, 4000)
    this.touch(task)
    if (status === 'completed') this.bus.publish('agent.completed', { agentId, role: agent.role, summary: agent.summary }, task.taskId)
    else this.bus.publish('agent.failed', { agentId, role: agent.role, message: agent.summary || 'The agent stopped.', code: status === 'cancelled' ? 'CANCELLED' : code }, task.taskId)
  }

  runningAgents(taskId: string, role?: AgentRole): AgentRun[] {
    return (this.active.get(taskId)?.agents ?? []).filter(agent => agent.status === 'running' && (role === undefined || agent.role === role))
  }

  // ---- event observation ----------------------------------------------------------------------

  private observe(event: AltrexEvent): void {
    if (!event.taskId) return
    const task = this.active.get(event.taskId)
    if (!task && !this.isStoredTask(event.taskId)) return
    if (this.store && !this.store.appendEvent(event) && task && !task.eventsTruncated) { task.eventsTruncated = true; this.save(task) }
    if (!task) return
    switch (event.type) {
      case 'checkpoint.created': {
        const id = (event.payload as { checkpointId: string }).checkpointId
        if (!task.checkpointIds.includes(id)) { task.checkpointIds = [...task.checkpointIds, id].slice(-100); this.touch(task) }
        return
      }
      case 'file.changed': {
        const { paths, cumulative } = event.payload as { paths: string[]; cumulative: boolean }
        task.changedFiles = (cumulative ? [...new Set(paths)] : [...new Set([...task.changedFiles, ...paths])]).slice(0, 1000)
        this.touch(task)
        return
      }
      // Derived transitions are deferred so every listener sees events in sequence order.
      case 'permission.required':
        queueMicrotask(() => this.safely(() => {
          const live = this.active.get(task.taskId)
          if (live && APPROVAL_PAUSABLE.has(live.state)) { live.resumeState = live.state; this.transition(live.taskId, 'AWAITING_APPROVAL') }
        }))
        return
      case 'permission.resolved':
        queueMicrotask(() => this.safely(() => {
          const live = this.active.get(task.taskId)
          if (live && live.state === 'AWAITING_APPROVAL' && live.resumeState) { const back = live.resumeState; live.resumeState = null; this.transition(live.taskId, back) }
        }))
        return
    }
  }

  // ---- helpers --------------------------------------------------------------------------------

  private isStoredTask(taskId: string): boolean {
    if (!this.store) return false
    let known = this.knownFinished.get(taskId)
    if (known === undefined) {
      known = this.store.get(taskId) !== null
      this.knownFinished.set(taskId, known)
      if (this.knownFinished.size > 2000) this.knownFinished.delete(this.knownFinished.keys().next().value as string)
    }
    return known
  }

  private agent(agentId: string): { task: Active; agent: AgentRun } | null {
    const task = this.active.get(this.agentTask.get(agentId) ?? '')
    const agent = task?.agents.find(item => item.agentId === agentId)
    return task && agent ? { task, agent } : null
  }

  private require(taskId: string): Active {
    const task = this.active.get(taskId)
    if (!task) throw new Error(`Task ${taskId} is not active.`)
    return task
  }

  private finalize(task: Active, outcome: TaskSummary['outcome']): void {
    task.outcome = outcome
    task.finishedAt = this.now()
    this.touch(task)
  }

  private touch(task: Active): void {
    task.updatedAt = this.now()
    this.save(task)
  }

  private save(task: Active): void {
    try { this.store?.save(this.view(task)) } catch (error) { this.onError(error) }
  }

  private view(task: Active): TaskSummary {
    const { resumeState: _resume, ...summary } = task
    return { ...summary, agents: summary.agents.map(agent => ({ ...agent })), checkpointIds: [...summary.checkpointIds], changedFiles: [...summary.changedFiles] }
  }

  private safely(work: () => void): void { try { work() } catch (error) { this.onError(error) } }
  private now(): string { return new Date().toISOString() }
}
