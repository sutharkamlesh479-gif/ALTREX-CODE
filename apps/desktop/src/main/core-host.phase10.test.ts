import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '@altrex/core/events/event-bus'
import { TaskManager } from '@altrex/core/orchestrator/task-manager'
import { RepositoryIntelligence } from '@altrex/core/repo/intelligence'
import { PermissionCenter } from '@altrex/core/security/permission-center'
import { CheckpointStore } from '@altrex/core/workspace/checkpoints'
import type { AltrexEvent } from '@altrex/contracts'
import { CoreHost } from './core-host'

// Phase 10: structured errors at the bridge and the remaining UI capabilities.

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function setup(options: { trusted?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-phase10-'))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node test.js', build: 'node fail.js' } }))
  writeFileSync(join(project, 'test.js'), 'console.log("# pass 2")')
  writeFileSync(join(project, 'fail.js'), 'console.error("Error: build broke"); process.exit(3)')
  writeFileSync(join(project, 'loop.js'), 'setInterval(() => {}, 1000)')
  const events = new EventBus(), published: AltrexEvent[] = []
  events.subscribe(event => published.push(event))
  const tasks = new TaskManager(events)
  const permissions = new PermissionCenter(null, events)
  const providers = { connect: vi.fn(async () => undefined), disconnect: vi.fn(), test: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined), openLink: vi.fn(async (providerId: string) => providerId !== 'ollama') }
  const host = new CoreHost({
    events, tasks, permissions, providers, checkpoints: new CheckpointStore(join(root, 'cp')),
    isProjectTrusted: () => options.trusted ?? true, isProjectBusy: () => false, repo: path => new RepositoryIntelligence(path),
    catalog: { providers: () => [], models: () => [] },
    projects: { open: async () => ({ name: 'project', path: project, branch: null, markers: ['package.json'] }), list: () => [{ name: 'project', path: project, branch: null, markers: ['package.json'] }] },
  })
  return { root, project, host, published, providers, tasks, permissions }
}

describe('structured command errors', () => {
  it('maps failures to contract error codes instead of raw exceptions', async () => {
    const { host, project } = setup({ trusted: false })
    expect(await host.handleResult('no.such.command', {})).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } })
    expect(await host.handleResult('task.get', { taskId: 42 })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', detail: expect.stringContaining('taskId') } })
    expect(await host.handleResult('task.get', { taskId: 'missing' })).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown task.', retryable: false } })
    expect(await host.handleResult('git.status', { projectPath: project })).toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_OPEN' } })
    expect(await host.handleResult('checkpoint.restore', { checkpointId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await host.handleResult('tool.list', {})).toMatchObject({ ok: true })
  })
})

describe('platform commands', () => {
  it('projects, sessions, tools and provider operations', async () => {
    const { host, project, providers, tasks } = setup()
    expect(await host.handle('project.open', {})).toMatchObject({ path: project })
    expect(await host.handle('project.list', {})).toHaveLength(1)
    const a = tasks.begin({ requestId: null, sessionId: 'session-aaaa', mode: 'ASK', intent: 'question', projectPath: project, title: 'First question', modelSelection: 'AUTO' })
    tasks.begin({ requestId: null, sessionId: 'session-aaaa', mode: 'ASK', intent: 'question', projectPath: project, title: 'Follow-up', modelSelection: 'AUTO' })
    expect(await host.handle('session.list', {})).toEqual([expect.objectContaining({ sessionId: 'session-aaaa', title: 'First question', taskCount: 2 })])
    expect((await host.handle('task.list', { sessionId: 'session-aaaa' }) as unknown[]).length).toBe(2)
    expect(a).toBeTruthy()
    const tools = await host.handle('tool.list', {}) as Array<{ name: string; risk: string }>
    expect(tools.find(tool => tool.name === 'run_command')?.risk).toBe('CLASSIFIED')
    expect(tools.find(tool => tool.name === 'read_file')?.risk).toBe('LOW')
    expect(tools.find(tool => tool.name === 'delete_file')?.risk).toBe('MEDIUM')
    await host.handle('provider.connect', { providerId: 'groq', apiKey: 'gsk_secret_value', model: 'm' })
    expect(providers.connect).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'groq', apiKey: 'gsk_secret_value', baseUrl: '' }))
    await host.handle('provider.disconnect', { providerId: 'groq' }); await host.handle('provider.test', {}); await host.handle('provider.refresh', {})
    expect(providers.disconnect).toHaveBeenCalledWith('groq')
    expect(providers.test).toHaveBeenCalled(); expect(providers.refresh).toHaveBeenCalled()
    expect(await host.handle('provider.openLink', { providerId: 'google', kind: 'apiKey' })).toEqual({ opened: true })
    expect(providers.openLink).toHaveBeenCalledWith('google', 'apiKey')
    expect(await host.handleResult('provider.openLink', { providerId: 'google', kind: 'https://evil.example' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('git status/diff for repositories', async () => {
    const { host, project } = setup()
    expect(await host.handle('git.status', { projectPath: project })).toEqual({ isRepository: false, branch: null, head: null, entries: [] })
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const git = (...args: string[]) => spawnSync('git', args, { cwd: project, env })
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'init')
    writeFileSync(join(project, 'test.js'), 'console.log("# pass 3")')
    expect(await host.handle('git.status', { projectPath: project })).toMatchObject({ isRepository: true, branch: 'main', entries: [expect.objectContaining({ path: 'test.js', worktree: 'M' })] })
    expect(await host.handle('git.diff', { projectPath: project })).toMatchObject({ diff: expect.stringContaining('+console.log("# pass 3")'), truncated: false })
  })

  it('discovers and runs the declared checks with test events (taskId null)', async () => {
    const { host, project, published } = setup()
    expect((await host.handle('checks.discover', { projectPath: project }) as Array<{ name: string }>).map(check => check.name)).toEqual(['test', 'build'])
    const evidence = await host.handle('checks.run', { projectPath: project }) as Array<{ name: string; status: string; exitCode: number | null; parsed?: unknown }>
    expect(evidence.map(item => [item.name, item.status, item.exitCode])).toEqual([['test', 'PASS', 0], ['build', 'FAIL', 3]])
    expect(evidence[0]!.parsed).toEqual({ passed: 2 })
    expect(published.filter(event => event.type === 'test.completed').every(event => event.taskId === null)).toBe(true)
  }, 60_000)

  it('runs user terminal commands with streamed events, refuses FORBIDDEN, and cancels', async () => {
    const { host, project, published, permissions } = setup()
    const result = await host.handle('terminal.run', { projectPath: project, command: 'node', args: ['test.js'] }) as { commandId: string; exitCode: number; output: string }
    expect(result).toMatchObject({ exitCode: 0, output: expect.stringContaining('# pass 2') })
    expect(published.filter(event => event.type.startsWith('command.')).map(event => event.type)).toEqual(expect.arrayContaining(['command.started', 'command.output', 'command.completed']))
    expect(await host.handleResult('terminal.run', { projectPath: project, command: 'git', args: ['push', 'origin', 'main'] })).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } })
    permissions.setProfile(project, 'read_only')
    expect(await host.handleResult('terminal.run', { projectPath: project, command: 'node', args: ['test.js'] })).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED', message: expect.stringContaining('read-only') } })
    permissions.setProfile(project, 'standard')
    const pending = host.handleResult('terminal.run', { projectPath: project, command: 'node', args: ['loop.js'] })
    await vi.waitFor(() => expect(published.some(event => event.type === 'command.started' && (event.payload as { command: string }).command === 'node loop.js')).toBe(true))
    const started = published.filter(event => event.type === 'command.started').at(-1)!.payload as { commandId: string }
    expect(await host.handle('terminal.cancel', { commandId: started.commandId })).toEqual({ cancelled: true })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
  }, 60_000)
})
