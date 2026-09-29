# Test Strategy (V4)

## 1. Baseline

At audit time: `pnpm test` → 25 files / **101 tests passing** (vitest 3, ~26 s). `pnpm typecheck` and `pnpm build` pass. Existing strengths to keep:

- Real child processes and real temp directories for the tool broker, command runner, verification and Director tests (Windows shim and tree-kill cases included).
- Deterministic `FixtureProvider` driving the real Director end to end.
- Loopback HTTP / stubbed-fetch transport tests for the OpenAI-compatible provider, 413 compaction, long streams, retries and cancellation.
- React integration test through a test-only `DesktopApi` fixture.

Gaps: no conformance suite for providers, no SSE edge cases (split frames, keep-alives, malformed), no streamed tool calls, no circuit-breaker timing tests, no router decision tests beyond name heuristics, no state-machine tests, no security classifier tests, no fixture repositories for full task E2E, and no live-provider opt-in suite with recorded results.

## 2. Rules

1. `pnpm test` never touches the network except loopback, never needs an API key, never spends quota, and finishes in under 2 minutes.
2. Every bug fix gets a regression test first (red → green).
3. Refactors of existing modules are preceded by **characterization tests** that pin current behaviour (Phase 1).
4. Time-dependent logic (retries, breakers, deadlines) uses an injected clock (`Clock` interface) or vitest fake timers. There are no real sleeps over 100 ms in unit tests.
5. Tests assert on normalized codes and event sequences, not on user-facing message wording, except for a dedicated message snapshot test.
6. Nothing reports PASS in the product that was not executed. Tests guard that too: verdict tests feed stale-hash evidence and expect `COMPLETED_UNVERIFIED`/`FAILED`.

## 3. Test infrastructure to build

### 3.1 Fake OpenAI-compatible server (`core/src/testing/fake-openai-server.ts`)

A real `node:http` server on `127.0.0.1:0`, scripted per test:

```ts
const server = await startFakeOpenAi({
  models: [{ id: 'fake-coder', context_length: 32000, supported_parameters: ['tools'] }],
  script: [
    reply.stream(['Hel', 'lo']),                       // SSE text in chunks
    reply.streamToolCall({ name: 'read_file', args: { path: 'a.ts' }, splitArgsInto: 3 }),
    reply.status(429, { retryAfter: 2, body: rateLimitBody }),
    reply.status(401), reply.status(404, modelNotFoundBody), reply.status(413, contextBody(8192)),
    reply.status(500), reply.status(503),
    reply.hang('beforeHeaders'), reply.hang('afterFirstChunk'),
    reply.malformedSse(), reply.disconnectAfter(2 /*chunks*/),
    reply.toolsUnsupported(), reply.finishLength(), reply.keepAliveComments(3),
  ],
})
// server.requests → recorded bodies/headers (assert redaction, params, tool schemas)
```

A matching `fake-gemini-server.ts` is added for the native Gemini adapter.

### 3.2 Scripted model (`ScriptedModel`)

An in-process `ProviderAdapter` that returns scripted turns by matching on role and turn index. It generalizes the existing `FixtureProvider`, and is used for orchestrator/agent E2E where HTTP isn't the subject.

### 3.3 Fixture repositories (`packages/core/test/fixtures/repos/`)

| Fixture | Content | Used for |
|---|---|---|
| `node-auth-bug` | tiny TS module + vitest; `login()` accepts wrong password | full pipeline: plan → edit → test fail → debug → pass → review → VERIFIED |
| `node-no-tests` | JS without scripts | `COMPLETED_UNVERIFIED` path |
| `python-bug` | pytest project with failing test | non-JS check discovery + parser |
| `regression-trap` | fixing A naively breaks B's test | regression detection + green checkpoint restore |
| `non-git` | plain folder | snapshot checkpoints |
| `monorepo` | pnpm workspace, 2 packages | check discovery, scoped tests |

Fixtures are copied to a temp directory per test (and `git init`-ed where needed). They are never edited in place.

### 3.4 Helpers

`FakeClock`, `collectEvents(bus)`, `expectEventSequence([...])`, `tempProject(fixture)`, `withGitRepo()`.

## 4. Test levels

### 4.1 Unit (fast, pure)

| Area | Examples |
|---|---|
| Error normalization | table test: every status × body pattern → `GatewayErrorCode`, retryable, fallback, breaker effect (migrate existing classifier corpus) |
| SSE parser | CRLF/LF, split frames, multi-line data, comments, `[DONE]`, invalid JSON, oversized frame |
| Tool-call assembly | split argument deltas, parallel indexes, missing id, invalid JSON at finish |
| Circuit breaker | CLOSED→OPEN after 3 in 60 s, cooldown doubling, HALF_OPEN single trial, latched AUTH/QUOTA |
| Router | hard filters per mode (LOCAL_ONLY never returns cloud, FREE_ONLY, consent), capability `null` handling, diversity of fallbacks, pinned CUSTOM, reviewer `preferDifferentFrom`, deterministic ordering |
| Capabilities/registry | precedence user > probe > usage > discovery > hint, migration from old `models.json` |
| Context engine | budget math from contextWindow, pinned overflow error, supersession, tool-output aging, 413 shrink |
| Task state machine | every legal transition, illegal transitions throw, INTERRUPTED resume rules |
| Verdict | stale tree hash ignored, NOT_AVAILABLE → COMPLETED_UNVERIFIED, blocker forces request_changes |
| Security | command classifier table, path guard (traversal, symlink, reserved names, protected reads), redactor formats |
| Timeouts | each deadline raises its own code (fake clock) |

### 4.2 Integration (real I/O, loopback only)

- **Adapter conformance** (PROVIDER_SPEC §12) against the fake servers: every scenario in 3.1 for each adapter/preset configuration.
- **Gateway**: retry then success; 429 with Retry-After within and beyond the threshold; fallback across profiles with events `model.request_failed` → `model.fallback` → success; all endpoints failing → aggregated user message; cancellation during connect, stream and retry sleep; no replay after delivered content.
- **Health**: probe ladder stops at the first hard failure; persisted states reload and age correctly.
- **Tools**: existing broker and command-runner tests, plus stale-write rejection, patch atomicity, ripgrep search, git checkpoint create/restore on a real repo (user index untouched, untracked files included), worktree lease and cleanup, process registry kills background processes on task cancel.
- **Secret flow**: resolved key appears in the fake server's `Authorization` header and **nowhere** in logs, events or persisted files (scan the temp userData directory after the test).

### 4.3 End-to-end (core, headless, scripted models + fake server)

| Scenario | Expectation |
|---|---|
| open project → "fix login bug" on `node-auth-bug` | events RECEIVED…VERIFIED in order; diff touches only planned files; Verdict checks PASS with evidence on the final tree hash |
| seeded failure | TESTING fail → DEBUGGING → TESTING pass, repair count 1 |
| regression-trap | regression detected; the green checkpoint is used or the task FAILs with retained work |
| cancel mid-IMPLEMENTING | `task.cancelled`; no child process alive; checkpoint offered |
| provider unavailable (503 ×3) | breaker opens; fallback endpoint completes the task; `model.fallback` emitted |
| invalid API key | profile → AUTH_ERROR; routed around; if it is the only profile, the task FAILs with the plain message "API key rejected" |
| all providers down | FAILED with the aggregated explanation; no infinite retry (bounded request count asserted on the fake server) |
| LOCAL_ONLY with fake cloud server running | zero requests to the cloud server |
| app restart mid-task | store reload → INTERRUPTED → resume from last completed phase |
| no tests project | COMPLETED_UNVERIFIED with reason |

#### 4.3.1 Implementation status (Phase 11, 2026-09-27)

End-to-end scenarios run in `apps/desktop/src/main/hardening.scenarios.test.ts` through the real stack: two loopback HTTP providers (`custom`, `nim-local`) → gateway (SSE, deadlines, retries, breaker) → router → coding agent → tools → verification → task events and persistence. A scripted responder answers as coder, debugger or reviewer depending on the request it receives.

| Scenario | Where | Result asserted |
|---|---|---|
| HTTP 500/502/503/504 on the primary | scenarios | fallback.started/completed with PROVIDER_SERVER_ERROR; task completes; provider.health_changed |
| HTTP 429 + Retry-After | scenarios | retried on the same provider; no fallback |
| HTTP 413 | scenarios | retry with budgets reduced to 65% (max_tokens drops, input never grows) |
| first-token timeout | scenarios | TIMEOUT fallback; stalled request actually closed |
| malformed stream | scenarios | same model retried without streaming |
| connection dropped mid-stream | scenarios | fallback; work kept |
| all providers down | scenarios | FAILED with fallback.failed and a real reason; bounded requests |
| unsupported tool call | scenarios | tool error returned to the model; agent recovers |
| failing test → repair → VERIFIED | scenarios, provider-service.phase8 | real `npm run test`; repair count 1; verdict VERIFIED |
| build keeps failing | scenarios | FAILED after bounded repairs; never VERIFIED on the model's word |
| cancellation mid-request | scenarios | CANCELLED; agents cancelled; HTTP request aborted; nothing after the terminal event |
| restart mid-task | scenarios, task-manager.test | history kept; running task INTERRUPTED; **no request re-sent** (no automatic resume, by requirement) |
| checkpoint restore | scenarios, checkpoints.test | exactly the task's changes reverted; later user edits kept |
| long conversation compaction | scenarios, budget.test | earlier requirements shortened in labelled stages instead of failing |
| concurrent tasks in two projects | scenarios | isolated task ids, files, checkpoints and events |
| Ollama unavailable in LOCAL mode | scenarios | FAILED clearly; zero cloud requests (skipped automatically if a real Ollama is running) |
| secrets | scenarios | the key (even echoed in a 401 body) appears in no event, history, response, request body or state file |
| no-tests project | verification.test, scenarios | COMPLETED_UNVERIFIED with the reason |
| approvals / FORBIDDEN / read-only | project-tools.test, provider-service.phase6, core-host.phase10 | denied with explanations; approvals task-scoped; never silently approved |

Not implemented: the opt-in live suite (§4.5) and the regression-trap/green-checkpoint scenario (green checkpoints are deferred).

### 4.4 Desktop (Electron)

- The existing smoke launch (`ALTREX_SMOKE_TEST=1`) plus a bridge round-trip for the new command/event channels.
- IPC validation tests: malformed payloads are rejected, wrong sender is rejected.
- Legacy `ChatStreamEvent` compatibility adapter tests, so the current UI keeps working during migration.
- UI behaviour tests belong to the frontend team. Core exposes a `FakeCore` for them.

### 4.5 Live (opt-in, manual or nightly, never in `pnpm test`)

`ALTREX_LIVE=1 pnpm test:live --profile <id>` runs the conformance subset (catalog, completion, streaming, tools) against real saved profiles, with a hard request cap and a printed cost warning. Results are written to `docs/live-validation/<date>.md` with provider, model, pass/fail per probe and latency, and no secrets. Live results are evidence, not assumptions.

## 5. Tests to write first (Phase 1)

In priority order. These protect the refactor and the most failure-prone code:

1. **Characterization**: `budgetContext` (current compaction behaviour), `RequestManager` retry/413/429 paths with a fake clock, `classifyProviderHttpError` full corpus (extend the existing 3 tests to a table), `RoleRouter` fallback order.
2. **Fake OpenAI server + SSE edge cases** against the *current* `OpenAiCompatibleProvider`, which documents today's gaps (streamed tool calls expected to fail, marked `it.todo`/`it.fails` until Phase 2).
3. **Startup does not block on Ollama** (unit test of lazy start) and **the Ollama process started by ALTREX is stopped on quit**.
4. **Pre-task checkpoint for Agent mode** (snapshot-based quick win): write then restore returns the original bytes, and user edits made after the checkpoint are preserved.
5. **Contracts**: zod schema round-trip for every event and command type in `packages/contracts`.
6. **Command classifier** table (written before the classifier replaces the allowlist).
7. **Disconnect isolation**: disconnecting provider A does not cancel requests on provider B (regression test for the current bug).

## 6. CI

A GitHub Actions matrix (windows-latest, ubuntu-latest; Node 22 LTS and current): `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, plus a lint rule that `packages/core` has no `electron` import. Packaging smoke on Windows only for release branches. Coverage is reported but not gated, except `gateway/`, `router/`, `security/` and `verification/`, which must stay ≥ 85% lines.
