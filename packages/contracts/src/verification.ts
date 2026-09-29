import { z } from 'zod'

export const CheckNameSchema = z.enum(['build', 'test', 'typecheck', 'lint'])
export type CheckName = z.infer<typeof CheckNameSchema>

export const ParsedTestCountsSchema = z.object({
  passed: z.int().nonnegative().optional(),
  failed: z.int().nonnegative().optional(),
  skipped: z.int().nonnegative().optional(),
  failingTests: z.array(z.string().max(300)).max(50).optional(),
})

/** One real check execution. Evidence is produced by code (the Tester), never by a model. */
export const EvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  name: CheckNameSchema,
  argv: z.array(z.string()).min(1),
  status: z.enum(['PASS', 'FAIL', 'TIMEOUT', 'ERROR', 'NOT_RUN']),
  exitCode: z.int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.int().nonnegative(),
  /** Tree the check ran against. Only evidence on the final tree counts toward a verdict. */
  treeHash: z.string(),
  /** Present only when an output parser recognized the runner's output. */
  parsed: ParsedTestCountsSchema.optional(),
  /** Failure-focused tail of the output (≤4 KB). */
  outputTail: z.string().max(4096),
  /** Why the check did not run (policy, missing dependencies, …). */
  note: z.string().max(1000).optional(),
  at: z.iso.datetime(),
})
export type Evidence = z.infer<typeof EvidenceSchema>

export const ReviewFindingSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  category: z.enum(['bug', 'regression', 'security', 'incomplete', 'architecture', 'test-gap', 'style']),
  file: z.string().max(500).optional(),
  line: z.int().positive().optional(),
  description: z.string().min(1).max(2000),
})

export const ReviewSummarySchema = z.object({
  /** Blocker or major findings force `request_changes`, whatever the model decided. */
  decision: z.enum(['approve', 'request_changes', 'not_run']),
  independence: z.enum(['different-provider', 'different-model', 'same-model', 'unknown', 'none']),
  reviewer: z.object({ providerId: z.string(), model: z.string() }).nullable(),
  blockers: z.int().nonnegative(),
  majors: z.int().nonnegative(),
  findings: z.array(ReviewFindingSchema).max(50),
  /** Why the review did not run, when `decision` is `not_run`. */
  note: z.string().max(1000).optional(),
})
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>

export const VerdictSchema = z.object({
  status: z.enum(['VERIFIED', 'COMPLETED_UNVERIFIED', 'FAILED']),
  treeHash: z.string(),
  checks: z.array(z.object({
    name: CheckNameSchema,
    status: z.enum(['PASS', 'FAIL', 'NOT_RUN', 'NOT_AVAILABLE']),
    evidenceId: z.string().optional(),
    summary: z.string().max(500).optional(),
  })).max(20),
  review: ReviewSummarySchema,
  repairs: z.object({ attempts: z.int().nonnegative(), limitReached: z.boolean() }),
  /** Plain-language reasons for the status. No confidence percentages. */
  reasons: z.array(z.string().max(1000)).max(20),
})
export type Verdict = z.infer<typeof VerdictSchema>

export const verificationEventSchemas = {
  'test.started': z.object({ testId: z.string(), name: CheckNameSchema, command: z.string().max(1000) }),
  'test.completed': z.object({ testId: z.string(), evidence: EvidenceSchema }),
  'review.completed': ReviewSummarySchema,
  /** A bounded repair round began (`check_failed`: a check failed; `review_changes`: the reviewer requested changes). */
  'repair.started': z.object({ attempt: z.int().positive(), limit: z.int().positive(), reason: z.enum(['check_failed', 'review_changes']), signature: z.string().max(200), escalated: z.boolean() }),
  /** The verdict, computed by code from evidence. Precedes the terminal task event. */
  'verification.completed': VerdictSchema,
  /** Terminal (`VERIFIED`). */
  'task.verified': z.object({ verdict: VerdictSchema }),
} as const

/** What the Reviewer model must return (validated; not an event). */
export const ReviewOutputSchema = z.object({
  decision: z.enum(['approve', 'request_changes']),
  findings: z.array(ReviewFindingSchema).max(50).default([]),
  summary: z.string().max(4000).optional(),
})
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>
