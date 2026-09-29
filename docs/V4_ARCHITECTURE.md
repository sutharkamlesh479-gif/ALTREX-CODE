# ALTREX CODE V4 — Target Architecture

Status: proposed, Phase 1 of the V4 migration. Supersedes `ALTREX_ARCHITECTURE.md` (Python orchestrator design) and the topology parts of `ROADMAP.md`.
Current state: [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md). Migration: [MIGRATION_PLAN.md](MIGRATION_PLAN.md).

## 1. Goal

ALTREX is an engineering system, not a chat wrapper. A task is accepted, planned, implemented, executed, tested, repaired, reviewed and **verified with recorded evidence** before it is reported as done. Much of the quality comes from the system (routing, tools, repository understanding, verification, review, retries), not from any single model.

## 2. Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Stay TypeScript/Node.** Do not introduce the Python orchestrator from the old design. | All working code is TS. One toolchain, and types are shared with the UI. Node handles streaming HTTP and child processes well. |
| D2 | **Extract an Electron-free core package** (`packages/core`) and a dependency-free contracts package (`packages/contracts`). `apps/desktop` becomes a thin host. | Headless tests without Electron. The core can later move into an Electron `utilityProcess` so heavy work stops blocking the UI thread (a current defect), and a CLI can reuse it. |
| D3 | **One Model Gateway, many adapters.** Nothing outside `core/gateway/adapters/*` knows a provider's wire format. | Fixes the scattered provider logic. The UI and agents see one request/stream/error format. |
| D4 | **The OpenAI-compatible adapter is the base implementation**; provider presets configure it. Gemini gets a native adapter. | OpenRouter, NVIDIA hosted NIM, local NIM, Groq, Ollama `/v1`, vLLM, LM Studio and ngrok-tunnelled servers all speak it. Gemini's compatibility layer is limited for tools and metadata. |
| D5 | **ngrok is not a provider.** A tunnelled server is a `custom` OpenAI-compatible profile with a base URL. | Networking is not a model source. |
| D6 | **Routing is a pure function** over (registry snapshot, health snapshot, policy, request). It returns a decision with reasons and a fallback chain. | Deterministic, unit-testable, explainable in the UI. |
| D7 | **Roles are specs, not models.** A role declares required capabilities and a preference profile. The router binds a model at call time. | Models can be swapped without changing agent code. |
| D8 | **The Manager is deterministic code** (a task state machine), not an LLM. LLMs fill the Planner, Coder, Debugger and Reviewer roles. The Tester is mostly deterministic command execution. | Control flow must be observable, bounded and testable. LLMs make judgments; code enforces the workflow. |
| D9 | **Evidence decides completion.** `VERIFIED` requires passing checks recorded against the *final* tree hash, plus a passing independent review. Tasks without executable checks end as `COMPLETED_UNVERIFIED`. | No fake success. |
| D10 | **Every write-capable task has a checkpoint.** In Git repos a private ref (`refs/altrex/checkpoints/*`) built with a temporary index; the user's index, HEAD and branch are untouched. Non-Git projects get a snapshot copy. | Recovery for every mode, including the direct-edit single-agent mode that currently has none. |
| D11 | **Parallel writers never share a working tree.** Git worktrees for Git repos; the existing Director copy/merge/publish machinery for non-Git projects. | Reuses proven code. Tournament mode becomes an extension of it. |
| D12 | **Persistence: append-only JSONL event logs + atomic JSON snapshots**, behind a `Store` interface. SQLite later if query needs justify a native dependency. | Matches existing storage. No native module rebuild for Electron. Replayable. |
| D13 | **Runtime validation with `zod`** at every trust boundary: IPC, model structured outputs (plans, reviews), tool arguments, persisted files. | Replaces several hand-rolled validators. One schema produces both types and validation. |
| D14 | **Codex App Server stays as an optional "external engine"**, wrapped with ALTREX checkpoints and ALTREX verification after it runs. | Keeps working functionality without letting it bypass the verification contract. |

## 3. Module structure

```text
packages/
  contracts/            # zero runtime deps except zod; safe to import from renderer
    src/events.ts       # event envelope + all event payload schemas
    src/commands.ts     # UI → core command schemas
    src/task.ts         # task states, plan, acceptance criteria, verdict
    src/provider.ts     # profile/health/model views (no secrets)
    src/index.ts
  core/                 # pure Node; must not import 'electron'
    src/gateway/        # ModelGateway, adapters, transport, SSE, errors, retry, circuit, health, registry
    src/router/         # routing modes, eligibility, scoring, decisions
    src/context/        # context packs, budgets, compaction, token estimation
    src/repo/           # file index, search, symbols, imports, test mapping, project profile
    src/tools/          # tool registry + fs / terminal / git / test / repo tools
    src/security/       # permission policy, command classifier, path guard, redactor, SecretResolver
    src/workspace/      # checkpoints, worktrees/copies, merge, publication journal
    src/agents/         # role specs, prompts, agent loop, structured-output helper
    src/orchestrator/   # task engine (state machine), pipeline, parallel executor (ex-Director), tournament
    src/verification/   # check discovery, runners, evidence, verdict
    src/memory/         # project memory
    src/sessions/       # task/session store, event log, recovery
    src/events/         # event bus with sequence numbers
    src/observability/  # structured logger, metrics
    src/testing/        # fake OpenAI-compatible server, scripted model, fixture repos helpers
apps/
  desktop/              # Electron host: windows, preload, IPC ↔ core commands/events,
                        # SafeStorageSecretStore, native dialogs, packaging. Renderer owned by UI team.
```

Dependency rule: `contracts ← core ← desktop(main)`. `renderer` imports only `contracts`. Enforced by tsconfig project references and a lint rule/test that fails on `electron` imports inside `core`.

## 4. Runtime topology

```mermaid
flowchart TB
  UI["Renderer (UI team)"] -->|commands (zod-validated)| HOST["Electron main (host)"]
  HOST -->|events with seq| UI
  HOST <-->|in-process now; utilityProcess later| CORE
  subgraph CORE["@altrex/core"]
    TE["Task engine\n(state machine)"] --> AG["Agent runner\n(role specs)"]
    TE --> VE["Verification engine"]
    TE --> WS["Workspace: checkpoints / isolation"]
    AG --> CX["Context engine"] --> RI["Repository intelligence"]
    AG --> TL["Tool engine + policy"]
    VE --> TL
    AG --> RT["Model router"] --> GW["Model gateway"]
    GW --> A1["OpenAI-compatible adapter\n(OpenRouter, NVIDIA, Groq, Ollama, custom)"]
    GW --> A2["Gemini adapter"]
    TE --> ST[("Session store\nJSONL events + snapshots")]
  end
  HOST -->|SecretResolver| SS["safeStorage secret store"]
```

The core receives secrets only through a `SecretResolver` callback that the host implements. The core never persists a secret and never places one in an event, log or prompt.

## 5. Model Gateway (summary; full spec in [PROVIDER_SPEC.md](PROVIDER_SPEC.md))

```ts
interface ModelGateway {
  stream(req: GatewayRequest, opts: CallOptions): AsyncIterable<GatewayStreamEvent>
  chat(req: GatewayRequest, opts: CallOptions): Promise<GatewayResponse>   // = collect(stream) where streaming works
  listModels(profileId: string, opts?): Promise<ModelDescriptor[]>
  checkHealth(profileId: string, level: HealthLevel, opts?): Promise<HealthReport>
}
```

The gateway owns timeouts, retries, circuit breakers, context-size recovery, redaction, metrics and event emission. Adapters own only wire format, discovery, capability hints and error mapping.

## 6. Router (full spec in [PROVIDER_SPEC.md §8](PROVIDER_SPEC.md#8-router))

`route(request: RoutingRequest, snapshot: RoutingSnapshot): RoutingDecision`: hard filters (capabilities, context size, privacy/consent, mode, health/circuit) run first, then soft scoring (role success history, tier, latency, cost, locality). The result is `primary`, an ordered `fallbacks`, `reasons[]`, and `rejected[]` with reasons. Modes: `AUTO`, `FAST`, `POWERFUL`, `FREE_ONLY`, `LOCAL_ONLY`, `CUSTOM`.

## 7. Task engine and agents (full spec in [AGENT_SPEC.md](AGENT_SPEC.md))

```text
RECEIVED → UNDERSTANDING → REPOSITORY_ANALYSIS → PLANNING → [AWAITING_APPROVAL] → IMPLEMENTING
   → TESTING ⇄ DEBUGGING (bounded) → REVIEWING → (IMPLEMENTING on rejection, bounded)
   → VERIFYING → VERIFIED | COMPLETED_UNVERIFIED | FAILED | CANCELLED   (INTERRUPTED after crash)
```

All modes run through this one engine. The mode only changes policy:

| Old mode | V4 equivalent |
|---|---|
| ASK | task with `intent: question`: read-only tools, no implementation phases |
| AGENT / LOCAL | standard pipeline; LOCAL = router mode `LOCAL_ONLY` |
| MULTI | standard pipeline with `parallelism > 1`: Planner emits a DAG and the parallel executor (ex-Director) runs isolated workers |
| CODEX | `IMPLEMENTING` delegated to the external engine; checkpoint, testing, review and verification still run in ALTREX |

## 8. Tools, security, context, verification

- Tools: [TOOL_SYSTEM.md](TOOL_SYSTEM.md). Stable contracts with zod schemas and a declared capability and risk; every call passes the policy engine.
- Security: [SECURITY_MODEL.md](SECURITY_MODEL.md). Permission profiles, a command classifier replacing the name allowlist, approvals, secret handling, project trust.
- Context: [CONTEXT_ENGINE.md](CONTEXT_ENGINE.md). Typed context items with provenance and budgets derived from the real model context window.
- Verification: [AGENT_SPEC.md §7](AGENT_SPEC.md#7-verification-and-evidence). Evidence records bound to tree hashes, and a verdict computed by code.

## 9. Event protocol for the UI

**Contract v1 shipped in Phase 1.** The authoritative reference for the UI team is [packages/contracts/README.md](../packages/contracts/README.md). It is exposed to the renderer as `window.altrexCore` (`onEvent`, and `invoke(name, request)`), separate from the legacy `window.altrex`.

Adapted from `AGENT_PROTOCOL.md`:

```ts
type AltrexEvent<T extends EventType = EventType> = {
  v: 1
  streamId: string       // random per core process; a change means seq restarted
  seq: number            // strictly increasing per stream; supports replay(afterSeq)
  id: string             // UUIDv7
  ts: string             // ISO-8601 UTC
  taskId: string | null  // null for global events (provider health)
  type: T
  payload: EventPayload<T>   // zod schema per type; never contains secrets
}
```

**Emitted in v1 (Phase 1):** `task.created`, `task.state_changed`, `task.activity`, `task.completed` (answered question), `task.completed_unverified`, `task.failed`, `task.cancelled`, `agent.message_delta`, `model.selected`, `command.exited`, `file.changed`, `checkpoint.created`, `checkpoint.failed`, `checkpoint.restored`. Commands: `events.replay`, `checkpoint.list`, `checkpoint.preview`, `checkpoint.restore`. Until Phase 7, task events come from a legacy-event bridge in the desktop host (`taskId` = chat `requestId`), and the stream is in memory only.

The full target set is below. A type joins the schema only when a real producer exists, and the UI must not simulate the others:

| Family | Types |
|---|---|
| task | `task.created`, `task.state_changed`, `task.plan_ready`, `task.approval_required`, `task.approval_resolved`, `task.verified`, `task.completed_unverified`, `task.failed`, `task.cancelled` |
| agent | `agent.started`, `agent.message_delta`, `agent.completed`, `agent.failed` |
| model | `model.selected` (with routing reasons), `model.fallback`, `model.request_failed` (normalized error) |
| tool | `tool.started`, `tool.completed`, `tool.denied` |
| file | `file.changed`, `diff.available` |
| terminal | `command.started`, `command.output` (chunked, capped), `command.exited` |
| test | `check.started`, `check.result` (build/test/typecheck/lint with parsed counts when available) |
| review | `review.finding`, `review.completed` |
| checkpoint | `checkpoint.created`, `checkpoint.restored` |
| provider | `provider.health_changed`, `provider.circuit_changed`, `provider.models_updated` |

Commands (UI → core, request/response): `project.open`, `task.create`, `task.cancel`, `task.approve`, `task.revise`, `task.get`, `task.list`, `events.subscribe(afterSeq)`, `checkpoint.list|diff|restore`, `provider.list|save|delete|test`, `model.list`, `router.preview` (explains which model AUTO would choose), `settings.get|set`.

During migration the host also emits the legacy `ChatStreamEvent` through a compatibility adapter, so the current UI keeps working until the UI team moves to the new stream.

## 10. Cancellation and timeouts

One root `AbortController` per task. Child controllers are created per agent run, per model request, per tool call and per process. Cancelling a task aborts streams, stops retry sleeps, kills process trees (the existing `taskkill /T` / process-group code), and waits for exits before emitting `task.cancelled`.

Timeouts are layered, and each layer is separately configurable: connect, first token, stream idle, request overall, tool, check, task. Defaults are listed in [PROVIDER_SPEC.md §6](PROVIDER_SPEC.md#6-timeouts) and [TOOL_SYSTEM.md](TOOL_SYSTEM.md).

## 11. Observability

Structured JSONL logs in `userData/logs/`, written through the redactor. Fields: `ts, level, taskId, agentRunId, role, provider, profileId, model, requestId, attempt, phase, durationMs, ttftMs, inputTokens(est/reported), outputTokens, errorCode, fallbackFrom, fallbackTo, routingReason, tool, exitCode, checkStatus`. A `debug.*` event family mirrors this for a developer panel. The normal UI does not need to show it.

## 12. Non-goals for V4.0

OS-level sandboxing of project commands (documented as a known limit), MCP, browser/visual testing, plugins, SWARM-scale concurrency (>4 parallel workers), cloud sync. The architecture leaves seams for each; none are built yet.
