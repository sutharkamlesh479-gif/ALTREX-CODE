import { useMemo, useState } from "react";
import type { AltrexEvent, TaskSummary } from "@altrex/contracts";
import { X } from "lucide-react";
import {
  commandViews,
  label,
  problems,
  taskView,
  terminalStates,
} from "./state";
import { EvidenceRow, Status } from "./TaskCard";
import { RouteLabel } from "./logos";
import { Changes, Checkpoints } from "./Changes";
import { ProjectContext } from "./ProjectContext";
import type { Workspace } from "./useWorkspace";
export const panelTabs = [
  "Changes",
  "Terminal",
  "Tests",
  "Problems",
  "Agents",
  "Checkpoints",
  "Context",
  "Developer",
] as const;
export type PanelTab = (typeof panelTabs)[number];
export function WorkPanel({
  app,
  tab,
  setTab,
  task,
  events,
  onClose,
}: {
  app: Workspace;
  tab: PanelTab;
  setTab: (tab: PanelTab) => void;
  task?: TaskSummary | undefined;
  events: AltrexEvent[];
  onClose: () => void;
}) {
  const view = useMemo(
    () =>
      task
        ? taskView(
            task,
            events.filter((e) => e.taskId === task.taskId),
          )
        : undefined,
    [task, events],
  );
  const commands = useMemo(() => commandViews(events), [events]),
    issues = useMemo(() => problems(events), [events]);
  const [command, setCommand] = useState(""),
    [args, setArgs] = useState(""),
    [running, setRunning] = useState(false),
    [checksRunning, setChecksRunning] = useState(false),
    [limit, setLimit] = useState(50),
    [inputError, setInputError] = useState("");
  const projectPath = app.project?.path,
    busy = app.activeTasks.some((t) => t.projectPath === projectPath);
  const run = async () => {
    if (!projectPath) return;
    let parsed: unknown;
    try {
      parsed = args.trim() ? JSON.parse(args) : [];
      if (
        !Array.isArray(parsed) ||
        !parsed.every((arg) => typeof arg === "string")
      )
        throw new Error();
    } catch {
      setInputError(
        'Enter arguments as a JSON string array, for example ["run", "dev"].',
      );
      return;
    }
    setInputError("");
    setRunning(true);
    await app.invoke("terminal.run", {
      projectPath,
      command,
      args: parsed as string[],
    });
    setRunning(false);
  };
  const evidence = events.filter((e) => e.type === "test.completed"),
    tests = events.filter((e) => e.type === "test.started");
  const runningTests = tests.filter(
    (e) => !evidence.some((done) => done.payload.testId === e.payload.testId),
  );
  return (
    <section className="v4-panel" aria-label="Workspace details">
      <div
        className="v4-panel-tabs"
        role="tablist"
        aria-label="Workspace details"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const next =
              panelTabs[
                (panelTabs.indexOf(tab) +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  panelTabs.length) %
                  panelTabs.length
              ]!;
            setTab(next);
            document.getElementById(`tab-${next}`)?.focus();
          }
        }}
      >
        {panelTabs.map((name) => (
          <button
            role="tab"
            id={`tab-${name}`}
            aria-controls="v4-panel-content"
            tabIndex={tab === name ? 0 : -1}
            aria-selected={tab === name}
            key={name}
            onClick={() => setTab(name)}
          >
            {name}
            {name === "Problems" && issues.length > 0
              ? ` (${issues.length})`
              : ""}
          </button>
        ))}
        <button
          className="v4-close"
          aria-label="Close details"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div
        id="v4-panel-content"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="v4-panel-content"
      >
        {tab === "Changes" && (
          <Changes
            key={task?.taskId ?? "none"}
            invoke={app.invoke}
            files={view?.files ?? []}
            checkpoint={view?.checkpoint}
            changes={view?.changes ?? new Map()}
            truncated={view?.diffTruncated ?? false}
          />
        )}
        {tab === "Terminal" && (
          <>
            <header className="v4-panel-heading">
              <h3>Command output</h3>
              <small>Selected task + app-wide manual commands.</small>
            </header>
            {commands.slice(-limit).map((item) => (
              <details className="v4-command" key={item.id} open>
                <summary>
                  <code>{item.command}</code>
                  <span>
                    {item.done
                      ? `Exit ${item.exitCode ?? "unknown"} · ${((item.durationMs ?? 0) / 1000).toFixed(1)}s${item.timedOut ? " · Timed out" : ""}`
                      : "Running"}
                  </span>
                </summary>
                {!item.done && (
                  <button
                    onClick={() =>
                      void (item.taskId
                        ? app.invoke("task.cancel", { taskId: item.taskId })
                        : app.invoke("terminal.cancel", { commandId: item.id }))
                    }
                  >
                    {item.taskId ? "Stop owning task" : "Cancel command"}
                  </button>
                )}
                {item.output && <pre>{item.output}</pre>}
                {item.stderr && <pre className="bad">{item.stderr}</pre>}
                {item.clipped && (
                  <small>
                    Showing the last 100,000 characters per output stream.
                  </small>
                )}
              </details>
            ))}
            {!commands.length && (
              <p className="v4-empty">
                Output will appear here when a command runs.
              </p>
            )}
            {commands.length > limit && (
              <button onClick={() => setLimit((n) => n + 50)}>
                Show earlier commands
              </button>
            )}
            <details className="v4-work">
              <summary>Run a project command</summary>
              <p className="muted">
                Executable and separate arguments; shell syntax is not
                supported.
              </p>
              <form
                className="v4-terminal-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run();
                }}
              >
                <label>
                  Executable
                  <input
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="pnpm"
                  />
                </label>
                <label>
                  Arguments (JSON array)
                  <input
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder={'["run", "test"]'}
                  />
                </label>
                <button
                  disabled={!projectPath || !command.trim() || running || busy}
                >
                  {running ? "Running…" : "Run command"}
                </button>
              </form>
              {inputError && <p role="alert">{inputError}</p>}
            </details>
          </>
        )}
        {tab === "Tests" && (
          <>
            <header className="v4-panel-heading">
              <div>
                <h3>Checks & repair history</h3>
                <p>
                  Only declared project checks are run. Counts come from
                  recognized runner output.
                </p>
              </div>
              <button
                disabled={!projectPath || checksRunning || busy}
                onClick={() => {
                  if (projectPath) {
                    setChecksRunning(true);
                    void app
                      .invoke("checks.run", { projectPath })
                      .finally(() => setChecksRunning(false));
                  }
                }}
              >
                {checksRunning ? "Running checks…" : "Run project checks"}
              </button>
            </header>
            {runningTests.map((e) => (
              <p key={e.id} role="status">
                {label(e.payload.name)} · running {e.payload.command}
              </p>
            ))}
            {events
              .filter((e) => e.type === "repair.started")
              .map((e) => (
                <p className="v4-notice" key={e.id}>
                  Repair {e.payload.attempt}/{e.payload.limit}:{" "}
                  {label(e.payload.reason)}
                </p>
              ))}
            {evidence.map((e, index) => (
              <EvidenceRow
                key={e.id}
                evidence={e.payload.evidence}
                attempt={
                  evidence
                    .slice(0, index + 1)
                    .filter(
                      (prior) =>
                        prior.payload.evidence.name === e.payload.evidence.name,
                    ).length
                }
              />
            ))}
            {!evidence.length && !runningTests.length && (
              <p className="v4-empty">No checks have run in this view.</p>
            )}
          </>
        )}
        {tab === "Problems" &&
          (issues.length ? (
            issues.slice(-100).map((issue) => (
              <div className="v4-issue" key={issue.id}>
                <strong>{issue.category}</strong>
                <pre>{issue.message}</pre>
              </div>
            ))
          ) : (
            <p className="v4-empty">
              No reported problems in this view. This is not a verification
              result.
            </p>
          ))}
        {tab === "Agents" &&
          (view?.agents.length ? (
            view.agents.map((agent) => (
              <div className="v4-agent" key={agent.agentId}>
                <strong>{label(agent.role)}</strong>
                <Status value={agent.status} />
                <p>{agent.summary ?? agent.label}</p>
                <small>
                  {agent.providerId || /codex/i.test(agent.label) ? (
                    <RouteLabel providerId={agent.providerId ?? "codex"} model={agent.model} />
                  ) : (
                    "System"
                  )}
                </small>
              </div>
            ))
          ) : (
            <p className="v4-empty">
              Agents appear when the backend starts them.
            </p>
          ))}
        {tab === "Checkpoints" &&
          (projectPath ? (
            <Checkpoints
              key={projectPath}
              invoke={app.invoke}
              projectPath={projectPath}
              busy={busy}
            />
          ) : (
            <p className="v4-empty">
              Open the project to inspect recovery checkpoints.
            </p>
          ))}
        {tab === "Context" &&
          (projectPath ? (
            <ProjectContext
              key={projectPath}
              invoke={app.invoke}
              projectPath={projectPath}
            />
          ) : (
            <p className="v4-empty">
              Open a project to inspect files and context.
            </p>
          ))}
        {tab === "Developer" && (
          <>
            <h3>Core events</h3>
            <p>
              Task: <code>{task?.taskId ?? "No task selected"}</code> · Contract
              v{app.core?.contractVersion ?? "unavailable"}
            </p>
            <p className="muted">
              Selected task and live global events. Context usage and unexposed
              tool internals are unavailable in contract v1.
            </p>
            {events.slice(-100).map((event) => (
              <details key={event.id}>
                <summary>
                  <code>
                    {event.seq} {event.type}
                  </code>
                  <time>{new Date(event.ts).toLocaleTimeString()}</time>
                </summary>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            ))}
            {events.length > 100 && <p>Showing the latest 100 events.</p>}
            {view && !terminalStates.has(view.state) && (
              <p role="status">Task is active.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
