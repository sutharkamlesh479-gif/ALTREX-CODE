import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safePath } from '../security/path-guard'

// Git operations for ALTREX (TOOL_SYSTEM.md §4–6). Everything uses argv arrays, no prompts, no pager.
// Snapshot commits are built with a temporary index, so the user's index, HEAD and branch are untouched.

const IDENTITY = { GIT_AUTHOR_NAME: 'ALTREX', GIT_AUTHOR_EMAIL: 'altrex@localhost', GIT_COMMITTER_NAME: 'ALTREX', GIT_COMMITTER_EMAIL: 'altrex@localhost' }
/** Never snapshot secrets into the object database. */
const PROTECTED_PATHSPECS = [':(exclude,glob)**/.env*', ':(exclude,glob)**/*secret*', ':(exclude,glob)**/*credential*', ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key', ':(exclude,glob)**/.altrex/**']

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) { super(message) }
}

function git(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; buffer?: boolean } = {}): SpawnSyncReturns<string | Buffer> {
  return spawnSync('git', ['-C', root, '-c', 'core.quotepath=off', '-c', 'core.autocrlf=false', ...args], {
    encoding: options.buffer ? 'buffer' : 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...options.env },
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
}
function run(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = git(root, args, env ? { env } : {})
  if (result.error || result.status !== 0) throw new GitError(`git ${args[0]} failed`, String(result.stderr ?? result.error?.message ?? '').slice(0, 2000))
  return String(result.stdout)
}

export function gitAvailable(): boolean {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0
}

export function isRepository(root: string): boolean {
  if (!existsSync(root)) return false
  const result = git(root, ['rev-parse', '--is-inside-work-tree'])
  return result.status === 0 && String(result.stdout).trim() === 'true'
}

export function repositoryRoot(root: string): string {
  return run(root, ['rev-parse', '--show-toplevel']).trim()
}

export type StatusEntry = { path: string; index: string; worktree: string; untracked: boolean }
export type GitStatus = { branch: string | null; head: string | null; entries: StatusEntry[]; clean: boolean }

export function status(root: string): GitStatus {
  const output = run(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])
  const parts = output.split('\0').filter(Boolean)
  let branch: string | null = null
  const entries: StatusEntry[] = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    if (part.startsWith('## ')) { branch = part.slice(3).split('...')[0]!.replace(/^No commits yet on /, '') || null; continue }
    const code = part.slice(0, 2), path = part.slice(3)
    if (code[0] === 'R' || code[0] === 'C') index++ // skip the rename source
    entries.push({ path, index: code[0]!, worktree: code[1]!, untracked: code === '??' })
  }
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  return { branch, head: head.status === 0 ? String(head.stdout).trim() : null, entries, clean: entries.length === 0 }
}

/** Unified diff of the working tree (optionally for one path) against HEAD or a given commit. */
export function diff(root: string, options: { base?: string; path?: string; stat?: boolean; maxBytes?: number } = {}): string {
  const args = ['diff', '--no-color', '--no-ext-diff', ...(options.stat ? ['--stat'] : []), options.base ?? 'HEAD']
  if (options.path) { safePath(options.path); args.push('--', options.path) }
  const result = git(root, args)
  if (result.status !== 0 && !String(result.stderr).includes('unknown revision')) throw new GitError('git diff failed', String(result.stderr).slice(0, 2000))
  return String(result.stdout).slice(0, options.maxBytes ?? 500_000)
}

/**
 * Commit the complete current working tree (tracked + untracked, respecting .gitignore, excluding protected
 * paths) without touching the user's index, HEAD or branch. Returns the commit id.
 */
export function snapshotCommit(root: string, message: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'altrex-index-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index'), ...IDENTITY }
    run(root, ['add', '-A', '--', '.', ...PROTECTED_PATHSPECS], env)
    const tree = run(root, ['write-tree'], env).trim()
    const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
    const parent = head.status === 0 ? ['-p', String(head.stdout).trim()] : []
    return run(root, ['commit-tree', tree, ...parent, '-m', message], env).trim()
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/** Tree id of the complete working tree (same inclusion rules as snapshotCommit), without writing a commit. */
export function workingTreeHash(root: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'altrex-index-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index'), ...IDENTITY }
    run(root, ['add', '-A', '--', '.', ...PROTECTED_PATHSPECS], env)
    return run(root, ['write-tree'], env).trim()
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/** Keep a snapshot reachable (and out of the user's branches) under refs/altrex/. */
export function pinRef(root: string, name: string, commit: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.includes('..')) throw new GitError('Invalid ALTREX ref name.', name)
  run(root, ['update-ref', `refs/altrex/${name}`, commit])
}
export function deleteRef(root: string, name: string): void {
  git(root, ['update-ref', '-d', `refs/altrex/${name}`])
}

/** Paths that differ between two commits (renames reported as delete + add). */
export function changedBetween(root: string, from: string, to: string): string[] {
  return run(root, ['diff', '--name-only', '--no-renames', '-z', from, to]).split('\0').filter(Boolean)
}

/** File content at a commit, or null if the path does not exist there. */
export function blobAt(root: string, commit: string, path: string): Buffer | null {
  const result = git(root, ['cat-file', 'blob', `${commit}:${path}`], { buffer: true })
  return result.status === 0 ? result.stdout as Buffer : null
}

/** Files in a commit with blob ids and sizes. */
export function lsTree(root: string, commit: string): Array<{ path: string; blob: string; size: number }> {
  return run(root, ['ls-tree', '-r', '-l', '-z', commit]).split('\0').filter(Boolean).flatMap(line => {
    const match = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/s.exec(line)
    return match ? [{ blob: match[1]!, size: match[2] === '-' ? 0 : Number(match[2]), path: match[3]! }] : []
  })
}

/** Git blob ids of working-tree files, as `git add` would compute them (clean filters applied). */
export function hashFiles(root: string, paths: readonly string[]): Map<string, string> {
  const hashes = new Map<string, string>()
  const present = paths.filter(path => existsSync(join(root, path)))
  if (!present.length) return hashes
  const result = git(root, ['hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n` })
  if (result.status !== 0) throw new GitError('git hash-object failed', String(result.stderr).slice(0, 2000))
  String(result.stdout).trim().split(/\r?\n/).forEach((hash, index) => { if (present[index]) hashes.set(present[index]!, hash.trim()) })
  return hashes
}

/** Content of a path at a commit as it would be checked out (smudge/eol filters applied). */
export function checkoutContent(root: string, commit: string, path: string): Buffer | null {
  const result = git(root, ['cat-file', '--filters', `${commit}:${path}`], { buffer: true })
  return result.status === 0 ? result.stdout as Buffer : null
}

export function addWorktree(root: string, path: string, commit: string): void {
  run(root, ['worktree', 'add', '--detach', path, commit])
}
export function removeWorktree(root: string, path: string): void {
  git(root, ['worktree', 'remove', '--force', path])
  git(root, ['worktree', 'prune'])
}
