# @altrex/contracts — core ↔ UI contract, version 1

The stable, validated interface between the ALTREX core (Electron main process today, a utility process later) and any UI. The renderer imports **only types** from this package (and `channels`); it never imports `@altrex/core`.

Status: **v1, first stable release (V4 Phase 1).** The legacy `window.altrex` / `ChatStreamEvent` API still exists and stays unchanged until the UI migrates (MIGRATION_PLAN Phase 10).

## Access

```ts
import type { AltrexEvent } from '@altrex/contracts'

const core = window.altrexCore!            // contractVersion === 1
const stop = core.onEvent((event: AltrexEvent) => { /* switch on event.type */ })
const replay = await core.invoke('events.replay', { afterSeq: 0 })
```

## Event envelope

| Field | Meaning |
|---|---|
| `v` | Contract version (`1`). |
| `streamId` | Random per core process. **If it changes, sequence numbers restarted**: drop cached state and resync with `events.replay({ afterSeq: 0 })`. |
| `seq` | Strictly increasing within a stream, starting at 1. Deduplicate and order by `seq`. |
| `id` | UUIDv7, unique per event. |
| `ts` | ISO-8601 UTC. |
| `taskId` | Task the event belongs to (Phase 1: the chat `requestId`), or `null` for global events. |
| `type`, `payload` | See below. Payloads never contain secrets. |

**History across restarts:** task records and each task's events are persisted. After a restart use `task.list` and `task.events` (events keep their original `streamId`/`seq`).

**Resume protocol:** remember the last `seq` you processed. After a reload or reconnect, call `events.replay({ afterSeq: lastSeq })`. If `streamId` differs, or `gap` is `true` (events older than the buffer of 5,000 were evicted), rebuild from what is available. Phase 1 keeps events in memory only; they do not survive an app restart.

## Events emitted in v1

| Type | Payload | When |
|---|---|---|
| `task.created` | `state: 'RECEIVED'`, `mode` (`ASK`/`AGENT`/`LOCAL`/`MULTI`), `intent` (`question`/`change`), `projectPath`, `title`, `modelSelection`, `requestId?` (legacy chat id, correlation only) | A request was accepted. |
| `task.state_changed` | `from`, `to` (`TaskState`) | Lifecycle transition. Phase 1 legacy engines reach: `ANSWERING`, `PLANNING`, `IMPLEMENTING`, `TESTING` (Multi-AI only), and the terminal states below. |
| `task.activity` | `message`, `source` | Human-readable progress. Display it; **never parse it** for control flow. |
| `agent.message_delta` | `text` | Streamed assistant text. |
| `model.selected` | `provider` (display), `model`, `reasons[]`, `providerId?`, `role?`, `mode?` | The endpoint a role call will use (emitted by the router on every change). |
| `provider.selected` | `providerId`, `role`, `mode`, `reason` | A role call moved to a (different) provider. |
| `route.changed` | `role`, `from`, `to`, `reason` | The router re-ranked and chose another endpoint without a failure. |
| `fallback.started` | `role`, `from`, `to`, `reason` (error category) | A call failed and routing moves on. |
| `fallback.completed` | `role`, `from`, `to` | The fallback endpoint succeeded. |
| `fallback.failed` | `role`, `from`, `reason`, `attempted` | Every candidate was exhausted. |
| `command.started` | `commandId`, `command` | An agent command passed policy and started. |
| `command.output` | `commandId`, `stream` (`stdout`/`stderr`), `text` (≤8 KB; long output is split) | Live command output. |
| `command.completed` | `commandId`, `command`, `exitCode` (`null` if unknown), `timedOut`, `durationMs` | The command ended. |
| `tool.denied` | `tool`, `summary`, `risk` (`LOW`/`MEDIUM`/`HIGH`/`FORBIDDEN`), `reason` | Policy refused a tool call (FORBIDDEN command, read-only project, HIGH without approval). The agent receives the reason as a tool error. |
| `permission.required` | `ApprovalRequest`: `approvalId`, `taskId`, `tool`, `summary`, `risk`, `capability`, `reason` (classifier), `agentReason?`, `requestedAt` | A HIGH-risk action is waiting for the user. Answer with `permission.respond`. |
| `permission.resolved` | `approvalId`, `decision` (`approved`/`denied`), `scope`, `by` (`user`/`policy`/`task-grant`), `note` | An approval was answered, denied by policy (no approval UI connected, task cancelled/ended), or covered by an earlier task-scoped grant. |
| `agent.started` | `agentId`, `role` (`MANAGER`/`PLANNER`/`CODER`/`DEBUGGER`/`TESTER`/`REVIEWER`), `label`, `providerId`, `model` | An agent run began (coding agent, Codex, Director planner/worker/checks). |
| `agent.progress` | `agentId`, `role`, `round`, `message` | Structured progress (e.g. `Round 3: read_file, edit_file`). |
| `agent.completed` | `agentId`, `role`, `summary` | The agent finished. |
| `agent.failed` | `agentId`, `role`, `message`, `code` (`CANCELLED` when the task was cancelled) | The agent stopped without finishing. |
| `diff.available` | `checkpointId`, `files[]` (`path`, `change`: `added`/`modified`/`deleted`), `truncated` | The task's changes relative to its checkpoint; fetch contents with `checkpoint.diff`. |
| `tournament.candidate` | `candidate`, `providerId`, `model`, `status`, `changedFiles`, `changedLines`, `conflicts`, `checks[]`, `error?` | One tournament candidate finished in its isolated workspace. |
| `tournament.selected` | `winner` (index or null), `ranking[]` (`candidate`, `eligible`, `reasons[]`), `applied[]` | Code ranked the candidates from evidence and applied the winner. |
| `memory.updated` | `projectPath`, `keys[]` | Evidence-backed project memory changed after verification. |
| `task.interrupted` | `reason` | Terminal (`INTERRUPTED`): the app stopped while the task ran. Emitted at the next startup. Never resumed automatically. |
| `command.exited` | `command`, `exitCode` (`null` if unknown or timed out), `output` (≤8 KB) | A real command finished. |
| `file.changed` | `paths[]`, `cumulative` | Files changed by the task. `cumulative: true` = full list so far. |
| `checkpoint.created` | `CheckpointSummary` | A pre-task checkpoint exists (AGENT, LOCAL and Codex tasks with a project). |
| `checkpoint.failed` | `projectPath`, `reason` | No checkpoint could be made (for example the project is over the size limits). The task still runs; show the reason. |
| `checkpoint.restored` | `RestoreResult` | A restore finished. |
| `provider.health_changed` | `providerId`, `baseUrl`, `state`, `previous`, `errorCategory` | Measured provider health changed (global, `taskId: null`). States: `UNKNOWN`, `HEALTHY`, `DEGRADED`, `RATE_LIMITED`, `QUOTA_EXHAUSTED`, `AUTH_ERROR`, `OFFLINE`, `UNSUPPORTED`. |
| `task.completed` | `{}` | Terminal (`COMPLETED`): a `question` was answered. Answers are not "verified". |
| `test.started` | `testId`, `name` (`build`/`test`/`typecheck`/`lint`), `command` | The Tester started one of the project's declared checks. |
| `test.completed` | `testId`, `evidence` (`Evidence`: `status` PASS/FAIL/TIMEOUT/ERROR/NOT_RUN, `exitCode`, `durationMs`, `treeHash`, `parsed?` counts, `outputTail`, `note?`) | A real check finished. `parsed` exists only when the runner's output was recognized — show counts only then, otherwise the exit code. |
| `repair.started` | `attempt`, `limit`, `reason` (`check_failed`/`review_changes`), `signature`, `escalated` | A bounded repair round began (Debugger for failing checks, Coder for review findings). |
| `review.completed` | `ReviewSummary`: `decision` (`approve`/`request_changes`/`not_run`), `independence` (`different-provider`/`different-model`/`same-model`/`unknown`/`none`), `reviewer`, `blockers`, `majors`, `findings[]`, `note?` | The independent review finished (or could not run, with the reason). Show `independence` as is. |
| `verification.completed` | `Verdict`: `status`, `treeHash`, `checks[]` (PASS/FAIL/NOT_RUN/NOT_AVAILABLE per build/test/typecheck/lint), `review`, `repairs`, `reasons[]` | The verdict, computed by code from evidence. Precedes the terminal event. |
| `task.verified` | `verdict` | Terminal (`VERIFIED`): a test suite and every declared check passed on the final tree and the review approved with no blocker/major finding. |
| `task.completed_unverified` | `reason` | Terminal (`COMPLETED_UNVERIFIED`): a `change` task finished **without** meeting the VERIFIED bar (no test suite, stale/unrun checks, no review, no file changes, or a legacy engine). Show the reason; do not display "verified". |
| `task.failed` | `message`, `code` | Terminal (`FAILED`). |
| `task.cancelled` | `{}` | Terminal (`CANCELLED`). |

Ordering guarantees per task: `task.created` comes first; `checkpoint.created`/`checkpoint.failed` come before the first file change; exactly one terminal event comes last. No events follow a terminal event for the same task.

**Not yet emitted** (they must not be simulated in the UI): plan events (a separate Planner phase), green checkpoints during repair, tournament events. Each is added to the schema only when a real producer exists; see `docs/V4_ARCHITECTURE.md §9`.

## Commands (v1)

| Name | Request | Response |
|---|---|---|
| `events.replay` | `{ afterSeq }` | `{ streamId, events, oldestSeq, latestSeq, gap }` |
| `checkpoint.list` | `{ projectPath }` (project must be open in ALTREX) | `CheckpointSummary[]`, newest first |
| `checkpoint.preview` | `{ checkpointId, scope? = 'task' }` | `RestorePlan` (dry run: `restore[]`, `delete[]`, `conflicts[]`) |
| `checkpoint.restore` | `{ checkpointId, scope? = 'task' }` | `RestoreResult` (includes `safetyCheckpointId`, which can itself be restored with scope `all` to undo) |
| `provider.list` | `{}` | `ProviderView[]` — configured providers, measured health, privacy class, protocol, `keyHint` (≤4 chars). Never a secret. |
| `router.preview` | `{ mode? = 'AUTO', role?, tools?, vision?, minContext?, prompt? }` | `RoutingPreview` — `primary`, `fallbacks`, `reasons`, `rejected[]` with reasons. No model is called. |
| `permission.configure` | `{ interactive }` | `{ interactive }` — declare that this UI answers approvals. Until then HIGH actions are denied with an explanation (never approved silently). |
| `permission.pending` | `{}` | `ApprovalRequest[]` waiting for an answer (use after reload). |
| `permission.respond` | `{ approvalId, decision: 'approve' \| 'deny', scope? = 'once' \| 'task' }` | `{ accepted }` — `false` if unknown or already answered. |
| `project.permissions` | `{ projectPath, profile? }` (`read_only`/`standard`/`autonomous`; omit to read) | `{ projectPath, profile }` — persisted per project; project must be open in ALTREX. |
| `task.start` | `{ projectPath \| null, mode, prompt, history? = [], modelSelection? = 'AUTO', routingMode?, attachmentIds? = [], resumeRunId?, candidates? = 1 }` (`candidates` 2–3 = AGENT tournament) | `{ taskId }` — progress arrives as events with that task id. The project must be open in ALTREX. |
| `task.cancel` | `{ taskId }` | `{ cancelled }` — `false` if the task is not running. |
| `task.list` | `{ projectPath?, limit? = 50 }` | `TaskSummary[]`, newest first (persisted across restarts). |
| `task.get` | `{ taskId }` | `TaskSummary` — state, engine, agents, checkpoints, changed files, outcome, `verdict` (null until verified). |
| `task.events` | `{ taskId, limit? = 5000 }` | `{ taskId, events, truncated }` — persisted event history. |
| `checkpoint.diff` | `{ checkpointId, path }` | `{ path, before, current, binary, changedSinceTask }` — text before the task and now (null when absent; binary/>1 MB content is not returned). |
| `project.open` | `{}` | `ProjectSummary \| null` — native folder picker; the chosen project is open (trusted) for the session. |
| `project.list` | `{}` | `ProjectSummary[]` (`name`, `path`, `branch`, `markers`) — projects open in this session. |
| `session.list` | `{ projectPath?, limit? = 50 }` | `SessionSummary[]` — tasks grouped by the `sessionId` given to `task.start`. |
| `provider.connect` | `{ providerId, apiKey? = '', baseUrl? = '', model? = '', additionalFields? }` | `ProviderView[]` — the key is sent once, stored encrypted in the main process and never returned. |
| `provider.disconnect` | `{ providerId }` | `ProviderView[]` |
| `provider.test` | `{}` | `ProviderView[]` — re-measures every configured provider. |
| `provider.refresh` | `{}` | `ModelView[]` — re-discovers models. |
| `tool.list` | `{}` | `{ name, description, risk }[]` (`LOW`/`MEDIUM`/`CLASSIFIED`). |
| `git.status` | `{ projectPath }` | `{ isRepository, branch, head, entries[] }` |
| `git.diff` | `{ projectPath, path?, maxBytes? = 200000 }` | `{ diff, truncated }` (working tree vs HEAD) |
| `checks.discover` | `{ projectPath }` | `{ name, argv, source }[]` — the project's declared checks (never invented). |
| `checks.run` | `{ projectPath, names? }` | `Evidence[]` — runs them now; `test.*` events with `taskId: null`. |
| `terminal.run` | `{ projectPath, command, args? = [], timeoutMs? = 600000 }` | `{ commandId, exitCode, timedOut, durationMs, output }` — argv only (no shell); FORBIDDEN refused; read-only projects allow LOW only; `command.*` events with `taskId: null`. |
| `terminal.cancel` | `{ commandId }` | `{ cancelled }` (the running `terminal.run` then fails with `CANCELLED`) |
| `consent.list` | `{}` | `{ providerId, baseUrl, displayName, granted, grantedAt }[]` — cloud endpoints (and the Codex engine) that could receive project code. |
| `consent.grant` | `{ providerId, baseUrl }` | `{ granted }` — `false` for an endpoint that is not configured. |
| `consent.revoke` | `{ providerId, baseUrl }` | `{ revoked }` |

**Cloud-code consent is enforced by the backend.** A task with a project fails with `task.failed` code `CONSENT_REQUIRED`, before any model request, if its only candidate endpoints are cloud endpoints without consent. Local endpoints never need consent.
| `memory.list` | `{ projectPath }` | `MemoryFact[]` (`key`, `value`, `source`: evidence/user/detected, `evidenceId?`, `confidence`, `lastVerifiedAt`). |
| `memory.remember` | `{ projectPath, key, value }` | `{ key }` — stored as `user.<key>`. |
| `memory.forget` | `{ projectPath, key }` | `{ removed }` |
| `model.list` | `{ providerId? }` | `ModelView[]` — capability knowledge (`null` = unknown), availability, health, `free`. |

Restore scopes:
- `task` reverts only files the task changed. Files the user edited after the task are reported as `conflicts` and left untouched.
- `all` reverts every difference since the checkpoint. It is required when the task never finished (`finalizedAt: null`).

A restore is refused while a task is running in that project. Checkpoints never include or modify ignored directories (`node_modules`, build output, `.git`, …) or protected files (`.env*`, secrets, keys).

## Errors

Every command failure is a `CoreError`: `{ code, message, retryable, detail? }`. Codes: `INVALID_REQUEST` (request does not match the schema; `detail` lists the paths), `UNKNOWN_COMMAND`, `PROJECT_NOT_OPEN`, `PROJECT_BUSY` (retryable), `NOT_FOUND`, `POLICY_DENIED`, `CONFLICT`, `CHECKPOINT_TOO_LARGE`, `CHECKPOINT_NOT_FINALIZED`, `CHECKPOINT_CORRUPT`, `PROVIDER_ERROR` (`detail` = provider error category; `retryable` from the gateway), `UNAVAILABLE`, `CANCELLED`, `INTERNAL`.

- `invokeResult(name, request)` resolves with `{ ok: true, value }` or `{ ok: false, error }` — prefer it in UI code.
- `invoke(name, request)` resolves with the value or rejects with an `Error` whose message is `CODE: message`.

## FakeCore (UI development without Electron or providers)

`import { FakeCore } from '@altrex/contracts/fake-core'` gives a scripted, in-memory `AltrexCoreBridge`. Every event and response it produces is validated against this contract. `task.start` scenarios: `mode: 'ASK'` → streamed answer → COMPLETED; a prompt containing "approval" → waits for `permission.respond`; "fail" → checks fail, one repair, FAILED verdict; anything else → VERIFIED with checks and review. Options: `{ delayMs = 150, interactiveApprovals = true }`; `idle()` resolves when scripts finish. Its providers and data are labelled "demo"; it is a development tool and must never replace the real core in a shipped build.

## Freeze

Contract v1 is frozen as of Phase 10. `contract-v1.snapshot.json` records the JSON Schema of every event payload and every command request/response; `src/freeze.test.ts` fails on any difference and on the removal of any recorded event or command. Additive changes (new events, new commands, new optional fields) are made deliberately by regenerating the snapshot (`UPDATE_CONTRACT_SNAPSHOT=1 pnpm --filter @altrex/contracts test`) and documenting them here.

## Versioning

Additive changes are non-breaking: new event types, new commands, new optional payload fields. Consumers must ignore unknown fields and unknown event types. Removing or renaming anything, or changing a field's meaning, requires `v: 2`.
