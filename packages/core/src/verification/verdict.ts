import type { CheckName, Evidence, ReviewSummary, Verdict } from '@altrex/contracts'

const ALL_CHECKS: CheckName[] = ['typecheck', 'lint', 'test', 'build']

export type VerdictInput = {
  /** Checks the project declares. */
  discovered: CheckName[]
  evidence: Evidence[]
  /** Tree hash at the end of the task. Only evidence on this tree counts. */
  finalTreeHash: string | null
  review: ReviewSummary
  repairs: { attempts: number; limitReached: boolean }
}

const describe = (item: Evidence): string => {
  if (item.parsed && (item.parsed.passed !== undefined || item.parsed.failed !== undefined)) return `${item.parsed.passed ?? 0} passed, ${item.parsed.failed ?? 0} failed`
  if (item.status === 'TIMEOUT') return 'timed out'
  return item.exitCode === null ? item.status.toLowerCase() : `exit ${item.exitCode}`
}

/**
 * The verdict, computed by code from evidence (AGENT_SPEC.md §7). A model's claims never count.
 *  - VERIFIED: a test check exists and passed, every other declared check passed — all on the final tree —
 *    and an independent review approved with no blocker or major finding.
 *  - FAILED: a declared check failed on the final tree, or the reviewer still requested changes when the
 *    repair budget ran out.
 *  - COMPLETED_UNVERIFIED: no failure, but something required is missing (no test suite, stale or unrun
 *    checks, no review). The reasons say what.
 */
export function computeVerdict(input: VerdictInput): Verdict {
  const reasons: string[] = []
  const current = (item: Evidence) => input.finalTreeHash !== null && item.treeHash === input.finalTreeHash
  const checks: Verdict['checks'] = ALL_CHECKS.map(name => {
    if (!input.discovered.includes(name)) return { name, status: 'NOT_AVAILABLE' as const }
    const latest = [...input.evidence].reverse().find(item => item.name === name)
    if (!latest) return { name, status: 'NOT_RUN' as const, summary: 'Not run.' }
    if (latest.status === 'NOT_RUN') return { name, status: 'NOT_RUN' as const, evidenceId: latest.evidenceId, summary: (latest.note ?? 'Not run.').slice(0, 500) }
    if (!current(latest)) return { name, status: 'NOT_RUN' as const, evidenceId: latest.evidenceId, summary: 'The files changed after this check ran; its result is stale.' }
    return { name, status: latest.status === 'PASS' ? 'PASS' as const : 'FAIL' as const, evidenceId: latest.evidenceId, summary: `${latest.argv.join(' ')}: ${describe(latest)}${latest.note ? ` (${latest.note})` : ''}`.slice(0, 500) }
  })
  const declared = checks.filter(check => check.status !== 'NOT_AVAILABLE')
  const failed = declared.filter(check => check.status === 'FAIL')
  const notRun = declared.filter(check => check.status === 'NOT_RUN')
  const test = checks.find(check => check.name === 'test')!

  let status: Verdict['status']
  if (failed.length) {
    status = 'FAILED'
    reasons.push(`${failed.map(check => check.name).join(', ')} failed on the final tree${input.repairs.limitReached ? ' after the repair limit was reached' : ''}.`)
  } else if (input.review.decision === 'request_changes') {
    status = 'FAILED'
    reasons.push(`The reviewer still requested changes (${input.review.blockers} blocker, ${input.review.majors} major) when the repair budget ran out.`)
  } else {
    status = 'VERIFIED'
    if (input.finalTreeHash === null) { status = 'COMPLETED_UNVERIFIED'; reasons.push('The project tree could not be fingerprinted, so no evidence can be tied to the final files.') }
    if (!declared.length) { status = 'COMPLETED_UNVERIFIED'; reasons.push('The project declares no build, test, typecheck or lint checks, so nothing could be executed as evidence.') }
    else if (test.status === 'NOT_AVAILABLE') { status = 'COMPLETED_UNVERIFIED'; reasons.push(`No test suite is declared; ${declared.filter(check => check.status === 'PASS').map(check => check.name).join(', ') || 'no other check'} passed, but behavior was not tested.`) }
    if (notRun.length) { status = 'COMPLETED_UNVERIFIED'; for (const check of notRun) reasons.push(`${check.name}: ${check.summary ?? 'not run'}`) }
    if (input.review.decision === 'not_run') { status = 'COMPLETED_UNVERIFIED'; reasons.push(`No independent review: ${input.review.note ?? 'the reviewer did not run.'}`) }
    if (status === 'VERIFIED') reasons.push(`All declared checks passed on the final tree and the ${input.review.independence === 'same-model' ? 'reviewer (same model as the coder)' : 'independent reviewer'} approved with no blocking findings.`)
  }
  return { status, treeHash: input.finalTreeHash ?? 'unknown', checks, review: input.review, repairs: input.repairs, reasons: reasons.slice(0, 20).map(reason => reason.slice(0, 1000)) }
}
