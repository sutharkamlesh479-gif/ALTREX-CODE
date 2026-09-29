import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings as SettingsIcon,
  Square,
  Terminal,
  X,
  Files,
} from "lucide-react";
import type {
  AltrexCoreBridge,
  AltrexEvent,
  RoutingMode,
  TaskMode,
} from "@altrex/contracts";
import { AltrexLogo, AltrexCodeSymbol } from "../AltrexBrand";
import { Dialog } from "../components/primitives";
import { useWorkspace } from "./useWorkspace";
import { label, taskView, terminalStates } from "./state";
import { TaskCard } from "./TaskCard";
import { WorkPanel, type PanelTab } from "./WorkPanel";
import { Settings } from "./Settings";
import { Approvals } from "./Approvals";
import { Palette, type PaletteAction } from "./Palette";
import { SetupPrompt } from "./SetupPrompt";
import { RouteBadge } from "./RouteBadge";
import "./workspace.css";

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The app still works when storage is disabled. */
  }
}
export function App({
  core = window.altrexCore,
  demo = false,
}: {
  core?: AltrexCoreBridge | undefined;
  demo?: boolean;
}) {
  const app = useWorkspace(core),
    [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState<TaskMode>("AGENT"),
    [routing, setRouting] = useState<RoutingMode>("AUTO");
  const [customModel, setCustomModel] = useState(""),
    [candidates, setCandidates] = useState(1),
    [settings, setSettings] = useState(false),
    [palette, setPalette] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>(null),
    [collapsed, setCollapsed] = useState(
      readPreference("altrex.v4.sidebar") === "collapsed",
    ),
    [starting, setStarting] = useState(false),
    [consent, setConsent] = useState(false);
  // First-run guidance: shown while no AI provider is configured, until dismissed for this session.
  const [setupDismissed, setSetupDismissed] = useState(false),
    [setupOpen, setSetupOpen] = useState(false),
    [settingsProvider, setSettingsProvider] = useState<string | undefined>();
  // Engine: ALTREX's routed providers, or the OpenAI Codex CLI with the user's ChatGPT sign-in (Build only).
  const [engine, setEngine] = useState<"ALTREX" | "CODEX">("ALTREX");
  // The backend lists the Codex engine among consent endpoints only when the Codex CLI is installed.
  const codexAvailable = app.consents.some((endpoint) => endpoint.providerId === "codex");
  const useCodex = engine === "CODEX" && mode === "AGENT";
  const relevantConsents = app.consents.filter((endpoint) =>
    useCodex ? endpoint.providerId === "codex" : endpoint.providerId !== "codex",
  );
  const needsProvider = !app.loading && !!core && !app.providers.length;
  const showSetup = needsProvider && (setupOpen || !setupDismissed);
  const [taskFilter, setTaskFilter] = useState(""),
    [allProjects, setAllProjects] = useState(false),
    [historyLimit, setHistoryLimit] = useState(60),
    [conversationLimit, setConversationLimit] = useState(12),
    [prompts, setPrompts] = useState<Record<string, string>>({});
  const composer = useRef<HTMLTextAreaElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    startLock = useRef(false);
  const conversation = app.tasks
    .filter(
      (task) =>
        task.sessionId === app.sessionId ||
        (!task.sessionId && task.taskId === app.sessionId),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const selected =
    app.tasks.find((task) => task.taskId === app.selectedId) ??
    conversation.at(-1);
  const groupedEvents = useMemo(() => {
    const map = new Map<string | null, AltrexEvent[]>();
    for (const event of app.events) {
      const list = map.get(event.taskId) ?? [];
      list.push(event);
      map.set(event.taskId, list);
    }
    return map;
  }, [app.events]);
  const visibleEvents = useMemo(
    () =>
      [
        ...(groupedEvents.get(null) ?? []),
        ...(selected ? (groupedEvents.get(selected.taskId) ?? []) : []),
      ].sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq),
    [groupedEvents, selected?.taskId],
  );
  const runningTask = conversation.find(
    (task) =>
      !terminalStates.has(
        taskView(task, groupedEvents.get(task.taskId) ?? []).state,
      ),
  );
  const busyProject = app.activeTasks.some(
    (t) => t.projectPath === app.project?.path,
  );
  const fresh = () => {
    if (starting) return;
    app.newSession();
    setPrompt("");
    setPanel(null);
    setConversationLimit(12);
    composer.current?.focus();
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "n" &&
        !settings &&
        !palette
      ) {
        event.preventDefault();
        fresh();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [starting, settings, palette]);
  useEffect(() => {
    if (nearBottom.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [app.events, conversation.length]);
  const send = async (confirmed = false) => {
    if (
      startLock.current ||
      !prompt.trim() ||
      runningTask ||
      busyProject ||
      app.historyLoading ||
      app.loading ||
      !core
    )
      return;
    if (!useCodex && !app.providers.length && !setupDismissed) {
      setSetupOpen(true);
      return;
    }
    if (!app.project && mode !== "ASK") {
      await app.openProject();
      return;
    }
    if (routing === "CUSTOM" && !customModel.trim()) {
      setSettings(true);
      return;
    }
    // Project code goes to cloud AI only with consent recorded by the backend, which enforces it
    // (tasks fail with CONSENT_REQUIRED otherwise). This prompt only collects the decision.
    const missing = relevantConsents.filter((endpoint) => !endpoint.granted);
    if (
      !confirmed &&
      app.project &&
      (useCodex || routing !== "LOCAL_ONLY") &&
      mode !== "LOCAL" &&
      missing.length
    ) {
      setConsent(true);
      return;
    }
    if (confirmed) {
      for (const endpoint of missing)
        await app.invoke("consent.grant", {
          providerId: endpoint.providerId,
          baseUrl: endpoint.baseUrl,
        });
      const next = await app.invoke("consent.list", {});
      if (next) app.setConsents(next);
    }
    setConsent(false);
    startLock.current = true;
    setStarting(true);
    app.setError(null);
    const history = conversation.slice(-80).flatMap((task) => {
      const view = taskView(task, groupedEvents.get(task.taskId) ?? []);
      return [
        {
          role: "user" as const,
          content: (prompts[task.taskId] ?? task.title).slice(0, 200000),
        },
        ...(view.text
          ? [
              {
                role: "assistant" as const,
                content: view.text.slice(0, 200000),
              },
            ]
          : []),
      ];
    });
    const text = prompt.trim();
    const result = await app.invoke("task.start", {
      projectPath: app.project?.path ?? null,
      mode,
      prompt: text,
      sessionId: app.sessionId,
      history,
      routingMode: mode === "LOCAL" ? "LOCAL_ONLY" : useCodex ? "AUTO" : routing,
      modelSelection: useCodex ? "CODEX" : routing === "CUSTOM" ? customModel : "AUTO",
      candidates: mode === "AGENT" ? candidates : 1,
    });
    if (result) {
      setPrompts((previous) => ({ ...previous, [result.taskId]: text }));
      setPrompt("");
      nearBottom.current = true;
      await app.acceptTask(result.taskId);
    }
    setStarting(false);
    startLock.current = false;
  };
  const retry = (text: string) => {
    setPrompt(text);
    composer.current?.focus();
  };
  const actions: PaletteAction[] = [
    {
      name: "Open project",
      run: () => void app.openProject(),
      disabled: starting,
    },
    { name: "New task / session", run: fresh, disabled: starting },
    { name: "Provider settings", run: () => setSettings(true) },
    {
      name: "Change AI mode",
      run: () => document.getElementById("v4-routing")?.focus(),
    },
    ...(
      [
        "Terminal",
        "Changes",
        "Tests",
        "Problems",
        "Agents",
        "Checkpoints",
        "Context",
        "Developer",
      ] as PanelTab[]
    ).map((tab) => ({
      name:
        tab === "Checkpoints"
          ? "Restore checkpoint"
          : `Open ${tab.toLowerCase()}`,
      run: () => setPanel(tab),
    })),
    ...app.projects.map((project) => ({
      name: `Switch project: ${project.name}`,
      run: () => {
        app.setProject(project);
        fresh();
      },
      disabled: starting,
    })),
  ];
  const taskHistory = app.tasks.filter(
    (task) =>
      (allProjects || !app.project || task.projectPath === app.project.path) &&
      task.title.toLowerCase().includes(taskFilter.toLowerCase()),
  );
  const health = app.providers.some((p) => p.health === "HEALTHY")
    ? "AI available"
    : app.providers.length
      ? "Check AI setup"
      : "Set up AI";
  return (
    <div className={`v4-shell ${collapsed ? "v4-collapsed" : ""}`}>
      <aside className="v4-sidebar">
        <div className="v4-brand">
          <AltrexLogo size={25} />
          <strong>ALTREX</strong>
          <button
            className="quiet"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              setCollapsed(!collapsed);
              savePreference(
                "altrex.v4.sidebar",
                collapsed ? "expanded" : "collapsed",
              );
            }}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
          </button>
        </div>
        <button
          className="v4-nav"
          title="New task"
          disabled={starting}
          onClick={fresh}
        >
          <Plus size={17} />
          <span>New task</span>
          <kbd>⌘/Ctrl N</kbd>
        </button>
        <button
          className="v4-nav"
          title="Commands"
          onClick={() => setPalette(true)}
        >
          <Search size={16} />
          <span>Commands</span>
          <kbd>⌘/Ctrl K</kbd>
        </button>
        <button
          className="v4-nav"
          title="Open project"
          disabled={starting}
          onClick={() => void app.openProject()}
        >
          <FolderOpen size={17} />
          <span>Open project</span>
        </button>
        <div className="v4-sidebar-content">
          <div className="v4-section-label">PROJECTS</div>
          {app.projects.map((project) => (
            <button
              className="v4-project"
              aria-current={
                app.project?.path === project.path ? "page" : undefined
              }
              key={project.path}
              title={project.path}
              disabled={starting}
              onClick={() => {
                app.setProject(project);
                fresh();
              }}
            >
              <FolderOpen size={15} />
              <span>{project.name}</span>
            </button>
          ))}
          {!app.projects.length && (
            <small className="muted">Your projects will appear here.</small>
          )}
          <div className="v4-section-label">SESSIONS</div>
          {app.sessions
            .filter(
              (s) =>
                allProjects ||
                !app.project ||
                s.projectPath === app.project.path,
            )
            .slice(0, 8)
            .map((session) => (
              <button
                className="v4-history"
                key={session.sessionId}
                disabled={starting}
                onClick={() => {
                  const task = app.tasks.find(
                    (t) => t.sessionId === session.sessionId,
                  );
                  if (task) void app.selectTask(task);
                }}
              >
                <span>{session.title}</span>
                <small>
                  {session.taskCount} tasks · {label(session.lastState)}
                </small>
              </button>
            ))}
          <div className="v4-section-label">TASK HISTORY</div>
          <select
            aria-label="History project filter"
            value={allProjects ? "all" : "current"}
            onChange={(e) => setAllProjects(e.target.value === "all")}
          >
            <option value="current">Current project</option>
            <option value="all">All projects</option>
          </select>
          <input
            className="v4-history-search"
            aria-label="Filter task history"
            value={taskFilter}
            placeholder="Find a task…"
            onChange={(e) => setTaskFilter(e.target.value)}
          />
          {taskHistory.slice(0, historyLimit).map((task) => (
            <button
              className="v4-history"
              key={task.taskId}
              title={task.title}
              aria-current={app.selectedId === task.taskId ? "true" : undefined}
              disabled={starting}
              onClick={() => {
                void app.selectTask(task);
                setPrompt("");
                setConversationLimit(12);
              }}
            >
              <span>{task.title}</span>
              <small>{label(task.state)}</small>
            </button>
          ))}
          {taskHistory.length > historyLimit && (
            <button onClick={() => setHistoryLimit((n) => n + 60)}>
              Show more tasks
            </button>
          )}
          {!taskHistory.length && (
            <p className="muted">Your work, ready to return to.</p>
          )}
        </div>
        <button
          className="v4-nav v4-settings-trigger"
          title="Settings"
          onClick={() => setSettings(true)}
        >
          <SettingsIcon size={17} />
          <span>Settings</span>
        </button>
        <small className="v4-sidebar-foot">Local workspace · Contract v1</small>
      </aside>
      <header className="v4-topbar">
        <div className="v4-breadcrumb">
          <span>{app.project?.name ?? "Your workspace"}</span>
          {app.project?.branch && <small>{app.project.branch}</small>}
          <ChevronRight size={13} />
          <span>{selected ? "Session" : "New task"}</span>
        </div>
        <div className="v4-top-actions">
          {demo && <span className="v4-demo">DEMO · no real execution</span>}
          <button
            className="v4-health"
            onClick={() => (needsProvider ? setSetupOpen(true) : setSettings(true))}
          >
            <span
              className={`v4-dot ${app.providers.some((p) => p.health === "HEALTHY") ? "good" : ""}`}
            />
            {health}
          </button>
          <button
            className="quiet"
            aria-label="View changes"
            onClick={() => setPanel(panel === "Changes" ? null : "Changes")}
          >
            <Files size={17} />
          </button>
          <button
            className="quiet"
            aria-label="Open terminal"
            onClick={() => setPanel(panel === "Terminal" ? null : "Terminal")}
          >
            <Terminal size={17} />
          </button>
        </div>
      </header>
      <main className={`v4-main ${panel ? "v4-has-panel" : ""}`}>
        <div className="v4-conversation-area">
          <div
            ref={scroller}
            className="v4-conversation"
            onScroll={() => {
              const el = scroller.current;
              if (el)
                nearBottom.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            }}
          >
            {app.loading ? (
              <div className="v4-home" role="status">
                Opening your workspace…
              </div>
            ) : !core ? (
              <div className="v4-home">
                <AltrexCodeSymbol />
                <h1>Connect to your workspace</h1>
                <p>Open ALTREX CODE on your desktop to use the secure core.</p>
              </div>
            ) : !conversation.length ? (
              <div className="v4-home">
                <AltrexCodeSymbol size={54} />
                <span className="eyebrow">YOUR IDEAS. WORKING SOFTWARE.</span>
                <h1>What should we build?</h1>
                <p>
                  Describe the result. ALTREX explores, implements,
                  <br className="wide-only" /> and checks the work with you.
                </p>
                {!app.project && (
                  <button
                    className="primary"
                    onClick={() => void app.openProject()}
                  >
                    <FolderOpen size={16} />
                    Open a project
                  </button>
                )}
                {!app.providers.length && (
                  <div className="v4-onboarding">
                    <button onClick={() => setSettings(true)}>
                      Configure cloud AI
                    </button>
                    <button
                      onClick={() => {
                        setRouting("LOCAL_ONLY");
                        setMode("LOCAL");
                        setSettings(true);
                      }}
                    >
                      Set up local AI
                    </button>
                  </div>
                )}
                <div className="v4-starters">
                  {[
                    {
                      title: "Build something",
                      text: "Build a login system for this project.",
                    },
                    {
                      title: "Find the problem",
                      text: "Find and fix a bug in this project. Explain the cause and verify the fix.",
                    },
                    {
                      title: "Understand the code",
                      text: "Explain the architecture and key entry points in this project.",
                      ask: true,
                    },
                  ].map((item) => (
                    <button
                      key={item.title}
                      onClick={() => {
                        setMode(item.ask ? "ASK" : "AGENT");
                        retry(item.text);
                      }}
                    >
                      <strong>{item.title}</strong>
                      <span>
                        {item.ask
                          ? "Explore your project"
                          : item.title === "Build something"
                            ? "Turn an idea into code"
                            : "Trace, fix, and verify"}
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="v4-transcript">
                {app.historyNotice && (
                  <p className="v4-warning">{app.historyNotice}</p>
                )}
                {app.historyLoading && (
                  <p role="status">Restoring session history…</p>
                )}
                {conversation.length > conversationLimit && (
                  <button onClick={() => setConversationLimit((n) => n + 12)}>
                    Load earlier tasks (
                    {conversation.length - conversationLimit})
                  </button>
                )}
                {conversation.slice(-conversationLimit).map((task) => (
                  <TaskCard
                    key={task.taskId}
                    task={task}
                    events={groupedEvents.get(task.taskId) ?? []}
                    prompt={prompts[task.taskId]}
                    onSelect={() => app.setSelectedId(task.taskId)}
                    onChanges={() => {
                      app.setSelectedId(task.taskId);
                      setPanel("Changes");
                    }}
                    onCancel={() =>
                      void app.invoke("task.cancel", { taskId: task.taskId })
                    }
                    onRetry={retry}
                    providers={app.providers}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="v4-composer-wrap">
            {selected && !app.project && selected.projectPath && (
              <p className="v4-warning">
                Reopen {selected.projectPath} before continuing work on this
                project.
              </p>
            )}
            <form
              className="v4-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={composer}
                aria-label="Ask ALTREX"
                placeholder={
                  app.project
                    ? "Ask ALTREX to build, fix, or explore…"
                    : "Describe what you want to work on…"
                }
                value={prompt}
                maxLength={200000}
                rows={3}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    (e.ctrlKey || e.metaKey) &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="v4-composer-controls">
                <div className="v4-composer-options">
                  <select
                    aria-label="Task mode"
                    value={mode}
                    disabled={starting || !!runningTask}
                    onChange={(e) => {
                      const next = e.target.value as TaskMode;
                      setMode(next);
                      if (next !== "AGENT") setEngine("ALTREX");
                    }}
                  >
                    <option value="AGENT">Build</option>
                    <option value="ASK">Ask</option>
                    <option value="LOCAL">Local AI</option>
                    <option value="MULTI">Multi-AI</option>
                  </select>
                  <select
                    id="v4-routing"
                    aria-label="AI mode"
                    value={useCodex ? "CODEX" : routing}
                    disabled={starting || !!runningTask || mode === "LOCAL"}
                    onChange={(e) => {
                      if (e.target.value === "CODEX") {
                        setEngine("CODEX");
                        return;
                      }
                      setEngine("ALTREX");
                      setRouting(e.target.value as RoutingMode);
                    }}
                  >
                    {mode === "AGENT" && (
                      <option value="CODEX" disabled={!codexAvailable}>
                        {codexAvailable
                          ? "ChatGPT Codex"
                          : "ChatGPT Codex (install Codex CLI)"}
                      </option>
                    )}
                    {[
                      "AUTO",
                      "FAST",
                      "POWERFUL",
                      "FREE_ONLY",
                      "LOCAL_ONLY",
                      "CUSTOM",
                    ].map((value) => (
                      <option key={value} value={value}>
                        {label(value)}
                      </option>
                    ))}
                  </select>
                  {(runningTask ?? conversation.at(-1)) && (
                    <RouteBadge
                      events={groupedEvents.get((runningTask ?? conversation.at(-1))!.taskId) ?? []}
                      providers={app.providers}
                    />
                  )}
                  <details className="v4-run-options">
                    <summary>Options</summary>
                    <div>
                      <label>
                        Solution candidates
                        <select
                          aria-label="Solution candidates"
                          disabled={mode !== "AGENT"}
                          value={candidates}
                          onChange={(e) =>
                            setCandidates(Number(e.target.value))
                          }
                        >
                          <option value={1}>One solution</option>
                          <option value={2}>Compare two</option>
                          <option value={3}>Compare three</option>
                        </select>
                      </label>
                      <small>
                        Tournament runs cost more and are available in Build
                        mode. Ranking uses actual checks.
                      </small>
                      <button type="button" onClick={() => setSettings(true)}>
                        Advanced AI settings
                      </button>
                    </div>
                  </details>
                </div>
                {runningTask ? (
                  <button
                    type="button"
                    className="v4-send"
                    aria-label="Stop task"
                    onClick={() =>
                      void app.invoke("task.cancel", {
                        taskId: runningTask.taskId,
                      })
                    }
                  >
                    <Square size={15} />
                  </button>
                ) : (
                  <button
                    className="v4-send"
                    aria-label="Run task"
                    disabled={
                      !prompt.trim() ||
                      starting ||
                      app.loading ||
                      app.historyLoading ||
                      busyProject ||
                      !core
                    }
                  >
                    <ArrowUp size={19} />
                  </button>
                )}
              </div>
            </form>
            <div className="v4-composer-foot">
              <span>
                {app.project
                  ? app.project.name
                  : "Open a project to edit files"}
                {useCodex
                  ? " · ChatGPT Codex (your subscription)"
                  : mode === "LOCAL" || routing === "LOCAL_ONLY"
                  ? " · Local only"
                  : ` · ${routing === "AUTO" ? "Auto-routed AI" : label(routing)}`}
              </span>
              <span>{starting ? "Starting task…" : "Ctrl + Enter to run"}</span>
            </div>
          </div>
        </div>
        {panel && (
          <WorkPanel
            key={app.project?.path ?? "no-project"}
            app={app}
            tab={panel}
            setTab={setPanel}
            task={selected}
            events={visibleEvents}
            onClose={() => setPanel(null)}
          />
        )}
      </main>
      {app.error && (
        <div role="alert" className="v4-error">
          <div>
            <strong>{label(app.error.code)}</strong>
            <p>
              {app.error.code === "INTERNAL"
                ? "ALTREX could not complete this action. Try again or inspect the desktop diagnostics."
                : app.error.message}
            </p>
            {app.error.detail && app.error.code !== "INTERNAL" && (
              <small className="mono">{app.error.detail}</small>
            )}
            {app.error.retryable && <small>You can retry this action.</small>}
          </div>
          <button
            className="quiet"
            aria-label="Dismiss error"
            onClick={() => app.setError(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {settings && (
        <Settings
          app={app}
          onClose={() => {
            setSettings(false);
            setSettingsProvider(undefined);
          }}
          routingMode={routing}
          initialProvider={settingsProvider}
          customModel={customModel}
          setCustomModel={setCustomModel}
        />
      )}
      {palette && (
        <Palette actions={actions} onClose={() => setPalette(false)} />
      )}
      {consent && (
        <Dialog
          title="Allow cloud AI for this workspace"
          onClose={() => setConsent(false)}
          className="v4-dialog"
        >
          <h2>Allow cloud AI</h2>
          <p>
            Automatic routing and fallback may send your prompt and relevant
            project content to these configured cloud endpoints:
          </p>
          {relevantConsents
            .filter((endpoint) => !endpoint.granted)
            .map((endpoint) => (
              <p key={`${endpoint.providerId}-${endpoint.baseUrl}`}>
                <strong>{endpoint.displayName}</strong>
                <br />
                <span className="mono">{endpoint.baseUrl}</span>
              </p>
            ))}
          <p>Choose Local only to keep model requests on local endpoints.</p>
          <footer>
            <button
              onClick={() => {
                setRouting("LOCAL_ONLY");
                setConsent(false);
              }}
            >
              Use Local only
            </button>
            <button className="primary" onClick={() => void send(true)}>
              Allow and run task
            </button>
          </footer>
        </Dialog>
      )}
      {showSetup && !settings && (
        <SetupPrompt
          invoke={app.invoke}
          codexAvailable={codexAvailable}
          onUseCodex={() => {
            setSetupOpen(false);
            setSetupDismissed(true);
            setMode("AGENT");
            setEngine("CODEX");
          }}
          onAdd={(providerId) => {
            setSetupOpen(false);
            setSetupDismissed(true);
            setSettingsProvider(providerId);
            setSettings(true);
          }}
          onClose={() => {
            setSetupOpen(false);
            setSetupDismissed(true);
          }}
        />
      )}
      <Approvals
        pending={app.pending}
        invoke={app.invoke}
        onRefresh={app.refresh}
      />
      <div className="sr-only" role="status">
        {runningTask
          ? `Task ${label(taskView(runningTask, groupedEvents.get(runningTask.taskId) ?? []).state)}`
          : ""}
      </div>
    </div>
  );
}
