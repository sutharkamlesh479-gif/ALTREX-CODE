import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DirectorPlan, ProjectRun, SpecialistTask, TaskContract, Verification } from '../../shared/multi-ai'
import type { ProviderMessage, ProviderRuntimeConnection } from '../providers/model-provider'
import { RoleRouter } from '../providers/model-registry'
import { ProjectToolBroker, codingToolDefinitions } from '../project-tool-broker'
import { buildRepositoryContext } from '../repository-context'
import { overlaps, ownsFile, parseJson, validateGraph, validatePlan, validateTask } from './contracts'
import { changed, copyWorkspace, mergeWorkspace, publishWorkspace, snapshot, guardedPath, type FileSnapshot } from './workspace'
import { RunStore } from './state-store'
import { verifyCommands } from './verification'
import { ProviderFailure } from '../providers/request-manager'
import { LoopDetectedError, TaskBudget } from '../task-budget'

const taskShape = '{id,title,description,role,priority,dependencies:string[],allowedFiles:string[],restrictedFiles:string[],inputs:string[],outputs:string[],acceptance:string[]}'
const specShape = '{project,goal,stack:string[],architecture:string[],designRules:string[],apiContracts:string[],dataModels:string[],requirements:string[],decisions:string[]}'
const dependencyTool = { type: 'function', function: { name: 'request_dependency', description: 'Ask the Director for missing work outside your ownership. The Director will plan it; do not implement it yourself.', parameters: { type: 'object', properties: { description: { type: 'string' }, requiredInterface: { type: 'string' } }, required: ['description', 'requiredInterface'], additionalProperties: false } } }
const workerTools = [...codingToolDefinitions.filter(t => t.function.name !== 'run_command'), dependencyTool]
const readerTools = codingToolDefinitions.filter(t => ['list_files', 'read_file'].includes(t.function.name))
const freshTask = (task: TaskContract): SpecialistTask => ({ ...task, status: task.dependencies.length ? 'WAITING' : 'QUEUED', model: null, provider: null, attempt: 0, filesChanged: [], actions: [], result: '', verification: null, error: null })
const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'Task failed.'
class DependencyRequest extends Error { constructor(readonly request: string) { super('Worker requested a dependency.') } }

export class Director {
  readonly run: ProjectRun
  private stage: string
  private base: FileSnapshot = {}
  private controllers = new Map<string, AbortController>()
  private running = new Map<string, Promise<void>>()
  private revisionQueue: string[] = []
  private wake: (() => void) | null = null
  constructor(private readonly store: RunStore, private readonly router: RoleRouter, private readonly signal: AbortSignal, private readonly emit: (run: ProjectRun) => void, input: { id: string; projectPath: string; request: string }, private readonly check = verifyCommands) {
    const now = new Date().toISOString()
    this.run = { version: 1, ...input, createdAt: now, updatedAt: now, status: 'PLANNING', spec: null, tasks: [], activity: [], finalVerification: null, revisions: [], filesChanged: [], error: null }
    this.stage = join(store.directory(input.id), 'integration')
  }
  private save(): void { this.store.save(this.run); this.emit(structuredClone(this.run)) }
  private activity(message: string): void { this.run.activity = [...this.run.activity, message].slice(-200); this.save() }
  revise(text: string): void { if (!['PLANNING', 'RUNNING'].includes(this.run.status)) throw new Error('This run has reached final verification. Send changes in a new run.'); if (!text.trim() || text.length > 12000 || this.run.revisions.length + this.revisionQueue.length >= 5) throw new Error('A run accepts up to five changes of 12,000 characters.'); this.revisionQueue.push(text); this.wake?.() }
  private async structured(role: string, instructions: string, data: unknown): Promise<unknown> {
    let correction = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { completion } = await this.router.complete(role, [{ role: 'system', content: `${instructions}\nReturn only compact JSON. No markdown or private reasoning. ${correction}` }, { role: 'user', content: JSON.stringify(data) }], [], this.signal, text => this.activity(text))
        try { return parseJson(completion.content) } catch { correction = 'Your previous response was not valid JSON. Return a complete JSON object within the output budget.' }
      } catch (error) { if (!(error instanceof ProviderFailure) || !error.message.includes('output reached')) throw error; correction = 'Your response exceeded the output budget. Use fewer narrowly scoped tasks and much shorter strings. Keep all JSON under 800 tokens.'; this.activity('Director is compacting its structured response to fit the model output budget.') }
    }
    throw new Error(`${role} did not return valid structured output after three attempts.`)
  }
  private async plan(): Promise<DirectorPlan> {
    this.activity('ALTREX Director: analyzing project and creating the master specification.')
    const context = buildRepositoryContext(this.run.projectPath, this.run.request, 9000)
    let feedback = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.structured('Director', `You are ALTREX Director. Own architecture, delegate narrow responsibilities. Preserve existing stack and UI unless requested. Create a minimal DAG: 1–3 tasks for small work; additional specialists only for independent responsibilities. Every task must have distinct outputs. Never give workers the entire project request. Shared files require explicit narrow ownership and dependencies. Scopes are exact relative files or directory/**; no global globs, secrets, generated files or node_modules. Acceptance must be verifiable. Workers can read/write owned source, but only the Director runs checks through the existing command layer. Return {spec:${specShape},tasks:[${taskShape}]}. Be concise (under 1500 output tokens). ${feedback}\nRepository context:\n${context}\nPrior project memory:\n${this.store.memory(this.run.projectPath)}`, { request: this.run.request })
      try { return validatePlan(result) } catch (error) { feedback = `Correct this validation failure: ${messageOf(error)}` }
    }
    throw new Error('Director could not produce a valid task DAG.')
  }
  async execute(resumeId?: string): Promise<ProjectRun> {
    try {
      this.save(); this.signal.throwIfAborted()
      if (resumeId) {
        const previous = this.store.load(resumeId)
        if (!previous || previous.projectPath !== this.run.projectPath || !previous.spec || !['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(previous.status)) throw new Error('This run is not eligible for restart.')
        const directory = this.store.directory(resumeId)
        if (existsSync(join(directory, 'publication.json'))) throw new Error('This run has a publication journal. Inspect the original project and retained changes before starting a new run.')
        this.base = JSON.parse(readFileSync(join(directory, 'base.json'), 'utf8')) as FileSnapshot
        if (changed(this.base, snapshot(this.run.projectPath)).length) throw new Error('The original workspace changed. Start a new run so the Director can reconcile it safely.')
        copyWorkspace(join(directory, 'integration'), this.stage)
        this.run.spec = previous.spec; this.run.request = previous.request; this.run.revisions = previous.revisions
        this.run.tasks = previous.tasks.map(task => task.status === 'COMPLETED' ? task : freshTask(task))
        this.activity(`Restarted ${this.run.tasks.filter(t => t.status !== 'COMPLETED').length} unfinished tasks from ${resumeId}.`)
      } else {
        this.base = copyWorkspace(this.run.projectPath, this.stage)
        const plan = await this.plan(); this.run.spec = plan.spec; this.run.tasks = plan.tasks.map(freshTask)
        this.activity(`Director created ${plan.tasks.length} tasks with explicit ownership and dependencies.`)
      }
      writeFileSync(join(this.store.directory(this.run.id), 'base.json'), JSON.stringify(this.base))
      this.run.status = 'RUNNING'; this.save()
      for (let integrationAttempt = 0; integrationAttempt < 3; integrationAttempt++) {
      while (true) {
        this.signal.throwIfAborted()
        if (this.revisionQueue.length) await this.applyRevision(this.revisionQueue.shift()!)
        for (const task of this.run.tasks) if (['QUEUED', 'WAITING'].includes(task.status) && task.dependencies.some(id => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(this.run.tasks.find(t => t.id === id)!.status))) { task.status = 'BLOCKED'; task.error = 'A required dependency failed.'; this.save() }
        const ready = this.run.tasks.filter(t => ['QUEUED', 'WAITING'].includes(t.status) && t.dependencies.every(id => this.run.tasks.find(d => d.id === id)?.status === 'COMPLETED')).sort((a, b) => b.priority - a.priority)
        for (const task of ready) {
          if (this.running.size >= 3) break
          if ([...this.running.keys()].some(id => overlaps(task, this.run.tasks.find(t => t.id === id)!))) continue
          const pending = this.work(task).finally(() => { this.running.delete(task.id); this.controllers.delete(task.id) }); this.running.set(task.id, pending)
        }
        if (!this.running.size) break
        let wake: (() => void) | null = null
        const revision = new Promise<void>(resolve => { wake = resolve; this.wake = resolve })
        await Promise.race([...this.running.values(), revision]); if (this.wake === wake) this.wake = null
      }
      if (this.revisionQueue.length) throw new Error('A requested change arrived too late for scheduling; it remains recorded in activity.')
      if (this.run.tasks.some(task => task.status !== 'COMPLETED')) throw new Error('Some required tasks failed or remain blocked. Independent verified work is retained; nothing was published.')
      this.run.status = 'VERIFYING'; this.activity('Director: running final project checks and independent review.')
      this.run.finalVerification = await this.review(this.stage, null, this.base, this.signal)
      if (this.run.finalVerification.passed) break
      if (integrationAttempt === 2) throw new Error(`Final QA rejected integration after repairs: ${this.run.finalVerification.summary}`)
      this.activity('Final QA found issues. Director is assigning a bounded integration repair.')
      const proposal = await this.structured('Director', `Create one integration repair task following the existing architecture. Return {task:${taskShape}}. It must fix reported QA failures, use a new task id, depend on completed tasks as needed and own only required source files.`, { spec: this.run.spec, completedTasks: this.run.tasks.map(t => ({ id: t.id, files: t.filesChanged })), failure: this.run.finalVerification.summary.slice(0, 5000) }) as { task?: unknown }
      const repair = validateTask(proposal.task); validateGraph([...this.run.tasks, repair]); this.run.tasks.push(freshTask(repair)); this.run.status = 'RUNNING'; this.save()
      }
      this.signal.throwIfAborted(); this.run.status = 'INTEGRATING'; this.activity('Final QA passed. Checking original files before publishing verified changes.')
      this.run.filesChanged = publishWorkspace(this.stage, this.run.projectPath, this.base, this.store.directory(this.run.id))
      this.run.status = 'COMPLETED'; this.store.saveMemory(this.run); this.activity(`Integrated ${this.run.filesChanged.length} verified files.`)
    } catch (error) {
      for (const controller of this.controllers.values()) controller.abort()
      await Promise.allSettled(this.running.values())
      this.run.status = this.signal.aborted ? 'CANCELLED' : 'FAILED'; this.run.error = messageOf(error)
      for (const task of this.run.tasks) if (['QUEUED', 'WAITING', 'RUNNING', 'VERIFYING'].includes(task.status)) task.status = this.signal.aborted ? 'CANCELLED' : 'BLOCKED'
      this.save()
    }
    return this.run
  }
  private async work(task: SpecialistTask): Promise<void> {
    const controller = new AbortController(), abort = () => controller.abort(this.signal.reason)
    this.controllers.set(task.id, controller); this.signal.addEventListener('abort', abort, { once: true }); if (this.signal.aborted) abort()
    let dependency: string | null = null
    try {
      while (task.attempt < 3) {
        controller.signal.throwIfAborted(); task.attempt++; task.status = 'RUNNING'; this.activity(`${task.role}: ${task.title} (attempt ${task.attempt}/3).`)
        const workspace = join(this.store.directory(this.run.id), 'workers', `${task.id}-${task.attempt}-${Date.now()}`)
        const base = copyWorkspace(this.stage, workspace), broker = new ProjectToolBroker(workspace, controller.signal, task), started = Date.now()
        const messages: ProviderMessage[] = [{ role: 'system', content: `You are ALTREX ${task.role}. Implement only your task. Architecture is owned by the Director. Do not duplicate completed outputs. read_file supports line ranges. Use write_file for small owned files, edit_file for exact replacements, and append_file to build larger files in chunks. If a dependency outside your files is missing, request_dependency and stop. Do not claim tests ran; the Director runs real checks. Finish with a concise result summary.\nRepository context:\n${buildRepositoryContext(workspace, `${task.title} ${task.description}`, 6000)}` }, { role: 'user', content: JSON.stringify({ task: validateTask(task), masterSpec: this.run.spec, dependencies: this.run.tasks.filter(t => task.dependencies.includes(t.id)).map(t => ({ id: t.id, outputs: t.outputs, result: t.result.slice(0, 1500) })), previousFailure: task.error?.slice(0, 1200) }) }]
        let connection: ProviderRuntimeConnection | undefined
        try {
          let finished = false, loopRecoveries = 0
          const budget = new TaskBudget(`${task.title}\n${task.description}`, task.acceptance.length + task.allowedFiles.length)
          while (true) {
            if (!budget.canStartRound()) {
              if (budget.extendForProgress()) this.action(task, `Worker budget extended for measurable progress. ${budget.summary()}`)
              else break
            }
            budget.startRound()
            controller.signal.throwIfAborted()
            const response = await this.router.complete(task.role, messages, workerTools, controller.signal, text => this.action(task, text), connection ? this.router.registry.key(connection) : undefined)
            connection = response.connection
            if (task.model && task.model !== connection.model) this.action(task, `${task.model} reassigned to ${connection.providerId} / ${connection.model}.`)
            task.model = connection.model; task.provider = connection.providerId; this.save()
            const { completion } = response
            if (!completion.toolCalls.length) { if (!completion.content.trim()) throw new Error('Worker returned no result.'); task.result = completion.content.slice(0, 8000); finished = true; break }
            messages.push({ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) })
            for (const call of completion.toolCalls) {
              controller.signal.throwIfAborted()
              if (call.name === 'request_dependency') { const data = parseJson(call.arguments) as { description?: string; requiredInterface?: string }; if (!data.description || !data.requiredInterface) throw new Error('Dependency request requires description and requiredInterface.'); throw new DependencyRequest(JSON.stringify(data).slice(0, 5000)) }
              const result = await broker.execute(call)
              this.action(task, `${call.name}${result.changedFile ? `: ${result.changedFile}` : ''}${result.content.startsWith('ERROR:') ? ` — ${result.content}` : ''}`)
              if (result.content.includes('SCOPE VIOLATION')) throw new Error(result.content)
              try { budget.record(call, result.content, result.changedFile !== undefined || (result.changedFiles?.length ?? 0) > 0 || result.commandResult?.exitCode === 0) }
              catch (error) {
                if (!(error instanceof LoopDetectedError) || loopRecoveries >= 1) throw error
                loopRecoveries++; this.action(task, `${error.message} Worker instructed to choose a different approach.`)
                messages.push({ role: 'system', content: `${error.message} Do not repeat it. Preserve current files, summarize the failure, and use a materially different approach.` })
              }
              messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
            }
          }
          if (!finished) throw new Error(`Worker paused after its task budget. Workspace progress is retained. ${budget.summary()}`)
          task.filesChanged = changed(base, snapshot(workspace))
          for (const file of task.filesChanged) if (!ownsFile(task, file)) throw new Error(`SCOPE VIOLATION: ${file}`)
          if (!task.filesChanged.length) throw new Error('Worker produced no owned file changes for this implementation task.')
          task.status = 'VERIFYING'; this.action(task, 'Running project checks and independent acceptance review.')
          task.verification = await this.review(workspace, task, base, controller.signal)
          if (!task.verification.passed) throw new Error(task.verification.summary)
          controller.signal.throwIfAborted(); task.filesChanged = mergeWorkspace(workspace, this.stage, base, task)
          task.status = 'COMPLETED'; task.error = null
          if (connection) this.router.registry.observe(connection, task.role, true, Date.now() - started, true)
          this.activity(`${task.title}: verified and merged into the integration workspace.`); return
        } catch (error) {
          if (error instanceof DependencyRequest) { dependency = error.request; break }
          if (controller.signal.aborted) throw error
          task.error = messageOf(error); if (connection) this.router.registry.observe(connection, task.role, false, Date.now() - started)
          const providerFailure = error instanceof ProviderFailure
          this.action(task, `Attempt rejected: ${task.error}. ${providerFailure ? 'Provider routing was exhausted; no identical task retry.' : task.attempt < 3 ? 'Rebasing on current integration state for repair.' : 'Retry limit reached.'}`)
          if (providerFailure) break
        }
      }
      if (dependency) {
        task.status = 'WAITING'; this.action(task, `Requested dependency through Director: ${dependency}`)
        const proposal = await this.structured('Director', `A worker needs a dependency. Follow the existing architecture. Reuse an existing task when possible: return {existingTaskId:string}. Otherwise return {task:${taskShape}}. New work must be narrowly scoped; do not depend on the requesting task.`, { spec: this.run.spec, tasks: this.run.tasks.map(t => ({ id: t.id, title: t.title, outputs: t.outputs, allowedFiles: t.allowedFiles })), requester: task.id, request: dependency }) as { existingTaskId?: string; task?: unknown }
        controller.signal.throwIfAborted()
        const newTask = proposal.task ? validateTask(proposal.task) : undefined, id = proposal.existingTaskId ?? newTask?.id
        if (!id || (newTask && this.run.tasks.some(t => t.id === newTask.id))) throw new Error('Director returned an invalid dependency assignment.')
        const graph = this.run.tasks.map(t => t.id === task.id ? { ...t, dependencies: [...new Set([...t.dependencies, id])] } : t)
        if (newTask) graph.push(freshTask(newTask)); validateGraph(graph)
        task.dependencies = [...new Set([...task.dependencies, id])]; if (newTask) this.run.tasks.push(freshTask(newTask))
        if (task.attempt >= 3) throw new Error('Worker dependency expansion limit reached.')
        this.activity(`Director assigned dependency ${id} for ${task.id}.`)
      } else { task.status = 'FAILED'; this.save() }
    } catch (error) { task.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED'; task.error = messageOf(error); this.save() }
    finally { this.signal.removeEventListener('abort', abort) }
  }
  private action(task: SpecialistTask, text: string): void { task.actions = [...task.actions, text].slice(-100); this.save() }
  private async review(root: string, task: SpecialistTask | null, base: FileSnapshot, signal: AbortSignal): Promise<Verification> {
    const unfinishedPeers = task !== null && this.run.tasks.some(other => other.id !== task.id && other.status !== 'COMPLETED')
    const commands = unfinishedPeers ? [] : await this.check(root, signal, text => task ? this.action(task, text) : this.activity(text))
    if (commands.some(c => c.exitCode !== 0)) return { passed: false, summary: `Checks failed: ${commands.filter(c => c.exitCode !== 0).map(c => `${c.command}\n${c.output.slice(-3500)}`).join('\n')}`, commands, reviewer: 'command checks', checkedAt: new Date().toISOString() }
    const files = changed(base, snapshot(root)), broker = new ProjectToolBroker(root, signal, task ?? undefined)
    const excerpts = files.map(path => ({ path, content: existsSync(guardedPath(root, path)) ? readFileSync(guardedPath(root, path), 'utf8').slice(0, 1600) : '[deleted]' })).slice(0, 30)
    const messages: ProviderMessage[] = [{ role: 'system', content: `You are an independent ALTREX acceptance reviewer. You cannot edit. Inspect actual source with read_file ranges/list_files, evaluate architecture, contracts, loading/errors, and all acceptance criteria. Reject placeholder implementations, unverified claims and insufficient evidence. Command outcomes below are real. If no executable checks exist, explicitly say so; never claim a build passed. Final answer only JSON {passed:boolean,summary:string}.\nRepository context:\nChanged source excerpts (retrieve complete relevant files): ${JSON.stringify(excerpts)}` }, { role: 'user', content: JSON.stringify({ masterSpec: this.run.spec, task: task ? { title: task.title, description: task.description, acceptance: task.acceptance, allowedFiles: task.allowedFiles, result: task.result } : 'Final integrated project: check every requirement', files, commands: commands.map(c => ({ command: c.command, exitCode: c.exitCode, output: c.output.slice(-1800) })) }) }]
    for (let round = 0; round < 10; round++) {
      const { completion, connection } = await this.router.complete('Reviewer', messages, readerTools, signal, text => task ? this.action(task, text) : this.activity(text))
      if (!completion.toolCalls.length) { const result = parseJson(completion.content) as { passed?: unknown; summary?: unknown }; if (typeof result.passed !== 'boolean' || typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('Reviewer returned invalid acceptance evidence.'); return { passed: result.passed, summary: `${commands.length ? '' : 'No executable project checks were found. Source review only. '}${result.summary}`, commands, reviewer: `${connection.providerId}/${connection.model}`, checkedAt: new Date().toISOString() } }
      messages.push({ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) })
      for (const call of completion.toolCalls) { if (!['read_file', 'list_files'].includes(call.name)) throw new Error('Reviewer attempted a forbidden write.'); const result = await broker.execute(call); messages.push({ role: 'tool', tool_call_id: call.id, content: result.content }) }
    }
    throw new Error('Review exceeded its retrieval budget.')
  }
  private async applyRevision(text: string): Promise<void> {
    this.activity('Director is locating tasks affected by your change.')
    const proposal = await this.structured('Director', `Revise this plan for the user change. Return {spec:${specShape},tasks:[${taskShape}],affectedTaskIds:string[]}. Include ALL tasks, preserving IDs and contracts for unaffected work. Only change affected contracts. Keep completed architecture and unrelated work intact.`, { change: text, spec: this.run.spec, tasks: this.run.tasks.map(({ id, title, description, role, priority, dependencies, allowedFiles, restrictedFiles, inputs, outputs, acceptance }) => ({ id, title, description, role, priority, dependencies, allowedFiles, restrictedFiles, inputs, outputs, acceptance })) })
    const plan = validatePlan(proposal), raw = proposal as { affectedTaskIds?: unknown }, affected = new Set(Array.isArray(raw.affectedTaskIds) ? raw.affectedTaskIds.filter((id): id is string => typeof id === 'string') : [])
    for (const task of plan.tasks) { const old = this.run.tasks.find(t => t.id === task.id); if (!old || JSON.stringify(validateTask(old)) !== JSON.stringify(task)) affected.add(task.id) }
    if (this.run.tasks.some(old => !plan.tasks.some(t => t.id === old.id))) throw new Error('Revision cannot silently delete existing tasks.')
    let grew = true; while (grew) { grew = false; for (const task of plan.tasks) if (!affected.has(task.id) && task.dependencies.some(id => affected.has(id))) { affected.add(task.id); grew = true } }
    for (const id of affected) this.controllers.get(id)?.abort()
    await Promise.allSettled([...affected].flatMap(id => this.running.get(id) ? [this.running.get(id)!] : []))
    this.run.spec = plan.spec; this.run.revisions.push(text)
    this.run.tasks = plan.tasks.map(task => affected.has(task.id) ? freshTask(task) : this.run.tasks.find(old => old.id === task.id) ?? freshTask(task))
    this.activity(`Director revised ${affected.size} affected tasks. Unrelated work continues.`)
  }
}


