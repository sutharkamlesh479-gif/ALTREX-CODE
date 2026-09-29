import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { MemoryFact, Verdict } from '@altrex/contracts'
import type { ProjectProfile } from '../repo/project-profile'

// Machine memory per project (CONTEXT_ENGINE.md §7), stored outside the repository. Facts come only from
// evidence (checks that ran), detection (manifests) or the user — never from model claims.

const DAY = 86_400_000
const MAX_FACTS = 300
const RULES_FILE = 'ALTREX.md'
const MAX_RULES = 8000

type MemoryFile = { version: 1; projectPath: string; facts: MemoryFact[] }

function canonical(path: string): string {
  let value: string
  try { value = realpathSync.native(path) } catch { value = resolve(path) }
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export class ProjectMemory {
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  /** Facts for a project, aged: >30 days without re-verification → observed-once; >90 days → dropped. */
  facts(projectPath: string): MemoryFact[] {
    const now = this.now().getTime()
    return this.read(projectPath).facts
      .filter(fact => now - Date.parse(fact.lastVerifiedAt) <= 90 * DAY)
      .map(fact => (now - Date.parse(fact.lastVerifiedAt) > 30 * DAY && fact.confidence === 'confirmed' ? { ...fact, confidence: 'observed-once' as const } : fact))
  }

  /** Record what a verdict proved: which checks passed or failed on the final tree. Returns changed keys. */
  recordVerdict(projectPath: string, verdict: Verdict, argvByEvidence: Map<string, string[]>): string[] {
    const changed: string[] = []
    for (const check of verdict.checks) {
      if (check.status !== 'PASS' && check.status !== 'FAIL') continue
      const argv = check.evidenceId ? argvByEvidence.get(check.evidenceId) : undefined
      if (!argv) continue
      const key = `check.${check.name}`
      const value = `${argv.join(' ')} → ${check.status}`
      const previous = this.read(projectPath).facts.find(fact => fact.key === key)
      // Confirmed only when the same command has passed before; a contradiction resets confidence.
      const confidence = check.status === 'PASS' && previous?.value === value ? 'confirmed' : 'observed-once'
      this.put(projectPath, { key, value, source: 'evidence', evidenceId: check.evidenceId!, confidence, lastVerifiedAt: this.now().toISOString() })
      changed.push(key)
    }
    return changed
  }

  /** A failure signature that a repair fixed (evidence: failing check, then the same check passing). */
  recordFix(projectPath: string, signature: string, detail: string, evidenceId?: string): string {
    const key = `failure.${createHash('sha256').update(signature).digest('hex').slice(0, 12)}`
    this.put(projectPath, { key, value: `${signature.slice(0, 200)} — ${detail.slice(0, 500)}`, source: 'evidence', ...(evidenceId ? { evidenceId } : {}), confidence: 'observed-once', lastVerifiedAt: this.now().toISOString() })
    return key
  }

  /** Stack facts detected from manifests. */
  recordProfile(projectPath: string, profile: ProjectProfile): string[] {
    const entries: Array<[string, string]> = []
    if (profile.packageManager) entries.push(['stack.packageManager', profile.packageManager])
    if (profile.testRunner) entries.push(['stack.testRunner', profile.testRunner])
    if (profile.frameworks.length) entries.push(['stack.frameworks', profile.frameworks.join(', ')])
    if (profile.languages.length) entries.push(['stack.languages', profile.languages.map(item => item.language).join(', ')])
    const existing = new Map(this.read(projectPath).facts.map(fact => [fact.key, fact]))
    const changed: string[] = []
    for (const [key, value] of entries) {
      if (existing.get(key)?.value === value && existing.get(key)?.source === 'detected') continue
      this.put(projectPath, { key, value, source: 'detected', confidence: 'confirmed', lastVerifiedAt: this.now().toISOString() })
      changed.push(key)
    }
    return changed
  }

  /** A fact the user stated. */
  remember(projectPath: string, key: string, value: string): void {
    this.put(projectPath, { key: `user.${key}`.slice(0, 120), value: value.slice(0, 2000), source: 'user', confidence: 'confirmed', lastVerifiedAt: this.now().toISOString() })
  }

  forget(projectPath: string, key: string): boolean {
    const file = this.read(projectPath)
    const facts = file.facts.filter(fact => fact.key !== key)
    if (facts.length === file.facts.length) return false
    this.write(projectPath, { ...file, facts })
    return true
  }

  /** Relevant memory plus the user's ALTREX.md rules, rendered as a delimited data block for prompts. */
  render(projectPath: string, taskText = '', limit = 20): string {
    const terms = new Set(taskText.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 2))
    const scored = this.facts(projectPath).map(fact => {
      const words = `${fact.key} ${fact.value}`.toLowerCase()
      const score = (fact.key.startsWith('check.') || fact.key.startsWith('stack.') || fact.source === 'user' ? 2 : 0) + [...terms].filter(term => words.includes(term)).length
      return { fact, score }
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
    const rules = this.rules(projectPath)
    const parts: string[] = []
    if (rules) parts.push(`<project_rules source="${RULES_FILE}" owner="user">\n${rules}\n</project_rules>`)
    if (scored.length) parts.push(`<project_memory trust="evidence">\n${scored.map(({ fact }) => `- ${fact.key}: ${fact.value} (${fact.source}, ${fact.confidence})`).join('\n')}\n</project_memory>`)
    return parts.join('\n')
  }

  /** User-owned project rules from ALTREX.md at the project root (read-only for ALTREX). */
  rules(projectPath: string): string {
    const path = join(projectPath, RULES_FILE)
    try { return existsSync(path) ? readFileSync(path, 'utf8').slice(0, MAX_RULES) : '' } catch { return '' }
  }

  /** One-time import of the legacy Multi-AI memory (completed tasks and known issues). */
  importLegacy(projectPath: string, legacyJson: string): number {
    if (this.read(projectPath).facts.some(fact => fact.key.startsWith('history.'))) return 0
    let legacy: { completed?: Array<{ title?: string; files?: string[] }>; knownIssues?: Array<{ title?: string; error?: string }> }
    try { legacy = JSON.parse(legacyJson) as typeof legacy } catch { return 0 }
    let count = 0
    const at = this.now().toISOString()
    for (const item of (legacy.completed ?? []).slice(0, 30)) {
      if (!item.title) continue
      this.put(projectPath, { key: `history.${createHash('sha256').update(item.title).digest('hex').slice(0, 10)}`, value: `Completed earlier: ${item.title.slice(0, 200)}${item.files?.length ? ` (${item.files.slice(0, 8).join(', ')})` : ''}`, source: 'detected', confidence: 'observed-once', lastVerifiedAt: at })
      count++
    }
    for (const issue of (legacy.knownIssues ?? []).slice(0, 20)) {
      if (!issue.title || !issue.error) continue
      this.put(projectPath, { key: `issue.${createHash('sha256').update(issue.title).digest('hex').slice(0, 10)}`, value: `${issue.title.slice(0, 200)}: ${issue.error.slice(0, 400)}`, source: 'detected', confidence: 'observed-once', lastVerifiedAt: at })
      count++
    }
    return count
  }

  private put(projectPath: string, fact: MemoryFact): void {
    const file = this.read(projectPath)
    const facts = [fact, ...file.facts.filter(item => item.key !== fact.key)].slice(0, MAX_FACTS)
    this.write(projectPath, { ...file, facts })
  }

  private path(projectPath: string): string {
    return join(this.root, createHash('sha256').update(canonical(projectPath)).digest('hex').slice(0, 24), 'memory.json')
  }

  private read(projectPath: string): MemoryFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path(projectPath), 'utf8')) as MemoryFile
      if (parsed.version === 1 && Array.isArray(parsed.facts)) return parsed
    } catch { /* no memory yet */ }
    return { version: 1, projectPath, facts: [] }
  }

  private write(projectPath: string, file: MemoryFile): void {
    const path = this.path(projectPath), temporary = `${path}.${process.pid}.tmp`
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(temporary, JSON.stringify(file, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
  }
}
