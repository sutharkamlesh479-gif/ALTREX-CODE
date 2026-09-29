import type { CheckName, Evidence } from '@altrex/contracts'

// Tournament mode (AGENT_SPEC.md §8): N ≤ 3 candidates implement the same request in isolated workspaces;
// code ranks them from evidence; only the winner is applied (conflict-safe). Model confidence is never
// a ranking input.

export const MAX_CANDIDATES = 3

export type CandidateResult = {
  candidate: number
  endpoint: { providerId: string; model: string } | null
  status: 'completed' | 'failed'
  error?: string
  changedFiles: string[]
  /** Files the user changed in the project meanwhile (the candidate cannot be applied). */
  conflicts: string[]
  checks: Array<{ name: CheckName; status: Evidence['status'] }>
  /** Added + removed lines against the project (smaller wins ties). */
  changedLines: number
}

export type Ranked = { candidate: number; eligible: boolean; score: [number, number, number, number]; reasons: string[] }

/** Order: all declared checks pass > more passing checks > fewer failing checks > smaller change. */
export function rankCandidates(results: CandidateResult[], declared: CheckName[]): Ranked[] {
  const ranked = results.map(result => {
    const reasons: string[] = []
    let eligible = true
    if (result.status !== 'completed') { eligible = false; reasons.push(`did not finish: ${result.error ?? 'failed'}`) }
    if (!result.changedFiles.length) { eligible = false; reasons.push('made no changes') }
    if (result.conflicts.length) { eligible = false; reasons.push(`conflicts with files changed meanwhile: ${result.conflicts.slice(0, 5).join(', ')}`) }
    const pass = result.checks.filter(check => check.status === 'PASS').length
    const fail = result.checks.filter(check => check.status === 'FAIL' || check.status === 'TIMEOUT' || check.status === 'ERROR').length
    const allPass = declared.length > 0 && declared.every(name => result.checks.some(check => check.name === name && check.status === 'PASS'))
    reasons.push(declared.length ? `${pass}/${declared.length} declared checks passed${fail ? `, ${fail} failed` : ''}` : 'no declared checks')
    reasons.push(`${result.changedFiles.length} file(s), ${result.changedLines} changed line(s)`)
    return { candidate: result.candidate, eligible, score: [allPass ? 1 : 0, pass, -fail, -result.changedLines] as [number, number, number, number], reasons }
  })
  return ranked.sort((a, b) => Number(b.eligible) - Number(a.eligible) || compare(b.score, a.score) || a.candidate - b.candidate)
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! - b[index]!
  return 0
}

export type TournamentHooks<Lease> = {
  candidates: number
  declared: CheckName[]
  signal: AbortSignal
  acquire: (candidate: number) => Promise<Lease> | Lease
  /** Run the coder for one candidate inside its lease. Returns the endpoint that did the work. */
  implement: (candidate: number, lease: Lease) => Promise<{ providerId: string; model: string } | null>
  check: (candidate: number, lease: Lease) => Promise<Evidence[]>
  changes: (lease: Lease) => { changed: string[]; conflicts: string[]; changedLines: number }
  apply: (lease: Lease) => string[]
  release: (lease: Lease) => void
  onCandidate?: (result: CandidateResult) => void
}

export type TournamentOutcome = { ranking: Ranked[]; results: CandidateResult[]; winner: number | null; applied: string[] }

/** Run candidates in parallel, rank by evidence, apply the winner. Every lease is released afterwards. */
export async function runTournament<Lease>(hooks: TournamentHooks<Lease>): Promise<TournamentOutcome> {
  const count = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(hooks.candidates)))
  const leases = new Map<number, Lease>()
  try {
    const results = await Promise.all(Array.from({ length: count }, async (_, candidate): Promise<CandidateResult> => {
      let endpoint: CandidateResult['endpoint'] = null
      try {
        const lease = await hooks.acquire(candidate)
        leases.set(candidate, lease)
        endpoint = await hooks.implement(candidate, lease)
        hooks.signal.throwIfAborted()
        const evidence = await hooks.check(candidate, lease)
        const { changed, conflicts, changedLines } = hooks.changes(lease)
        const result: CandidateResult = { candidate, endpoint, status: 'completed', changedFiles: changed, conflicts, changedLines, checks: evidence.map(item => ({ name: item.name, status: item.status })) }
        hooks.onCandidate?.(result)
        return result
      } catch (error) {
        if (hooks.signal.aborted) throw error
        const result: CandidateResult = { candidate, endpoint, status: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : 'failed', changedFiles: [], conflicts: [], changedLines: 0, checks: [] }
        hooks.onCandidate?.(result)
        return result
      }
    }))
    const ranking = rankCandidates(results, hooks.declared)
    const best = ranking[0]?.eligible ? ranking[0].candidate : null
    const applied = best === null ? [] : hooks.apply(leases.get(best)!)
    return { ranking, results, winner: best, applied }
  } finally {
    for (const lease of leases.values()) { try { hooks.release(lease) } catch { /* cleaned at next startup */ } }
  }
}
