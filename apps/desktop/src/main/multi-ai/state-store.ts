import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ProjectRun } from '../../shared/multi-ai'
export class RunStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true }) }
  directory(id: string): string { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid run ID.'); return join(this.root, id) }
  save(run: ProjectRun): void { const directory = this.directory(run.id); mkdirSync(directory, { recursive: true }); run.updatedAt = new Date().toISOString(); const path = join(directory, 'run.json'); writeFileSync(`${path}.tmp`, JSON.stringify(run), { mode: 0o600 }); renameSync(`${path}.tmp`, path) }
  load(id: string): ProjectRun | null { try { const run = JSON.parse(readFileSync(join(this.directory(id), 'run.json'), 'utf8')) as ProjectRun; return run.version === 1 && run.id === id && Array.isArray(run.tasks) ? run : null } catch { return null } }
  list(projectPath: string): ProjectRun[] { return readdirSync(this.root, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => { const run = this.load(e.name); return run && run.projectPath === projectPath ? [run] : [] }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30) }
  recover(): void { for (const entry of readdirSync(this.root, { withFileTypes: true })) { if (!entry.isDirectory()) continue; const run = this.load(entry.name); if (!run || !['PLANNING', 'RUNNING', 'VERIFYING', 'INTEGRATING'].includes(run.status)) continue; run.status = 'INTERRUPTED'; run.error = 'Application closed during execution. Inspect retained work before restarting. No work was automatically resumed.'; run.tasks.forEach(t => { if (['RUNNING', 'VERIFYING', 'QUEUED', 'WAITING'].includes(t.status)) t.status = 'CANCELLED' }); this.save(run) } }
  memory(project: string): string { const path = join(this.root, `memory-${createHash('sha256').update(project).digest('hex')}.json`); return existsSync(path) ? readFileSync(path, 'utf8').slice(0, 12000) : '' }
  saveMemory(run: ProjectRun): void { writeFileSync(join(this.root, `memory-${createHash('sha256').update(run.projectPath).digest('hex')}.json`), JSON.stringify({ spec: run.spec, components: run.tasks.filter(t => t.status === 'COMPLETED').flatMap(t => t.outputs), apiRegistry: run.spec?.apiContracts, completed: run.tasks.filter(t => t.status === 'COMPLETED').map(t => ({ title: t.title, files: t.filesChanged })), knownIssues: run.tasks.filter(t => t.error).map(t => ({ title: t.title, error: t.error })), runId: run.id })) }
}
