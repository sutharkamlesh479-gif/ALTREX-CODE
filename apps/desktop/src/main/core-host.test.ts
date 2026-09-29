import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '@altrex/core/events/event-bus'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import type { AltrexEvent } from '@altrex/contracts'
import { CoreHost } from './core-host'
import { RepositoryIntelligence } from '@altrex/core/repo/intelligence'
import { parseCommandResponse } from '@altrex/contracts'
import { PermissionCenter } from '@altrex/core/security/permission-center'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function setup(options: { trusted?: boolean; busy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-core-host-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'a.txt'), 'original')
  const events = new EventBus(), checkpoints = new CheckpointStore(join(root, 'store')), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const state = { busy: options.busy ?? false }
  const host = new CoreHost({ events, checkpoints, isProjectTrusted: () => options.trusted ?? true, isProjectBusy: () => state.busy })
  return { host, project, checkpoints, events, published, state }
}

async function checkpointWithTaskChange(checkpoints: CheckpointStore, project: string) {
  const checkpoint = await checkpoints.create({ projectPath: project, taskId: 'task-1', label: 'Before task' })
  writeFileSync(join(project, 'a.txt'), 'agent change')
  await checkpoints.finalize(checkpoint.checkpointId)
  return checkpoint
}

describe('CoreHost command boundary', () => {
  it('rejects unknown command names and invalid requests before doing any work', async () => {
    const { host } = setup()
    await expect(host.handle('fs.delete', {})).rejects.toThrow('Unknown ALTREX core command')
    await expect(host.handle('__proto__', {})).rejects.toThrow('Unknown ALTREX core command')
    await expect(host.handle('events.replay', { afterSeq: -1 })).rejects.toThrow()
    await expect(host.handle('checkpoint.restore', { checkpointId: '../../x' })).rejects.toThrow()
  })

  it('replays events for reconnecting clients', async () => {
    const { host, events } = setup()
    events.publish('task.cancelled', {}, 'task-1')
    events.publish('task.cancelled', {}, 'task-2')
    expect(await host.handle('events.replay', { afterSeq: 1 })).toMatchObject({ streamId: events.streamId, latestSeq: 2, gap: false, events: [{ seq: 2, taskId: 'task-2' }] })
  })

  it('lists, previews and restores checkpoints, publishing checkpoint.restored', async () => {
    const { host, project, checkpoints, published } = setup()
    const checkpoint = await checkpointWithTaskChange(checkpoints, project)
    expect(await host.handle('checkpoint.list', { projectPath: project })).toMatchObject([{ checkpointId: checkpoint.checkpointId, changedByTask: 1 }])
    expect(await host.handle('checkpoint.preview', { checkpointId: checkpoint.checkpointId })).toMatchObject({ scope: 'task', restore: ['a.txt'] })
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('agent change')

    const result = await host.handle('checkpoint.restore', { checkpointId: checkpoint.checkpointId })
    expect(result).toMatchObject({ restored: ['a.txt'], conflicts: [] })
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('original')
    expect(published.at(-1)).toMatchObject({ type: 'checkpoint.restored', taskId: 'task-1' })
  })

  it('refuses to restore while a task is running in the project', async () => {
    const { host, project, checkpoints, state } = setup()
    const checkpoint = await checkpointWithTaskChange(checkpoints, project)
    state.busy = true
    await expect(host.handle('checkpoint.restore', { checkpointId: checkpoint.checkpointId })).rejects.toThrow('A task is still running')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('agent change')
  })

  it('refuses checkpoint access for projects the user has not opened', async () => {
    const { host, project, checkpoints } = setup({ trusted: false })
    const checkpoint = await checkpointWithTaskChange(checkpoints, project)
    await expect(host.handle('checkpoint.list', { projectPath: project })).rejects.toThrow('Open the project')
    await expect(host.handle('checkpoint.restore', { checkpointId: checkpoint.checkpointId })).rejects.toThrow('Open the project')
  })
})

describe('CoreHost repository commands (Phase 5)', () => {
  function repoHost(trusted = true) {
    const root = mkdtempSync(join(tmpdir(), 'altrex-core-repo-'))
    roots.push(root)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '3' } }))
    writeFileSync(join(root, 'src', 'cart.ts'), 'export function cartTotal(items: number[]) {\n  return items.reduce((a, b) => a + b, 0)\n}\n')
    writeFileSync(join(root, 'src', 'cart.test.ts'), "import { cartTotal } from './cart'\n")
    writeFileSync(join(root, '.env'), 'TOKEN=secret')
    const host = new CoreHost({ events: new EventBus(), checkpoints: new CheckpointStore(join(root, '..', 'cp-' + Date.now())), isProjectTrusted: () => trusted, isProjectBusy: () => false, repo: path => new RepositoryIntelligence(path) })
    return { root, host }
  }

  it('serves profile, search, symbols, related files and a context preview for an opened project', async () => {
    const { root, host } = repoHost()
    expect(parseCommandResponse('repo.profile', await host.handle('repo.profile', { projectPath: root }))).toMatchObject({ testRunner: 'vitest', commands: [{ kind: 'test', argv: ['npm', 'run', 'test'] }] })
    const search = parseCommandResponse('repo.search', await host.handle('repo.search', { projectPath: root, pattern: 'cartTotal', word: true, caseSensitive: true }))
    expect(search.matches.map(match => match.path).sort()).toEqual(['src/cart.test.ts', 'src/cart.ts'])
    expect(parseCommandResponse('repo.symbols', await host.handle('repo.symbols', { projectPath: root, name: 'cartTotal' }))).toEqual([{ path: 'src/cart.ts', name: 'cartTotal', kind: 'function', line: 1, exported: true }])
    expect(parseCommandResponse('repo.related', await host.handle('repo.related', { projectPath: root, path: 'src/cart.ts' }))).toEqual({ imports: [], importers: ['src/cart.test.ts'], tests: ['src/cart.test.ts'] })
    const preview = parseCommandResponse('context.preview', await host.handle('context.preview', { projectPath: root, task: 'cartTotal returns the wrong value' }))
    expect(preview.items).toContainEqual(expect.objectContaining({ path: 'src/cart.ts', reason: expect.stringContaining('defines cartTotal') }))
    expect(JSON.stringify(await host.handle('repo.search', { projectPath: root, pattern: 'secret' }))).not.toContain('TOKEN')
  })

  it('refuses repository access to projects that were not opened', async () => {
    const { root, host } = repoHost(false)
    await expect(host.handle('repo.search', { projectPath: root, pattern: 'x' })).rejects.toThrow('Open the project')
  })
})

describe('CoreHost permission commands (Phase 6)', () => {
  function permissionHost(trusted = true) {
    const root = mkdtempSync(join(tmpdir(), 'altrex-perm-host-'))
    roots.push(root)
    const events = new EventBus(), published: AltrexEvent[] = []
    events.subscribe(event => published.push(event))
    const permissions = new PermissionCenter(join(root, 'permissions.json'), events)
    const host = new CoreHost({ events, checkpoints: new CheckpointStore(join(root, 'cp')), isProjectTrusted: () => trusted, isProjectBusy: () => false, permissions })
    return { root, host, permissions, published }
  }

  it('gets and sets project permission profiles, persisted across restarts', async () => {
    const { root, host } = permissionHost()
    expect(await host.handle('project.permissions', { projectPath: root })).toEqual({ projectPath: root, profile: 'standard' })
    expect(await host.handle('project.permissions', { projectPath: root, profile: 'read_only' })).toEqual({ projectPath: root, profile: 'read_only' })
    expect(new PermissionCenter(join(root, 'permissions.json')).profileFor(root)).toBe('read_only')
    await expect(host.handle('project.permissions', { projectPath: root, profile: 'root' })).rejects.toThrow()
  })

  it('refuses profile changes for projects that were not opened', async () => {
    const { root, host } = permissionHost(false)
    await expect(host.handle('project.permissions', { projectPath: root, profile: 'autonomous' })).rejects.toThrow('Open the project')
  })

  it('lists pending approvals and answers them once (replay-safe), with contract events', async () => {
    const { host, permissions, published } = permissionHost()
    expect(await host.handle('permission.configure', { interactive: true })).toEqual({ interactive: true })
    const outcome = permissions.approvals.request({ taskId: 'task-1', tool: 'run_command', summary: 'npx create-vite app', risk: 'HIGH', capability: 'package.execute', reason: 'npx downloads and executes code' })
    const pending = await host.handle('permission.pending', {}) as Array<{ approvalId: string }>
    expect(pending).toHaveLength(1)
    expect(await host.handle('permission.respond', { approvalId: pending[0]!.approvalId, decision: 'approve' })).toEqual({ accepted: true })
    expect(await host.handle('permission.respond', { approvalId: pending[0]!.approvalId, decision: 'deny' })).toEqual({ accepted: false })
    expect(await outcome).toMatchObject({ decision: 'approved', by: 'user', scope: 'once' })
    expect(published.map(event => event.type)).toEqual(['permission.required', 'permission.resolved'])
    expect(published[0]!.taskId).toBe('task-1')
  })

  it('denies immediately (never silently approves) when no approval UI is configured', async () => {
    const { permissions, published } = permissionHost()
    const outcome = await permissions.approvals.request({ taskId: 't', tool: 'run_command', summary: 'curl x', risk: 'HIGH', capability: 'network', reason: 'network access' })
    expect(outcome).toMatchObject({ decision: 'denied', by: 'policy' })
    expect(published.map(event => event.type)).toEqual(['permission.resolved'])
  })

  it('maps tool events to contract events, splitting long command output', () => {
    const { root, permissions, published } = permissionHost()
    const options = permissions.toolOptions('task-9', root)
    expect(options.profile).toBe('standard')
    options.onEvent!({ type: 'command.started', commandId: 'c', command: 'pnpm test' })
    options.onEvent!({ type: 'command.output', commandId: 'c', stream: 'stdout', text: 'x'.repeat(20_000) })
    options.onEvent!({ type: 'command.completed', commandId: 'c', command: 'pnpm test', exitCode: 1, timedOut: false, durationMs: 12.7 })
    options.onEvent!({ type: 'tool.denied', tool: 'run_command', summary: 'git push', risk: 'FORBIDDEN', reason: 'publishes' })
    expect(published.map(event => event.type)).toEqual(['command.started', 'command.output', 'command.output', 'command.output', 'command.completed', 'tool.denied'])
    expect(published.every(event => event.taskId === 'task-9')).toBe(true)
  })
})
