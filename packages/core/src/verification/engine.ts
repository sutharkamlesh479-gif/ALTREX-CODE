import type { CheckName, Evidence, ReviewSummary, TaskState, Verdict } from '@altrex/contracts'
import { failureSignature } from './parsers'
import { reviewNotRun } from './review'
import { computeVerdict } from './verdict'

export type RepairRequest = {
  reason: 'check_failed' | 'review_changes'
  attempt: number
  /** Failing evidence with full output (failure-first) for the Debugger. */
  failures: Array<{ evidence: Evidence; output: string }>
  /** Reviewer findings for the Coder when `reason` is `review_changes`. */
  review: ReviewSummary | null
  /** The same failure persisted without any tree change: use a stronger model once. */
  escalate: boolean
}

export type VerificationHooks = {
  discovered: CheckName[]
  runChecks: () => Promise<{ evidence: Evidence[]; outputs: Map<string, string> }>
  review: (input: { evidence: Evidence[]; round: number; previous: ReviewSummary | null }) => Promise<ReviewSummary>
  /** Debugger/Coder round. Throwing ends repair (the verdict reflects the last evidence). */
  repair: (request: RepairRequest) => Promise<void>
  treeHash: () => string | null
  transition: (state: TaskState) => void
  onRepairStarted?: (info: { attempt: number; limit: number; reason: RepairRequest['reason']; signature: string; escalated: boolean }) => void
  onReview?: (review: ReviewSummary) => void
  /** A failure signature disappeared after a repair (evidence: the failing checks now pass). */
  onFixed?: (info: { signature: string; attempt: number; evidence: Evidence[] }) => void
  signal: AbortSignal
}

export type RepairLimits = { perSignature: number; total: number; reviewCycles: number }
export const DEFAULT_REPAIR_LIMITS: RepairLimits = { perSignature: 3, total: 6, reviewCycles: 2 }

const FAILING = new Set<Evidence['status']>(['FAIL', 'TIMEOUT', 'ERROR'])

/**
 * TESTING → (DEBUGGING → TESTING)* → REVIEWING → (IMPLEMENTING → TESTING …)* → VERIFYING → verdict.
 * Repairs are bounded per failure signature and in total; a signature that repeats without any change to
 * the tree is escalated once, then stops. The verdict is computed by code from the evidence.
 */
export async function verifyAndRepair(hooks: VerificationHooks, limits: RepairLimits = DEFAULT_REPAIR_LIMITS): Promise<Verdict> {
  const evidence: Evidence[] = []
  const seen = new Map<string, { count: number; tree: string | null }>()
  let attempts = 0, limitReached = false, escalated = false, reviewCycles = 0
  let review: ReviewSummary | null = null
  let pending: string | null = null

  for (;;) {
    hooks.signal.throwIfAborted()
    hooks.transition('TESTING')
    const round = await hooks.runChecks()
    evidence.push(...round.evidence)
    const failures = round.evidence.filter(item => FAILING.has(item.status)).map(item => ({ evidence: item, output: round.outputs.get(item.evidenceId) ?? item.outputTail }))
    if (!failures.length && pending !== null) { hooks.onFixed?.({ signature: pending, attempt: attempts, evidence: round.evidence }); pending = null }
    if (failures.length) {
      review = null
      const signature = failures.map(failure => failureSignature(failure.evidence.name, failure.output, failure.evidence.parsed)).join('+').slice(0, 200)
      pending = signature
      const tree = hooks.treeHash(), previous = seen.get(signature)
      const count = (previous?.count ?? 0) + 1
      if (attempts >= limits.total || count > limits.perSignature) { limitReached = true; break }
      let escalate = false
      if (previous && previous.tree !== null && previous.tree === tree) {
        // The last repair changed nothing and the same failure came back.
        if (escalated) { limitReached = true; break }
        escalate = escalated = true
      }
      seen.set(signature, { count, tree })
      attempts += 1
      hooks.transition('DEBUGGING')
      hooks.onRepairStarted?.({ attempt: attempts, limit: limits.total, reason: 'check_failed', signature, escalated: escalate })
      try { await hooks.repair({ reason: 'check_failed', attempt: attempts, failures, review: null, escalate }) }
      catch (error) { if (hooks.signal.aborted) throw error; limitReached = true; hooks.transition('TESTING'); const again = await hooks.runChecks(); evidence.push(...again.evidence); break }
      continue
    }

    hooks.transition('REVIEWING')
    review = await hooks.review({ evidence: round.evidence, round: reviewCycles, previous: review })
    hooks.onReview?.(review)
    if (review.decision === 'request_changes') {
      if (reviewCycles >= limits.reviewCycles || attempts >= limits.total) { limitReached = true; break }
      reviewCycles += 1; attempts += 1
      hooks.transition('IMPLEMENTING')
      hooks.onRepairStarted?.({ attempt: attempts, limit: limits.total, reason: 'review_changes', signature: `review:${review.blockers}b${review.majors}m`, escalated: false })
      try { await hooks.repair({ reason: 'review_changes', attempt: attempts, failures: [], review, escalate: false }) }
      catch (error) { if (hooks.signal.aborted) throw error; limitReached = true; break }
      continue
    }
    break
  }

  hooks.transition('VERIFYING')
  const discovered = hooks.discovered
  return computeVerdict({
    discovered, evidence, finalTreeHash: hooks.treeHash(),
    review: review ?? reviewNotRun(limitReached ? 'Checks were still failing when the repair limit was reached, so the change was not sent for review.' : 'The review did not run.'),
    repairs: { attempts, limitReached },
  })
}
