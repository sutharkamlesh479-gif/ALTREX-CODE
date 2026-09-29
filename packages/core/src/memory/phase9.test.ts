import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Evidence, Verdict } from '@altrex/contracts'
import { ProjectMemory } from './project-memory'
import { rankCandidates, runTournament, type CandidateResult } from '../orchestrator/tournament'
import { acquireWorkspace, applyLease, leaseChanges, recoverLeases, releaseWorkspace, type WorkspaceLease } from '../workspace/lease'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
function temp(prefix: string) { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root }

const verdict = (status: 'PASS' | 'FAIL', evidenceId = 'ev1'): Verdict => ({
  status: status === 'PASS' ? 'VERIFIED' : 'FAILED', treeHash: 'T', review: { decision: 'approve', independence: 'same-model', reviewer: null, blockers: 0, majors: 0, findings: [] },
  checks: [{ name: 'test', status, evidenceId }, { name: 'lint', status: 'NOT_AVAILABLE' }], repairs: { attempts: 0, limitReached: false }, reasons: [],
})

describe('ProjectMemory', () => {
  it('records only evidence: a check becomes confirmed after passing twice and is reset by a contradiction', () => {
    let now = new Date('2026-09-01T00:00:00Z')
    const memory = new ProjectMemory(temp('altrex-mem-'), () => now), project = temp('altrex-proj-')
    const argv = new Map([['ev1', ['pnpm', 'run', 'test']]])
    expect(memory.recordVerdict(project, verdict('PASS'), argv)).toEqual(['check.test'])
    expect(memory.facts(project)[0]).toMatchObject({ key: 'check.test', value: 'pnpm run test → PASS', source: 'evidence', confidence: 'observed-once', evidenceId: 'ev1' })
    memory.recordVerdict(project, verdict('PASS'), argv)
    expect(memory.facts(project)[0]!.confidence).toBe('confirmed')
    memory.recordVerdict(project, verdict('FAIL'), argv)
    expect(memory.facts(project)[0]).toMatchObject({ value: 'pnpm run test → FAIL', confidence: 'observed-once' })
    // checks without evidence (NOT_AVAILABLE) and unknown evidence ids are never recorded
    expect(memory.facts(project).map(fact => fact.key)).toEqual(['check.test'])
    // aging: >30 days downgrades, >90 days drops
    memory.recordVerdict(project, verdict('PASS'), argv); memory.recordVerdict(project, verdict('PASS'), argv)
    now = new Date('2026-10-15T00:00:00Z')
    expect(memory.facts(project)[0]!.confidence).toBe('observed-once')
    now = new Date('2026-12-15T00:00:00Z')
    expect(memory.facts(project)).toEqual([])
  })

  it('renders user rules (ALTREX.md) and relevant facts as delimited data; supports user facts and forget', () => {
    const memory = new ProjectMemory(temp('altrex-mem-')), project = temp('altrex-proj-')
    writeFileSync(join(project, 'ALTREX.md'), 'Use tabs. Never edit generated files.')
    memory.recordFix(project, 'test:login > rejects bad password', 'Fixed by repair 1 in task t1.')
    memory.remember(project, 'deploy', 'Deploys run from the release branch only')
    const text = memory.render(project, 'fix the login password check')
    expect(text).toContain('<project_rules source="ALTREX.md" owner="user">\nUse tabs.')
    expect(text).toMatch(/<project_memory trust="evidence">[\s\S]*failure\.[0-9a-f]{12}: test:login > rejects bad password/)
    expect(text).toContain('user.deploy: Deploys run from the release branch only (user, confirmed)')
    expect(memory.forget(project, 'user.deploy')).toBe(true)
    expect(memory.forget(project, 'user.deploy')).toBe(false)
    expect(existsSync(join(project, '.altrex'))).toBe(false) // nothing is written into the repository
  })

  it('imports the legacy Multi-AI memory once', () => {
    const memory = new ProjectMemory(temp('altrex-mem-')), project = temp('altrex-proj-')
    const legacy = JSON.stringify({ spec: { secret: 'model-made spec is not imported' }, completed: [{ title: 'Login page', files: ['src/login.tsx'] }], knownIssues: [{ title: 'Build', error: 'tsc failed' }] })
    expect(memory.importLegacy(project, legacy)).toBe(2)
    expect(memory.importLegacy(project, legacy)).toBe(0)
    expect(JSON.stringify(memory.facts(project))).not.toContain('model-made spec')
  })
})

describe('tournament ranking', () => {
  const result = (candidate: number, overrides: Partial<CandidateResult>): CandidateResult => ({ candidate, endpoint: null, status: 'completed', changedFiles: ['a.ts'], conflicts: [], checks: [], changedLines: 10, ...overrides })
  it('prefers all declared checks passing, then more passes, then smaller changes; ineligible last', () => {
    const ranking = rankCandidates([
      result(0, { checks: [{ name: 'test', status: 'FAIL' }], changedLines: 2 }),
      result(1, { checks: [{ name: 'test', status: 'PASS' }], changedLines: 50 }),
      result(2, { checks: [{ name: 'test', status: 'PASS' }], changedLines: 20 }),
    ], ['test'])
    expect(ranking.map(item => item.candidate)).toEqual([2, 1, 0])
    const ineligible = rankCandidates([result(0, { status: 'failed', error: 'offline' }), result(1, { changedFiles: [] }), result(2, { conflicts: ['a.ts'] }), result(3, {})], ['test'])
    expect(ineligible.map(item => [item.candidate, item.eligible])).toEqual([[3, true], [0, false], [1, false], [2, false]])
    expect(ineligible.find(item => item.candidate === 2)!.reasons.join(' ')).toMatch(/conflicts/)
  })
})

describe('runTournament with real workspace leases', () => {
  it('runs candidates in isolation, applies only the winner, and releases every lease (never following links)', async () => {
    const base = temp('altrex-tour-'), projectPath = join(base, 'project'), leasesRoot = join(base, 'leases')
    mkdirSync(join(projectPath, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(projectPath, 'node_modules', 'dep', 'index.js'), 'dependency')
    writeFileSync(join(projectPath, 'value.txt'), 'original\n')
    const leases: WorkspaceLease[] = []
    const outcome = await runTournament<WorkspaceLease>({
      candidates: 3, declared: ['test'], signal: new AbortController().signal,
      acquire: () => { const lease = acquireWorkspace({ projectPath, leasesRoot }); symlinkSync(join(projectPath, 'node_modules'), join(lease.path, 'node_modules'), 'junction'); leases.push(lease); return lease },
      implement: async (candidate, lease) => { if (candidate === 1) throw new Error('provider offline'); writeFileSync(join(lease.path, 'value.txt'), `candidate ${candidate}\n`); return { providerId: `p${candidate}`, model: 'm' } },
      check: async (candidate): Promise<Evidence[]> => [{ evidenceId: `e${candidate}`, name: 'test', argv: ['t'], status: candidate === 2 ? 'PASS' : 'FAIL', exitCode: candidate === 2 ? 0 : 1, timedOut: false, durationMs: 1, treeHash: 'x', outputTail: '', at: new Date().toISOString() }],
      changes: lease => ({ ...leaseChanges(lease), changedLines: 1 }),
      apply: lease => applyLease(lease),
      release: lease => releaseWorkspace(lease, leasesRoot),
    })
    expect(outcome.winner).toBe(2)
    expect(outcome.applied).toEqual(['value.txt'])
    expect(readFileSync(join(projectPath, 'value.txt'), 'utf8')).toBe('candidate 2\n')
    expect(outcome.results.find(item => item.candidate === 1)).toMatchObject({ status: 'failed', error: 'provider offline' })
    for (const lease of leases) expect(existsSync(lease.path)).toBe(false)
    expect(readFileSync(join(projectPath, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('dependency') // links were unlinked, not followed
  })

  it('startup recovery removes leases left by a crash (including Git worktrees) and nothing else', () => {
    const base = temp('altrex-recover-'), projectPath = join(base, 'project'), leasesRoot = join(base, 'leases')
    mkdirSync(projectPath)
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const git = (...args: string[]) => spawnSync('git', args, { cwd: projectPath, encoding: 'utf8', env })
    writeFileSync(join(projectPath, 'a.txt'), 'a'); git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'init')
    const worktree = acquireWorkspace({ projectPath, leasesRoot })
    const copy = acquireWorkspace({ projectPath, leasesRoot, kind: 'copy' })
    mkdirSync(join(leasesRoot, 'stray-dir'))
    // crash: nothing released
    expect(recoverLeases(leasesRoot)).toBe(3)
    expect(existsSync(worktree.path) || existsSync(copy.path) || existsSync(join(leasesRoot, 'stray-dir'))).toBe(false)
    expect(git('worktree', 'list').stdout.trim().split('\n')).toHaveLength(1)
    expect(readFileSync(join(projectPath, 'a.txt'), 'utf8')).toBe('a')
    expect(recoverLeases(leasesRoot)).toBe(0)
  })
})
