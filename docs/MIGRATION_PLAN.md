# Migration Plan: ALTREX (current) → ALTREX V4

Strategy: **strangler migration**. New core modules are built beside the existing code. Old entry points are rewired to them one path at a time, behind the existing IPC contract. Old code is deleted only after its replacement passes the same tests. The app stays shippable after every phase.

Each phase ends with: `pnpm typecheck`, `pnpm test`, `pnpm build` passing, the smoke launch passing, a Git commit, and a short evidence note appended to this file (§Phase log).

## Phase 0 — Audit ✅ (2026-09-26)

- Repository placed under Git (baseline `55cf3ab`; `.pnpm-store/` ignored; LF pinned).
- Existing validation: typecheck PASS, 101/101 tests PASS, build PASS.
- Docs: CURRENT_ARCHITECTURE, V4_ARCHITECTURE, MIGRATION_PLAN, PROVIDER_SPEC, AGENT_SPEC, TOOL_SYSTEM, CONTEXT_ENGINE, SECURITY_MODEL (rewritten), TEST_STRATEGY.

## Phase 1 — Foundations and safety quick wins ✅ (2026-09-26, pending review)

Goal: packages exist, tests protect the refactor, and the two most dangerous current defects are fixed.

1. Create `packages/contracts` (zod) and `packages/core` (no Electron). Add tsconfig project references, vitest workspace, and a "no electron import in core" test.
2. Move pure modules into core **with re-exports from their old paths** (no behaviour change): `provider-errors`, `request-policy`, `context-manager`, `task-budget`, `multi-ai/contracts`, `multi-ai/workspace`, `project-command-runner`, `abortableDelay`. Consolidate the four ignore-directory lists into one constant.
3. Write the Phase 1 tests from TEST_STRATEGY §5 (characterization, fake OpenAI server, contracts round-trip, classifier table as `todo`).
4. **Quick win A**: make the Ollama start lazy (on first use of an Ollama profile) and track/stop only the process ALTREX started. Removes the up-to-~90 s startup block and the orphaned process.
5. **Quick win B**: pre-task snapshot checkpoint for AGENT/LOCAL/CODEX modes, using the existing `snapshot`/`copyWorkspace`, plus an internal `restore` API (no UI yet; exposed through IPC for the UI team).
6. **Quick win C**: `disconnect(providerId)` aborts only that provider's requests.
7. Publish `packages/contracts` event/command schemas (V4_ARCHITECTURE §9) so the UI team can start building against `FakeCore`.

Exit: existing 101 tests + new tests green; smoke launch green; startup time measured before and after.

## Phase 2 — Universal Model Gateway ✅ (2026-09-27)

1. `gateway/` types (PROVIDER_SPEC §3), `GatewayError` + table (§5), SSE parser with **streamed tool-call assembly**, `DeadlineController` (connect / first-token / idle / overall), retry policy, `Redactor`, structured logger.
2. `OpenAICompatibleAdapter` extracted from `openai-compatible.ts` + `request-manager.ts` + `provider-adapters.ts`. Model-name body hacks become registry `paramProfile` data.
3. `ModelGateway` with injectable transport and clock. Conformance suite green against the fake server.
4. **Shim**: `OpenAiCompatibleProvider` (used by `RoleRouter`, `agent-runner`, `Director`) is re-implemented on top of the gateway, keeping its `complete`/`stream` signatures. All existing tests must pass unchanged.
5. ASK mode switches to gateway streaming. AGENT mode switches to streamed turns (text deltas reach the UI during agent work).

Exit: conformance suite green; the existing Director/agent tests pass through the shim; no provider wire-format code remains outside `gateway/adapters/`.

## Phase 3 — Provider adapters, health, registry, credentials ✅ (2026-09-27)

1. Presets as data: `openrouter`, `nvidia-hosted`, `groq`, `ollama`, `custom` (covers local NIM, vLLM, LM Studio and tunnels), `gemini-openai-compat`. Legacy presets (`openai`, `cerebras`, `sambanova`, `cloudflare`) are kept and marked community-tested.
2. Discovery metadata parsing (OpenRouter pricing/context/params, Groq context_window, Ollama `/api/show`).
3. Native `GeminiAdapter` + fake Gemini server conformance.
4. Health probe ladder, 8-state profile health, per-model health, circuit breaker, persisted `health.json`. `AUTH_ERROR` is no longer shown as OFFLINE.
5. `SecretStore` (host) / `SecretResolver` (core). **Credential migration**: read `credentials/provider.json` and `.profiles`, create profiles with `credentialRef` pointing at the existing ciphertext (moved, not decrypted to disk), map `providerId` → preset (`google` → `gemini-openai-compat`, `nvidia` → `nvidia-hosted`, the rest 1:1), and keep a backup of the old files until the first successful load. `keyHint` is captured during migration.
6. Registry migration from `multi-ai/models.json` (role history preserved). Remove hard-coded model preference lists. "Suggested model" moves to `presets.json` and is validated against discovery.
7. Order of *verification* (live, opt-in): the user's primary cloud provider → OpenRouter → Ollama/custom → Gemini native → NVIDIA hosted → Groq. Implementation shares one adapter, so the order only affects live validation effort.

Exit: conformance suite green for all presets; migration test with fixture legacy credential files; the provider status IPC reports real probe-backed states.

## Phase 4 — Router, modes, fallback ✅ (2026-09-27)

1. Pure `route()` (PROVIDER_SPEC §8) replacing `selectCodingModelCandidates`, `routedConnections` and `ModelRegistry.rank`. The name heuristic survives only as a labelled weak prior.
2. Modes AUTO/FAST/POWERFUL/FREE_ONLY/LOCAL_ONLY/CUSTOM, a consent filter, and reviewer diversity.
3. `router.preview` IPC. Events `model.selected` (with reasons) and `model.fallback`.
4. Gateway uses routing chains, and `RoleRouter` becomes a thin wrapper over it (Director and agent-runner are unchanged).

Exit: router table tests; E2E "provider unavailable" and "invalid key" scenarios green with scripted models.

## Phase 5 — Context engine and repository intelligence

1. File index (`git ls-files` / walk), ripgrep search, regex outline (5a), import graph, test mapping, project profile.
2. ContextItem/ContextPack, model-aware budgets, supersession, tool-output aging, turn summaries. Removes the `Repository context:\n` string coupling.
3. `repository-context.ts` and `context-manager.ts` are retired once their callers use packs.
4. 5b (later in the phase): `web-tree-sitter` symbols and references.

Exit: retrieval fixture tests (known-relevant files included under budget); budget tests per model window.

## Phase 6 — Tool system, policy, checkpoints

1. ToolDefinition registry + executor pipeline. Port the six existing tools, then add `fs.search`, `fs.patch`, `fs.delete`, `fs.move`, `terminal.start/read/stop`, `git.*`, `test.*`, `repo.*`.
2. ReadLedger stale-write protection. Protected-path read denial.
3. Command classifier replaces the executable allowlist. Permission profiles, project trust, approvals (`task.approval_required` / `task.approve`), action log.
4. Git-based checkpoints (private refs, temp index). Snapshot checkpoints remain for non-Git projects. Worktree leases.
5. Codex approvals are routed through the policy engine.
6. Attachments move to `userData`.

Exit: security test list (SECURITY_MODEL §10) green; checkpoint restore tests on real Git repos.

## Phase 7 — Task engine and agent orchestration

1. Session store (JSONL events + snapshots), event bus with `seq`, `events.subscribe(afterSeq)`.
2. Task state machine and the role specs Planner/Coder/Tester/Debugger/Reviewer. The AgentRunner is generalized from `runCodingAgent`.
3. All modes are routed through the task engine (V4_ARCHITECTURE §7 table). The legacy `ChatStreamEvent` is emitted by a compatibility adapter.
4. The Director becomes the parallel executor used when `Plan.parallel` is set. Its planning moves to the Planner and its publication to `workspace/`.

Exit: E2E scenarios for plan → implement → test → review with scripted models; the Director test suite passes through the executor.

## Phase 8 — Verification and repair loop

Evidence records bound to tree hashes, check discovery (from `multi-ai/verification.ts`), output parsers, verdict computation, Debugger loop with signatures/escalation/green checkpoints, independent Reviewer with a fresh context.

Exit: E2E `node-auth-bug`, `regression-trap`, `node-no-tests`, `python-bug` produce the expected verdicts.

## Phase 9 — Memory, isolation, recovery

Project memory from evidence, `ALTREX.md` pinning, import of old Multi-AI memory, resume of INTERRUPTED tasks, worktree-based parallel execution, and tournament mode (AGENT_SPEC §8) once the above is stable.

Exit: restart-recovery E2E; tournament fixture selecting the candidate that passes checks.

## Phase 10 — Frontend integration contracts

The contracts are published in Phase 1 and implemented incrementally. This phase finishes the command/event surface, freezes `v: 1`, provides `FakeCore` for UI tests, documents it in `docs/FRONTEND_CONTRACT.md`, and removes the legacy `ChatStreamEvent` adapter once the UI team confirms migration.

## Phase 11 — Hardening

Move the core into an Electron `utilityProcess` (the heavy fs/hash work leaves the UI thread). Add performance budgets (index a 50k-file repo without UI jank), live-validation runs recorded under `docs/live-validation/`, CI matrix, packaging smoke, dependency audit, and doc cleanup.

## Deletion schedule

| Remove | After |
|---|---|
| `describeProviderFailure`, unused `bodyExtras`, `testStrategy` | Phase 1 |
| startup `ensureLocalAiServer` await | Phase 1 |
| `provider-adapters.ts` model-name hacks, legacy `FailureKind` | Phase 2 |
| `selectNvidiaCodingModel`, hard-coded model lists, `routedConnections`, `ModelRegistry.rank` | Phase 4 |
| `testConfigured`/`testWorkflows` in `ProviderService` (→ `core/diagnostics` + live test suite) | Phase 3 |
| `repository-context.ts`, `context-manager.ts` | Phase 5 |
| executable allowlist, `ProjectToolBroker` | Phase 6 |
| `runCodingAgent` non-router fallback path, `ProviderService.streamChat` dispatch | Phase 7 |
| `ProviderService` (split into profile service, gateway host, task host) | Phase 7 |
| legacy `ChatStreamEvent` | Phase 10 (with the UI team) |
| `docs/ALTREX_ARCHITECTURE.md` (superseded; retained for history until then) | Phase 11 |

## Data migrations

| Data | Migration | When |
|---|---|---|
| `credentials/provider.json(.profiles)` | → profiles + secret store, ciphertext moved; old files kept as `.bak` until verified | Phase 3 |
| `multi-ai/models.json` | → `core/models.json` with field mapping; role history kept | Phase 3 |
| `multi-ai/provider-models.json` | discarded (re-discovered) | Phase 3 |
| `multi-ai/<runId>/` runs | remain readable via `run:list` until Phase 10; new runs live under the task store | Phase 7 |
| `multi-ai/memory-<hash>.json` | imported into project memory | Phase 9 |
| renderer `localStorage` conversations | UI team decides; the core offers `session.import` | Phase 10 |

Every migration is idempotent, keeps the source until the destination is verified, and is covered by a test using fixture files in the old format.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Refactor breaks working Director/agent flows | Shims keep old signatures; the existing 101 tests must stay green at every step |
| Live providers behave differently from fakes | Opt-in live suite per phase, results recorded; capability `null` until observed |
| Credential migration loses keys | Move ciphertext without decrypting; keep `.bak`; migration test; fall back to the old reader if the new store fails |
| UI team blocked on contracts | Contracts + `FakeCore` published in Phase 1 |
| Scope creep (30 providers, swarm) | Provider count fixed at the presets above; parallelism capped at 3 until Phase 11 |

## Phase log

- **Phase 0** — 2026-09-26 — audit complete; baseline `55cf3ab`; typecheck/test (101)/build PASS; live providers not exercised.
- **Phase 1** — 2026-09-26 — foundations and safety fixes. Evidence: `pnpm typecheck` PASS (contracts, core, desktop); `pnpm test` 277 passed / 0 failed / 17 todo (contracts 36, core 80 + 17 todo, desktop 161, which includes all 101 original tests unchanged); `pnpm build` PASS; smoke launch PASS with `bridge=connected core=contract-v1`. Startup, same machine and conditions (bundled Ollama runtime visible): baseline smoke 28.6 s and left an orphaned `ollama.exe`; Phase 1 smoke 14.6 s / 14.5 s with no Ollama process started. Regression tests for disconnect isolation and agent checkpointing were mutation-checked (they fail against the old behaviour). Live providers were not exercised. Deviations from the plan:
  - No tsconfig project references. The packages are consumed as TypeScript source through package `exports` and typecheck independently; electron-vite bundles them (devDependencies), so nothing new is packaged.
  - The checkpoint store is a new async, content-addressed implementation (`core/workspace/checkpoints.ts`) rather than a direct reuse of the synchronous Director `snapshot`/`copyWorkspace`. It reuses their path guard, ignore list and limits, and avoids blocking the Electron main thread on every agent task.
  - Added so the contract is real rather than schemas only: `CoreHost` (validated command handler), `window.altrexCore` preload bridge, and `LegacyEventBridge` (ChatStreamEvent → contract-v1 events). `FakeCore` stays in Phase 10 as planned.
  - The command classifier table exists only as `it.todo` specification rows (plan item 3); the classifier itself is Phase 6.
- **Phase 2** — 2026-09-27 — Universal Model Gateway. `RequestManager` → `core/gateway/request-executor.ts` and provider dialects → `core/gateway/adapters/openai-dialects.ts` (desktop shims kept). New: `ModelGateway`, incremental `SseParser`, `ToolCallAssembler`, OpenAI-compatible stream/completion adapter, stream error categories, per-model `supportsStreamingTools` capability with explicit non-streamed fallback. The Phase 1 `it.fails` marker for streamed tool calls is now a passing test. Evidence: typecheck PASS; tests 324 passed / 0 failed / 17 todo (contracts 36, core 121, desktop 167); build PASS; smoke PASS. Deviation: the error taxonomy extends the existing category names instead of renaming them, because the UI already consumes them.
- **Phase 3** — 2026-09-27 — Provider infrastructure: native Gemini adapter, self-hosted NIM preset, OpenRouter/Groq/vLLM/Ollama/Gemini discovery metadata, 8-state provider health with a formal circuit breaker and latched states, persisted health with aging, `ENDPOINT_NOT_FOUND` vs model-level 404, `PROVIDER_DISCONNECTED` precise disconnect, key hints with legacy migration, and contract `provider.list` / `model.list` / `provider.health_changed`. Phase 1 characterization rows marked "V4 change" updated deliberately (auth now latches `AUTH_ERROR`; the breaker opens at 3 failures). Evidence: typecheck PASS; tests 373 passed / 0 failed / 17 todo (contracts 41, core 155, desktop 177); build PASS; smoke PASS. Deviation: the SecretResolver/credentialRef split was deferred (see PROVIDER_SPEC status).
- **Phase 4** — 2026-09-27 — Smart router: pure `route()` (filters with reasons, mode-specific scoring, provider-diverse fallbacks, labelled heuristics), `RoleRouter` rebuilt on it with structured routing events, modes AUTO/FAST/POWERFUL/FREE_ONLY/LOCAL_ONLY/CUSTOM through `ChatRequest.routingMode`, `router.preview`. Fixed issue #5: Ollama starts only when a local model is actually selected. `ModelRegistry.rank` deleted; the legacy bridge no longer fabricates `model.selected`. Evidence: typecheck PASS; tests 410 passed / 0 failed / 17 todo (contracts 48, core 178, desktop 184); build PASS; smoke PASS.
- **Phase 5** — 2026-09-27 — Repository intelligence (git-aware index, ripgrep/builtin search, symbol outlines, import graph, related tests, project profile), task-driven retrieval with provenance, model-aware input budgets (context window from registry), tool-output supersession/aging, contract repo.* and context.preview commands. Evidence: typecheck PASS; tests 446 passed / 0 failed / 17 todo; build PASS. Smoke not re-run for this phase.
- **Phase 6** — 2026-09-27 — Tools, security, workspace and Git. Argv command classifier (LOW/MEDIUM/HIGH/FORBIDDEN) replaces the executable allowlist; permission profiles `read_only`/`standard`/`autonomous` persisted per project; `ApprovalBroker` (HIGH asks; denied with explanation when no approval UI is connected; task-scoped grants; cancellation denies); new tools `apply_patch`, `delete_file`, `move_file`, `find_symbol`, `git_status`, `git_diff`, recursive/glob `list_files`; read-ledger stale-write protection; command events; Git helpers (temp-index snapshot commits under `refs/altrex`, worktrees); Git-backed checkpoint fallback for large projects; empty directories removed on restore; worktree/copy workspace leases with conflict-safe apply; attachments moved out of the user repository; contract `permission.*`, `tool.denied`, `command.started/output/completed` events and `permission.configure/pending/respond`, `project.permissions` commands. Real bugs found by the new tests: patches ending in a newline failed to apply (the terminator was read as an empty context line); restore never removed empty directories (`fs.rm` without `recursive` rejects directories). Evidence: typecheck PASS; tests 541 passed / 0 failed / 0 todo (contracts 66, core 282, desktop 193); build PASS; smoke PASS. Deviations are listed in SECURITY_MODEL §4.5.
- **Phase 7** — 2026-09-27 — Task engine and agents. Core `TaskManager` (uuidv7 task ids, validated transition table, agent runs with roles, approval pause/resume), `TaskStore` (persisted records + per-task event history, bounded), crash recovery to INTERRUPTED without auto-resume, `LegacyEventBridge` reduced to an adapter over the Manager (Director planner/workers/checks mapped to agent runs), ProviderService agent runs for the coding agent and Codex with round progress, `diff.available` after each checkpointed task, contract `agent.*`, `diff.available`, `task.interrupted` events and `task.start/cancel/list/get/events`, `checkpoint.diff` commands. Fixed Phase 1 issues #7 (history lost on restart) and #8 (task ids = chat request ids). Characterization tests updated deliberately ("V4 Phase 7 change"): task ids are no longer request ids; Director runs emit agent events. Evidence: typecheck PASS; tests 577 passed / 0 failed (contracts 79, core 302, desktop 196); build PASS; smoke PASS. `test.started/completed` and `task.verified` are added in Phase 8 together with their producer (the verification engine).
- **Phase 8** — 2026-09-27 — Verification and auto-repair. Core Tester (declared checks through the policy, evidence bound to tree hashes, source-integrity rule), test-output parsers, verdict rules computed by code, independent reviewer (read-only, routed away from the coder, strict JSON, blocker/major force changes), bounded repair loop (3 per signature, 6 total, 2 review cycles, one escalation), LCS unified diff. Wired into Agent/Local (with Debugger/Coder repair), Codex (checks + review) and Multi-AI (checks + review). Contract `test.started/completed`, `repair.started`, `review.completed`, `verification.completed`, `task.verified`, `TaskSummary.verdict`. Real bug found by tests: the vitest summary parser missed the space before the total. Evidence: typecheck PASS; tests 615 passed / 0 failed (contracts 86, core 330, desktop 199; the Phase 8 end-to-end tests run a real `npm run test`); build PASS; smoke PASS. The Phase 7 characterization of an Agent task now also shows its (not run) review — updated deliberately.
- **Phase 9** — 2026-09-27 — Memory, recovery and multi-agent/tournament foundation. Evidence-only project memory (checks, fixed failure signatures, detected stack, user facts; aging and contradiction rules; legacy Multi-AI memory imported once without its model-written spec), user-owned `ALTREX.md` rules pinned into project context, memory commands/events; engine reports fixed signatures; tournament ranking and runner with isolated leases, wired as `task.start { candidates }` for AGENT mode; lease registry with startup recovery (worktrees detached, strays removed); lease release unlinks junctions/symlinks before any removal. No automatic resume anywhere (tasks → INTERRUPTED; leases → removed). Evidence: typecheck PASS; tests 633 passed / 0 failed (contracts 93, core 339, desktop 201); build PASS; smoke PASS.
- **Phase 10** — 2026-09-27 — Backend contract freeze. Structured error model (`CoreError` codes; `toCoreError` in core; CoreHost `handleResult`; the IPC always answers with a result envelope; preload `invoke` throws `CODE: message`, new `invokeResult`), remaining UI capabilities as contract commands (`project.open/list`, `session.list` + `sessionId` on tasks, `provider.connect/disconnect/test/refresh`, `tool.list`, `git.status/diff`, `checks.discover/run`, `terminal.run/cancel` via the core `UserTerminal`), FakeCore (scripted, contract-validated bridge for UI work) and the v1 snapshot freeze test. Real bugs found by tests: FakeCore lost an approval answered synchronously (registered after announcing); a cancelled terminal command resolved as a normal exit. Evidence: typecheck PASS; tests 662 passed / 0 failed (contracts 115, core 341, desktop 206); build PASS; smoke PASS (bridge=connected core=contract-v1 through the new envelope).
- **Phase 11** — 2026-09-27 — Hardening. End-to-end scenario suite through the real stack (two loopback HTTP providers → gateway → router → agent → tools → verification → events/persistence): HTTP 413/429/500/502/503/504, first-token timeout, malformed stream, mid-stream disconnect, all providers down, unsupported tool call, repair to VERIFIED, persistent build failure, cancellation, restart (INTERRUPTED, nothing re-sent), checkpoint restore, long-conversation compaction, concurrent tasks, Ollama unavailable in LOCAL mode, and a secret audit across events, history, responses, request bodies and state files. Real bug found: every earlier user turn was a mandatory requirement, so any conversation longer than the input budget failed outright; earlier requirements are now shortened in explicitly labelled stages (the latest request and instructions never are). Windows packaging validated (Phase 1 issue #13): NSIS + portable built from the final code into a scratch directory, release verifier PASS, packaged executable smoke PASS. Evidence: typecheck PASS; tests 683 passed / 0 failed / 0 todo (contracts 115, core 342, desktop 226); build PASS; smoke PASS at 100/125/150 % scale; packaged smoke PASS. Handoff: `docs/CODEX_HANDOFF.md`.
