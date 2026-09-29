import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { status } from '../git/git'
import { acquireWorkspace, applyLease, leaseChanges, releaseWorkspace } from './lease'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env })

function setup(withGit: boolean) {
  const base = mkdtempSync(join(tmpdir(), 'altrex-lease-'))
  roots.push(base)
  const projectPath = join(base, 'project'), leasesRoot = join(base, 'leases')
  mkdirSync(join(projectPath, 'src'), { recursive: true })
  writeFileSync(join(projectPath, 'src', 'a.ts'), 'a1\n'); writeFileSync(join(projectPath, 'src', 'b.ts'), 'b1\n')
  if (withGit) { git(projectPath, 'init', '-q', '-b', 'main'); git(projectPath, 'add', '-A'); git(projectPath, 'commit', '-q', '-m', 'init') }
  return { projectPath, leasesRoot }
}

describe('workspace leases', () => {
  for (const withGit of [true, false]) {
    it(`isolates agent changes until applied (${withGit ? 'git worktree' : 'copy'})`, () => {
      const { projectPath, leasesRoot } = setup(withGit)
      writeFileSync(join(projectPath, 'src', 'a.ts'), 'a-uncommitted\n') // lease starts from the working tree
      const lease = acquireWorkspace({ projectPath, leasesRoot })
      expect(lease.kind).toBe(withGit ? 'worktree' : 'copy')
      expect(readFileSync(join(lease.path, 'src', 'a.ts'), 'utf8')).toBe('a-uncommitted\n')
      writeFileSync(join(lease.path, 'src', 'b.ts'), 'b-agent\n'); writeFileSync(join(lease.path, 'src', 'c.ts'), 'c\n')
      expect(readFileSync(join(projectPath, 'src', 'b.ts'), 'utf8')).toBe('b1\n')
      expect(leaseChanges(lease)).toEqual({ changed: ['src/b.ts', 'src/c.ts'], conflicts: [] })
      expect(applyLease(lease).sort()).toEqual(['src/b.ts', 'src/c.ts'])
      expect(readFileSync(join(projectPath, 'src', 'b.ts'), 'utf8')).toBe('b-agent\n')
      expect(readFileSync(join(projectPath, 'src', 'a.ts'), 'utf8')).toBe('a-uncommitted\n')
      if (withGit) expect(status(projectPath).branch).toBe('main')
      releaseWorkspace(lease, leasesRoot)
      expect(existsSync(lease.path)).toBe(false)
      if (withGit) expect(git(projectPath, 'worktree', 'list').stdout.trim().split('\n')).toHaveLength(1)
    })
  }

  it('refuses to apply over files the user changed meanwhile, applying nothing', () => {
    const { projectPath, leasesRoot } = setup(false)
    const lease = acquireWorkspace({ projectPath, leasesRoot })
    writeFileSync(join(lease.path, 'src', 'a.ts'), 'agent\n'); writeFileSync(join(lease.path, 'src', 'b.ts'), 'agent\n')
    writeFileSync(join(projectPath, 'src', 'a.ts'), 'user\n')
    expect(leaseChanges(lease).conflicts).toEqual(['src/a.ts'])
    expect(() => applyLease(lease)).toThrow(/Nothing was applied/)
    expect(readFileSync(join(projectPath, 'src', 'b.ts'), 'utf8')).toBe('b1\n')
    releaseWorkspace(lease, leasesRoot)
  })

  it('never removes paths outside the leases root', () => {
    const { projectPath, leasesRoot } = setup(false)
    const lease = acquireWorkspace({ projectPath, leasesRoot })
    expect(() => releaseWorkspace({ ...lease, path: projectPath }, leasesRoot)).toThrow(/outside the workspace leases directory/)
    expect(existsSync(join(projectPath, 'src', 'a.ts'))).toBe(true)
    releaseWorkspace(lease, leasesRoot)
  })
})
