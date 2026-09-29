import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { TaskContract } from '../orchestrator/director-types'
import { ownsFile } from '../orchestrator/director-contracts'
import { safePath } from '../security/path-guard'
import { IGNORED_DIRECTORIES } from './ignore'
export type FileSnapshot = Record<string, string>
export const digest = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
export function guardedPath(root: string, path: string): string {
  safePath(path); const base = realpathSync(root), target = resolve(base, path), rel = relative(base, target)
  if (rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Path escaped workspace.')
  let cursor = base
  for (const part of rel.split(sep)) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink traversal is not allowed.') }
  return target
}
export function snapshot(root: string): FileSnapshot {
  const result: FileSnapshot = {}; let bytes = 0, count = 0
  const walk = (folder: string) => { for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.endsWith('.tsbuildinfo') || entry.isSymbolicLink()) continue
    const absolute = join(folder, entry.name), path = relative(root, absolute).replaceAll('\\', '/')
    try { safePath(path) } catch { continue }
    if (entry.isDirectory()) walk(absolute)
    else if (entry.isFile()) { const size = statSync(absolute).size; bytes += size; count++; if (bytes > 200_000_000 || count > 30000 || size > 20_000_000) throw new Error('Workspace exceeds safe copy limits (200 MB / 30,000 source files / 20 MB per file).'); result[path] = digest(readFileSync(absolute)) }
  } }
  walk(root); return result
}
export function changed(before: FileSnapshot, after: FileSnapshot): string[] { return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]) }
export function copyWorkspace(source: string, destination: string): FileSnapshot {
  mkdirSync(destination, { recursive: true }); const files = snapshot(source)
  for (const path of Object.keys(files)) { const target = guardedPath(destination, path); mkdirSync(dirname(target), { recursive: true }); const bytes = readFileSync(guardedPath(source, path)); if (digest(bytes) !== files[path]) throw new Error(`File changed during snapshot: ${path}`); writeFileSync(target, bytes) }
  return files
}
export function mergeWorkspace(source: string, destination: string, base: FileSnapshot, task?: TaskContract): string[] {
  const after = snapshot(source), files = changed(base, after), current = snapshot(destination)
  for (const path of files) {
    if (task && !ownsFile(task, path)) throw new Error(`SCOPE VIOLATION: ${path} is outside ${task.id}.`)
    if (current[path] !== base[path]) throw new Error(`Integration conflict: ${path} changed since this task started. Rebase required.`)
  }
  for (const path of files) { const target = guardedPath(destination, path); if (after[path] === undefined) unlinkSync(target); else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(guardedPath(source, path))) } }
  return files
}
// Publish only after final QA. Journal plus byte-for-byte backups survive a process crash.
export function publishWorkspace(stage: string, project: string, base: FileSnapshot, journalDirectory: string): string[] {
  const after = snapshot(stage), current = snapshot(project), files = changed(base, after)
  for (const path of files) if (current[path] !== base[path]) throw new Error(`Your file changed during the run: ${path}. Staged work is retained; publication stopped.`)
  const backup = join(journalDirectory, 'publication-backup'); mkdirSync(backup, { recursive: true })
  for (const path of files) if (current[path]) { const target = guardedPath(backup, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(guardedPath(project, path))) }
  const applied: string[] = [], journal = join(journalDirectory, 'publication.json')
  const save = (status: string) => writeFileSync(journal, JSON.stringify({ status, files, applied, base, after }))
  save('PREPARED')
  try {
    for (const path of files) {
      const target = guardedPath(project, path)
      if ((existsSync(target) ? digest(readFileSync(target)) : undefined) !== base[path]) throw new Error(`Concurrent edit detected: ${path}`)
      if (after[path] === undefined) unlinkSync(target)
      else { mkdirSync(dirname(target), { recursive: true }); const temp = `${target}.altrex-publish`; if (existsSync(temp)) throw new Error(`Publication temporary file already exists: ${path}`); writeFileSync(temp, readFileSync(guardedPath(stage, path))); renameSync(temp, target) }
      applied.push(path); save('APPLYING')
    }
    save('COMPLETED'); return files
  } catch (error) {
    for (const path of [...applied].reverse()) { const target = guardedPath(project, path); if ((existsSync(target) ? digest(readFileSync(target)) : undefined) !== after[path]) continue; if (base[path]) writeFileSync(target, readFileSync(guardedPath(backup, path))); else if (existsSync(target)) unlinkSync(target) }
    save('ROLLED_BACK'); throw error
  }
}
