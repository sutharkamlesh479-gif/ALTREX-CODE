# ALTREX Agent and Event Protocol

> **Status (2026-09-26):** not implemented; the live protocol is `ChatStreamEvent` ([CURRENT_ARCHITECTURE.md §3](CURRENT_ARCHITECTURE.md#3-ipc-contract-current)). The V4 event envelope in [V4_ARCHITECTURE.md §9](V4_ARCHITECTURE.md#9-event-protocol-for-the-ui) adapts this design.

Protocol version `1`. All envelopes are JSON, validated at every process boundary, and carry correlation identifiers. Unknown event types are retained in logs but not executed. Unknown command versions fail closed.

## Command envelope

```json
{
  "protocolVersion": 1,
  "commandId": "0198...",
  "correlationId": "0198...",
  "causationId": null,
  "issuedAt": "2026-08-10T16:00:00.000Z",
  "actor": { "kind": "user", "id": "local-user" },
  "type": "task.create",
  "payload": {}
}
```

Commands represent requested state changes. They receive one accepted/rejected response; progress arrives as events. Commands include an idempotency key where retry is possible.

## Event envelope

```json
{
  "protocolVersion": 1,
  "eventId": "0198...",
  "sequence": 481,
  "correlationId": "0198...",
  "causationId": "0198...",
  "taskId": "0198...",
  "workerId": null,
  "type": "task.started",
  "occurredAt": "2026-08-10T16:00:01.120Z",
  "payload": {}
}
```

The persistent sequence supports resume after disconnect. Clients request events after their last acknowledged sequence. Payloads never contain API secrets; large terminal output and patches are content-addressed artifacts with size and hash.

## Required events

| Family | Events |
|---|---|
| Task | `task.created`, `task.planned`, `task.started`, `task.updated`, `task.paused`, `task.cancelled`, `task.failed`, `task.completed` |
| Agent | `agent.created`, `agent.started`, `agent.tool.requested`, `agent.tool.completed`, `agent.message`, `agent.failed`, `agent.completed` |
| File | `file.change.proposed`, `file.changed`, `file.conflict`, `diff.ready` |
| Terminal | `terminal.started`, `terminal.output`, `terminal.exited`, `terminal.cancelled` |
| Verify | `test.started`, `test.result`, `review.finding`, `confidence.updated` |
| Approval | `approval.required`, `approval.resolved`, `approval.expired` |
| Provider | `provider.health.changed`, `provider.rate_limited`, `model.usage` |

## Worker record

```ts
type Worker = {
  workerId: string;
  role: WorkerRole;
  modelProvider: string;
  modelId: string;
  endpoint: string;
  context: ContextManifest;
  task: TaskAssignment;
  permissions: PermissionProfileRef;
  workspace: WorkspaceLease;
  status: WorkerStatus;
  tokenUsage: { input: number; output: number };
  latency: { firstTokenMs?: number; totalMs?: number };
  qualityScore?: number;
  confidence?: EvidenceScore;
  logs: ArtifactRef[];
  result?: WorkerResult;
};
```

`endpoint` is redacted for display when it contains sensitive query parameters. Provider and model values come from the resolved endpoint, never the requested label.

## Tool request

```json
{
  "taskId": "task-id",
  "agentId": "worker-id",
  "type": "tool_request",
  "tool": "terminal.execute",
  "args": { "command": ["pnpm", "test"], "cwdRef": "workspace-root" },
  "reason": "Run the repository's declared test suite",
  "capability": "process.execute",
  "requiresApproval": false,
  "idempotencyKey": "test:workspace-hash"
}
```

Arguments use arrays and canonical path references, not shell-concatenated strings. The tool broker resolves paths after policy evaluation and rechecks before execution.

## Task and worker states

Task states: `draft → planning → awaiting_approval → queued → running → verifying → reviewing → integrating → completed`. Side paths are `paused`, `cancelling → cancelled`, and `failed`. A completed task is immutable; follow-up work creates a new task linked by causation.

Worker states: `created → waiting → ready → starting → running → completing → completed`. Side paths are `blocked`, `cancelling → cancelled`, and `failed`. A worker runs only when dependencies are complete, its workspace lease is valid, its endpoint is healthy, and its permissions satisfy the assignment.

## Result and evidence

Every worker result includes status, summary, artifacts, file-change manifest, unresolved issues, usage, and evidence. Test evidence records exact command, exit code, duration, working tree hash, stdout/stderr artifact references, and parser version. Reviewer approval records reviewer worker and endpoint so independence can be assessed honestly.

## Ordering and cancellation

Events for one aggregate are ordered. Consumers tolerate duplicates by `eventId`. Cancellation uses a root `AbortSignal` propagated to scheduler tasks, provider streams, tool invocations, terminals, and child processes. A cancelled process is awaited and its final exit state is logged; no background process is silently abandoned.

