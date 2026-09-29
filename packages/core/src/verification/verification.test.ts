import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CheckName, Evidence, ReviewSummary, TaskState } from '@altrex/contracts'
import { failureSignature, parseTestOutput } from './parsers'
import { computeVerdict } from './verdict'
import { verifyAndRepair, type RepairRequest } from './engine'
import { discoverChecks, runChecks, type TesterEvent } from './tester'
import { parseReviewOutput, reviewIndependence, reviewNotRun, summarizeReview, ReviewFormatError } from './review'
import { treeHash } from './tree-hash'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'altrex-verify-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content) }
  return root
}
let counter = 0
const evidence = (name: CheckName, status: Evidence['status'], tree = 'T1', extra: Partial<Evidence> = {}): Evidence => ({ evidenceId: `ev${++counter}`, name, argv: ['pnpm', 'run', name], status, exitCode: status === 'PASS' ? 0 : status === 'NOT_RUN' ? null : 1, timedOut: false, durationMs: 10, treeHash: tree, outputTail: '', at: new Date().toISOString(), ...extra })
const approve: ReviewSummary = { decision: 'approve', independence: 'different-provider', reviewer: { providerId: 'google', model: 'g' }, blockers: 0, majors: 0, findings: [] }
const changes: ReviewSummary = { ...approve, decision: 'request_changes', blockers: 1, findings: [{ severity: 'blocker', category: 'bug', description: 'Broken' }] }
const noRepairs = { attempts: 0, limitReached: false }

describe('test output parsers', () => {
  it('reads vitest, jest, pytest, node:test, cargo and go summaries', () => {
    expect(parseTestOutput(' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed | 1 skipped (43)\n × src/a.test.ts > adds 3ms')).toMatchObject({ passed: 40, failed: 2, skipped: 1, failingTests: ['src/a.test.ts > adds'] })
    expect(parseTestOutput('  ● sum › adds\nTests:       1 failed, 12 passed, 13 total')).toEqual({ passed: 12, failed: 1, failingTests: ['sum › adds'] })
    expect(parseTestOutput('FAILED tests/test_a.py::test_x - assert 1 == 2\n==== 1 failed, 10 passed in 0.12s ====')).toEqual({ passed: 10, failed: 1, failingTests: ['tests/test_a.py::test_x'] })
    expect(parseTestOutput('# tests 6\n# pass 5\n# fail 1')).toEqual({ passed: 5, failed: 1 })
    expect(parseTestOutput('---- math::adds stdout ----\ntest result: FAILED. 3 passed; 1 failed; 0 ignored')).toEqual({ passed: 3, failed: 1, skipped: 0, failingTests: ['math::adds'] })
    expect(parseTestOutput('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)')).toEqual({ passed: 1, failed: 1, failingTests: ['TestB'] })
    expect(parseTestOutput('built in 3.2s')).toBeUndefined()
  })
  it('failure signatures ignore line numbers and timings but keep the failing identity', () => {
    const a = failureSignature('typecheck', 'src/a.ts:10:5 - error TS2322: Type string is not assignable (12ms)')
    const b = failureSignature('typecheck', 'src/a.ts:14:9 - error TS2322: Type string is not assignable (40ms)')
    expect(a).toBe(b)
    expect(failureSignature('test', '', { failingTests: ['x > y'] })).toBe('test:x > y')
  })
})

describe('computeVerdict', () => {
  it('VERIFIED only with a passing test suite, all declared checks passing on the final tree, and an approving review', () => {
    const verdict = computeVerdict({ discovered: ['typecheck', 'test'], evidence: [evidence('typecheck', 'PASS'), evidence('test', 'PASS', 'T1', { parsed: { passed: 84, failed: 0 } })], finalTreeHash: 'T1', review: approve, repairs: noRepairs })
    expect(verdict.status).toBe('VERIFIED')
    expect(verdict.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'test', status: 'PASS', summary: expect.stringContaining('84 passed, 0 failed') }), { name: 'lint', status: 'NOT_AVAILABLE' }]))
  })
  it('evidence from an older tree is stale and cannot verify', () => {
    const verdict = computeVerdict({ discovered: ['test'], evidence: [evidence('test', 'PASS', 'T1')], finalTreeHash: 'T2', review: approve, repairs: noRepairs })
    expect(verdict.status).toBe('COMPLETED_UNVERIFIED')
    expect(verdict.reasons.join(' ')).toMatch(/stale/)
  })
  it('a failing check on the final tree is FAILED, whatever the reviewer says', () => {
    expect(computeVerdict({ discovered: ['test', 'build'], evidence: [evidence('test', 'PASS'), evidence('build', 'FAIL')], finalTreeHash: 'T1', review: approve, repairs: { attempts: 6, limitReached: true } })).toMatchObject({ status: 'FAILED', reasons: [expect.stringMatching(/build failed .*repair limit/)] })
  })
  it('no test suite, no checks, or no review is COMPLETED_UNVERIFIED with the reason spelled out', () => {
    expect(computeVerdict({ discovered: ['build'], evidence: [evidence('build', 'PASS')], finalTreeHash: 'T1', review: approve, repairs: noRepairs }).reasons.join(' ')).toMatch(/No test suite is declared; build passed/)
    expect(computeVerdict({ discovered: [], evidence: [], finalTreeHash: 'T1', review: approve, repairs: noRepairs })).toMatchObject({ status: 'COMPLETED_UNVERIFIED', reasons: [expect.stringMatching(/declares no build, test/)] })
    expect(computeVerdict({ discovered: ['test'], evidence: [evidence('test', 'PASS')], finalTreeHash: 'T1', review: reviewNotRun('No reviewer model is available.'), repairs: noRepairs }).reasons.join(' ')).toMatch(/No independent review: No reviewer model/)
    expect(computeVerdict({ discovered: ['test'], evidence: [evidence('test', 'NOT_RUN', 'T1', { note: 'Not run: policy' })], finalTreeHash: 'T1', review: approve, repairs: noRepairs }).status).toBe('COMPLETED_UNVERIFIED')
  })
  it('a reviewer that still requests changes at the end is FAILED', () => {
    expect(computeVerdict({ discovered: ['test'], evidence: [evidence('test', 'PASS')], finalTreeHash: 'T1', review: changes, repairs: { attempts: 2, limitReached: true } }).status).toBe('FAILED')
  })
})

describe('reviewer output', () => {
  it('parses JSON in fences, forces request_changes on blocker/major, and reports independence', () => {
    const output = parseReviewOutput('Here is my review:\n```json\n{"decision":"approve","findings":[{"severity":"major","category":"bug","description":"Off by one"}]}\n```')
    expect(summarizeReview(output, { providerId: 'google', model: 'g' }, 'different-provider')).toMatchObject({ decision: 'request_changes', majors: 1 })
    expect(() => parseReviewOutput('Looks great to me!')).toThrow(ReviewFormatError)
    expect(reviewIndependence({ providerId: 'nvidia', model: 'a' }, { providerId: 'google', model: 'b' })).toBe('different-provider')
    expect(reviewIndependence({ providerId: 'nvidia', model: 'a' }, { providerId: 'nvidia', model: 'b' })).toBe('different-model')
    expect(reviewIndependence({ providerId: 'nvidia', model: 'a' }, { providerId: 'nvidia', model: 'a' })).toBe('same-model')
  })
})

describe('verifyAndRepair', () => {
  function engine(script: { checks: Array<Evidence['status'][]>; reviews?: ReviewSummary[]; repairChangesTree?: boolean }) {
    const states: TaskState[] = [], repairs: RepairRequest[] = []
    let round = 0, reviewRound = 0, tree = 1
    const hooks = {
      discovered: ['test'] as CheckName[],
      runChecks: async () => {
        const statuses = script.checks[Math.min(round++, script.checks.length - 1)]!
        const items = statuses.map(status => evidence('test', status, `T${tree}`, { outputTail: status === 'PASS' ? '' : 'Error: expected 1 to be 2' }))
        return { evidence: items, outputs: new Map(items.map(item => [item.evidenceId, item.outputTail])) }
      },
      review: async () => script.reviews?.[Math.min(reviewRound++, script.reviews.length - 1)] ?? approve,
      repair: async (request: RepairRequest) => { repairs.push(request); if (script.repairChangesTree !== false) tree += 1 },
      treeHash: () => `T${tree}`,
      transition: (state: TaskState) => { if (states.at(-1) !== state) states.push(state) },
      signal: new AbortController().signal,
    }
    return { hooks, states, repairs }
  }

  it('repairs a failing check, re-tests, reviews and verifies on the final tree', async () => {
    const { hooks, states, repairs } = engine({ checks: [['FAIL'], ['PASS']] })
    const verdict = await verifyAndRepair(hooks)
    expect(states).toEqual(['TESTING', 'DEBUGGING', 'TESTING', 'REVIEWING', 'VERIFYING'])
    expect(repairs).toHaveLength(1)
    expect(repairs[0]!.failures[0]!.output).toContain('expected 1 to be 2')
    expect(verdict).toMatchObject({ status: 'VERIFIED', repairs: { attempts: 1, limitReached: false } })
  })

  it('stops after the per-signature limit and reports FAILED without claiming a review', async () => {
    const { hooks, repairs } = engine({ checks: [['FAIL']] })
    const verdict = await verifyAndRepair(hooks, { perSignature: 3, total: 6, reviewCycles: 2 })
    expect(repairs).toHaveLength(3)
    expect(verdict).toMatchObject({ status: 'FAILED', repairs: { attempts: 3, limitReached: true }, review: { decision: 'not_run' } })
  })

  it('escalates once when a repair changes nothing, then stops', async () => {
    const { hooks, repairs } = engine({ checks: [['FAIL']], repairChangesTree: false })
    const verdict = await verifyAndRepair(hooks)
    expect(repairs.map(request => request.escalate)).toEqual([false, true])
    expect(verdict.repairs.limitReached).toBe(true)
  })

  it('sends reviewer findings back for a bounded number of review cycles', async () => {
    const { hooks, states, repairs } = engine({ checks: [['PASS']], reviews: [changes, changes, changes] })
    const verdict = await verifyAndRepair(hooks, { perSignature: 3, total: 6, reviewCycles: 2 })
    expect(repairs.map(request => request.reason)).toEqual(['review_changes', 'review_changes'])
    expect(repairs[0]!.review?.findings[0]?.description).toBe('Broken')
    expect(states).toEqual(['TESTING', 'REVIEWING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'VERIFYING'])
    expect(verdict.status).toBe('FAILED')
  })

  it('honors the total repair budget and cancellation', async () => {
    const controller = new AbortController()
    const { hooks } = engine({ checks: [['FAIL']] })
    controller.abort()
    await expect(verifyAndRepair({ ...hooks, signal: controller.signal })).rejects.toThrow()
  })
})

describe('Tester (real commands)', () => {
  it('runs declared checks, records evidence on the tree it ran against, and emits test events', async () => {
    const root = project({ 'package.json': '{"name":"x","scripts":{"test":"node test.js"}}', 'test.js': 'console.log("# pass 3"); console.log("# fail 0")', 'fail.js': 'console.error("Error: boom"); process.exit(2)' })
    const events: TesterEvent[] = []
    const result = await runChecks({ root, checks: [{ name: 'test', argv: ['node', 'test.js'], source: 't' }, { name: 'build', argv: ['node', 'fail.js'], source: 't' }], signal: new AbortController().signal, onEvent: event => events.push(event) })
    expect(result.evidence.map(item => [item.name, item.status, item.exitCode])).toEqual([['test', 'PASS', 0], ['build', 'FAIL', 2]])
    expect(result.evidence[0]!.parsed).toEqual({ passed: 3, failed: 0 })
    expect(result.evidence[0]!.treeHash).toBe(treeHash(root))
    expect(result.evidence[1]!.outputTail).toContain('Error: boom')
    expect(events.map(event => event.type)).toEqual(['test.started', 'test.completed', 'test.started', 'test.completed'])
  })

  it('flags a check that modifies source, and never runs checks the policy forbids', async () => {
    const root = project({ 'mutate.js': 'require("fs").writeFileSync("src.js", "changed")', 'src.js': 'original' })
    const result = await runChecks({ root, checks: [{ name: 'test', argv: ['node', 'mutate.js'], source: 't' }, { name: 'lint', argv: ['node', '-e', '1'], source: 't' }], signal: new AbortController().signal })
    expect(result.evidence[0]).toMatchObject({ status: 'ERROR', note: expect.stringContaining('modified project source') })
    expect(result.evidence[1]).toMatchObject({ status: 'NOT_RUN', note: expect.stringContaining('FORBIDDEN') })
  })

  it('discovers only declared checks, in a stable order', () => {
    expect(discoverChecks({ commands: [{ kind: 'build', argv: ['pnpm', 'run', 'build'], source: 's' }, { kind: 'test', argv: ['pnpm', 'run', 'test'], source: 's' }, { kind: 'typecheck', argv: ['pnpm', 'run', 'typecheck'], source: 's' }] }).map(check => check.name)).toEqual(['typecheck', 'test', 'build'])
  })

  it('tree hash ignores build output but changes with source', () => {
    const root = project({ 'src/a.ts': 'a' })
    const before = treeHash(root)
    mkdirSync(join(root, 'dist')); writeFileSync(join(root, 'dist', 'a.js'), 'built')
    expect(treeHash(root)).toBe(before)
    writeFileSync(join(root, 'src/a.ts'), 'b')
    expect(treeHash(root)).not.toBe(before)
  })
})
