# Agent Architecture & Task Lifecycle Specification (V4)

Location: `packages/core/src/orchestrator/`, `src/agents/`, `src/verification/`. Types: `packages/contracts/src/task.ts`.

## 1. Principles

1. **Code controls the workflow and models make judgments.** The Manager is a deterministic state machine. Planner, Coder, Debugger and Reviewer are LLM roles. The Tester is mostly deterministic command execution.
2. **Roles are specs, not models.** A role spec declares tools, output schema, routing requirements and budgets. The router picks the model per call (PROVIDER_SPEC §8).
3. **Every phase is bounded** by rounds, tool calls, wall time and repair attempts. Every bound that is hit is reported, never silently absorbed.
4. **Completion means evidence** (§7). Model prose is never proof.
5. **Everything is observable.** Every transition, agent run, model choice, tool call and check emits an event and is persisted.

## 2. Task model

```ts
type Task = {
  id: string; sessionId: string; projectId: string
  intent: 'change' | 'question'            // 'question' = old ASK mode: read-only, no implementation phases
  request: string                          // user text (plus attachment refs)
  routingMode: RoutingMode
  parallelism: 1 | 2 | 3                   // >1 = parallel executor (ex-Director)
  engine: 'altrex' | 'codex'               // external engine replaces IMPLEMENTING only
  state: TaskState
  plan: Plan | null
  checkpoints: CheckpointRef[]
  attempts: { review: number; repair: number }
  verdict: Verdict | null
  createdAt: string; updatedAt: string
}
```

### 2.1 State machine

```text
RECEIVED
  → UNDERSTANDING            classify intent/difficulty; detect missing info; load project profile + memory
  → REPOSITORY_ANALYSIS      context engine builds analysis pack (CONTEXT_ENGINE.md)
  → PLANNING                 Planner → Plan (validated); may loop once on validation failure
  → AWAITING_APPROVAL        only if policy requires plan approval or a HIGH-risk action is planned
  → IMPLEMENTING             checkpoint first; Coder (or parallel executor / external engine)
  → TESTING                  Tester runs required checks on current tree
      ├ fail → DEBUGGING → IMPLEMENTING-lite (Debugger edits) → TESTING    (bounded, §6)
  → REVIEWING                Reviewer (independent, §5)
      ├ changes requested → IMPLEMENTING (bounded: 2 review rounds)
  → VERIFYING                verdict computed by code from evidence (§7)
  → VERIFIED | COMPLETED_UNVERIFIED | FAILED
Any state → CANCELLED (user) ; any non-terminal state → INTERRUPTED (on restart after crash)
```

Transitions are defined in one table (`orchestrator/transitions.ts`). An illegal transition throws, and unit tests enumerate the table. For `intent: 'question'` the path is `RECEIVED → UNDERSTANDING → REPOSITORY_ANALYSIS → ANSWERING → COMPLETED` (answers are not "verified").

`INTERRUPTED` tasks can be **resumed** from their last completed phase if the working tree still matches the last recorded tree hash. Otherwise the user can restore the checkpoint or discard the task. This is the same rule the Director already applies to runs.

### 2.2 Implementation status (Phase 7, 2026-09-27)

- `packages/core/src/orchestrator/transitions.ts` — the state table above, plus two deliberate additions: `AWAITING_APPROVAL` is entered from PLANNING/IMPLEMENTING/TESTING/DEBUGGING while a HIGH-risk permission is pending and returns to the state that asked; `PLANNING → COMPLETED_UNVERIFIED` exists for engines that finish from planning. Tests enumerate the table (terminal states have no successors; only VERIFYING reaches VERIFIED; only ANSWERING reaches COMPLETED; every state is reachable).
- `orchestrator/task-manager.ts` — the Manager. Task ids are uuidv7 core ids (Phase 1 issue #8 fixed); legacy chat request ids are kept in `requestId` for correlation only. Agent runs (`agent.started/progress/completed/failed`) with role, label and endpoint. An engine that reports completion from a state without a direct edge is recorded as COMPLETED_UNVERIFIED (it did work) or FAILED `ENGINE_PROTOCOL` (it never started) — never as a plain success.
- `tasks/task-store.ts` — task records and per-task event history persisted under `userData/core/tasks/` (atomic writes; 300 tasks retained; 8 MB history per task, dropping deltas/command output first and flagging `eventsTruncated`). Phase 1 issue #7 fixed: history survives restarts (`task.list`, `task.get`, `task.events`).
- Crash recovery: tasks unfinished at startup become INTERRUPTED (`task.interrupted`); running agents are marked cancelled. **Nothing is resumed automatically** and no command is re-run.
- Agents today: CODER = ALTREX coding agent (round progress with tool names), OpenAI Codex (external engine), and one CODER per Director specialist task; PLANNER = Director planning; TESTER = Director project checks. DEBUGGER/REVIEWER/verification-owned TESTER runs come with Phase 8.
- `task.start` starts a task entirely through the core bridge; `task.cancel` cancels the engine behind it; `diff.available` + `checkpoint.diff` expose the task's changes.

## 3. Roles

| Role | Kind | Tools | Output | Routing requirement |
|---|---|---|---|---|
| Manager | code | — | transitions, budgets | — |
| Planner | LLM | read-only repo tools (`fs.read`, `fs.list`, `fs.search`, `repo.*`, `git.log`) | `Plan` (zod) | tools, structuredOutput preferred, `difficulty` from Understanding |
| Coder | LLM | read + write tools, `terminal.run` (policy-gated) | edits + `CoderReport` | tools; context ≥ pack size |
| Tester | code (+ optional LLM to map criteria → checks) | `test.*`, `build`, `lint`, `typecheck`, `terminal.run` | `Evidence[]` | — (LLM part: small tier) |
| Debugger | LLM | read tools, write tools, `terminal.run`, `test.run --target` | edits + `DiagnosisReport` | tools; `POWERFUL` bias on repeated failure |
| Reviewer | LLM | read-only tools, `git.diff` | `Review` (zod) | tools; `preferDifferentFrom: coderEndpoint` |

```ts
type RoleSpec = {
  id: RoleId
  systemPrompt: (ctx: PromptContext) => string       // prompts live in agents/prompts/*.ts, versioned
  tools: ToolName[]
  output?: ZodSchema                                   // validated; 2 correction attempts then fail
  routing: Omit<RoutingRequest, 'mode' | 'exclude' | 'estimatedInputTokens' | 'carriesRepositoryData'>
  budget: { rounds: number; toolCalls: number; wallMs: number }
}
```

One `AgentRunner` executes any RoleSpec. It evolves from today's `runCodingAgent` and Director worker loop, and keeps their behaviour: nudging models that describe instead of acting, `TaskBudget` loop detection, and preserving work on provider failure.

### 3.1 Plan schema

```ts
type Plan = {
  summary: string
  difficulty: 'trivial' | 'standard' | 'hard'
  steps: Array<{ id: string; description: string; files: string[]; dependsOn: string[] }>
  acceptanceCriteria: Array<{
    id: string                                   // "AC1"
    statement: string
    verifiedBy: 'check' | 'command' | 'file' | 'reviewer'
    check?: { kind: 'test' | 'build' | 'typecheck' | 'lint'; target?: string }
    command?: { argv: string[]; expectExit: number }   // policy-gated like any command
    file?: { path: string; mustExist: boolean; contains?: string }
  }>
  risks: string[]
  requiresApproval: boolean                      // planner flags HIGH-risk intent (deletions, migrations, deps)
  parallel?: TaskContract[]                      // existing Director DAG contract; enables parallel executor
}
```

The Planner cannot mark a criterion `reviewer` if a mechanical check is feasible. Code rejects plans where more than half of the criteria are `reviewer`-only for a `change` task on a project with discovered checks, and asks the Planner to strengthen them. Code also appends mandatory criteria: required project checks must pass, and no unrelated files may change.

## 4. Agent loop contract

Per round: `route → gateway.stream (text + tool calls streamed) → execute tool calls through the policy engine → append results → budget check`. Rules:

- Tool results go back to the model as data. Failures are tool errors, not exceptions.
- File writes require a current read-hash (TOOL_SYSTEM §4). Stale writes are rejected with guidance to re-read.
- On a mid-task model failure the gateway falls back. The runner keeps history and file state and tells the new model it is continuing.
- Streaming text is forwarded as `agent.message_delta`. Reasoning deltas are not forwarded by default.
- A run ends when the model returns no tool calls **and** the role's exit condition is met (Coder: at least one change or an explicit "no change needed" justification; Planner/Reviewer: valid schema output).

## 5. Reviewer independence

The Reviewer receives a **fresh context**, not the Coder's conversation:

- the original request, the Plan and its acceptance criteria;
- the final diff (`git.diff` against the task checkpoint), plus read access to the full tree;
- the evidence list (commands, exit codes, parsed results);
- project rules (`ALTREX.md`) and relevant memory.

The router is asked to `preferDifferentFrom` the Coder's endpoint. The review records `independence: 'different-provider' | 'different-model' | 'same-model'`, and the UI shows it honestly. Output:

```ts
type Review = {
  decision: 'approve' | 'request_changes'
  findings: Array<{ severity: 'blocker' | 'major' | 'minor' | 'nit'; category: 'bug' | 'regression' | 'security' | 'incomplete' | 'architecture' | 'test-gap' | 'style'; file?: string; line?: number; description: string }>
  criteria: Array<{ id: string; assessment: 'met' | 'not_met' | 'cannot_determine'; rationale: string }>
}
```

Any `blocker` or `major` finding forces `request_changes` in code regardless of the model's `decision`. Findings are passed to the Coder in the next IMPLEMENTING round.

## 6. Repair loop

```text
TESTING fails → failure signature = hash(check name + first failing test ids / first error lines normalized)
DEBUGGING: Debugger gets failing output (compacted, failure-first), diff so far, relevant files
         → DiagnosisReport { rootCause, evidence, fixPlan } → edits → back to TESTING
Stop conditions:
  - checks pass → continue to REVIEWING
  - same signature seen twice with no tree change between → escalate: router mode POWERFUL / different model, once
  - repair attempts ≥ 3 per signature or ≥ 6 total → FAILED (work retained, checkpoint offered)
  - regression: a previously passing check now fails → Debugger is told explicitly; if unresolved, restore to last green checkpoint
```

A checkpoint is taken after every green TESTING (`checkpoint.created` with label `green-<n>`), so a bad repair can be rolled back to the last known-good state.

## 7. Verification and evidence

```ts
type Evidence = {
  id: string
  kind: 'check' | 'command' | 'file' | 'review'
  name: string                      // 'build' | 'test' | 'typecheck' | 'lint' | criterion id …
  argv?: string[]; cwd?: string
  exitCode?: number | null; timedOut?: boolean; durationMs?: number
  treeHash: string                  // git write-tree of worktree (temp index) or snapshot digest
  parsed?: { passed?: number; failed?: number; skipped?: number; failingTests?: string[] }  // only if parser recognized output
  outputRef: string                 // artifact file (full output), not inlined
  at: string
}

type Verdict = {
  status: 'VERIFIED' | 'COMPLETED_UNVERIFIED' | 'FAILED'
  treeHash: string
  checks: Array<{ name: 'build' | 'test' | 'typecheck' | 'lint'; status: 'PASS' | 'FAIL' | 'NOT_RUN' | 'NOT_AVAILABLE'; evidenceId?: string; summary?: string }>
  acceptance: Array<{ id: string; status: 'PASS' | 'FAIL' | 'REVIEWER_ATTESTED' | 'UNVERIFIED'; evidenceIds: string[] }>
  review: { decision: 'approve' | 'request_changes' | 'not_run'; independence: string; blockers: number }
  reasons: string[]
}
```

Verdict rules, computed by code in `verification/verdict.ts`:

- Only evidence whose `treeHash` equals the **final** tree hash counts. Checks run before the last edit are stale.
- `VERIFIED` ⇔ every discovered required check is `PASS` on the final tree, **and** every acceptance criterion is `PASS` (or `REVIEWER_ATTESTED` only when its type is `reviewer`), **and** the review is `approve` with 0 blockers.
- `COMPLETED_UNVERIFIED` ⇔ no failures, but at least one required item is `NOT_AVAILABLE`/`UNVERIFIED` (for example the project has no test script). The reason is spelled out.
- `FAILED` ⇔ any required check or criterion failed at the end of the repair budget.
- There are no confidence percentages. The UI renders counts: `TESTS 84/84 PASS` only when `parsed` exists, otherwise `test: exit 0`.

Check discovery evolves from `multi-ai/verification.ts` `projectChecks` (package manager detection, typecheck/test/build scripts, Cargo, Go, pytest) plus lint, plus project memory ("commands that worked"). The existing **source-integrity check** (a check must not modify source files) is kept.

### 7.1 Implementation status (Phase 8, 2026-09-27)

`packages/core/src/verification/`:

- `tester.ts` — the Tester runs the checks the project declares (project profile; never invented) through the permission policy, installs missing Node dependencies with lifecycle scripts disabled, and records `Evidence` bound to the tree hash it ran against. A check that modifies source files is recorded as ERROR (source-integrity rule kept from the Director).
- `tree-hash.ts` — digest of the source tree excluding ignored directories and protected files (build output does not change it; any source edit does); Git tree id fallback for very large repositories.
- `parsers.ts` — vitest, jest, pytest, node:test (TAP), cargo and go output parsers; failure signatures normalized for line numbers and timings.
- `review.ts` — reviewer prompts (fresh context: request, diff against the task checkpoint, real evidence), strict JSON output validated by `ReviewOutputSchema`, two format corrections, blocker/major findings force `request_changes`, honest `independence` (`unknown` when the coder is not a single known endpoint). The reviewer runs with the `read_only` permission profile and read tools only, and is routed away from the coder's endpoint (`differentFrom`).
- `engine.ts` — `verifyAndRepair`: TESTING → DEBUGGING (Debugger agent, failure-first output) → TESTING … → REVIEWING → IMPLEMENTING (review findings) … → VERIFYING. Limits: 3 repairs per failure signature, 6 in total, 2 review cycles; a signature that returns with no tree change escalates once to the POWERFUL routing mode, then stops.
- `verdict.ts` — the rules of §7, with one explicit choice: **VERIFIED requires a declared test suite** that passed. Projects with only build/typecheck/lint end COMPLETED_UNVERIFIED with the reason "behavior was not tested".
- `util/text-diff.ts` — LCS unified diff used for the reviewer (round-trips through `applyUnifiedPatch`).

Applied to every change task with file changes: ALTREX coding agent (with repair), OpenAI Codex (checks + review; no repair by Codex), Multi-AI Director (checks + review on the integrated tree; the Director owns its own repairs). The coding agent no longer spends model rounds asking itself to run checks when the Tester verifies afterwards. Deferred: green checkpoints after each passing TESTING round, acceptance criteria from a Planner `Plan` (the request is reviewed as a whole), full-output artifact files.

## 8. Parallel executor (ex-Director) and tournament

- When `Plan.parallel` is present, IMPLEMENTING delegates to the parallel executor, which is today's `Director` minus its own planning and publication. It keeps: the DAG contract validation, ownership scopes, ≤3 workers, per-attempt isolated workspaces, merge conflict detection, `request_dependency`, and live revisions. Isolation moves to Git worktrees when the project is a Git repo (TOOL_SYSTEM §6).
- **Tournament mode** (later phase): N Coders (N ≤ 3, different endpoints when possible) implement the same Plan in separate worktrees. Each candidate goes through TESTING (and bounded DEBUGGING). Candidates are ranked by code: required checks pass > acceptance PASS count > fewer changed lines outside plan files > reviewer blockers. An independent Reviewer compares the top candidates' diffs and may only choose among candidates that passed checks. The winner is applied through the normal publication path. Losing worktrees are retained until the task closes. Model confidence is never a ranking input.

### 8.1 Implementation status (Phase 9, 2026-09-27)

- `packages/core/src/orchestrator/tournament.ts`: `rankCandidates` (eligible = finished, changed files, no conflicts; then all declared checks pass > more passes > fewer failures > fewer changed lines; model confidence is not an input) and `runTournament` (≤3 candidates in parallel, each in a workspace lease; winner applied with the conflict-safe `applyLease`; every lease released).
- Wired for AGENT mode through `task.start { candidates: 2 | 3 }`: candidate *i* starts on a different endpoint (rotated provider order), runs the coding agent inside its lease with the project's permission profile, then the Tester runs the project's checks in the lease. Events `tournament.candidate` / `tournament.selected`. The winner is then verified on the real project like any task (checks, review, repair). If no candidate is applicable the task fails and the project is untouched.
- Leases share the project's `node_modules` through a junction/symlink (read-mostly) to avoid reinstalling per candidate; releasing a lease always unlinks such links first, so cleanup can never follow them into the project (tested).
- Recovery: leases are registered in `userData/core/leases/leases.json`; at startup every registered lease (and stray directory under the leases root) is removed and Git worktrees are detached. Tasks running at a crash become INTERRUPTED (Phase 7); nothing is resumed and no command is re-run automatically.
- Deferred: an independent reviewer comparing the top candidates' diffs before selection, and keeping losing candidates until the task closes (they are released immediately after selection).

## 9. External engine (Codex)

`engine: 'codex'` replaces only the IMPLEMENTING phase. ALTREX still checkpoints before, detects changed files through Git/snapshot diff, runs TESTING/DEBUGGING (the Debugger may be ALTREX's own), REVIEWING and VERIFYING. The Codex approval auto-accept policy changes to go through the ALTREX policy engine (SECURITY_MODEL §4).

## 10. Budgets (defaults)

| Scope | Default |
|---|---|
| Planner | 12 rounds, 40 tool calls, 5 min |
| Coder | TaskBudget 12/22/32 rounds by difficulty (existing), 15 commands, 40 writes |
| Debugger | 10 rounds per attempt |
| Reviewer | 10 rounds, read-only |
| Repair | 3 per signature, 6 total |
| Review cycles | 2 |
| Task wall time | 60 min (configurable) |

Hitting a budget produces `FAILED` or `COMPLETED_UNVERIFIED` with the reason `budget_exhausted:<scope>`, and the work is retained.

## 11. Memory hooks

At task end the engine records evidence-backed facts only (MEMORY section of CONTEXT_ENGINE.md): commands that passed, detected frameworks, and recurring failure signatures with their fixes. Model claims are not recorded as facts.
