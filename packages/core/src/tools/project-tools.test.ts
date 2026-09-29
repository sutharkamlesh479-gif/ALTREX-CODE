import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalBroker, type ApprovalRequest } from '../security/approvals'
import { applyUnifiedPatch, PatchError } from './patch'
import { ProjectToolBroker, type ToolEvent, type ProjectToolOptions } from './project-tools'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'altrex-tools-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  return root
}
let calls = 0
const call = (name: string, args: Record<string, unknown>) => ({ id: `call-${++calls}`, name, arguments: JSON.stringify(args) })
function broker(root: string, options: ProjectToolOptions = {}) {
  const events: ToolEvent[] = []
  const tools = new ProjectToolBroker(root, new AbortController().signal, undefined, { ...options, onEvent: event => events.push(event) })
  return { tools, events }
}

describe('ProjectToolBroker files', () => {
  it('refuses to overwrite a file that changed outside the task since it was read (STALE)', async () => {
    const root = project({ 'a.ts': 'one\n' })
    const { tools } = broker(root)
    await tools.execute(call('read_file', { path: 'a.ts' }))
    writeFileSync(join(root, 'a.ts'), 'user edit\n')
    const result = await tools.execute(call('edit_file', { path: 'a.ts', old_text: 'user edit', new_text: 'agent' }))
    expect(result.content).toMatch(/^ERROR: STALE/)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('user edit\n')
    await tools.execute(call('read_file', { path: 'a.ts' }))
    expect((await tools.execute(call('edit_file', { path: 'a.ts', old_text: 'user edit', new_text: 'agent' }))).changedFile).toBe('a.ts')
  })

  it('keeps CRLF files consistent when the model edits with LF', async () => {
    const root = project({ 'w.txt': 'a\r\nb\r\nc\r\n' })
    const { tools } = broker(root)
    const result = await tools.execute(call('edit_file', { path: 'w.txt', old_text: 'a\nb', new_text: 'x\ny' }))
    expect(result.changedFile).toBe('w.txt')
    expect(readFileSync(join(root, 'w.txt'), 'utf8')).toBe('x\r\ny\r\nc\r\n')
  })

  it('applies unified patches atomically and reports mismatches without changing the file', async () => {
    const root = project({ 'm.ts': 'const a = 1\nconst b = 2\nconst c = 3\n' })
    const { tools } = broker(root)
    const ok = await tools.execute(call('apply_patch', { path: 'm.ts', patch: '@@ -2,1 +2,1 @@\n-const b = 2\n+const b = 20\n' }))
    expect(ok.changedFile).toBe('m.ts')
    expect(readFileSync(join(root, 'm.ts'), 'utf8')).toBe('const a = 1\nconst b = 20\nconst c = 3\n')
    const bad = await tools.execute(call('apply_patch', { path: 'm.ts', patch: '@@ -1,1 +1,1 @@\n-const a = 1\n+const a = 10\n@@ -3,1 +3,1 @@\n-const z = 9\n+const z = 0\n' }))
    expect(bad.content).toMatch(/Hunk 2 .* does not match/)
    expect(readFileSync(join(root, 'm.ts'), 'utf8')).toContain('const a = 1\n')
  })

  it('deletes and moves files, removing directories they leave empty', async () => {
    const root = project({ 'src/deep/x.ts': 'x', 'src/keep.ts': 'k', 'old/y.ts': 'y' })
    const { tools } = broker(root)
    expect((await tools.execute(call('delete_file', { path: 'src/deep/x.ts' }))).changedFile).toBe('src/deep/x.ts')
    expect(existsSync(join(root, 'src/deep'))).toBe(false)
    expect(existsSync(join(root, 'src/keep.ts'))).toBe(true)
    const moved = await tools.execute(call('move_file', { from: 'old/y.ts', to: 'new/y.ts' }))
    expect(moved.changedFiles).toEqual(['old/y.ts', 'new/y.ts'])
    expect(existsSync(join(root, 'old'))).toBe(false)
    expect((await tools.execute(call('move_file', { from: 'src/keep.ts', to: 'new/y.ts' }))).content).toMatch(/Destination already exists/)
  })

  it('blocks traversal and protected files for every file tool', async () => {
    const root = project({ '.env': 'SECRET=1', 'a.ts': 'a' })
    const { tools } = broker(root)
    for (const request of [call('read_file', { path: '../x' }), call('read_file', { path: '.env' }), call('delete_file', { path: '.env' }), call('move_file', { from: 'a.ts', to: '../a.ts' }), call('write_file', { path: '.env.local', content: 'x' })]) {
      expect((await tools.execute(request)).content).toMatch(/^ERROR:/)
    }
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('SECRET=1')
  })

  it('lists recursively with a glob and searches file content', async () => {
    const root = project({ 'src/a.ts': 'export function alpha() {}\n', 'src/b.js': 'alpha()\n', 'README.md': 'docs' })
    const { tools } = broker(root)
    const listed = await tools.execute(call('list_files', { path: '', recursive: true, glob: 'src/**/*.ts' }))
    expect(listed.content.split('\n')).toEqual(['src/a.ts'])
    expect((await tools.execute(call('search_files', { pattern: 'alpha' }))).content).toMatch(/src\/a\.ts:1:/)
    expect((await tools.execute(call('find_symbol', { name: 'alpha' }))).content).toMatch(/Definitions:\nsrc\/a\.ts:1 function/)
  })

  it('read_only projects cannot be modified', async () => {
    const root = project({ 'a.ts': 'a' })
    const { tools, events } = broker(root, { profile: 'read_only' })
    expect((await tools.execute(call('write_file', { path: 'a.ts', content: 'b' }))).content).toMatch(/Not allowed: .*read-only/)
    expect((await tools.execute(call('delete_file', { path: 'a.ts' }))).content).toMatch(/Not allowed/)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('a')
    expect(events.map(event => event.type)).toEqual(['tool.denied', 'tool.denied'])
  })
})

describe('ProjectToolBroker commands and policy', () => {
  it('runs allowed commands with command.started/output/completed events', async () => {
    const root = project({ 'hello.js': 'console.log("hi from script")' })
    const { tools, events } = broker(root)
    const result = await tools.execute(call('run_command', { command: 'node', args: ['hello.js'] }))
    expect(result.content).toMatch(/exited with code 0/)
    expect(result.content).toContain('hi from script')
    const types = events.map(event => event.type)
    expect(types[0]).toBe('command.started')
    expect(types.at(-1)).toBe('command.completed')
    expect(events.some(event => event.type === 'command.output' && event.text.includes('hi from script'))).toBe(true)
    const completed = events.at(-1) as Extract<ToolEvent, { type: 'command.completed' }>
    expect(completed.exitCode).toBe(0)
    expect(completed.commandId).toBe((events[0] as Extract<ToolEvent, { type: 'command.started' }>).commandId)
  })

  it('never runs FORBIDDEN commands, in any profile', async () => {
    const root = project()
    for (const profile of ['standard', 'autonomous'] as const) {
      const { tools, events } = broker(root, { profile })
      for (const [command, args] of [['git', ['push', 'origin', 'main']], ['bash', ['-c', 'ls']], ['npm', ['publish']], ['node', ['-e', 'process.exit(0)']]] as const) {
        const result = await tools.execute(call('run_command', { command, args }))
        expect(result.content).toMatch(/Command is not allowed \(FORBIDDEN\)/)
      }
      expect(events.every(event => event.type === 'tool.denied')).toBe(true)
    }
  })

  it('denies HIGH commands with an explanation when no approval UI is connected (never silently approved)', async () => {
    const root = project()
    const approvals = new ApprovalBroker()
    const { tools, events } = broker(root, { approvals, taskId: 'task-1' })
    const result = await tools.execute(call('run_command', { command: 'npx', args: ['cowsay', 'hi'] }))
    expect(result.content).toMatch(/Command not approved \(HIGH/)
    expect(result.content).toMatch(/no approval UI is connected/)
    expect(events).toEqual([expect.objectContaining({ type: 'tool.denied', risk: 'HIGH' })])
  })

  it('waits for the user on HIGH commands, and a task-scoped approval covers repeats in the same task only', async () => {
    const root = project()
    const required: ApprovalRequest[] = []
    const approvals = new ApprovalBroker({ onRequired: request => required.push(request) })
    approvals.setInteractive(true)
    const { tools } = broker(root, { approvals, taskId: 'task-1' })
    // An unknown executable is HIGH: the classifier cannot vouch for it.
    const pending = tools.execute(call('run_command', { command: 'definitely-not-a-real-tool-xyz', args: [] }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(required).toHaveLength(1)
    expect(required[0]).toMatchObject({ taskId: 'task-1', tool: 'run_command', risk: 'HIGH' })
    expect(approvals.list()).toHaveLength(1)
    expect(approvals.respond(required[0]!.approvalId, 'approve', 'task')).toBe(true)
    expect(approvals.respond(required[0]!.approvalId, 'approve', 'task')).toBe(false) // replay-safe
    const first = await pending
    expect(first.content).not.toMatch(/not approved/) // it ran (and failed to spawn), it was not denied
    await tools.execute(call('run_command', { command: 'definitely-not-a-real-tool-xyz', args: [] }))
    expect(required).toHaveLength(1) // covered by the task grant
    approvals.endTask('task-1')
    const again = tools.execute(call('run_command', { command: 'definitely-not-a-real-tool-xyz', args: [] }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(required).toHaveLength(2)
    approvals.respond(required[1]!.approvalId, 'deny')
    expect((await again).content).toMatch(/Command not approved .* Denied by the user/)
  })

  it('autonomous projects run HIGH commands without asking', async () => {
    const root = project()
    const approvals = new ApprovalBroker({ onRequired: () => { throw new Error('should not ask') } })
    const { tools, events } = broker(root, { approvals, profile: 'autonomous' })
    const result = await tools.execute(call('run_command', { command: 'definitely-not-a-real-tool-xyz', args: [] }))
    expect(result.content).not.toMatch(/not approved|not allowed/)
    expect(events.some(event => event.type === 'tool.denied')).toBe(false)
  })

  it('cancelling the task denies a pending approval', async () => {
    const root = project()
    const approvals = new ApprovalBroker(); approvals.setInteractive(true)
    const controller = new AbortController()
    const tools = new ProjectToolBroker(root, controller.signal, undefined, { approvals, taskId: 't' })
    const pending = tools.execute(call('run_command', { command: 'definitely-not-a-real-tool-xyz', args: [] }))
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    expect((await pending).content).toMatch(/The task was cancelled/)
    expect(approvals.list()).toEqual([])
  })
})

describe('applyUnifiedPatch', () => {
  it('tolerates stale line numbers, keeps CRLF, and supports multiple hunks', () => {
    const original = 'a\r\nb\r\nc\r\nd\r\ne\r\n'
    expect(applyUnifiedPatch(original, '--- a/f\n+++ b/f\n@@ -40,2 +40,2 @@\n b\n-c\n+C\n@@ -4,1 +4,2 @@\n d\n+d2\n')).toBe('a\r\nb\r\nC\r\nd\r\nd2\r\ne\r\n')
  })
  it('rejects patches with no hunks or unrecognized lines', () => {
    expect(() => applyUnifiedPatch('x\n', 'just text')).toThrow(PatchError)
    expect(() => applyUnifiedPatch('x\n', '@@ -1 +1 @@\n*x\n')).toThrow(/Unrecognized patch line/)
  })
})
