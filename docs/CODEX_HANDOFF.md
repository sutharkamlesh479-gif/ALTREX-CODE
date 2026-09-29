# ALTREX CODE V4 — Core/Backend Handoff to Codex + GPT-6 Astra

Status: Claude-owned backend/core phases 0–11 complete (tags `phase-1-complete` … `phase-11-complete`).
Date: 2026-09-27. This document is the entry point for the frontend/product phase.

---

## 1. Architecture in one page

```text
┌──────────────────────── Electron renderer (React) ────────────────────────┐
│  YOUR WORK. Talks to the core ONLY through window.altrexCore (contract v1) │
│  (window.altrex = legacy V3 API, still used by today's UI; migrate off it) │
└───────────────▲──────────────────────────────────────────┬────────────────┘
      core:event│ (validated AltrexEvent envelopes)        │core:command (name, request)
┌───────────────┴──────────── preload (contextIsolation) ──▼────────────────┐
│ window.altrexCore = { contractVersion, onEvent, invoke, invokeResult }     │
└───────────────▲──────────────────────────────────────────┬────────────────┘
┌───────────────┴──────────── Electron main (apps/desktop/src/main) ─────────┐
│ CoreHost: validates every command/response against @altrex/contracts,     │
│           maps failures to CoreError, owns trust checks                    │
│ ProviderService: request flow (Ask/Agent/Local/Multi-AI/Codex/tournament) │
│ LegacyEventBridge: legacy chat stream → TaskManager                        │
│ index.ts: wiring, IPC, lease recovery, task recovery, smoke mode           │
└───────────────▲────────────────────────────────────────────────────────────┘
┌───────────────┴──────────── @altrex/core (pure Node, never imports electron)
│ gateway/   ModelGateway, SSE, tool-call assembly, request executor         │
│            (deadlines, retries, 413 shrink, breaker, 8-state health)       │
│ router/    pure route(): filters with reasons, modes, fallbacks            │
│ orchestrator/ TaskManager (state machine, agents), tournament, transitions │
│ verification/ Tester, verdict, reviewer, repair loop, parsers, tree hash   │
│ tools/     ProjectToolBroker (agent tools), UserTerminal, patch, runner    │
│ security/  command classifier, policy, approvals, PermissionCenter         │
│ workspace/ checkpoints (snapshot + Git fallback), leases, snapshot         │
│ repo/ context/ memory/ git/ tasks/ events/ errors                          │
└────────────────────────────────────────────────────────────────────────────┘
```

Principles the backend enforces (keep them visible in the UI):
- **Nothing is shown as done unless it happened.** Provider health is measured; tests are real command runs (`Evidence`); "VERIFIED" is computed by code from evidence (`Verdict`), never from model text; agents appear only when they actually run.
- **Secrets never reach the renderer.** Keys are sent once (`provider.connect`), stored encrypted in main, redacted from every event, error and log; only a 4-character `keyHint` is ever returned.
- **Every write-capable task is reversible.** A checkpoint precedes it; `checkpoint.restore` reverts exactly the task's changes and reports user edits as conflicts.
- **Dangerous actions are never silent.** FORBIDDEN commands are refused; HIGH-risk ones need user approval (or the Autonomous profile). Nothing is resumed automatically after a crash.

---

## 2. What is implemented (by phase)

| Phase | Delivered | Key modules |
|---|---|---|
| 1 | Contract v1, CoreHost, preload bridge, checkpoints, legacy bridge, safety fixes | contracts/*, main/core-host.ts |
| 2 | Universal model gateway, streamed tool calls, stream error taxonomy | core/gateway/* |
| 3 | Providers: native Gemini, NVIDIA hosted + self-hosted NIM, OpenRouter, Groq, Ollama, custom OpenAI-compatible (ngrok = custom endpoint, classified cloud); 8-state health with breaker, latched AUTH_ERROR/QUOTA/UNSUPPORTED, persisted health, precise disconnect, discovery, key hints | core/gateway/*, main/provider-service.ts |
| 4 | Router: AUTO/FAST/POWERFUL/FREE_ONLY/LOCAL_ONLY/CUSTOM; routing events; Ollama started only when a local model is selected | core/router/router.ts, main/providers/model-registry.ts |
| 5 | Repository intelligence (index, search, symbols, imports, related tests, project profile), retrieval with provenance, model-aware budgets, compaction | core/repo/*, core/context/* |
| 6 | Tools (read/write/edit/patch/move/delete/search/symbol/git), command classifier (LOW/MEDIUM/HIGH/FORBIDDEN), permission profiles, approvals, command events, Git checkpoints for large projects, workspace leases, attachments out of the repo | core/tools/*, core/security/*, core/workspace/*, core/git/* |
| 7 | Task engine: core task ids, validated state machine, agent runs (MANAGER/PLANNER/CODER/DEBUGGER/TESTER/REVIEWER), persisted task + event history, INTERRUPTED recovery, diffs | core/orchestrator/*, core/tasks/* |
| 8 | Verification: Tester, verdict rules, independent reviewer, bounded auto-repair; applied to Agent, Local, Codex and Multi-AI | core/verification/*, main/task-verification.ts |
| 9 | Evidence-only project memory + ALTREX.md rules, lease recovery, tournament (2–3 candidates) | core/memory/*, core/orchestrator/tournament.ts |
| 10 | Contract freeze: CoreError model, project/session/provider/git/checks/terminal/tool commands, FakeCore, snapshot test | contracts/platform.ts, contracts/fake-core.ts |
| 11 | End-to-end hardening scenarios over real HTTP, secret audit, long-conversation compaction fix, packaging validation | main/hardening.scenarios.test.ts |

Phase-by-phase evidence and deviations: `docs/MIGRATION_PLAN.md` (Phase log). Specs with implementation-status sections: `docs/PROVIDER_SPEC.md`, `docs/AGENT_SPEC.md`, `docs/TOOL_SYSTEM.md`, `docs/CONTEXT_ENGINE.md`, `docs/SECURITY_MODEL.md`, `docs/TEST_STRATEGY.md`.

---

## 3. Run, build, test

```bash
pnpm install
pnpm dev                 # Electron app (electron-vite)
pnpm dev:web             # renderer in a browser (use FakeCore there)
pnpm typecheck           # contracts, core, desktop
pnpm test                # all suites (contracts, core, desktop)
pnpm build               # production bundles
pnpm --filter @altrex/desktop smoke     # launches the built app headless-ish and checks the core bridge
pnpm dist:win            # NSIS installer + portable exe into release/
pnpm --filter @altrex/desktop verify:release
```

Contract snapshot (only when you deliberately change the contract):

```bash
UPDATE_CONTRACT_SNAPSHOT=1 pnpm --filter @altrex/contracts test
```

Final evidence at handoff: see §9.

---

## 4. Frontend ↔ backend communication

```ts
import type { AltrexCoreBridge, AltrexEvent } from '@altrex/contracts'
const core = (window as unknown as { altrexCore: AltrexCoreBridge }).altrexCore

const stop = core.onEvent((event: AltrexEvent) => { /* switch (event.type) … */ })
const result = await core.invokeResult('task.start', { projectPath, mode: 'AGENT', prompt, sessionId })
if (!result.ok) showError(result.error)          // { code, message, retryable, detail? }
```

- The renderer imports **only** `@altrex/contracts` (types, schemas, `channels`, `fake-core`). Never import `@altrex/core` or Electron.
- Events: envelope `{ v, streamId, seq, id, ts, taskId, type, payload }`. `seq` is strictly increasing per process; after a reload call `events.replay({ afterSeq })`. After an app restart use `task.list` + `task.events` (persisted history).
- Ordering per task: `task.created` first; checkpoint before the first file change; exactly one terminal event last (`task.completed` / `task.completed_unverified` / `task.verified` / `task.failed` / `task.cancelled` / `task.interrupted`), nothing after it.
- Unknown event types and unknown fields must be ignored (additive evolution).
- Full reference with every payload: `packages/contracts/README.md`.

### Building the UI without Electron or providers

```ts
import { FakeCore } from '@altrex/contracts/fake-core'
const core = new FakeCore({ delayMs: 150 })
```

Scripted and contract-validated: Ask → answer; prompt with "approval" → waits for `permission.respond`; "fail" → FAILED verdict after a repair; otherwise → VERIFIED. Data is labelled "demo"; never ship FakeCore as the real core.

---

## 5. Commands (39)

| Area | Commands |
|---|---|
| Events | `events.replay` |
| Projects | `project.open`, `project.list`, `project.permissions` |
| Tasks & sessions | `task.start`, `task.cancel`, `task.list`, `task.get`, `task.events`, `session.list` |
| Providers & models | `provider.list`, `provider.connect`, `provider.disconnect`, `provider.test`, `provider.refresh`, `model.list` |
| Routing | `router.preview` |
| Permissions | `permission.configure`, `permission.pending`, `permission.respond` |
| Checkpoints & diffs | `checkpoint.list`, `checkpoint.preview`, `checkpoint.restore`, `checkpoint.diff` |
| Repository & context | `repo.search`, `repo.symbols`, `repo.related`, `repo.profile`, `context.preview` |
| Git | `git.status`, `git.diff` |
| Checks & terminal | `checks.discover`, `checks.run`, `terminal.run`, `terminal.cancel` |
| Tools | `tool.list` |
| Memory | `memory.list`, `memory.remember`, `memory.forget` |

Request/response schemas: `packages/contracts/src/*.ts`; JSON Schema of all of them: `packages/contracts/contract-v1.snapshot.json`.

## 6. Events (41)

| Area | Events |
|---|---|
| Task lifecycle | `task.created`, `task.state_changed`, `task.activity`, `task.completed`, `task.completed_unverified`, `task.verified`, `task.failed`, `task.cancelled`, `task.interrupted` |
| Agents | `agent.started`, `agent.progress`, `agent.completed`, `agent.failed`, `agent.message_delta` |
| Routing & providers | `model.selected`, `provider.selected`, `route.changed`, `fallback.started`, `fallback.completed`, `fallback.failed`, `provider.health_changed` |
| Tools, commands, permissions | `command.started`, `command.output`, `command.completed`, `command.exited` (legacy), `tool.denied`, `permission.required`, `permission.resolved` |
| Files & checkpoints | `file.changed`, `diff.available`, `checkpoint.created`, `checkpoint.failed`, `checkpoint.restored` |
| Verification | `test.started`, `test.completed`, `repair.started`, `review.completed`, `verification.completed` |
| Tournament & memory | `tournament.candidate`, `tournament.selected`, `memory.updated` |

Task states: `RECEIVED, UNDERSTANDING, REPOSITORY_ANALYSIS, PLANNING, AWAITING_APPROVAL, IMPLEMENTING, TESTING, DEBUGGING, REVIEWING, VERIFYING, ANSWERING, VERIFIED, COMPLETED_UNVERIFIED, COMPLETED, FAILED, CANCELLED, INTERRUPTED` (transition table: `packages/core/src/orchestrator/transitions.ts`).

## 7. Schemas (where to find them)

| Concept | Schema (packages/contracts/src) |
|---|---|
| Projects, sessions, errors, git, tools, terminal | `platform.ts` (`ProjectSummary`, `SessionSummary`, `CoreError`, `GitStatus`, `ToolInfo`) |
| Tasks, agents, diffs | `tasks.ts` (`TaskSummary`, `AgentRun`, `AgentRole`, `FileChange`), `task.ts` (`TaskState`, `TaskMode`, `TaskIntent`) |
| Providers, models | `provider.ts` (`ProviderView`, `ModelView`, `ProviderHealthState`) |
| Routing | `routing.ts` (`RoutingMode`, `Endpoint`, `RoutingPreview`) |
| Permissions | `permissions.ts` (`Risk`, `PermissionProfile`, `ApprovalRequest`) |
| Tests & verification | `verification.ts` (`Evidence`, `Verdict`, `ReviewSummary`, `CheckName`) |
| Checkpoints & rollback | `checkpoint.ts` (`CheckpointSummary`, `RestorePlan`, `RestoreResult`, scopes) |
| Repository & context | `repo.ts` |
| Memory | `memory.ts` (`MemoryFact`) |
| Events & commands | `events.ts`, `commands.ts`, `bridge.ts` |

---

## 8. Known limitations and deferred work (honest list)

Behavioural limits the UI must present truthfully:
1. **Live providers were not exercised** in these phases (quota, credentials). Everything is proven against deterministic loopback HTTP fakes that reproduce real failures (issue #14). A live smoke per provider is recommended before release.
2. **Approvals need the UI.** Until the UI calls `permission.configure({ interactive: true })` and answers `permission.required`, HIGH-risk commands are denied with an explanation (by design, never approved silently).
3. **VERIFIED requires a declared test suite.** Projects with only build/typecheck/lint end COMPLETED_UNVERIFIED ("behavior was not tested").
4. **Project trust** = opened in ALTREX this session (native picker or recent). There is no persistent "trust this project" flow yet (a UI decision).
5. **Codex engine** runs in its own sandbox; ALTREX cannot approve its individual actions. Read-only projects refuse it; checks + review run afterwards; no automatic repair of Codex output.
6. **Multi-AI Director** keeps its own planning and publication; ALTREX adds checks + review on the integrated tree (no extra repair).
7. **No OS sandbox** for commands (argv-only runner, classifier, policy, checkpoints are the mitigations).
8. **Global events** (e.g. `provider.health_changed`) are live/replayable but not stored in per-task history.
9. **Legacy renderer** still uses `window.altrex` and shows the V3 UI; nothing of the new product UI was built by Claude.

Deferred backend items (seams exist): SecretResolver/credentialRef split (keys never leave the main process today), tree-sitter symbols (regex outlines today), Planner phase with acceptance criteria, green checkpoints during repair, append-only action log, custom permission profile and "always for this project" approvals, reviewer comparison of tournament candidates, background terminal processes (`terminal.start/read/stop`), consent flow per cloud provider (`consent.repositoryData`).

Packaging: validated (§9); installers are unsigned unless a certificate is configured.

---

## 9. Final evidence at handoff

| Check | Result |
|---|---|
| `pnpm typecheck` | PASS (contracts, core, desktop) |
| `pnpm test` | **683 passed / 0 failed / 0 todo** — contracts 115, core 342, desktop 226 (incl. 20 end-to-end hardening scenarios over real loopback HTTP) |
| `pnpm build` | PASS |
| Electron smoke (dev build) | PASS at 100 %, 125 % and 150 % scale — `bridge=connected core=contract-v1` |
| Windows packaging (`electron-builder --win`) | PASS — NSIS setup + portable x64 built from the final code into a scratch output directory (the existing `release/` artifacts were left untouched) |
| Release verifier (`verify-windows-release` checks) | PASS — 3,926 asar entries, only `out/`, `node_modules/`, `package.json`; no credentials/.env/.codex paths; valid PE executables; Chromium licenses present |
| Packaged app smoke (`win-unpacked/ALTREX CODE.exe`, `ALTREX_SMOKE_TEST=1`) | PASS — `bridge=connected core=contract-v1` |
| Live providers | Not exercised (no quota spent); all provider behaviour proven against deterministic fakes |

To publish installers into `release/`, run `pnpm dist:win` then `pnpm --filter @altrex/desktop verify:release` (overwrites the older 0.1.0 artifacts there). Code signing uses whatever certificate the machine provides; none was configured for this validation.

---

## 10. Files you may change — and core files not to rewrite

You own:
- `apps/desktop/src/renderer/**` (all UI), renderer assets and styles, `docs/UI_SPEC.md`.
- `apps/desktop/src/shared/desktop-api.ts` only for legacy-UI types while you migrate; prefer contract types.
- `apps/desktop/vite.web.config.ts` (web dev with FakeCore).

Coordinate before changing (additive only, keep tests green):
- `packages/contracts/**` — additive changes only, regenerate the snapshot deliberately, add samples to `contracts.test.ts`, document in the README. Never remove or rename in v1.
- `apps/desktop/src/preload/index.ts` — only to expose the bridge; never expose Node, IPC or secrets directly.
- `apps/desktop/src/main/index.ts` / `core-host.ts` — only to wire a new contract command to existing core services.

Do not rewrite (backend-owned; behaviour is covered by tests and security invariants):
- `packages/core/**` (gateway, router, orchestrator, verification, tools, security, workspace, memory, tasks).
- `apps/desktop/src/main/provider-service.ts`, `task-verification.ts`, `legacy-event-bridge.ts`, `agent-runner.ts`, `attachment-service.ts`, `providers/**`.

---

# CODEX + GPT-6 ASTRA — YOUR WORK STARTS HERE

The backend exposes everything below through `window.altrexCore`. Build the product UI on it (use `FakeCore` for fast iteration), then retire the legacy `window.altrex` chat flow.

1. **Task timeline** from events: states, agent cards (role, label, endpoint, progress rounds), streamed answer (`agent.message_delta`), activity. Show exactly one terminal state; after reloads resync via `events.replay`, after restarts via `task.list` + `task.events`.
2. **Verification view**: per-check evidence (`test.completed.evidence`: argv, status, exit code, duration, parsed counts only when present, output tail), repairs (`repair.started`), review (`review.completed`: decision, findings, **independence shown as is**), and the `Verdict` with its reasons. Never show VERIFIED without `task.verified`; show COMPLETED_UNVERIFIED reasons verbatim.
3. **Approvals**: call `permission.configure({ interactive: true })` at startup; render `permission.required` (command, risk, capability, classifier reason; agent reason labelled as agent-provided); answer with `permission.respond` (once / this task); list with `permission.pending` after reloads.
4. **Diffs and rollback**: `diff.available` → file list; `checkpoint.diff` for side-by-side before/current (flag `changedSinceTask`); `checkpoint.preview` then `checkpoint.restore` with conflicts explained; offer undo via the safety checkpoint.
5. **Terminal panel**: live `command.*` output (task and user commands), `terminal.run` / `terminal.cancel`, `tool.denied` explanations.
6. **Providers**: `provider.list` (measured health, privacy local/cloud, key hint), `provider.connect` (key entered once, never displayed again), `provider.test`, `provider.refresh`, `model.list` (capabilities `null` = unknown, never shown as supported), routing mode selector and `router.preview` explanations including rejected candidates and reasons; fallback notices from `fallback.*`.
7. **Projects & sessions**: `project.open` / `project.list`, conversations via `sessionId` on `task.start` + `session.list`; per-project permission profile (`project.permissions`: Read-only / Standard / Autonomous) with a clear explanation of each.
8. **Checks & Git**: `checks.discover` / `checks.run` buttons, `git.status` / `git.diff` panels.
9. **Memory**: `memory.list` with sources and confidence, `memory.remember`, `memory.forget`; show that ALTREX.md rules are user-owned.
10. **Tournament**: `task.start({ candidates: 2 | 3 })` option for Agent mode; show `tournament.candidate` results and the code-based ranking reasons from `tournament.selected`.
11. **Errors**: render `CoreError` codes meaningfully (e.g. `PROJECT_NOT_OPEN` → open the project; `PROJECT_BUSY` → retry later; `POLICY_DENIED` → explain the rule).
12. **Honesty rules for every screen** (from ALTREX.md): no simulated agents, models, test results, confidence percentages or health states; every visible action backed by a capability or an explanation of why it is unavailable.
