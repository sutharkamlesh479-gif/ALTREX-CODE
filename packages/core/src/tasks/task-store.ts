import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AltrexEventSchema, TaskSummarySchema, type AltrexEvent, type TaskSummary } from '@altrex/contracts'

export type TaskStoreOptions = {
  /** Task records kept; older finished tasks are pruned with their event history. */
  retention?: number
  /** Per-task event history cap. Above it, deltas and command output are dropped (state events are kept). */
  maxEventBytes?: number
}

const ID = /^[A-Za-z0-9-]{8,128}$/
const HIGH_VOLUME = new Set(['agent.message_delta', 'command.output'])

/**
 * Durable task records and per-task event history (`<root>/<taskId>.json` + `<taskId>.events.jsonl`).
 * Writes are synchronous and atomic (temp file + rename) so a crash never leaves a half-written record.
 */
export class TaskStore {
  private readonly retention: number
  private readonly maxEventBytes: number
  private readonly eventBytes = new Map<string, number>()

  constructor(readonly root: string, options: TaskStoreOptions = {}) {
    this.retention = Math.max(10, options.retention ?? 300)
    this.maxEventBytes = Math.max(64_000, options.maxEventBytes ?? 8_000_000)
    mkdirSync(root, { recursive: true })
  }

  save(task: TaskSummary): void {
    const valid = TaskSummarySchema.parse(task)
    const path = this.recordPath(valid.taskId), temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(valid), { mode: 0o600 })
    renameSync(temporary, path)
  }

  get(taskId: string): TaskSummary | null {
    if (!ID.test(taskId)) return null
    try { return TaskSummarySchema.parse(JSON.parse(readFileSync(this.recordPath(taskId), 'utf8'))) } catch { return null }
  }

  /** Newest first. */
  list(filter: { projectPath?: string | undefined; limit?: number } = {}): TaskSummary[] {
    const tasks: TaskSummary[] = []
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue
      const task = this.get(name.slice(0, -5))
      if (task && (filter.projectPath === undefined || samePath(task.projectPath, filter.projectPath))) tasks.push(task)
    }
    tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.taskId.localeCompare(a.taskId))
    return tasks.slice(0, filter.limit ?? tasks.length)
  }

  /** Append one event to its task's history. Returns false when it was dropped by the size cap. */
  appendEvent(event: AltrexEvent): boolean {
    if (!event.taskId || !ID.test(event.taskId)) return false
    const path = this.eventsPath(event.taskId)
    let size = this.eventBytes.get(event.taskId)
    if (size === undefined) { try { size = statSync(path).size } catch { size = 0 } }
    const line = `${JSON.stringify(event)}\n`
    if (size + line.length > this.maxEventBytes && (HIGH_VOLUME.has(event.type) || size + line.length > this.maxEventBytes * 1.25)) return false
    appendFileSync(path, line, { mode: 0o600 })
    this.eventBytes.set(event.taskId, size + line.length)
    return true
  }

  /** Persisted events of a task, oldest first. Lines that no longer parse (e.g. torn by a crash) are skipped. */
  events(taskId: string, limit = 5000): { events: AltrexEvent[]; truncated: boolean } {
    if (!ID.test(taskId) || !existsSync(this.eventsPath(taskId))) return { events: [], truncated: false }
    const events: AltrexEvent[] = []
    for (const line of readFileSync(this.eventsPath(taskId), 'utf8').split('\n')) {
      if (!line) continue
      try { const parsed = AltrexEventSchema.safeParse(JSON.parse(line)); if (parsed.success) events.push(parsed.data) } catch { /* torn line */ }
    }
    return { events: events.slice(-limit), truncated: events.length > limit }
  }

  /** Keep the newest `retention` tasks; never prune unfinished ones. */
  prune(): void {
    const tasks = this.list()
    for (const task of tasks.slice(this.retention)) {
      if (task.finishedAt === null) continue
      for (const path of [this.recordPath(task.taskId), this.eventsPath(task.taskId)]) { try { unlinkSync(path) } catch { /* already gone */ } }
      this.eventBytes.delete(task.taskId)
    }
  }

  private recordPath(taskId: string): string { return join(this.root, `${taskId}.json`) }
  private eventsPath(taskId: string): string { return join(this.root, `${taskId}.events.jsonl`) }
}

function samePath(left: string | null, right: string): boolean {
  if (left === null) return false
  const normalize = (value: string) => { const text = value.replace(/[\\/]+$/, '').replaceAll('\\', '/'); return process.platform === 'win32' ? text.toLowerCase() : text }
  return normalize(left) === normalize(right)
}
