import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { CheckpointSummary, RestoreConflict, RestorePlan, RestoreResult, RestoreScope } from '@altrex/contracts'
import { safePath } from '../security/path-guard'
import { uuidv7 } from '../util/uuid'
import { IGNORED_DIRECTORIES } from './ignore'
import { guardedPath } from './snapshot'
import { checkoutContent, deleteRef, hashFiles, isRepository, lsTree, pinRef, snapshotCommit } from '../git/git'

type ManifestEntry = { sha256: string; size: number; mtimeMs: number }
type Manifest = { scanStartedAt: number; files: Record<string, ManifestEntry> }
type CheckpointRecord = {
  version: 1
  id: string
  projectPath: string
  taskId: string | null
  label: string
  /** `snapshot`: content-addressed copy. `git`: temp-index commits under refs/altrex (large Git projects). */
  kind: 'snapshot' | 'git'
  createdAt: string
  before: Manifest
  after: Manifest | null
  finalizedAt: string | null
  beforeCommit?: string
  afterCommit?: string
}

export type CheckpointLimits = { maxFiles: number; maxTotalBytes: number; maxFileBytes: number }
// Same limits as the Director's isolated copies (workspace/snapshot.ts).
const defaultLimits: CheckpointLimits = { maxFiles: 30_000, maxTotalBytes: 200_000_000, maxFileBytes: 20_000_000 }
// A cached hash is trusted only if the file was last modified comfortably before the scan that
// produced it; otherwise an edit within the same mtime tick could go unnoticed ("racy" entries).
const RACY_WINDOW_MS = 2000
const CHECKPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class CheckpointError extends Error {
  constructor(message: string, readonly code: 'NOT_FOUND' | 'TOO_LARGE' | 'NOT_FINALIZED' | 'CORRUPT') {
    super(message)
  }
}

export type CheckpointStoreOptions = {
  /** Checkpoints kept per project; older ones are pruned together with unreferenced file blobs. */
  retention?: number
  limits?: Partial<CheckpointLimits>
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const changedPaths = (a: Manifest['files'], b: Manifest['files']): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(path => a[path]?.sha256 !== b[path]?.sha256).sort()

/**
 * Content-addressed snapshot checkpoints for projects (Git or not), stored outside the project:
 *   <root>/<projectKey>/checkpoints/<id>.json   manifest (path → sha256/size/mtime) before and after a task
 *   <root>/<projectKey>/objects/<aa>/<sha256>    file contents, shared between checkpoints
 * Covers every file ALTREX tools may touch: ignored directories (node_modules, build output, .git, …)
 * and protected paths (.env*, secrets, keys) are neither captured nor ever modified by a restore.
 */
export class CheckpointStore {
  private readonly limits: CheckpointLimits
  private readonly retention: number
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly manifestCache = new Map<string, Manifest>()

  constructor(readonly root: string, options: CheckpointStoreOptions = {}) {
    this.limits = { ...defaultLimits, ...options.limits }
    this.retention = Math.max(1, options.retention ?? 20)
  }

  /** Snapshot the project before a task changes it. */
  async create(input: { projectPath: string; taskId: string | null; label: string }): Promise<CheckpointSummary> {
    const project = await realpath(input.projectPath)
    const key = this.projectKey(project)
    return this.withLock(key, () => this.createUnlocked(project, key, input.taskId, input.label))
  }

  /** Record the project state after the task, so a restore can revert exactly the task's changes. */
  async finalize(checkpointId: string): Promise<CheckpointSummary> {
    const located = await this.locate(checkpointId)
    return this.withLock(located.key, async () => {
      const record = await this.readRecord(located.path)
      if (record.kind === 'git') {
        record.afterCommit = snapshotCommit(record.projectPath, `ALTREX checkpoint ${record.id} (task end)`)
        pinRef(record.projectPath, `checkpoints/${record.id}-after`, record.afterCommit)
        record.after = this.gitManifest(record.projectPath, record.afterCommit)
      } else record.after = await this.scan(record.projectPath, located.key, this.manifestCache.get(located.key) ?? record.before, false)
      record.finalizedAt = new Date().toISOString()
      await this.writeRecord(located.path, record)
      if (record.kind === 'snapshot') this.manifestCache.set(located.key, record.after)
      return this.summary(record)
    })
  }

  async list(projectPath: string): Promise<CheckpointSummary[]> {
    const key = this.projectKey(await realpath(projectPath))
    return (await this.records(key)).map(record => this.summary(record))
  }

  async get(checkpointId: string): Promise<CheckpointSummary> {
    const located = await this.locate(checkpointId)
    return this.summary(await this.readRecord(located.path))
  }

  /** Files the task changed (before → after manifests). Requires a finalized checkpoint. */
  async changes(checkpointId: string): Promise<Array<{ path: string; change: 'added' | 'modified' | 'deleted' }>> {
    const located = await this.locate(checkpointId)
    const record = await this.readRecord(located.path)
    if (!record.after) throw new CheckpointError('This checkpoint has no recorded task result yet.', 'NOT_FINALIZED')
    const before = record.before.files, after = record.after.files
    return changedPaths(before, after).map(path => ({ path, change: !before[path] ? 'added' as const : !after[path] ? 'deleted' as const : 'modified' as const }))
  }

  /**
   * One file before the task (from the checkpoint) and now (from disk), for diff rendering. Text only:
   * binary or oversized (> 1 MB) content is reported as `binary` with null contents. Never modifies anything.
   */
  async fileVersions(checkpointId: string, path: string): Promise<{ path: string; before: string | null; current: string | null; binary: boolean; changedSinceTask: boolean }> {
    const located = await this.locate(checkpointId)
    const record = await this.readRecord(located.path)
    const target = guardedPath(record.projectPath, path) // rejects traversal and protected paths
    const entry = record.before.files[path]
    let before: Buffer | null = null
    if (entry) before = record.kind === 'git' ? checkoutContent(record.projectPath, record.beforeCommit!, path) : await readFile(this.blobPath(located.key, entry.sha256)).catch(() => null)
    const current = existsSync(target) ? await readFile(target) : null
    const afterHash = record.after?.files[path]?.sha256
    const currentHash = current === null ? undefined : record.kind === 'git' ? hashFiles(record.projectPath, [path]).get(path) : sha256(current)
    const changedSinceTask = record.after !== null && afterHash !== currentHash
    const binary = [before, current].some(buffer => buffer !== null && (buffer.length > 1_000_000 || buffer.subarray(0, 8000).includes(0)))
    return { path, before: binary || !before ? null : before.toString('utf8'), current: binary || !current ? null : current.toString('utf8'), binary, changedSinceTask }
  }

  /** Dry run: what a restore would change. Never modifies the project. */
  async plan(checkpointId: string, scope: RestoreScope = 'task'): Promise<RestorePlan> {
    const located = await this.locate(checkpointId)
    return this.withLock(located.key, async () => (await this.planUnlocked(located.key, await this.readRecord(located.path), scope)).plan)
  }

  /**
   * Revert the project to the checkpoint. A safety checkpoint of the current tree is taken first, so a
   * restore can itself be undone. Files edited after the task (scope `task`) or while restoring are
   * reported as conflicts and left untouched.
   */
  async restore(checkpointId: string, scope: RestoreScope = 'task'): Promise<RestoreResult> {
    const located = await this.locate(checkpointId)
    return this.withLock(located.key, async () => {
      const record = await this.readRecord(located.path)
      const { plan, expected } = await this.planUnlocked(located.key, record, scope)
      const result: RestoreResult = { checkpointId, scope, restored: [], deleted: [], conflicts: [...plan.conflicts], safetyCheckpointId: null }
      if (!plan.restore.length && !plan.delete.length) return result

      // The checkpoint being restored is protected from the retention pruning this triggers.
      const safety = await this.createUnlocked(record.projectPath, located.key, record.taskId, `Before restoring checkpoint ${checkpointId.slice(0, 8)}`, checkpointId)
      result.safetyCheckpointId = safety.checkpointId
      const unchangedSincePlan = async (path: string): Promise<boolean> => {
        const target = join(record.projectPath, ...path.split('/'))
        const current = record.kind === 'git' ? hashFiles(record.projectPath, [path]).get(path) : existsSync(target) ? sha256(await readFile(target)) : undefined
        return current === expected.get(path)
      }
      for (const path of plan.restore) {
        if (!await unchangedSincePlan(path)) { result.conflicts.push({ path, reason: 'changed-during-restore' }); continue }
        const entry = record.before.files[path]!
        let bytes: Buffer
        if (record.kind === 'git') {
          const content = checkoutContent(record.projectPath, record.beforeCommit!, path)
          if (!content) throw new CheckpointError(`Checkpoint content for ${path} is missing from the Git object store; nothing further was restored.`, 'CORRUPT')
          bytes = content
        } else {
          bytes = await readFile(this.blobPath(located.key, entry.sha256))
          if (sha256(bytes) !== entry.sha256) throw new CheckpointError(`Checkpoint content for ${path} is corrupt; nothing further was restored.`, 'CORRUPT')
        }
        const target = guardedPath(record.projectPath, path)
        await mkdir(dirname(target), { recursive: true })
        const temporary = `${target}.altrex-restore-${randomBytes(4).toString('hex')}`
        await writeFile(temporary, bytes)
        await rename(temporary, target)
        result.restored.push(path)
      }
      for (const path of plan.delete) {
        if (!await unchangedSincePlan(path)) { result.conflicts.push({ path, reason: 'changed-during-restore' }); continue }
        const target = guardedPath(record.projectPath, path)
        if (existsSync(target)) await unlink(target)
        result.deleted.push(path)
      }
      await this.removeCreatedDirectories(record, result.deleted)
      return result
    })
  }

  private async createUnlocked(project: string, key: string, taskId: string | null, label: string, protectedId?: string): Promise<CheckpointSummary> {
    let cache = this.manifestCache.get(key) ?? null
    if (!cache) { const latest = (await this.records(key))[0]; cache = latest?.after ?? latest?.before ?? null }
    let before: Manifest
    try { before = await this.scan(project, key, cache, true) }
    catch (error) {
      if (!(error instanceof CheckpointError && error.code === 'TOO_LARGE')) throw error
      if (!isRepository(project)) throw new CheckpointError(`${error.message} The project is not a Git repository, so no fallback checkpoint was possible. Initialize Git in the project to enable checkpoints for large projects.`, 'TOO_LARGE')
      return this.createGitUnlocked(project, key, taskId, label, protectedId)
    }
    const record: CheckpointRecord = {
      version: 1, id: uuidv7(), projectPath: project, taskId, label: label.slice(0, 200), kind: 'snapshot',
      createdAt: new Date().toISOString(), before, after: null, finalizedAt: null,
    }
    await this.writeRecord(join(this.root, key, 'checkpoints', `${record.id}.json`), record)
    this.manifestCache.set(key, before)
    await this.prune(key, protectedId)
    return this.summary(record)
  }

  /** Git-backed checkpoint: a temp-index commit of the whole working tree, pinned under refs/altrex. */
  private async createGitUnlocked(project: string, key: string, taskId: string | null, label: string, protectedId?: string): Promise<CheckpointSummary> {
    const id = uuidv7(), commit = snapshotCommit(project, `ALTREX checkpoint ${id}: ${label}`.slice(0, 200))
    pinRef(project, `checkpoints/${id}`, commit)
    const record: CheckpointRecord = {
      version: 1, id, projectPath: project, taskId, label: label.slice(0, 200), kind: 'git',
      createdAt: new Date().toISOString(), before: this.gitManifest(project, commit), after: null, finalizedAt: null, beforeCommit: commit,
    }
    await this.writeRecord(join(this.root, key, 'checkpoints', `${record.id}.json`), record)
    await this.prune(key, protectedId)
    return this.summary(record)
  }

  /** A commit's tree as a manifest (blob ids stand in for content hashes), excluding protected paths. */
  private gitManifest(project: string, commit: string): Manifest {
    const files: Manifest['files'] = {}
    for (const entry of lsTree(project, commit)) {
      try { safePath(entry.path) } catch { continue }
      files[entry.path] = { sha256: entry.blob, size: entry.size, mtimeMs: 0 }
    }
    return { scanStartedAt: Date.now(), files }
  }

  /** After deleting files a task created, remove directories that are now empty and held nothing before. */
  private async removeCreatedDirectories(record: CheckpointRecord, deleted: readonly string[]): Promise<void> {
    const beforePaths = Object.keys(record.before.files)
    const directories = new Set<string>()
    for (const path of deleted) {
      const parts = path.split('/')
      for (let depth = parts.length - 1; depth > 0; depth--) directories.add(parts.slice(0, depth).join('/'))
    }
    for (const directory of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      if (beforePaths.some(path => path.startsWith(`${directory}/`))) continue
      const absolute = join(record.projectPath, ...directory.split('/'))
      try { if (!(await readdir(absolute)).length) await rmdir(absolute) } catch { /* not empty or already gone */ }
    }
  }

  private async planUnlocked(key: string, record: CheckpointRecord, scope: RestoreScope): Promise<{ plan: RestorePlan; expected: Map<string, string | undefined> }> {
    const current = record.kind === 'git'
      ? this.gitManifest(record.projectPath, snapshotCommit(record.projectPath, `ALTREX restore plan for ${record.id}`)).files
      : (await this.scan(record.projectPath, key, this.manifestCache.get(key) ?? record.after ?? record.before, false)).files
    const before = record.before.files
    const plan: RestorePlan = { checkpointId: record.id, scope, restore: [], delete: [], conflicts: [] }
    const expected = new Map<string, string | undefined>()
    let candidates: string[]
    if (scope === 'task') {
      if (!record.after) throw new CheckpointError('This checkpoint has no recorded task result (the task may have been interrupted). Use scope "all" to revert every change made since the checkpoint.', 'NOT_FINALIZED')
      const after = record.after.files
      candidates = []
      for (const path of changedPaths(before, after)) {
        if (current[path]?.sha256 !== after[path]?.sha256) plan.conflicts.push({ path, reason: 'modified-after-task' } satisfies RestoreConflict)
        else { candidates.push(path); expected.set(path, after[path]?.sha256) }
      }
    } else {
      candidates = changedPaths(before, current)
      for (const path of candidates) expected.set(path, current[path]?.sha256)
    }
    for (const path of candidates) (before[path] ? plan.restore : plan.delete).push(path)
    return { plan, expected }
  }

  private async scan(project: string, key: string, cache: Manifest | null, storeBlobs: boolean): Promise<Manifest> {
    const manifest: Manifest = { scanStartedAt: Date.now(), files: {} }
    let count = 0, total = 0
    const walk = async (folder: string): Promise<void> => {
      const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.endsWith('.tsbuildinfo') || entry.isSymbolicLink()) continue
        const absolute = join(folder, entry.name)
        const path = relative(project, absolute).replaceAll('\\', '/')
        try { safePath(path) } catch { continue }
        if (entry.isDirectory()) { await walk(absolute); continue }
        if (!entry.isFile()) continue
        const stats = await lstat(absolute)
        count++; total += stats.size
        if (count > this.limits.maxFiles || total > this.limits.maxTotalBytes || stats.size > this.limits.maxFileBytes) {
          throw new CheckpointError(`Project exceeds checkpoint limits (${this.limits.maxFiles} files, ${Math.round(this.limits.maxTotalBytes / 1e6)} MB total, ${Math.round(this.limits.maxFileBytes / 1e6)} MB per file).`, 'TOO_LARGE')
        }
        const cached = cache?.files[path]
        if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && stats.mtimeMs < cache!.scanStartedAt - RACY_WINDOW_MS
          && (!storeBlobs || existsSync(this.blobPath(key, cached.sha256)))) {
          manifest.files[path] = cached
          continue
        }
        const bytes = await readFile(absolute)
        const digest = sha256(bytes)
        if (storeBlobs) await this.storeBlob(key, digest, bytes)
        manifest.files[path] = { sha256: digest, size: bytes.length, mtimeMs: stats.mtimeMs }
      }
    }
    await walk(project)
    return manifest
  }

  private async storeBlob(key: string, digest: string, bytes: Buffer): Promise<void> {
    const target = this.blobPath(key, digest)
    if (existsSync(target)) return
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, bytes)
    await rename(temporary, target).catch(async (error: unknown) => { await rm(temporary, { force: true }); if (!existsSync(target)) throw error })
  }

  private async prune(key: string, protectedId?: string): Promise<void> {
    const records = await this.records(key)
    const kept = records.filter((record, index) => index < this.retention || record.id === protectedId)
    const expired = records.filter(record => !kept.includes(record))
    if (!expired.length) return
    for (const record of expired) {
      if (record.kind === 'git') { deleteRef(record.projectPath, `checkpoints/${record.id}`); deleteRef(record.projectPath, `checkpoints/${record.id}-after`) }
      await rm(join(this.root, key, 'checkpoints', `${record.id}.json`), { force: true })
    }
    const referenced = new Set(kept.filter(record => record.kind === 'snapshot').flatMap(record => Object.values(record.before.files).map(entry => entry.sha256)))
    const objects = join(this.root, key, 'objects')
    if (!existsSync(objects)) return
    for (const prefix of await readdir(objects)) {
      for (const blob of await readdir(join(objects, prefix))) {
        if (!referenced.has(blob)) await rm(join(objects, prefix, blob), { force: true })
      }
    }
  }

  private async records(key: string): Promise<CheckpointRecord[]> {
    const directory = join(this.root, key, 'checkpoints')
    if (!existsSync(directory)) return []
    const records: CheckpointRecord[] = []
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue
      try { records.push(await this.readRecord(join(directory, name))) } catch { /* A corrupt record is skipped, never used. */ }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  private async locate(checkpointId: string): Promise<{ key: string; path: string }> {
    if (!CHECKPOINT_ID.test(checkpointId)) throw new CheckpointError('Invalid checkpoint ID.', 'NOT_FOUND')
    if (existsSync(this.root)) {
      for (const key of await readdir(this.root)) {
        const path = join(this.root, key, 'checkpoints', `${checkpointId}.json`)
        if (existsSync(path)) return { key, path }
      }
    }
    throw new CheckpointError('Checkpoint not found.', 'NOT_FOUND')
  }

  private async readRecord(path: string): Promise<CheckpointRecord> {
    const record = JSON.parse(await readFile(path, 'utf8')) as CheckpointRecord
    if (record.version !== 1 || !CHECKPOINT_ID.test(record.id) || typeof record.before?.files !== 'object') throw new CheckpointError('Unreadable checkpoint record.', 'CORRUPT')
    return record
  }

  private async writeRecord(path: string, record: CheckpointRecord): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await rename(temporary, path)
  }

  private summary(record: CheckpointRecord): CheckpointSummary {
    const entries = Object.values(record.before.files)
    return {
      checkpointId: record.id, projectPath: record.projectPath, taskId: record.taskId, label: record.label, kind: record.kind ?? 'snapshot',
      createdAt: record.createdAt, fileCount: entries.length, totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      finalizedAt: record.finalizedAt, changedByTask: record.after ? changedPaths(record.before.files, record.after.files).length : null,
    }
  }

  private projectKey(canonicalProject: string): string {
    const normalized = process.platform === 'win32' ? canonicalProject.toLowerCase() : canonicalProject
    return createHash('sha256').update(normalized).digest('hex').slice(0, 24)
  }

  private blobPath(key: string, digest: string): string {
    return join(this.root, key, 'objects', digest.slice(0, 2), digest)
  }

  private withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.locks.set(key, next)
    return next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key) })
  }
}
