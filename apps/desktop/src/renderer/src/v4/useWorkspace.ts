import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AltrexCoreBridge,
  AltrexEvent,
  CommandName,
  CommandRequest,
  CommandResponse,
  CoreError,
  ProjectSummary,
  ProviderView,
  TaskSummary,
} from "@altrex/contracts";
import { mergeEvents, terminalStates } from "./state";
export type Invoke = <N extends CommandName>(
  name: N,
  request: CommandRequest<N>,
) => Promise<CommandResponse<N> | undefined>;
export function useWorkspace(core: AltrexCoreBridge | undefined) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [project, setProject] = useState<ProjectSummary | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]),
    [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [events, setEvents] = useState<AltrexEvent[]>([]),
    [error, setError] = useState<CoreError | null>(null);
  const [pending, setPending] = useState<CommandResponse<"permission.pending">>(
    [],
  );
  const [loading, setLoading] = useState(true),
    [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [historyNotice, setHistoryNotice] = useState("");
  const [sessions, setSessions] = useState<CommandResponse<"session.list">>([]),
    [historyLoading, setHistoryLoading] = useState(false);
  // Cloud-code consent is owned and enforced by the backend; this is a view of it for the prompt.
  const [consents, setConsents] = useState<CommandResponse<"consent.list">>([]);
  const generation = useRef(0),
    alive = useRef(true),
    queued = useRef<AltrexEvent[]>([]);
  const ingest = useCallback((batch: AltrexEvent[]) => {
    setEvents((previous) => {
      const merged = mergeEvents(previous, batch);
      // Task snapshots remain authoritative. Users can reload persisted task history on demand.
      return merged.length > 20000 ? merged.slice(-20000) : merged;
    });
  }, []);
  const invoke: Invoke = useCallback(
    async (name, request) => {
      if (!core) {
        setError({
          code: "UNAVAILABLE",
          message:
            "The desktop core is unavailable. Reopen ALTREX CODE to reconnect.",
          retryable: true,
        });
        return;
      }
      try {
        const result = await core.invokeResult(name, request);
        if (!result.ok) {
          if (alive.current) setError(result.error);
          return;
        }
        return result.value;
      } catch {
        if (alive.current)
          setError({
            code: "UNAVAILABLE",
            message:
              "The connection to ALTREX was interrupted. Reopen the app to reconnect.",
            retryable: true,
          });
        return;
      }
    },
    [core],
  );
  const refresh = useCallback(async () => {
    const [nextTasks, nextProviders, nextPending, nextSessions, nextConsents] =
      await Promise.all([
        invoke("task.list", { limit: 500 }),
        invoke("provider.list", {}),
        invoke("permission.pending", {}),
        invoke("session.list", { limit: 500 }),
        invoke("consent.list", {}),
      ]);
    if (!alive.current) return;
    if (nextTasks) setTasks(nextTasks);
    if (nextProviders) setProviders(nextProviders);
    if (nextPending) setPending(nextPending);
    if (nextSessions) setSessions(nextSessions);
    if (nextConsents) setConsents(nextConsents);
  }, [invoke]);
  useEffect(() => {
    alive.current = true;
    let stopped = false,
      streamId: string | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      const batch = queued.current.splice(0);
      if (!batch.length || stopped) return;
      ingest(batch);
      timer = undefined;
    };
    const stop = core?.onEvent((event) => {
      if (streamId && streamId !== event.streamId) {
        setHistoryNotice(
          "The core restarted. Saved task records have been refreshed; commands will not resume automatically.",
        );
        void invoke("events.replay", { afterSeq: 0 }).then((replay) => {
          if (replay && !stopped) ingest(replay.events);
        });
        void refresh();
      }
      streamId = event.streamId;
      queued.current.push(event);
      if (!timer) timer = setTimeout(flush, 40);
      const terminal = {
        "task.verified": "VERIFIED",
        "task.completed_unverified": "COMPLETED_UNVERIFIED",
        "task.completed": "COMPLETED",
        "task.failed": "FAILED",
        "task.cancelled": "CANCELLED",
        "task.interrupted": "INTERRUPTED",
      } as const;
      if (event.type in terminal) {
        // Ingest everything queued (including this event) before the snapshot turns terminal, so a task
        // never looks finished ahead of its own final output (and follow-ups never see a truncated answer).
        clearTimeout(timer);
        timer = undefined;
        flush();
        const state = terminal[event.type as keyof typeof terminal];
        setTasks((previous) =>
          previous.map((task) =>
            task.taskId === event.taskId
              ? { ...task, state, finishedAt: event.ts }
              : task,
          ),
        );
      }
      if (event.type === "permission.required")
        setPending((previous) => [
          ...previous.filter((p) => p.approvalId !== event.payload.approvalId),
          event.payload,
        ]);
      if (event.type === "permission.resolved")
        setPending((previous) =>
          previous.filter((p) => p.approvalId !== event.payload.approvalId),
        );
      if (event.type === "provider.health_changed")
        setProviders((previous) =>
          previous.map((p) =>
            p.providerId === event.payload.providerId &&
            p.baseUrl === event.payload.baseUrl
              ? {
                  ...p,
                  health: event.payload.state,
                  lastErrorCategory: event.payload.errorCategory,
                  lastCheckedAt: event.ts,
                }
              : p,
          ),
        );
      if (
        event.type.startsWith("task.") &&
        event.type !== "task.activity" &&
        event.type !== "task.state_changed"
      ) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          void refresh();
        }, 70);
      }
    });
    void (async () => {
      await invoke("permission.configure", { interactive: true });
      const [list, replay] = await Promise.all([
        invoke("project.list", {}),
        invoke("events.replay", { afterSeq: 0 }),
        refresh(),
      ]);
      if (stopped) return;
      if (list) {
        setProjects(list);
        setProject(list[0] ?? null);
      }
      if (replay) {
        streamId = replay.streamId;
        ingest(replay.events);
        if (replay.gap)
          setHistoryNotice(
            "Some live events expired. Open a task to load its saved history.",
          );
      }
      setLoading(false);
    })();
    return () => {
      stopped = true;
      alive.current = false;
      stop?.();
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      queued.current = [];
    };
  }, [core, invoke, refresh, ingest]);
  const newSession = useCallback(() => {
    generation.current++;
    setHistoryLoading(false);
    setSessionId(crypto.randomUUID());
    setSelectedId(null);
    setHistoryNotice("");
  }, []);
  const openProject = async () => {
    const next = await invoke("project.open", {});
    if (next) {
      setProject(next);
      setProjects((previous) => [
        next,
        ...previous.filter((p) => p.path !== next.path),
      ]);
      newSession();
    }
  };
  const selectTask = async (task: TaskSummary) => {
    const token = ++generation.current;
    setSelectedId(task.taskId);
    setSessionId(task.sessionId ?? task.taskId);
    setHistoryLoading(true);
    setHistoryNotice("");
    setProject(projects.find((p) => p.path === task.projectPath) ?? null);
    const related = task.sessionId
        ? tasks.filter((t) => t.sessionId === task.sessionId)
        : [task],
      saved: AltrexEvent[] = [];
    let truncated = false;
    for (let i = 0; i < related.length; i += 8) {
      const histories = await Promise.all(
        related
          .slice(i, i + 8)
          .map((t) => invoke("task.events", { taskId: t.taskId, limit: 5000 })),
      );
      if (token !== generation.current) return;
      histories.forEach((history) => {
        if (history) {
          saved.push(...history.events);
          truncated ||= history.truncated;
        }
      });
    }
    ingest(saved);
    setHistoryLoading(false);
    if (truncated || task.eventsTruncated)
      setHistoryNotice(
        "This saved history is partial. Task status and verification come from the persisted record.",
      );
  };
  const acceptTask = async (taskId: string) => {
    setSelectedId(taskId);
    const task = await invoke("task.get", { taskId });
    if (task)
      setTasks((previous) => [
        task,
        ...previous.filter((t) => t.taskId !== taskId),
      ]);
  };
  const activeTasks = tasks.filter((task) => !terminalStates.has(task.state));
  return {
    core,
    invoke,
    refresh,
    projects,
    project,
    setProject,
    providers,
    setProviders,
    consents,
    setConsents,
    tasks,
    events,
    pending,
    loading,
    error,
    setError,
    sessionId,
    selectedId,
    setSelectedId,
    sessions,
    historyLoading,
    historyNotice:
      events.length >= 20000
        ? "Live event memory is limited to the latest 20,000 events. Earlier output may be partial; reopen a task to load saved history."
        : historyNotice,
    newSession,
    openProject,
    selectTask,
    acceptTask,
    activeTasks,
  };
}
export type Workspace = ReturnType<typeof useWorkspace>;
