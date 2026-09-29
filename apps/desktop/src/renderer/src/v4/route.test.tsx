// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AltrexEvent, ProviderView } from "@altrex/contracts";
import { activeRoute } from "./state";
import { RouteBadge } from "./RouteBadge";
import { ProviderLogo, RouteLabel } from "./logos";

afterEach(cleanup);

let seq = 0;
const event = (type: AltrexEvent["type"], payload: unknown): AltrexEvent =>
  ({ v: 1, streamId: "s", seq: ++seq, id: `e${seq}`, ts: new Date(1_000_000 + seq).toISOString(), taskId: "t1", type, payload }) as AltrexEvent;
const selected = (providerId: string, provider: string, model: string, reason = "AUTO: selected for Coding Agent") =>
  event("model.selected", { provider, model, reasons: [reason], providerId, role: "Coding Agent", mode: "AUTO" });
const fallback = (from: string, to: string, model: string) =>
  event("fallback.started", { role: "Coding Agent", from: { providerId: from, model: "m" }, to: { providerId: to, model }, reason: "RATE_LIMITED" });

const providers: ProviderView[] = [
  { providerId: "google", displayName: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", protocol: "gemini", privacy: "cloud", health: "HEALTHY", lastErrorCategory: null, lastCheckedAt: null, model: "gemini-flash", modelsDiscovered: 3, hasCredential: true, keyHint: "abcd", statusMessage: null },
];

describe("active route (from backend routing events only)", () => {
  it("follows the real route through successive fallbacks", () => {
    const events = [
      selected("crax-gpt", "crax-gpt", "glm-5.3"),
      fallback("crax-gpt", "google", "gemini-flash"),
      selected("google", "Google Gemini", "gemini-flash", "Fallback after crax-gpt / glm-5.3 failed (RATE_LIMITED)."),
      fallback("google", "openrouter", "vendor/x"),
      selected("openrouter", "OpenRouter", "vendor/x", "Fallback after google failed."),
    ];
    expect(activeRoute(events.slice(0, 1))).toMatchObject({ providerId: "crax-gpt", model: "glm-5.3", afterFallback: false });
    expect(activeRoute(events.slice(0, 3))).toMatchObject({ providerId: "google", model: "gemini-flash", afterFallback: true });
    expect(activeRoute(events)).toMatchObject({ providerId: "openrouter", model: "vendor/x", afterFallback: true });
  });
  it("shows nothing until the backend selects a route, and reports the Codex engine", () => {
    expect(activeRoute([event("task.created", {})])).toBeNull();
    const codex = event("agent.started", { agentId: "a", role: "CODER", label: "OpenAI Codex (external engine)", providerId: null, model: "0.142.2" });
    expect(activeRoute([codex])).toMatchObject({ providerId: "codex", provider: "ChatGPT Codex" });
  });
});

describe("RouteBadge", () => {
  it("updates to the real provider/model after a fallback and explains it in the popover", () => {
    const first = [selected("crax-gpt", "crax-gpt", "glm-5.3")];
    const { rerender } = render(<RouteBadge events={first} providers={providers} />);
    expect(screen.getByRole("button", { name: /Active AI: crax-gpt, glm-5\.3/ })).toBeTruthy();
    const after = [...first, fallback("crax-gpt", "google", "gemini-flash"), selected("google", "Google Gemini", "gemini-flash", "Fallback after crax-gpt / glm-5.3 failed (RATE_LIMITED).")];
    rerender(<RouteBadge events={after} providers={providers} />);
    const badge = screen.getByRole("button", { name: /Active AI: Gemini, gemini-flash, after fallback/ });
    fireEvent.click(badge);
    const details = screen.getByRole("dialog", { name: "Active AI details" });
    expect(within(details).getByText("gemini-flash")).toBeTruthy();
    expect(within(details).getByText("Connected")).toBeTruthy(); // real health from provider.list
    expect(within(details).getByText(/After a fallback\. Fallback after crax-gpt/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Active AI details" })).toBeNull();
  });
  it("renders nothing without a backend route", () => {
    const { container } = render(<RouteBadge events={[]} providers={providers} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("logos", () => {
  it("uses official icons, the model family when known, crax-gpt's mark, and a neutral chip otherwise", () => {
    const { container: gemini } = render(<ProviderLogo providerId="google" />);
    expect(gemini.querySelector("svg path")?.getAttribute("fill")).toBe("currentColor");
    const { container: claudeViaOpenRouter } = render(<ProviderLogo providerId="openrouter" model="anthropic/claude-sonnet" />);
    const { container: openrouter } = render(<ProviderLogo providerId="openrouter" model="vendor/unknown-model" />);
    expect(claudeViaOpenRouter.querySelector("path")?.getAttribute("d")).not.toBe(openrouter.querySelector("path")?.getAttribute("d"));
    const { container: crax } = render(<ProviderLogo providerId="crax-gpt" />);
    expect(crax.querySelector("rect")).toBeTruthy();
    const { container: groq } = render(<ProviderLogo providerId="groq" />);
    expect(groq.querySelector(".v4-logo-mono")?.textContent).toBe("G");
    render(<RouteLabel providerId="crax-gpt" model="zhipu/glm-5.3" compact />);
    expect(screen.getByTitle("crax-gpt • zhipu/glm-5.3").textContent).toContain("glm-5.3");
  });
});
