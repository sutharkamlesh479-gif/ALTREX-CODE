import type {
  AltrexEvent,
  TaskState,
  TaskSummary,
  Evidence,
  Verdict,
  AgentRun,
} from "@altrex/contracts";

export const terminalStates = new Set<TaskState>([
  "VERIFIED",
  "COMPLETED_UNVERIFIED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);
export const label = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
export const healthLabel: Record<string, string> = {
  HEALTHY: "Connected",
  UNKNOWN: "Not checked",
  DEGRADED: "Connection degraded",
  RATE_LIMITED: "Rate limited",
  QUOTA_EXHAUSTED: "Quota exhausted",
  AUTH_ERROR: "Invalid credentials",
  OFFLINE: "Unavailable",
  UNSUPPORTED: "Unsupported configuration",
};
export function mergeEvents(
  previous: AltrexEvent[],
  incoming: AltrexEvent[],
): AltrexEvent[] {
  // Fast path for live streaming: strictly newer events of the same stream are appended without re-sorting.
  const last = previous.at(-1);
  if (
    last &&
    incoming.length &&
    incoming.every(
      (event, index) =>
        event.streamId === last.streamId &&
        event.seq > (index ? incoming[index - 1]!.seq : last.seq),
    )
  )
    return [...previous, ...incoming];
  const events = new Map(previous.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((a, b) =>
    a.streamId === b.streamId
      ? a.seq - b.seq
      : a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id),
  );
}
export type CommandView = {
  id: string;
  command: string;
  output: string;
  stderr: string;
  done: boolean;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  taskId: string | null;
  clipped: boolean;
};
export function commandViews(events: AltrexEvent[]): CommandView[] {
  const commands = new Map<string, CommandView>();
  for (const event of events) {
    if (event.type === "command.started")
      commands.set(event.payload.commandId, {
        id: event.payload.commandId,
        command: event.payload.command,
        output: "",
        stderr: "",
        done: false,
        taskId: event.taskId,
        clipped: false,
      });
    if (event.type === "command.output") {
      const command = commands.get(event.payload.commandId);
      if (command) {
        const key = event.payload.stream === "stderr" ? "stderr" : "output";
        command[key] += event.payload.text;
        if (command[key].length > 100_000) {
          command[key] = command[key].slice(-100_000);
          command.clipped = true;
        }
      }
    }
    if (event.type === "command.completed") {
      const command = commands.get(event.payload.commandId);
      if (command)
        Object.assign(command, {
          done: true,
          exitCode: event.payload.exitCode,
          durationMs: event.payload.durationMs,
          timedOut: event.payload.timedOut,
        });
    }
    if (event.type === "command.exited")
      commands.set(event.id, {
        id: event.id,
        command: event.payload.command,
        output: event.payload.output,
        stderr: "",
        done: true,
        exitCode: event.payload.exitCode,
        taskId: event.taskId,
        clipped: false,
      });
  }
  return [...commands.values()];
}
export function taskView(task: TaskSummary, events: AltrexEvent[]) {
  let state = task.state,
    text = "",
    activity = "",
    reason = task.outcome?.reason ?? "",
    verdict: Verdict | null = task.verdict;
  const agents = new Map<string, AgentRun>(
    task.agents.map((agent) => [agent.agentId, { ...agent }]),
  );
  const files = new Set(task.changedFiles),
    evidence: Evidence[] = [],
    stages: string[] = [],
    notices: string[] = [],
    // Provider/model a notice refers to (for its logo), aligned with `notices`.
    noticeRoutes: Array<{ providerId: string; model: string } | null> = [];
  let checkpoint = task.checkpointIds.at(-1),
    diffTruncated = false;
  const changes = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case "task.state_changed":
        if (!terminalStates.has(event.payload.to)) {
          if (!terminalStates.has(task.state)) state = event.payload.to;
          if (!stages.includes(event.payload.to)) stages.push(event.payload.to);
        }
        break;
      case "agent.message_delta":
        text += event.payload.text;
        break;
      case "task.activity":
        activity = event.payload.message;
        break;
      case "task.verified":
        state = "VERIFIED";
        verdict = event.payload.verdict;
        break;
      case "task.completed":
        state = "COMPLETED";
        break;
      case "task.completed_unverified":
        state = "COMPLETED_UNVERIFIED";
        reason = event.payload.reason;
        break;
      case "task.failed":
        state = "FAILED";
        reason = event.payload.message;
        break;
      case "task.cancelled":
        state = "CANCELLED";
        break;
      case "task.interrupted":
        state = "INTERRUPTED";
        reason = event.payload.reason;
        break;
      case "verification.completed":
        verdict = event.payload;
        break;
      case "test.completed":
        evidence.push(event.payload.evidence);
        break;
      case "agent.started":
        agents.set(event.payload.agentId, {
          ...event.payload,
          status: "running",
          startedAt: event.ts,
          finishedAt: null,
          summary: null,
        });
        break;
      case "agent.progress": {
        const agent = agents.get(event.payload.agentId);
        if (agent) agent.summary = event.payload.message;
        break;
      }
      case "agent.completed": {
        const agent = agents.get(event.payload.agentId);
        if (agent)
          Object.assign(agent, {
            status: "completed",
            summary: event.payload.summary,
            finishedAt: event.ts,
          });
        break;
      }
      case "agent.failed": {
        const agent = agents.get(event.payload.agentId);
        if (agent)
          Object.assign(agent, {
            status: event.payload.code === "CANCELLED" ? "cancelled" : "failed",
            summary: event.payload.message,
            finishedAt: event.ts,
          });
        break;
      }
      case "file.changed":
        if (event.payload.cumulative) files.clear();
        event.payload.paths.forEach((path) => files.add(path));
        break;
      case "diff.available":
        checkpoint = event.payload.checkpointId;
        diffTruncated = event.payload.truncated;
        event.payload.files.forEach((file) => {
          files.add(file.path);
          changes.set(file.path, file.change);
        });
        break;
      case "checkpoint.created":
        checkpoint = event.payload.checkpointId;
        break;
      case "checkpoint.failed":
        noticeRoutes.push(null);
        notices.push(
          `Recovery checkpoint unavailable: ${event.payload.reason}`,
        );
        break;
      case "fallback.started":
        noticeRoutes.push(event.payload.to);
        notices.push(
          `${event.payload.from.providerId}: ${label(event.payload.reason)}. Trying ${event.payload.to.providerId}.`,
        );
        break;
      case "fallback.completed":
        noticeRoutes.push(event.payload.to);
        notices.push(`Fallback succeeded with ${event.payload.to.providerId}.`);
        break;
      case "fallback.failed":
        noticeRoutes.push(event.payload.from);
        notices.push(`No fallback succeeded: ${event.payload.reason}`);
        break;
    }
  }
  return {
    state,
    text,
    activity,
    reason,
    verdict,
    agents: [...agents.values()],
    files: [...files],
    evidence,
    stages,
    notices,
    noticeRoutes,
    checkpoint,
    changes,
    diffTruncated,
  };
}
export function problems(events: AltrexEvent[]) {
  return events.flatMap((event) => {
    switch (event.type) {
      case "task.failed":
        return [
          { id: event.id, category: "Task", message: event.payload.message },
        ];
      case "tool.denied":
        return [
          {
            id: event.id,
            category: "Permission",
            message: `${event.payload.summary}: ${event.payload.reason}`,
          },
        ];
      case "checkpoint.failed":
        return [
          { id: event.id, category: "Recovery", message: event.payload.reason },
        ];
      case "provider.health_changed":
        return ["HEALTHY", "UNKNOWN"].includes(event.payload.state)
          ? []
          : [
              {
                id: event.id,
                category: "Provider",
                message: `${event.payload.providerId}: ${healthLabel[event.payload.state]}`,
              },
            ];
      case "test.completed":
        return ["FAIL", "TIMEOUT", "ERROR"].includes(
          event.payload.evidence.status,
        )
          ? [
              {
                id: event.id,
                category: label(event.payload.evidence.name),
                message:
                  event.payload.evidence.note ??
                  event.payload.evidence.outputTail,
              },
            ]
          : [];
      case "review.completed":
        return event.payload.findings.map((finding, index) => ({
          id: `${event.id}-${index}`,
          category: "Review",
          message: `${finding.file ?? ""} ${finding.description}`,
        }));
      default:
        return [];
    }
  });
}

export type ActiveRoute = {
  providerId: string;
  provider: string;
  model: string;
  mode: string | null;
  role: string | null;
  reason: string | null;
  /** The route changed after a failure (a fallback happened before this selection). */
  afterFallback: boolean;
};

/**
 * The route the backend is actually using for a task: the latest `model.selected` (the router emits it on
 * every change, including fallbacks), or the external Codex engine when it runs the task. Never the user's
 * requested model.
 */
export function activeRoute(events: AltrexEvent[]): ActiveRoute | null {
  let route: ActiveRoute | null = null,
    failed = false;
  for (const event of events) {
    if (event.type === "fallback.started") failed = true;
    if (event.type === "model.selected") {
      route = {
        providerId: event.payload.providerId ?? "",
        provider: event.payload.provider,
        model: event.payload.model,
        mode: event.payload.mode ?? null,
        role: event.payload.role ?? null,
        reason: event.payload.reasons[0] ?? null,
        afterFallback: failed,
      };
      failed = false;
    }
    if (event.type === "agent.started" && event.payload.providerId === null && /codex/i.test(event.payload.label))
      route = { providerId: "codex", provider: "ChatGPT Codex", model: event.payload.model ?? "Codex", mode: null, role: "Coder", reason: "External OpenAI Codex engine (your ChatGPT sign-in)", afterFallback: false };
  }
  return route;
}
