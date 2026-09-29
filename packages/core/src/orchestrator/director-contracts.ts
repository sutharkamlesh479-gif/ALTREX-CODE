import type { DirectorPlan, MasterSpec, TaskContract } from './director-types'
import { safePath } from '../security/path-guard'
export { safePath }
export function normalizeScope(scope: string): string { const prefix = scope.endsWith('/**') ? scope.slice(0, -3) : scope; safePath(prefix); if (/[*?\[\]]/.test(prefix)) throw new Error('Ownership scopes must be exact files or directory/** prefixes.'); return scope }
export function matchesScope(path: string, scope: string): boolean { path = path.toLowerCase(); scope = scope.toLowerCase(); return scope.endsWith('/**') ? path.startsWith(`${scope.slice(0, -3)}/`) : path === scope }
export function ownsFile(task: Pick<TaskContract, 'allowedFiles' | 'restrictedFiles'>, path: string): boolean { safePath(path); return task.allowedFiles.some(scope => matchesScope(path, scope)) && !task.restrictedFiles.some(scope => matchesScope(path, scope)) }
export function overlaps(a: TaskContract, b: TaskContract): boolean { return a.allowedFiles.some(x => b.allowedFiles.some(y => x.toLowerCase() === y.toLowerCase() || (x.endsWith('/**') && y.toLowerCase().startsWith(`${x.toLowerCase().slice(0, -3)}/`)) || (y.endsWith('/**') && x.toLowerCase().startsWith(`${y.toLowerCase().slice(0, -3)}/`)))) }
function strings(value: unknown, field: string, max = 24): string[] { if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || v.length > 3000)) throw new Error(`Invalid ${field}.`); return value as string[] }
function text(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw new Error(`Invalid ${field}.`); return value }
export function validateTask(value: unknown): TaskContract {
  if (!value || typeof value !== 'object') throw new Error('Invalid task contract.')
  const v = value as Record<string, unknown>
  const task: TaskContract = { id: text(v.id, 'task id'), title: text(v.title, 'title'), description: text(v.description, 'description'), role: text(v.role, 'role'), priority: typeof v.priority === 'number' ? v.priority : 0, dependencies: strings(v.dependencies, 'dependencies'), allowedFiles: strings(v.allowedFiles, 'allowed files'), restrictedFiles: strings(v.restrictedFiles, 'restricted files'), inputs: strings(v.inputs, 'inputs'), outputs: strings(v.outputs, 'outputs'), acceptance: strings(v.acceptance, 'acceptance') }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(task.id) || !task.allowedFiles.length || !task.acceptance.length || !task.outputs.length) throw new Error('Task requires a safe unique ID, ownership, outputs and acceptance criteria.')
  task.allowedFiles.forEach(normalizeScope); task.restrictedFiles.forEach(normalizeScope)
  return task
}
export function validateGraph(tasks: TaskContract[]): void {
  if (!tasks.length || tasks.length > 24 || new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error('Task graph must have 1–24 unique tasks.')
  const done = new Set<string>(), visiting = new Set<string>()
  const visit = (task: TaskContract) => { if (visiting.has(task.id)) throw new Error('Task dependency cycle detected.'); if (done.has(task.id)) return; visiting.add(task.id); for (const id of task.dependencies) { const dep = tasks.find(t => t.id === id); if (!dep) throw new Error(`Missing dependency ${id}.`); visit(dep) } visiting.delete(task.id); done.add(task.id) }
  tasks.forEach(visit)
}
export function parseJson(text: string): unknown { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) }
export function validatePlan(value: unknown): DirectorPlan {
  if (!value || typeof value !== 'object') throw new Error('Director must return a structured plan.')
  const v = value as Record<string, unknown>, s = v.spec as Record<string, unknown> | undefined
  if (!s || !Array.isArray(v.tasks)) throw new Error('Director plan requires spec and tasks.')
  const spec: MasterSpec = { project: text(s.project, 'project'), goal: text(s.goal, 'goal'), stack: strings(s.stack, 'stack'), architecture: strings(s.architecture, 'architecture'), designRules: strings(s.designRules, 'design rules'), apiContracts: strings(s.apiContracts, 'API contracts'), dataModels: strings(s.dataModels, 'data models'), requirements: strings(s.requirements, 'requirements'), decisions: strings(s.decisions, 'decisions') }
  const tasks = v.tasks.map(validateTask); validateGraph(tasks); return { spec, tasks }
}

