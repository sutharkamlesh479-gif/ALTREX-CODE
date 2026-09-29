import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { CheckpointError, CheckpointStore } from './checkpoints'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function fixture(files: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), 'altrex-checkpoints-'))
  roots.push(base)
  const project = join(base, 'project'), store = join(base, 'store')
  for (const [path, content] of Object.entries(files)) write(project, path, content)
  return { project, store }
}
function write(project: string, path: string, content: string) {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), content)
}
const read = (project: string, path: string) => readFileSync(join(project, path), 'utf8')

describe('CheckpointStore', () => {
  it('captures project source but never ignored directories or protected files', async () => {
    const { project, store } = fixture({
      'src/a.ts': 'a', 'README.md': 'readme', '.env': 'SECRET=1', 'config/credentials.json': '{}', 'keys/id.pem': 'k',
      'node_modules/pkg/index.js': 'dep', '.git/HEAD': 'ref', 'dist/out.js': 'built',
    })
    const checkpoints = new CheckpointStore(store)
    const summary = await checkpoints.create({ projectPath: project, taskId: 'task-1', label: 'Before task' })
    expect(summary).toMatchObject({ taskId: 'task-1', kind: 'snapshot', fileCount: 2, totalBytes: 7, finalizedAt: null, changedByTask: null })
    expect(await checkpoints.list(project)).toEqual([summary])
  })

  it('reverts exactly the task changes: modified, created and deleted files', async () => {
    const { project, store } = fixture({ 'src/a.ts': 'original a', 'src/b.ts': 'original b', 'src/untouched.ts': 'same' })
    const checkpoints = new CheckpointStore(store)
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 'task-1', label: 'Before task' })

    write(project, 'src/a.ts', 'agent rewrote a')
    write(project, 'src/new.ts', 'agent created this')
    rmSync(join(project, 'src/b.ts'))
    const finalized = await checkpoints.finalize(checkpoint.checkpointId)
    expect(finalized.changedByTask).toBe(3)

    expect(await checkpoints.plan(checkpoint.checkpointId)).toEqual({
      checkpointId: checkpoint.checkpointId, scope: 'task', restore: ['src/a.ts', 'src/b.ts'], delete: ['src/new.ts'], conflicts: [],
    })
    const result = await checkpoints.restore(checkpoint.checkpointId)
    expect(result).toMatchObject({ restored: ['src/a.ts', 'src/b.ts'], deleted: ['src/new.ts'], conflicts: [] })
    expect(read(project, 'src/a.ts')).toBe('original a')
    expect(read(project, 'src/b.ts')).toBe('original b')
    expect(existsSync(join(project, 'src/new.ts'))).toBe(false)
    expect(read(project, 'src/untouched.ts')).toBe('same')
  })

  it('takes a safety checkpoint so a restore can itself be undone', async () => {
    const { project, store } = fixture({ 'a.txt': 'before' })
    const checkpoints = new CheckpointStore(store)
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 't', label: 'Before task' })
    write(project, 'a.txt', 'after task')
    await checkpoints.finalize(checkpoint.checkpointId)
    const { safetyCheckpointId } = await checkpoints.restore(checkpoint.checkpointId)
    expect(read(project, 'a.txt')).toBe('before')

    await checkpoints.restore(safetyCheckpointId!, 'all')
    expect(read(project, 'a.txt')).toBe('after task')
  })

  it('never overwrites a file the user edited after the task finished', async () => {
    const { project, store } = fixture({ 'a.ts': 'original a', 'b.ts': 'original b' })
    const checkpoints = new CheckpointStore(store)
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 't', label: 'Before task' })
    write(project, 'a.ts', 'agent a'); write(project, 'b.ts', 'agent b')
    await checkpoints.finalize(checkpoint.checkpointId)
    write(project, 'a.ts', 'user kept editing a')

    const result = await checkpoints.restore(checkpoint.checkpointId)
    expect(result.conflicts).toEqual([{ path: 'a.ts', reason: 'modified-after-task' }])
    expect(result.restored).toEqual(['b.ts'])
    expect(read(project, 'a.ts')).toBe('user kept editing a')
    expect(read(project, 'b.ts')).toBe('original b')
  })

  it('does not touch protected or ignored files even when they changed', async () => {
    const { project, store } = fixture({ 'app.ts': 'v1', '.env': 'TOKEN=old', 'node_modules/x/index.js': 'old' })
    const checkpoints = new CheckpointStore(store)
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 't', label: 'Before task' })
    write(project, 'app.ts', 'v2'); write(project, '.env', 'TOKEN=new'); write(project, 'node_modules/x/index.js', 'new')
    await checkpoints.finalize(checkpoint.checkpointId)
    const result = await checkpoints.restore(checkpoint.checkpointId)
    expect(result.restored).toEqual(['app.ts'])
    expect(read(project, '.env')).toBe('TOKEN=new')
    expect(read(project, 'node_modules/x/index.js')).toBe('new')
  })

  it('requires an explicit "all" scope when the task never finalized (e.g. crash)', async () => {
    const { project, store } = fixture({ 'a.ts': 'original' })
    const checkpoints = new CheckpointStore(store)
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 't', label: 'Before task' })
    write(project, 'a.ts', 'half-written by interrupted task')
    await expect(checkpoints.plan(checkpoint.checkpointId, 'task')).rejects.toMatchObject({ code: 'NOT_FINALIZED' })
    await checkpoints.restore(checkpoint.checkpointId, 'all')
    expect(read(project, 'a.ts')).toBe('original')
  })

  it('refuses projects over the configured limits with a clear error', async () => {
    const { project, store } = fixture({ 'a.ts': '1', 'b.ts': '2', 'c.ts': '3' })
    const checkpoints = new CheckpointStore(store, { limits: { maxFiles: 2 } })
    await expect(checkpoints.create({ projectPath: project, taskId: null, label: 'x' })).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('prunes old checkpoints and their unreferenced content', async () => {
    const { project, store } = fixture({ 'a.txt': 'version 1' })
    const checkpoints = new CheckpointStore(store, { retention: 2 })
    await checkpoints.create({ projectPath: project, taskId: null, label: 'one' })
    write(project, 'a.txt', 'version 2'); await checkpoints.create({ projectPath: project, taskId: null, label: 'two' })
    write(project, 'a.txt', 'version 3'); await checkpoints.create({ projectPath: project, taskId: null, label: 'three' })
    expect((await checkpoints.list(project)).map(checkpoint => checkpoint.label)).toEqual(['three', 'two'])
    const [key] = readdirSync(store)
    const blobs = readdirSync(join(store, key!, 'objects')).flatMap(prefix => readdirSync(join(store, key!, 'objects', prefix)))
    expect(blobs).toHaveLength(2)
  })

  it('keeps the checkpoint being restored even when its safety checkpoint exceeds retention', async () => {
    const { project, store } = fixture({ 'a.txt': 'original' })
    const checkpoints = new CheckpointStore(store, { retention: 1 })
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 't', label: 'Before task' })
    write(project, 'a.txt', 'changed')
    await checkpoints.finalize(checkpoint.checkpointId)
    await checkpoints.restore(checkpoint.checkpointId)
    expect(read(project, 'a.txt')).toBe('original')
  })

  it('re-hashes files modified close to the previous scan even if size and mtime match', async () => {
    const { project, store } = fixture({ 'a.txt': 'aaaa' })
    const checkpoints = new CheckpointStore(store)
    const first = await checkpoints.create({ projectPath: project, taskId: null, label: 'first' })
    const { mtime } = statSync(join(project, 'a.txt'))
    write(project, 'a.txt', 'bbbb')
    utimesSync(join(project, 'a.txt'), mtime, mtime)
    const second = await checkpoints.create({ projectPath: project, taskId: null, label: 'second' })
    write(project, 'a.txt', 'cccc')
    await checkpoints.restore(second.checkpointId, 'all')
    expect(read(project, 'a.txt')).toBe('bbbb')
    await checkpoints.restore(first.checkpointId, 'all')
    expect(read(project, 'a.txt')).toBe('aaaa')
  })

  it('serializes concurrent operations on one project', async () => {
    const { project, store } = fixture({ 'a.txt': 'x' })
    const checkpoints = new CheckpointStore(store)
    const results = await Promise.all([1, 2, 3].map(index => checkpoints.create({ projectPath: project, taskId: null, label: `c${index}` })))
    expect(new Set(results.map(result => result.checkpointId)).size).toBe(3)
    expect(await checkpoints.list(project)).toHaveLength(3)
  })

  it('rejects malformed and unknown checkpoint IDs without touching the filesystem', async () => {
    const { store } = fixture({})
    const checkpoints = new CheckpointStore(store)
    await expect(checkpoints.restore('../../escape')).rejects.toBeInstanceOf(CheckpointError)
    await expect(checkpoints.get('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('removes directories a task created when their files are restored away', async () => {
    const { project, store } = fixture({ 'src/a.ts': 'a' })
    const checkpoints = new CheckpointStore(store)
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 't', label: 'Before task' })
    write(project, 'src/feature/deep/new.ts', 'n'); write(project, 'docs/guide.md', 'g')
    await checkpoints.finalize(checkpoint.checkpointId)
    const result = await checkpoints.restore(checkpoint.checkpointId)
    expect(result.deleted.sort()).toEqual(['docs/guide.md', 'src/feature/deep/new.ts'])
    expect(existsSync(join(project, 'src/feature'))).toBe(false)
    expect(existsSync(join(project, 'docs'))).toBe(false)
    expect(existsSync(join(project, 'src/a.ts'))).toBe(true)
  })

  it('falls back to Git-backed checkpoints for projects over the snapshot limits', async () => {
    const { project, store } = fixture({ 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n', '.env': 'SECRET=1' })
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const git = (...args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8', env })
    git('init', '-q', '-b', 'main'); writeFileSync(join(project, '.gitignore'), '.env\n'); git('add', '-A'); git('commit', '-q', '-m', 'init')
    write(project, 'b.txt', 'user uncommitted\n') // unrelated uncommitted work before the task
    const headBefore = git('rev-parse', 'HEAD').stdout.trim(), statusBefore = git('status', '--porcelain').stdout
    const checkpoints = new CheckpointStore(store, { limits: { maxFiles: 2 } })
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 't', label: 'Before task' })
    expect(checkpoint.kind).toBe('git')
    expect(git('rev-parse', 'HEAD').stdout.trim()).toBe(headBefore)
    expect(git('status', '--porcelain').stdout).toBe(statusBefore)

    write(project, 'a.txt', 'agent\n'); write(project, 'new/dir/x.txt', 'x'); rmSync(join(project, 'c.txt'))
    expect((await checkpoints.finalize(checkpoint.checkpointId)).changedByTask).toBe(3)
    const result = await checkpoints.restore(checkpoint.checkpointId)
    expect(result).toMatchObject({ restored: ['a.txt', 'c.txt'], deleted: ['new/dir/x.txt'], conflicts: [] })
    expect(read(project, 'a.txt')).toBe('one\n')
    expect(read(project, 'c.txt')).toBe('three\n')
    expect(read(project, 'b.txt')).toBe('user uncommitted\n')
    expect(read(project, '.env')).toBe('SECRET=1')
    expect(existsSync(join(project, 'new'))).toBe(false)
    expect(git('rev-parse', 'HEAD').stdout.trim()).toBe(headBefore)
    expect(git('for-each-ref', 'refs/altrex/').stdout).toContain(`refs/altrex/checkpoints/${checkpoint.checkpointId}`)
  }, 60_000) // real Git commands; slow under full-suite load

  it('explains that large non-Git projects cannot be checkpointed', async () => {
    const { project, store } = fixture({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' })
    await expect(new CheckpointStore(store, { limits: { maxFiles: 2 } }).create({ projectPath: project, taskId: null, label: 'x' })).rejects.toThrow(/not a Git repository/)
  })

  it('lists task changes and serves file versions for diffs without touching the project', async () => {
    const { project, store } = fixture({ 'src/a.ts': 'old a', 'src/gone.ts': 'bye', '.env': 'SECRET=1' })
    const checkpoints = new CheckpointStore(store)
    const checkpoint = await checkpoints.create({ projectPath: project, taskId: 't', label: 'Before task' })
    await expect(checkpoints.changes(checkpoint.checkpointId)).rejects.toMatchObject({ code: 'NOT_FINALIZED' })
    write(project, 'src/a.ts', 'new a'); write(project, 'src/new.ts', 'fresh'); rmSync(join(project, 'src/gone.ts'))
    await checkpoints.finalize(checkpoint.checkpointId)
    expect(await checkpoints.changes(checkpoint.checkpointId)).toEqual([
      { path: 'src/a.ts', change: 'modified' }, { path: 'src/gone.ts', change: 'deleted' }, { path: 'src/new.ts', change: 'added' },
    ])
    expect(await checkpoints.fileVersions(checkpoint.checkpointId, 'src/a.ts')).toEqual({ path: 'src/a.ts', before: 'old a', current: 'new a', binary: false, changedSinceTask: false })
    expect(await checkpoints.fileVersions(checkpoint.checkpointId, 'src/gone.ts')).toMatchObject({ before: 'bye', current: null })
    write(project, 'src/a.ts', 'user edit')
    expect(await checkpoints.fileVersions(checkpoint.checkpointId, 'src/a.ts')).toMatchObject({ current: 'user edit', changedSinceTask: true })
    await expect(checkpoints.fileVersions(checkpoint.checkpointId, '.env')).rejects.toThrow()
    await expect(checkpoints.fileVersions(checkpoint.checkpointId, '../outside.txt')).rejects.toThrow()
  })
})
