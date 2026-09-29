import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Director } from './director'
import { RunStore } from './state-store'
import { ModelRegistry, RoleRouter } from '../providers/model-registry'
import { ProviderFailure, abortableDelay } from '../providers/request-manager'
import type { ModelProvider, ProviderCompletionInput, ProviderCompletion } from '../providers/model-provider'
import type { MasterSpec, ProjectRun, TaskContract } from '../../shared/multi-ai'
import { copyWorkspace, snapshot, publishWorkspace } from './workspace'
import { ownsFile, validateGraph } from './contracts'
import { ProjectToolBroker } from '../project-tool-broker'
import { runProjectCommand } from '../project-command-runner'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const spec: MasterSpec = { project: 'Todo fixture', goal: 'Implement UI and backend modules', stack: ['JavaScript'], architecture: ['UI consumes backend'], designRules: ['Preserve UI'], apiContracts: ['getTodos returns an array'], dataModels: ['Todo'], requirements: ['Working modules'], decisions: ['No additional framework'] }
const task = (id: string, dependencies: string[] = [], file = `${id}.js`): TaskContract => ({ id, title: id, description: `Implement ${id}`, role: id, priority: 1, dependencies, allowedFiles: [file], restrictedFiles: [], inputs: [], outputs: [`${id} module`], acceptance: ['Valid JavaScript exporting a function'] })
class FixtureProvider implements ModelProvider {
  readonly protocol = 'test fixture only'
  active = 0; maximum = 0
  constructor(readonly tasks: TaskContract[], readonly options: { fail?: string; dependency?: boolean; slow?: boolean; fallback?: boolean; scope?: boolean } = {}) {}
  async healthCheck() { return { ok: true, message: 'fixture', latencyMs: 0 } }
  async listModels() { return ['fixture-primary', 'fixture-backup'] }
  async stream() { throw new Error('Not used') }
  async complete(input: ProviderCompletionInput): Promise<ProviderCompletion> {
    input.signal.throwIfAborted()
    if (this.options.fallback && input.connection.model === 'fixture-primary') throw new ProviderFailure('Fixture outage', 'unavailable', true)
    const system = String(input.messages[0]?.content), user = JSON.parse(String(input.messages.find(m => m.role === 'user')?.content)) as { task?: TaskContract; requester?: string; change?: string }
    if (system.includes('independent ALTREX')) return { content: JSON.stringify({ passed: true, summary: 'Fixture reviewer accepted actual supplied source and command evidence.' }), toolCalls: [] }
    if (system.includes('Revise this plan')) return { content: JSON.stringify({ spec: { ...spec, designRules: ['Red navbar'] }, tasks: this.tasks.map(t => t.id === 'ui' ? { ...t, description: 'Implement red UI' } : t), affectedTaskIds: ['ui'] }), toolCalls: [] }
    if (system.includes('Create one integration repair task')) return { content: JSON.stringify({ task: task('repair', [], 'ui.js') }), toolCalls: [] }
    if (user.requester) return { content: JSON.stringify({ task: task('backend') }), toolCalls: [] }
    if (!user.task) return { content: JSON.stringify({ spec, tasks: this.tasks }), toolCalls: [] }
    const contract = user.task
    if (contract.id === this.options.fail) throw new Error('Fixture worker failed')
    if (this.options.dependency && !contract.dependencies.includes('backend') && contract.id === 'ui') return { content: '', toolCalls: [{ id: 'dependency', name: 'request_dependency', arguments: JSON.stringify({ description: 'Need backend API', requiredInterface: 'getTodos()' }) }] }
    if (input.messages.some(m => m.role === 'tool')) return { content: `Implemented ${contract.title}`, toolCalls: [] }
    this.active++; this.maximum = Math.max(this.maximum, this.active)
    try { await abortableDelay(this.options.slow ? 200 : 20, input.signal) } finally { this.active-- }
    return { content: '', toolCalls: [{ id: `write-${contract.id}`, name: 'write_file', arguments: JSON.stringify({ path: this.options.scope ? 'unowned.js' : contract.allowedFiles[0], content: `module.exports = () => '${contract.description.includes('red') ? 'red' : contract.id}';\n` }) }] }
  }
}
function fixture(tasks = [task('ui'), task('backend')], options: ConstructorParameters<typeof FixtureProvider>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-director-')); roots.push(root)
  const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'README.md'), 'Fixture source repository')
  const store = new RunStore(join(root, 'runs')), provider = new FixtureProvider(tasks, options), registry = new ModelRegistry(join(store.root, 'models.json'))
  const router = new RoleRouter(provider, ['fixture-primary', 'fixture-backup'].map(model => ({ providerId: 'custom', apiKey: 'fixture-key', baseUrl: 'http://localhost', model })), registry)
  const controller = new AbortController(), events: ProjectRun[] = []
  const check = async (workspace: string, signal: AbortSignal) => {
    const files = Object.keys(snapshot(workspace)).filter(path => path.endsWith('.js')), results = []
    for (const file of files) results.push(await runProjectCommand({ projectRoot: workspace, command: 'node', args: ['--check', file], timeoutMs: 10000, signal }))
    return results
  }
  const director = new Director(store, router, controller.signal, run => events.push(run), { id: 'fixture-run-1', projectPath: project, request: 'Build a small todo module pair' }, check)
  return { root, project, store, provider, registry, router, controller, events, director, check }
}
describe('real Director orchestration with deterministic provider fixtures', () => {
  it('runs independent workers concurrently, verifies actual files, and publishes only after QA', async () => {
    const f = fixture(), run = await f.director.execute()
    expect(run.status, run.error ?? '').toBe('COMPLETED'); expect(f.provider.maximum).toBe(2)
    expect(run.tasks.every(t => t.verification?.passed && t.verification.commands.every(c => c.exitCode === 0))).toBe(true)
    expect(readFileSync(join(f.project, 'ui.js'), 'utf8')).toContain("'ui'")
    expect(run.finalVerification?.commands).toHaveLength(2)
    expect(f.store.load(run.id)?.status).toBe('COMPLETED')
    expect(f.store.memory(f.project)).toContain('UI consumes backend')
  })
  it('serializes shared-file owners and enforces dependency order', async () => {
    const f = fixture([task('ui', [], 'shared.js'), task('backend', [], 'shared.js'), task('tests', ['backend'])])
    const run = await f.director.execute(); expect(run.status, run.error ?? '').toBe('COMPLETED')
    expect(f.events.every(run => run.tasks.filter(t => t.status === 'RUNNING' && t.allowedFiles.includes('shared.js')).length <= 1)).toBe(true)
    expect(f.events.filter(run => run.tasks.some(t => t.id === 'tests' && t.status === 'RUNNING')).every(run => run.tasks.find(t => t.id === 'backend')?.status === 'COMPLETED')).toBe(true)
  })
  it('defers whole-project commands until dependent worker outputs are integrated', async () => {
    const f = fixture([task('ui'), task('backend', ['ui'])]); let checks = 0
    const check = async (root: string) => { checks++; const ready = existsSync(join(root, 'ui.js')) && existsSync(join(root, 'backend.js')); return [{ command: 'integrated acceptance', exitCode: ready ? 0 : 1, output: ready ? 'pass' : 'dependent output missing' }] }
    const run = await new Director(f.store, f.router, f.controller.signal, () => {}, { id: 'deferred-checks', projectPath: f.project, request: 'Build dependent modules' }, check).execute()
    expect(run.status, run.error ?? '').toBe('COMPLETED')
    expect(checks).toBe(2)
    expect(run.tasks[0]?.verification?.commands).toHaveLength(0)
    expect(run.tasks[1]?.verification?.commands).toHaveLength(1)
  })
  it('routes a missing dependency through Director and schedules it before retrying its requester', async () => {
    const f = fixture([task('ui')], { dependency: true }), run = await f.director.execute()
    expect(run.status, run.error ?? '').toBe('COMPLETED'); expect(run.tasks).toHaveLength(2)
    expect(run.tasks[0]?.dependencies).toEqual(['backend']); expect(run.activity.join(' ')).toContain('Director assigned dependency backend')
  })
  it('isolates failures, retains successful independent work, and supports explicit restart', async () => {
    const f = fixture(undefined, { fail: 'ui' }), run = await f.director.execute()
    expect(run.status).toBe('FAILED'); expect(run.tasks.find(t => t.id === 'backend')?.status).toBe('COMPLETED')
    expect(existsSync(join(f.project, 'backend.js'))).toBe(false)
    const provider = new FixtureProvider([task('ui'), task('backend')]), router = new RoleRouter(provider, f.router.connections, f.registry)
    const restarted = await new Director(f.store, router, f.controller.signal, () => {}, { id: 'fixture-run-2', projectPath: f.project, request: run.request }, f.check).execute(run.id)
    expect(restarted.status, restarted.error ?? '').toBe('COMPLETED'); expect(restarted.tasks.find(t => t.id === 'backend')?.attempt).toBe(1)
  })
  it('records an actual configured-model fallback', async () => {
    const f = fixture(undefined, { fallback: true }), run = await f.director.execute()
    expect(run.status, run.error ?? '').toBe('COMPLETED'); expect(run.activity.join(' ')).toContain('Switching to custom / fixture-backup')
  })
  it('rejects unauthorized worker edits', async () => {
    const f = fixture([task('ui')], { scope: true }), run = await f.director.execute()
    expect(run.tasks[0]?.error).toContain('SCOPE VIOLATION'); expect(existsSync(join(f.project, 'unowned.js'))).toBe(false)
    const broker = new ProjectToolBroker(f.project, f.controller.signal, task('ui'))
    expect((await broker.execute({ id: 'cmd', name: 'run_command', arguments: '{"command":"node","args":["file.js"]}' })).content).toContain('outside the worker file scope')
    expect(() => ownsFile(task('ui'), '../escape')).toThrow()
  })
  it('cancels every active worker and leaves no running or queued tasks', async () => {
    const f = fixture(undefined, { slow: true }), pending = f.director.execute()
    while (!f.provider.active) await new Promise(resolve => setTimeout(resolve, 5))
    f.controller.abort(); const run = await pending
    expect(run.status).toBe('CANCELLED'); expect(f.provider.active).toBe(0)
    expect(run.tasks.every(t => !['RUNNING', 'WAITING', 'QUEUED', 'VERIFYING'].includes(t.status))).toBe(true)
  })
  it('revises affected work while unrelated work is retained', async () => {
    const f = fixture(undefined, { slow: true }), pending = f.director.execute()
    while (!f.provider.active) await new Promise(resolve => setTimeout(resolve, 5))
    f.director.revise('Make UI red'); const run = await pending
    expect(run.status, run.error ?? '').toBe('COMPLETED'); expect(readFileSync(join(f.project, 'ui.js'), 'utf8')).toContain("'red'")
    expect(run.tasks.find(t => t.id === 'backend')?.attempt).toBe(1); expect(run.revisions).toEqual(['Make UI red'])
  })
  it('protects concurrent user edits and detects cyclic plans', () => {
    const f = fixture(), base = copyWorkspace(f.project, join(f.root, 'stage'))
    writeFileSync(join(f.root, 'stage', 'README.md'), 'worker edit'); writeFileSync(join(f.project, 'README.md'), 'user edit')
    expect(() => publishWorkspace(join(f.root, 'stage'), f.project, base, f.root)).toThrow('Your file changed')
    expect(readFileSync(join(f.project, 'README.md'), 'utf8')).toBe('user edit')
    expect(() => validateGraph([task('a', ['b']), task('b', ['a'])])).toThrow('cycle')
  })
  it('marks crash-interrupted runs without launching workers', () => {
    const f = fixture(); f.store.save(f.director.run); f.store.recover()
    expect(f.store.load('fixture-run-1')?.status).toBe('INTERRUPTED'); expect(f.provider.active).toBe(0)
  })
  it('uses a Director repair task when final QA fails', async () => {
    const f = fixture(); let finalRejected = false
    const check = async (root: string, signal: AbortSignal) => { if (!root.includes('workers') && !finalRejected) { finalRejected = true; return [{ command: 'final integration assertion', exitCode: 1, output: 'UI export needs correction' }] } return f.check(root, signal) }
    const director = new Director(f.store, f.router, f.controller.signal, () => {}, { id: 'fixture-repair', projectPath: f.project, request: 'Implement modules' }, check)
    const run = await director.execute()
    expect(run.status, run.error ?? '').toBe('COMPLETED'); expect(run.tasks.find(t => t.id === 'repair')?.status).toBe('COMPLETED')
    expect(run.activity.join(' ')).toContain('bounded integration repair')
  })
})
