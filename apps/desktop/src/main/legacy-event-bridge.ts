import type { EventBus } from '@altrex/core/events/event-bus'
import { TaskManager } from '@altrex/core/orchestrator/task-manager'
import type { TaskState } from '@altrex/contracts'
import type { ChatRequest, ChatStreamEvent } from '../shared/desktop-api'
import type { ProjectRun } from '../shared/multi-ai'
import { CODEX_PROVIDER_LABEL } from './codex-cli-agent'

// Adapter from the legacy ChatStreamEvent stream to the core TaskManager (V4 Phase 7). The Manager owns
// task identity, the validated state machine, agent runs and persistence; this class only translates.
// It reports what the legacy engines really did: change tasks finish as COMPLETED_UNVERIFIED because no
// evidence-based verdict exists for them yet.

const unverifiedReason: Record<ChatRequest['mode'], string> = {
  ASK: '',
  AGENT: 'ALTREX does not yet produce an evidence-based verification verdict for this engine. Command results and file changes reported for this task are real but were not evaluated as a verdict.',
  LOCAL: 'ALTREX does not yet produce an evidence-based verification verdict for this engine. Command results and file changes reported for this task are real but were not evaluated as a verdict.',
  MULTI: 'The Multi-AI Director ran its own project checks and review, but ALTREX does not yet record an evidence-based verification verdict for Director runs.',
}

const directorStates: Partial<Record<ProjectRun['status'], TaskState>> = { PLANNING: 'PLANNING', RUNNING: 'IMPLEMENTING', INTEGRATING: 'IMPLEMENTING', VERIFYING: 'TESTING' }

type DirectorAgents = { planner: string | null; tester: string | null; workers: Map<string, string> }

export class LegacyEventBridge {
  readonly tasks: TaskManager
  private readonly directors = new Map<string, DirectorAgents>()

  constructor(private readonly bus: EventBus, private readonly onError: (error: unknown) => void = () => undefined, tasks?: TaskManager) {
    this.tasks = tasks ?? new TaskManager(bus, null, onError)
  }

  /** Call once when a chat request is accepted, before any legacy event for it is handled. Returns the task id. */
  begin(request: ChatRequest): string | null {
    let taskId: string | null = null
    this.safely(() => {
      const prompt = request.messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
      taskId = this.tasks.begin({
        requestId: request.requestId,
        mode: request.mode,
        intent: request.mode === 'ASK' ? 'question' : 'change',
        projectPath: request.projectPath,
        title: prompt.trim().split(/\r?\n/, 1)[0] ?? '',
        modelSelection: request.modelSelection,
        routingMode: request.routingMode ?? null,
        sessionId: request.sessionId ?? null,
      })
    })
    return taskId
  }

  /** Translate one legacy event. Never throws into the legacy emit path. */
  handle(event: ChatStreamEvent): void {
    this.safely(() => {
      const id = this.tasks.taskIdFor(event.requestId)
      if (!id) return
      const mode = this.tasks.get(id)?.mode
      switch (event.type) {
        case 'started':
          this.tasks.transition(id, mode === 'ASK' ? 'ANSWERING' : mode === 'MULTI' ? 'PLANNING' : 'IMPLEMENTING')
          if (event.provider === CODEX_PROVIDER_LABEL) {
            this.bus.publish('task.activity', { message: `Using the external OpenAI Codex engine (${event.model ?? 'unknown version'}); it selects its own model.`, source: 'legacy' }, id)
          }
          // model.selected / provider.selected / fallback.* come from the router itself (Phase 4);
          // agent runs are started by the engine host (ProviderService) or from Director run states.
          return
        case 'delta':
          if (event.delta) this.bus.publish('agent.message_delta', { text: event.delta }, id)
          return
        case 'activity':
          if (event.message?.trim()) this.bus.publish('task.activity', { message: event.message.slice(0, 4000), source: 'legacy' }, id)
          return
        case 'files-changed':
          if (event.files) this.bus.publish('file.changed', { paths: event.files.slice(0, 1000), cumulative: true }, id)
          return
        case 'command-result':
          if (event.command) this.bus.publish('command.exited', { command: event.command, exitCode: Number.isInteger(event.exitCode) ? event.exitCode! : null, output: (event.output ?? '').slice(0, 8192) }, id)
          return
        case 'run-state':
          if (event.run) this.directorRun(id, event.run)
          return
        case 'completed':
          this.directors.delete(id)
          if (mode === 'ASK') this.tasks.end(id, { state: 'COMPLETED' })
          else this.tasks.end(id, { state: 'COMPLETED_UNVERIFIED', reason: unverifiedReason[mode ?? 'AGENT'] })
          return
        case 'cancelled':
          this.directors.delete(id)
          this.tasks.end(id, { state: 'CANCELLED' })
          return
        case 'error':
          this.directors.delete(id)
          this.tasks.end(id, { state: 'FAILED', message: (event.message?.trim() || 'The task failed.').slice(0, 4000), code: null })
          return
      }
    })
  }

  /** Tasks still in progress (for diagnostics and tests). */
  activeTaskIds(): string[] {
    return this.tasks.list().filter(task => this.tasks.isActive(task.taskId)).map(task => task.taskId)
  }

  /** Director run snapshot → task state and agent runs (planner, one coder per specialist task, project checks). */
  private directorRun(taskId: string, run: ProjectRun): void {
    this.tasks.setEngine(taskId, 'director')
    const next = directorStates[run.status]
    if (next && this.tasks.state(taskId) !== next) this.tasks.transition(taskId, next)
    let agents = this.directors.get(taskId)
    if (!agents) { agents = { planner: null, tester: null, workers: new Map() }; this.directors.set(taskId, agents) }
    if (run.status === 'PLANNING' && agents.planner === null) agents.planner = this.tasks.agentStarted(taskId, 'PLANNER', 'Director planner')
    if (run.status !== 'PLANNING' && agents.planner !== null && run.spec) this.tasks.agentFinished(agents.planner, 'completed', `Planned ${run.tasks?.length ?? 0} task${run.tasks?.length === 1 ? '' : 's'}.`)
    for (const task of run.tasks ?? []) {
      let agentId = agents.workers.get(task.id)
      if (!agentId && ['RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED'].includes(task.status)) {
        agentId = this.tasks.agentStarted(taskId, 'CODER', `${task.role}: ${task.title}`, { providerId: task.provider, model: task.model })
        agents.workers.set(task.id, agentId)
      }
      if (!agentId) continue
      if (task.provider && task.model) this.tasks.agentEndpoint(agentId, task.provider, task.model)
      if (task.status === 'COMPLETED') this.tasks.agentFinished(agentId, 'completed', task.result || 'Completed.')
      else if (task.status === 'FAILED' || task.status === 'BLOCKED') this.tasks.agentFinished(agentId, 'failed', task.error || `Task ${task.status.toLowerCase()}.`, task.status)
      else if (task.status === 'CANCELLED') this.tasks.agentFinished(agentId, 'cancelled', 'Cancelled.')
    }
    if (run.status === 'VERIFYING' && agents.tester === null) agents.tester = this.tasks.agentStarted(taskId, 'TESTER', 'Director project checks')
    if (agents.tester !== null && run.finalVerification) {
      this.tasks.agentFinished(agents.tester, run.finalVerification.passed ? 'completed' : 'failed', run.finalVerification.summary.slice(0, 4000) || (run.finalVerification.passed ? 'Checks passed.' : 'Checks failed.'), run.finalVerification.passed ? null : 'CHECKS_FAILED')
    }
  }

  private safely(work: () => void): void {
    try { work() } catch (error) { this.onError(error) }
  }
}
