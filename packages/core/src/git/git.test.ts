import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addWorktree, blobAt, changedBetween, diff, isRepository, pinRef, removeWorktree, snapshotCommit, status } from './git'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
const sh = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'altrex-git-'))
  roots.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  writeFileSync(join(root, '.gitignore'), 'build/\n')
  sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', 'init')
  return root
}

describe('git operations', () => {
  it('detects repositories and reports status including untracked files', () => {
    const root = repository()
    expect(isRepository(root)).toBe(true)
    writeFileSync(join(root, 'a.txt'), 'two\n'); writeFileSync(join(root, 'new.txt'), 'x')
    const state = status(root)
    expect(state.branch).toBe('main')
    expect(state.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'a.txt', worktree: 'M' }), expect.objectContaining({ path: 'new.txt', untracked: true })]))
    expect(diff(root, { path: 'a.txt' })).toContain('+two')
    const plain = mkdtempSync(join(tmpdir(), 'altrex-plain-')); roots.push(plain)
    expect(isRepository(plain)).toBe(false)
  })

  it('snapshots the working tree without touching the user index, HEAD or branch, and never includes secrets', () => {
    const root = repository()
    writeFileSync(join(root, 'a.txt'), 'changed\n'); writeFileSync(join(root, 'untracked.txt'), 'u'); writeFileSync(join(root, '.env'), 'TOKEN=secret')
    mkdirSync(join(root, 'build')); writeFileSync(join(root, 'build', 'out.js'), 'ignored')
    sh(root, 'add', 'untracked.txt') // user staged something: must stay staged exactly as is
    const before = status(root)
    const commit = snapshotCommit(root, 'altrex test snapshot')
    expect(status(root)).toEqual(before)
    expect(blobAt(root, commit, 'a.txt')?.toString()).toBe('changed\n')
    expect(blobAt(root, commit, 'untracked.txt')?.toString()).toBe('u')
    expect(blobAt(root, commit, '.env')).toBeNull()
    expect(blobAt(root, commit, 'build/out.js')).toBeNull()
    expect(sh(root, 'log', '--oneline').stdout.trim().split('\n')).toHaveLength(1)
  })

  it('lists paths changed between snapshots and keeps snapshots reachable under refs/altrex', () => {
    const root = repository()
    const first = snapshotCommit(root, 'one')
    writeFileSync(join(root, 'a.txt'), 'three\n'); writeFileSync(join(root, 'b.txt'), 'b')
    const second = snapshotCommit(root, 'two')
    expect(changedBetween(root, first, second).sort()).toEqual(['a.txt', 'b.txt'])
    pinRef(root, 'checkpoints/test', second)
    expect(sh(root, 'rev-parse', 'refs/altrex/checkpoints/test').stdout.trim()).toBe(second)
    expect(() => pinRef(root, '../escape', second)).toThrow()
  })

  it('creates and removes isolated worktrees from a snapshot', () => {
    const root = repository()
    writeFileSync(join(root, 'a.txt'), 'uncommitted work\n')
    const commit = snapshotCommit(root, 'lease')
    const tree = join(mkdtempSync(join(tmpdir(), 'altrex-wt-')), 'work'); roots.push(join(tree, '..'))
    addWorktree(root, tree, commit)
    expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('uncommitted work\n')
    writeFileSync(join(tree, 'a.txt'), 'isolated edit\n')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('uncommitted work\n')
    removeWorktree(root, tree)
    expect(existsSync(tree)).toBe(false)
  })
})
