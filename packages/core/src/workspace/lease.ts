import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { addWorktree, isRepository, removeWorktree, snapshotCommit } from '../git/git'
import { uuidv7 } from '../util/uuid'
import { changed, copyWorkspace, guardedPath, snapshot, type FileSnapshot } from './snapshot'

// Isolated workspaces for parallel agents and tournament candidates (TOOL_SYSTEM.md §6). Nothing an agent
// does in a lease reaches the user's project until its changes are explicitly applied.

export type WorkspaceLease = {
  id: string
  /** Where the agent works. */
  path: string
  kind: 'worktree' | 'copy'
  projectPath: string
  /** Content fingerprint of the starting state (for change detection and conflict-safe application). */
  base: FileSnapshot
  /** Snapshot commit the worktree started from (worktree leases). */
  baseCommit?: string
}

export type LeaseChanges = { changed: string[]; conflicts: string[] }

/**
 * Create an isolated workspace. Git projects get a detached worktree of a snapshot commit (which includes
 * uncommitted work); other projects get a guarded source copy (dependencies and build output excluded).
 */
export function acquireWorkspace(input: { projectPath: string; leasesRoot: string; kind?: 'auto' | 'worktree' | 'copy' }): WorkspaceLease {
  const projectPath = realpathSync(input.projectPath), id = uuidv7()
  mkdirSync(input.leasesRoot, { recursive: true })
  const path = join(realpathSync(input.leasesRoot), `${createHash('sha256').update(projectPath).digest('hex').slice(0, 12)}-${id}`)
  const useGit = input.kind === 'worktree' || (input.kind !== 'copy' && isRepository(projectPath))
  if (useGit) {
    const commit = snapshotCommit(projectPath, `ALTREX workspace lease ${id}`)
    register(input.leasesRoot, { id, path, kind: 'worktree', projectPath })
    addWorktree(projectPath, path, commit)
    return { id, path, kind: 'worktree', projectPath, base: snapshot(path), baseCommit: commit }
  }
  register(input.leasesRoot, { id, path, kind: 'copy', projectPath })
  const base = copyWorkspace(projectPath, path)
  return { id, path, kind: 'copy', projectPath, base }
}

/** Files changed in the lease, and which of them the user also changed in the project meanwhile. */
export function leaseChanges(lease: WorkspaceLease): LeaseChanges {
  const inLease = changed(lease.base, snapshot(lease.path))
  const project = snapshot(lease.projectPath)
  return { changed: inLease, conflicts: inLease.filter(path => project[path] !== lease.base[path]) }
}

/**
 * Apply the lease's changes to the project. Refuses (applies nothing) if any changed file was also modified
 * in the project since the lease started, so concurrent user edits are never overwritten.
 */
export function applyLease(lease: WorkspaceLease): string[] {
  const { changed: files, conflicts } = leaseChanges(lease)
  if (conflicts.length) throw new Error(`These files also changed in the project since the workspace was created: ${conflicts.slice(0, 20).join(', ')}. Nothing was applied.`)
  for (const path of files) {
    const source = join(lease.path, ...path.split('/')), target = guardedPath(lease.projectPath, path)
    if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(source)) }
    else if (existsSync(target)) unlinkSync(target)
  }
  return files
}

/** Remove the lease (worktree or copy). Only paths inside the leases root are ever deleted. */
export function releaseWorkspace(lease: WorkspaceLease, leasesRoot: string): void {
  const root = realpathSync(leasesRoot), target = resolve(lease.path), inside = relative(root, target)
  if (!inside || inside.startsWith('..') || inside.includes(`..${sep}`)) throw new Error('Refusing to remove a path outside the workspace leases directory.')
  // Links placed in the lease (e.g. a node_modules junction to the project's dependencies) are unlinked
  // first, so no removal below can ever follow them into the user's project.
  if (existsSync(target)) for (const entry of readdirSync(target, { withFileTypes: true })) if (entry.isSymbolicLink()) unlinkSync(join(target, entry.name))
  if (lease.kind === 'worktree') { try { removeWorktree(lease.projectPath, target) } catch { /* already removed */ } }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  unregister(leasesRoot, lease.id)
}

// ---- registry (crash recovery) -------------------------------------------------------------------

type LeaseRecord = { id: string; path: string; kind: WorkspaceLease['kind']; projectPath: string }
const registryPath = (root: string) => join(root, 'leases.json')
function records(root: string): LeaseRecord[] {
  try { return (JSON.parse(readFileSync(registryPath(root), 'utf8')) as { leases?: LeaseRecord[] }).leases ?? [] } catch { return [] }
}
function save(root: string, leases: LeaseRecord[]): void {
  const path = registryPath(root), temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, leases }), { mode: 0o600 })
  renameSync(temporary, path)
}
function register(root: string, record: LeaseRecord): void { save(root, [...records(root).filter(item => item.id !== record.id), record]) }
function unregister(root: string, id: string): void { if (existsSync(registryPath(root))) save(root, records(root).filter(item => item.id !== id)) }

/**
 * Remove workspaces left behind by a crash: every registered lease (worktrees are also detached from their
 * repository) and any unregistered directory inside the leases root. Never touches paths outside it.
 */
export function recoverLeases(leasesRoot: string): number {
  if (!existsSync(leasesRoot)) return 0
  let removed = 0
  for (const record of records(leasesRoot)) {
    try { releaseWorkspace({ ...record, base: {} }, leasesRoot); removed++ } catch { /* reported next time */ }
  }
  const root = realpathSync(leasesRoot)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    rmSync(join(root, entry.name), { recursive: true, force: true }); removed++
  }
  return removed
}
