import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Cloud-code consent (SECURITY_MODEL.md §6). Project code may be sent to a cloud endpoint only after the
// user granted consent for that exact endpoint (provider id + base URL). Local (loopback) endpoints never
// need consent. The backend enforces this; the UI only collects the decision.

export type ConsentRecord = { providerId: string; baseUrl: string; grantedAt: string }
export type Endpoint = { providerId: string; baseUrl: string }

/** The external OpenAI Codex engine is a cloud service reached through its CLI, not through a base URL. */
export const CODEX_CONSENT_ENDPOINT: Endpoint = { providerId: 'codex', baseUrl: 'codex-cli' }

const keyOf = (endpoint: Endpoint) => `${endpoint.providerId}|${endpoint.baseUrl.trim().replace(/\/+$/, '').toLowerCase()}`

export class ConsentRequiredError extends Error {
  readonly code = 'CONSENT_REQUIRED'
  constructor(readonly endpoints: Endpoint[]) {
    super(`Project code was not sent: cloud AI consent is required for ${endpoints.map(endpoint => endpoint.providerId).join(', ') || 'this provider'}. Allow cloud AI for the project in ALTREX, or use Local only.`)
    this.name = 'ConsentRequiredError'
  }
}

export class ConsentStore {
  private records = new Map<string, ConsentRecord>()

  /** `path` null = in memory (nothing granted). */
  constructor(private readonly path: string | null) {
    if (!path) return
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; grants?: ConsentRecord[] }
      for (const record of saved.grants ?? []) {
        if (typeof record.providerId === 'string' && typeof record.baseUrl === 'string' && typeof record.grantedAt === 'string') this.records.set(keyOf(record), record)
      }
    } catch { /* no consent recorded yet */ }
  }

  has(endpoint: Endpoint): boolean { return this.records.has(keyOf(endpoint)) }
  get(endpoint: Endpoint): ConsentRecord | null { return this.records.get(keyOf(endpoint)) ?? null }
  list(): ConsentRecord[] { return [...this.records.values()] }

  grant(endpoint: Endpoint): ConsentRecord {
    const record = { providerId: endpoint.providerId, baseUrl: endpoint.baseUrl, grantedAt: new Date().toISOString() }
    this.records.set(keyOf(endpoint), record)
    this.save()
    return record
  }

  revoke(endpoint: Endpoint): boolean {
    const removed = this.records.delete(keyOf(endpoint))
    if (removed) this.save()
    return removed
  }

  private save(): void {
    if (!this.path) return
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, grants: this.list() }, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
