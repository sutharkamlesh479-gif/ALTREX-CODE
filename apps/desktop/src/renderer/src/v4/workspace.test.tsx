// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCore } from "@altrex/contracts/fake-core";
import type {
  AltrexCoreBridge,
  AltrexEvent,
  CommandName,
  CommandRequest,
  CommandResponse,
  CoreInvokeResult,
  TaskSummary,
} from "@altrex/contracts";
import { App } from "./App";
import { Changes, Checkpoints, diffLines } from "./Changes";
import { mergeEvents, taskView, commandViews } from "./state";
import { TaskCard } from "./TaskCard";
import type { Invoke } from "./useWorkspace";
import { WorkPanel } from "./WorkPanel";
import type { Workspace } from "./useWorkspace";

let core: FakeCore;
beforeEach(() => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  Element.prototype.scrollIntoView = vi.fn();
  core = new FakeCore({ delayMs: 5 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function launch(bridge: AltrexCoreBridge = core) {
  render(<App core={bridge} />);
  await screen.findByRole("heading", { name: "What should we build?" });
}
async function send(prompt = "Build a login form") {
  fireEvent.change(screen.getByLabelText("Ask ALTREX"), {
    target: { value: prompt },
  });
  fireEvent.click(screen.getByLabelText("Run task"));
  const consent = screen.queryByRole("button", { name: "Allow and run task" });
  if (consent) fireEvent.click(consent);
}
const fixture = (state: TaskSummary["state"]): TaskSummary => ({
  taskId: "task-fixture",
  requestId: null,
  sessionId: "session-fixture",
  mode: "AGENT",
  intent: "change",
  projectPath: "/demo/demo-app",
  title: "Fix authentication",
  modelSelection: "AUTO",
  routingMode: "AUTO",
  engine: "altrex",
  state,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  checkpointIds: [],
  changedFiles: [],
  agents: [],
  outcome: null,
  eventsTruncated: false,
  verdict: null,
});
function event(
  type: AltrexEvent["type"],
  payload: unknown,
  seq = 1,
): AltrexEvent {
  return {
    v: 1,
    type,
    payload,
    seq,
    id: `event-${seq}`,
    streamId: "test-stream",
    taskId: "task-fixture",
    ts: new Date(1700000000000 + seq).toISOString(),
  } as AltrexEvent;
}

describe("contract workspace", () => {
  it("starts with the real contract and never calls the legacy bridge", async () => {
    const legacy = vi.fn();
    window.altrex = { startChat: legacy } as never;
    const invoke = vi.spyOn(core, "invokeResult");
    await launch();
    await send();
    await core.idle();
    await screen.findByText("Verified result");
    expect(invoke).toHaveBeenCalledWith("permission.configure", {
      interactive: true,
    });
    expect(invoke).toHaveBeenCalledWith(
      "task.start",
      expect.objectContaining({
        mode: "AGENT",
        routingMode: "AUTO",
        sessionId: expect.any(String),
      }),
    );
    expect(legacy).not.toHaveBeenCalled();
  });
  it("shows true checks, streamed text, agents and changed files from FakeCore", async () => {
    await launch();
    await send();
    await core.idle();
    await screen.findByText("Verified result");
    expect(screen.getByRole("button", { name: /changed file/ })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Open terminal"));
    expect(await screen.findByText(/pnpm run test/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Tests" }));
    expect(screen.getByText(/attempt 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    expect(screen.getAllByText("Coder").length).toBeGreaterThan(0);
  });
  it("renders failed checks and a real repair without upgrading failure to verified", async () => {
    await launch();
    await send("fail this task");
    await core.idle();
    await screen.findByRole("button", { name: "Edit and retry" });
    expect(screen.queryByText("Verified result")).toBeNull();
    fireEvent.click(screen.getByLabelText("Open terminal"));
    fireEvent.click(screen.getByRole("tab", { name: "Tests" }));
    expect(screen.getAllByText(/Repair 1/).length).toBeGreaterThan(0);
  });
  it.each(["Allow once", "Allow for this task", "Deny"])(
    "answers approval through permission.respond: %s",
    async (answer) => {
      const invoke = vi.spyOn(core, "invokeResult");
      await launch();
      await send("approval required");
      const dialog = await screen.findByRole("dialog", {
        name: "Approval required",
      });
      fireEvent.click(within(dialog).getByRole("button", { name: answer }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "permission.respond",
          expect.objectContaining({
            decision: answer === "Deny" ? "deny" : "approve",
            scope: answer === "Allow for this task" ? "task" : "once",
          }),
        ),
      );
      await act(async () => {
        await core.idle();
      });
    },
  );
  it("cancels an active task", async () => {
    core = new FakeCore({ delayMs: 100 });
    const invoke = vi.spyOn(core, "invokeResult");
    await launch();
    await send();
    const stop = await screen.findByLabelText("Stop task");
    fireEvent.click(stop);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "task.cancel",
        expect.objectContaining({ taskId: expect.any(String) }),
      ),
    );
    await act(async () => {
      await core.idle();
    });
  });
  it("restores persisted session events on selection after a renderer restart", async () => {
    await launch();
    await send();
    await core.idle();
    await screen.findByText("Verified result");
    cleanup();
    await launch();
    fireEvent.click(
      screen.getByRole("button", { name: /Build a login form Verified/ }),
    );
    await screen.findByText("Verified result");
    expect(
      screen.getByRole("article", { name: "Task: Build a login form" }),
    ).toBeTruthy();
  });
  it("uses local-only routing, keyboard send, and ignores composing input", async () => {
    const invoke = vi.spyOn(core, "invokeResult");
    await launch();
    fireEvent.change(screen.getByLabelText("AI mode"), {
      target: { value: "LOCAL_ONLY" },
    });
    fireEvent.change(screen.getByLabelText("Ask ALTREX"), {
      target: { value: "A local task" },
    });
    fireEvent.keyDown(screen.getByLabelText("Ask ALTREX"), {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    expect(invoke.mock.calls.some((call) => call[0] === "task.start")).toBe(
      false,
    );
    fireEvent.keyDown(screen.getByLabelText("Ask ALTREX"), {
      key: "Enter",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "task.start",
        expect.objectContaining({ routingMode: "LOCAL_ONLY" }),
      ),
    );
    await act(async () => {
      await core.idle();
    });
  });
  it("opens a keyboard-navigable command palette and restores focus", async () => {
    await launch();
    screen.getByLabelText("Ask ALTREX").focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByLabelText("Search commands");
    fireEvent.change(input, { target: { value: "Provider settings" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("does not label an unknown provider as connected, and clears a one-time key", async () => {
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getAllByText("Not checked", { exact: false }).length,
    ).toBeGreaterThan(0);
    const input = screen.getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "test-only-never-persist" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(localStorage.getItem("altrex.v4.cloud-consent") ?? "").not.toContain(
      "test-only-never-persist",
    );
  });
  it("does not fake an available core", async () => {
    delete window.altrexCore;
    render(<App />);
    await screen.findByRole("heading", { name: "Connect to your workspace" });
    expect(
      (screen.getByLabelText("Run task") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("opens the native project picker through the core contract", async () => {
    const invoke = vi.spyOn(core, "invokeResult");
    await launch();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("project.open", {}),
    );
    expect(
      screen.getByRole("heading", { name: "What should we build?" }),
    ).toBeTruthy();
  });
  it("sends follow-up conversation history without repeating replayed tokens", async () => {
    const invoke = vi.spyOn(core, "invokeResult");
    await launch();
    fireEvent.change(screen.getByLabelText("Task mode"), {
      target: { value: "ASK" },
    });
    await send("Explain the project");
    await core.idle();
    await screen.findByText(/This is a FakeCore demo answer/);
    await screen.findByRole("button", { name: "Completed" });
    await send("Explain the next step");
    await core.idle();
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter((call) => call[0] === "task.start"),
      ).toHaveLength(2),
    );
    const request = invoke.mock.calls
      .filter((call) => call[0] === "task.start")
      .at(-1)?.[1];
    expect(request).toMatchObject({
      history: [
        { role: "user", content: "Explain the project" },
        {
          role: "assistant",
          content: "This is a FakeCore demo answer. No model was called.",
        },
      ],
    });
  });
});
describe("first-run provider setup prompt", () => {
  // The same fake core, but with no provider configured yet.
  const unconfigured = (): AltrexCoreBridge => ({
    contractVersion: core.contractVersion,
    onEvent: (listener) => core.onEvent(listener),
    invoke: core.invoke.bind(core) as AltrexCoreBridge["invoke"],
    invokeResult: (async (name: CommandName, request: never) =>
      name === "provider.list"
        ? { ok: true, value: [] }
        : core.invokeResult(name, request)) as AltrexCoreBridge["invokeResult"],
  });
  it("appears without a provider, opens official key pages through the host, and opens the matching form", async () => {
    const invoke = vi.spyOn(core, "invokeResult");
    await launch(unconfigured());
    const dialog = await screen.findByRole("dialog", { name: "Add a main AI provider" });
    expect(within(dialog).getByText("Google Gemini")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Download Ollama/ })).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole("button", { name: /Get API key/ })[0]!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("provider.openLink", { providerId: "google", kind: "apiKey" }),
    );
    // The development fake never opens pages, and the prompt says so truthfully.
    expect((await within(dialog).findByRole("status")).textContent).toContain("could not be opened");
    // Rows: crax-gpt, Gemini, NVIDIA, … (crax-gpt was added first in the provider patch).
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Add key" })[2]!);
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("heading", { name: "Connect NVIDIA" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Add a main AI provider" })).toBeNull();
  });
  it("crax-gpt: guided setup asks only for the API key; ALTREX fills in everything else", async () => {
    const invoke = vi.spyOn(core, "invokeResult");
    await launch(unconfigured());
    const dialog = await screen.findByRole("dialog", { name: "Add a main AI provider" });
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Add key" })[0]!);
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    const crax = within(settings).getByRole("region", { name: /crax-gpt/ });
    fireEvent.click(within(crax).getByRole("button", { name: /Open crax-gpt/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("provider.openLink", { providerId: "crax-gpt", kind: "apiKey" }));
    expect(crax.querySelectorAll("input")).toHaveLength(1); // one field only: the API key
    expect(within(crax).queryByLabelText(/Endpoint|Model/)).toBeNull();
    const key = within(crax).getByLabelText("crax-gpt API key") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "crax-secret-key-5678" } });
    fireEvent.click(within(crax).getByRole("button", { name: "Connect" }));
    expect(key.value).toBe(""); // cleared at once, never kept in UI state
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("provider.connect", { providerId: "crax-gpt", apiKey: "crax-secret-key-5678", baseUrl: "", model: "" }));
    expect(localStorage.length).toBe(0);
  });
  it("Later dismisses it for the session; the top bar opens it again", async () => {
    await launch(unconfigured());
    const dialog = await screen.findByRole("dialog", { name: "Add a main AI provider" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Set up AI/ }));
    expect(await screen.findByRole("dialog", { name: "Add a main AI provider" })).toBeTruthy();
  });
  it("does not appear once a provider is configured", async () => {
    await launch();
    expect(screen.queryByRole("dialog", { name: "Add a main AI provider" })).toBeNull();
  });
});
describe("ChatGPT Codex engine", () => {
  // The fake core, reporting an installed Codex CLI (the backend lists it among consent endpoints).
  const withCodex = (): AltrexCoreBridge => {
    let codexGranted = false;
    return {
      contractVersion: core.contractVersion,
      onEvent: (listener) => core.onEvent(listener),
      invoke: core.invoke.bind(core) as AltrexCoreBridge["invoke"],
      invokeResult: (async (name: CommandName, request: { providerId?: string }) => {
        if (name === "consent.list") {
          const base = await core.invokeResult(name, {} as never);
          return base.ok ? { ok: true, value: [...base.value as CommandResponse<"consent.list">, { providerId: "codex", baseUrl: "codex-cli", displayName: "OpenAI Codex", granted: codexGranted, grantedAt: codexGranted ? new Date().toISOString() : null }] } : base;
        }
        if (name === "consent.grant" && request.providerId === "codex") { codexGranted = true; return { ok: true, value: { granted: true } }; }
        return core.invokeResult(name, request as never);
      }) as AltrexCoreBridge["invokeResult"],
    };
  };
  it("runs Build tasks on ChatGPT Codex and asks consent only for Codex", async () => {
    const bridge = withCodex(), invoke = vi.spyOn(bridge, "invokeResult");
    await launch(bridge);
    fireEvent.change(screen.getByLabelText("AI mode"), { target: { value: "CODEX" } });
    expect(await screen.findByText(/ChatGPT Codex \(your subscription\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Ask ALTREX"), { target: { value: "Make the UI like ChatGPT" } });
    fireEvent.click(screen.getByLabelText("Run task"));
    const dialog = await screen.findByRole("dialog", { name: "Allow cloud AI for this workspace" });
    expect(within(dialog).getByText("OpenAI Codex")).toBeTruthy();
    expect(within(dialog).queryByText(/Fake NVIDIA/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow and run task" }));
    await waitFor(() => expect(invoke.mock.calls.some((call) => call[0] === "task.start")).toBe(true));
    expect(invoke.mock.calls.find((call) => call[0] === "task.start")?.[1]).toMatchObject({ mode: "AGENT", modelSelection: "CODEX", routingMode: "AUTO" });
    expect(invoke.mock.calls.filter((call) => call[0] === "consent.grant").map((call) => (call[1] as { providerId: string }).providerId)).toEqual(["codex"]);
  });
  it("shows the Codex option as unavailable when the Codex CLI is not installed", async () => {
    await launch();
    const option = screen.getByRole("option", { name: /ChatGPT Codex/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain("install Codex CLI");
  });
});
describe("cloud-code consent (backend-owned)", () => {
  it("records consent in the backend before starting the task; dismissing starts nothing", async () => {
    const invoke = vi.spyOn(core, "invokeResult");
    await launch();
    fireEvent.change(screen.getByLabelText("Ask ALTREX"), { target: { value: "Build a login form" } });
    fireEvent.click(screen.getByLabelText("Run task"));
    const dialog = await screen.findByRole("dialog", { name: "Allow cloud AI for this workspace" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke.mock.calls.some((call) => call[0] === "task.start" || call[0] === "consent.grant")).toBe(false);
    fireEvent.click(screen.getByLabelText("Run task"));
    fireEvent.click(await screen.findByRole("button", { name: "Allow and run task" }));
    await waitFor(() => expect(invoke.mock.calls.some((call) => call[0] === "task.start")).toBe(true));
    const names = invoke.mock.calls.map((call) => call[0]);
    expect(names.indexOf("consent.grant")).toBeGreaterThan(-1);
    expect(names.lastIndexOf("consent.grant")).toBeLessThan(names.indexOf("task.start"));
    expect((await core.invoke("consent.list", {})).every((endpoint) => endpoint.granted)).toBe(true);
    expect(localStorage.getItem("altrex.v4.cloud-consent")).toBeNull();
  });
});
describe("truthful projection and bounded views", () => {
  it("deduplicates replay against live events and orders per stream", () => {
    const a = event("agent.message_delta", { text: "A" }, 1),
      b = event("agent.message_delta", { text: "B" }, 2);
    expect(mergeEvents([b], [a, b])).toEqual([a, b]);
    expect(taskView(fixture("COMPLETED"), mergeEvents([b], [a, b])).text).toBe(
      "AB",
    );
  });
  it("keeps the persisted terminal state even when a truncated history ends earlier", () => {
    expect(
      taskView(fixture("INTERRUPTED"), [
        event("task.state_changed", { from: "RECEIVED", to: "IMPLEMENTING" }),
      ]).state,
    ).toBe("INTERRUPTED");
  });
  it.each(["COMPLETED_UNVERIFIED", "INTERRUPTED", "CANCELLED"] as const)(
    "represents %s without simulated verification",
    (state) => {
      render(
        <TaskCard
          task={fixture(state)}
          events={[]}
          onSelect={() => {}}
          onChanges={() => {}}
          onCancel={() => {}}
          onRetry={() => {}}
        />,
      );
      expect(screen.queryByText("Verified result")).toBeNull();
      if (state === "INTERRUPTED")
        expect(
          screen.getByText("ALTREX closed before this task finished."),
        ).toBeTruthy();
    },
  );
  it("bounds terminal output and preserves stream identity and exit status", () => {
    const result = commandViews([
      event("command.started", { commandId: "cmd", command: "pnpm test" }, 1),
      event(
        "command.output",
        { commandId: "cmd", stream: "stdout", text: "a".repeat(120000) },
        2,
      ),
      event(
        "command.output",
        { commandId: "cmd", stream: "stderr", text: "warning" },
        3,
      ),
      event(
        "command.completed",
        {
          commandId: "cmd",
          command: "pnpm test",
          exitCode: 1,
          timedOut: false,
          durationMs: 500,
        },
        4,
      ),
    ]);
    expect(result[0]).toMatchObject({
      done: true,
      exitCode: 1,
      stderr: "warning",
      clipped: true,
    });
    expect(result[0]!.output.length).toBe(100000);
  });
  it("handles added, deleted and changed text without quadratic work", () => {
    expect(diffLines(null, "new")[0]?.kind).toBe("added");
    expect(diffLines("old", null)[0]?.kind).toBe("removed");
    expect(
      diffLines("same\nold\nend", "same\nnew\nend").map((line) => line.kind),
    ).toEqual(["same", "removed", "added", "same"]);
  });
  it("reports an automatic fallback only after backend events", () => {
    const view = taskView(fixture("COMPLETED_UNVERIFIED"), [
      event(
        "fallback.started",
        {
          role: "CODER",
          from: { providerId: "groq", model: "first" },
          to: { providerId: "nvidia", model: "second" },
          reason: "RATE_LIMITED",
        },
        1,
      ),
      event(
        "fallback.completed",
        {
          role: "CODER",
          from: { providerId: "groq", model: "first" },
          to: { providerId: "nvidia", model: "second" },
        },
        2,
      ),
    ]);
    expect(view.notices).toEqual([
      "groq: Rate limited. Trying nvidia.",
      "Fallback succeeded with nvidia.",
    ]);
    expect(view.state).toBe("COMPLETED_UNVERIFIED");
  });
  it("does not promote a model assertion to verified", () => {
    const task = fixture("COMPLETED_UNVERIFIED");
    const view = taskView(task, [
      event("agent.message_delta", { text: "VERIFIED: all tests passed." }),
    ]);
    expect(view.state).toBe("COMPLETED_UNVERIFIED");
    expect(view.verdict).toBeNull();
  });
  it("shows tournament evidence and no invented acceptance counts", () => {
    render(
      <TaskCard
        task={fixture("COMPLETED_UNVERIFIED")}
        events={[
          event(
            "tournament.candidate",
            {
              candidate: 0,
              providerId: "nvidia",
              model: "fixture",
              status: "completed",
              changedFiles: 1,
              changedLines: 2,
              conflicts: 0,
              checks: [{ name: "test", status: "PASS" }],
            },
            1,
          ),
          event(
            "tournament.selected",
            {
              winner: 0,
              ranking: [
                {
                  candidate: 0,
                  eligible: true,
                  reasons: ["All checks passed"],
                },
              ],
              applied: ["src/auth.ts"],
            },
            2,
          ),
        ]}
        onSelect={() => {}}
        onChanges={() => {}}
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText("Selected: Solution 1")).toBeTruthy();
    expect(screen.getByText("Test: PASS")).toBeTruthy();
    expect(screen.queryByText(/Acceptance/)).toBeNull();
  });
  it("cancels a manual terminal command by its real command ID", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ cancelled: true }) as unknown as Invoke;
    const app = {
      invoke,
      core,
      project: { path: "/demo" },
      activeTasks: [],
    } as unknown as Workspace;
    const started = {
      ...event("command.started", {
        commandId: "manual-command",
        command: "pnpm test",
      }),
      taskId: null,
    };
    render(
      <WorkPanel
        app={app}
        tab="Terminal"
        setTab={() => {}}
        events={[started]}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Cancel command"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("terminal.cancel", {
        commandId: "manual-command",
      }),
    );
  });
  it("runs project checks through checks.run and does not invent pass results", async () => {
    const invoke = vi.fn().mockResolvedValue([]) as unknown as Invoke;
    const app = {
      invoke,
      core,
      project: { path: "/demo" },
      activeTasks: [],
    } as unknown as Workspace;
    render(
      <WorkPanel
        app={app}
        tab="Tests"
        setTab={() => {}}
        events={[]}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Run project checks"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("checks.run", {
        projectPath: "/demo",
      }),
    );
    expect(screen.queryByText("Pass")).toBeNull();
  });
  it("limits the initially mounted changed-file list", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({
        path: "file-0.ts",
        before: "",
        current: "",
        binary: false,
        changedSinceTask: false,
      }) as unknown as Invoke;
    render(
      <Changes
        invoke={invoke}
        files={Array.from({ length: 1000 }, (_, index) => `file-${index}.ts`)}
        checkpoint="before"
        changes={new Map()}
        truncated={false}
      />,
    );
    await screen.findByText("Show 100 more files");
    expect(
      within(
        screen.getByRole("navigation", { name: "Changed files" }),
      ).getAllByRole("button"),
    ).toHaveLength(101);
  });
  it("pages large diffs instead of mounting every line", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({
        path: "large.ts",
        before: null,
        current: Array.from({ length: 10000 }, (_, i) => `line ${i}`).join(
          "\n",
        ),
        binary: false,
        changedSinceTask: true,
      }) as unknown as Invoke;
    const { container } = render(
      <Changes
        invoke={invoke}
        files={["large.ts"]}
        checkpoint="checkpoint"
        changes={new Map()}
        truncated={false}
      />,
    );
    await screen.findByText(/This file has changed since/);
    expect(container.querySelectorAll(".v4-diff-code>div")).toHaveLength(300);
    fireEvent.click(screen.getByText("Next lines"));
    expect(screen.getByText("301–600 of 10000")).toBeTruthy();
  });
  it("requires an explicit restore preview and offers safety-checkpoint undo", async () => {
    const calls: string[] = [];
    const invoke: Invoke = async <N extends CommandName>(
      name: N,
      _request: CommandRequest<N>,
    ) => {
      calls.push(name);
      const responses = {
        "checkpoint.list": [
          {
            checkpointId: "before",
            label: "Before task",
            createdAt: new Date().toISOString(),
            finalizedAt: new Date().toISOString(),
            changedByTask: 2,
          },
        ],
        "checkpoint.preview": {
          checkpointId: "before",
          scope: "task",
          restore: ["src/auth.ts"],
          delete: [],
          conflicts: [{ path: "src/user.ts", reason: "modified-after-task" }],
        },
        "checkpoint.restore": {
          checkpointId: "before",
          scope: "task",
          restored: ["src/auth.ts"],
          deleted: [],
          conflicts: [],
          safetyCheckpointId: "safety",
        },
      };
      return responses[name as keyof typeof responses] as CommandResponse<N>;
    };
    render(<Checkpoints invoke={invoke} projectPath="/demo" busy={false} />);
    fireEvent.click(await screen.findByText("Preview restore"));
    await screen.findByRole("dialog", { name: "Restore previous state" });
    expect(calls).not.toContain("checkpoint.restore");
    expect(screen.getByText(/Preserve: src\/user/)).toBeTruthy();
    fireEvent.click(screen.getByText("Restore these changes"));
    await screen.findByText("Preview undo restore");
    expect(calls).toContain("checkpoint.restore");
  });
  it.each(["AUTH_ERROR", "OFFLINE", "RATE_LIMITED", "MODEL_NOT_FOUND"])(
    "presents a classified provider error: %s",
    async (detail) => {
      const bridge: AltrexCoreBridge = {
        contractVersion: 1,
        onEvent: (listener) => core.onEvent(listener),
        invoke: (name, request) => core.invoke(name, request),
        invokeResult: async <N extends CommandName>(
          name: N,
          request: CommandRequest<N>,
        ) =>
          name === "task.start"
            ? ({
                ok: false,
                error: {
                  code: "PROVIDER_ERROR",
                  message: `Provider unavailable: ${detail}`,
                  retryable: detail !== "AUTH_ERROR",
                  detail,
                },
              } as CoreInvokeResult<N>)
            : core.invokeResult(name, request),
      };
      await launch(bridge);
      await send();
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.queryByText("Verified result")).toBeNull();
    },
  );
});
