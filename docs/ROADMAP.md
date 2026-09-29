# ALTREX CODE Roadmap

> **Superseded (2026-09-26)** by [MIGRATION_PLAN.md](MIGRATION_PLAN.md), which holds the V4 phases and current status. Kept for history.

Each milestone exits only when its stated validation is reproducible. UI controls are added when their backing capability exists or are clearly disabled with an explanation.

## Current status

- Milestone 0: complete — architecture contracts documented.
- Milestone 1: complete — desktop shell implemented and validated on Windows.
- Official branding revision: complete — supplied Logo A/Logo B integrated with the minimal home redesign, splash, Windows icon, and high-DPI assets.
- API-first milestone: implemented — encrypted provider connection, real health checks, bounded repository context, streaming OpenAI-compatible responses, cancellation, and explicit provider/model disclosure.
- Codex agent slice: implemented — official Codex App Server threads, selected-workspace sandboxing, project file creation, dependency installation, build/test feedback, approval callbacks, activity events, command results, and changed-file disclosure.
- Next: move conversation persistence from renderer storage to SQLite, expose granular interactive approval choices in the renderer, and add stronger OS-level process isolation before enabling Swarm modes.

## Milestone 0 — Architecture

- Product boundaries, threat model, schema, provider API, protocol, orchestration, and UI specification.
- Exit: contracts reviewed; state transitions and trust boundaries are unambiguous.

## Milestone 1 — Desktop shell and professional ALTREX UI

- Electron main/preload/renderer split with sandboxing and typed, allowlisted IPC.
- Original dark design system, collapsible project navigation, home command center, real native project picker, functional composer controls, command palette, and responsive layout.
- Exit: strict typecheck, unit tests, production build, renderer visual QA, Electron launch smoke test.
- Evidence (2026-08-10): typecheck passed; 2 unit tests passed; production build passed; desktop window and secure preload bridge smoke test passed; responsive renderer inspected at 1416px, 820px, and 600px; production audit reported no known vulnerabilities.
- Branding evidence (2026-08-10): 5 tests passed including source-hash and seven-frame ICO validation; production build passed; visual QA passed at 1920×1080, 1366×768, and effective 125%/150% viewports; Electron splash, Logo A window icon, bridge, and real 125%/150% scale-factor launches passed.

## Milestone 2 — Projects and sessions

- SQLite migrations, project trust, recent projects, persisted sessions/messages, recovery.
- Exit: create/open/reopen project and session persistence integration tests.

Current slice: recent-project persistence and reload-safe conversation history are implemented. SQLite multi-session history remains pending.

## Milestone 3 — Files, editor, and terminal

- Monaco, file explorer, search, diff decorations, xterm.js, safe PTY broker, terminal lifecycle.
- Exit: large-repo navigation remains responsive; terminal scope and cancellation tests pass.

## Milestone 4 — Single-agent runtime

- One worker lifecycle, structured prompts/results, tool broker, streaming timeline, cancellation.
- Exit: a configured model completes an isolated fixture edit and returns measured usage.

Current slice: Ask mode provides real single-model streaming and cancellation. Agent mode is exposed when a project is open and can list, read, and write files, run allowlisted development commands, install dependencies, inspect failures, and retry through a bounded tool broker. Measured usage and deterministic verifier policies remain pending.

## Milestone 5 — Provider abstraction

- Provider SDK, OpenAI-compatible and Ollama adapters, keychain references, health monitor.
- Exit: adapter conformance tests, offline/rate-limit/error handling, no plaintext secrets.

Current slice: the `ModelProvider` boundary and OpenAI-compatible adapter support OpenAI, OpenRouter, Groq, and custom endpoints. Credentials are OS-encrypted; authentication, rate-limit, provider-unavailable, timeout, malformed-stream, and cancellation paths are represented. Gemini and local advanced adapters remain pending.

## Milestone 6 — Code intelligence

- Repo map, ripgrep, Tree-sitter, LSP, dependency graph, context budgets, incremental index.
- Exit: retrieval quality fixtures and incremental re-index benchmarks.

## Milestone 7 — Tool execution and permissions

- Policy engine, approvals, filesystem/process/network capabilities, audit log and redaction.
- Exit: allow/deny/path escape/symlink/race tests and approval scope tests.

Current slice: project-scoped list/read/write operations reject path traversal and symbolic links and enforce per-file, per-task, and write-count limits. The command broker uses an executable allowlist, separate arguments, time/output/count limits, cancellation, sensitive-environment redaction, and project change snapshots. Commands still inherit the user's OS permissions; granular approvals and stronger process/network sandboxing remain pending.

## Milestone 8 — Git, worktrees, and checkpoints

- Status, diff, staging, checkpoints, recovery, isolated worktree leases and cleanup.
- Exit: checkpoint restore and concurrent worktree isolation tests.

## Milestone 9 — Multi-agent orchestration

- Dependency-aware scheduler, role registry, worker pools, structured handoffs, integration worker.
- Exit: real parallel workers execute independent fixture tasks without shared-write corruption.

## Milestone 10 — Smart router

- Capability registry, complexity classifier, availability/cost/privacy/resource-aware routing.
- Exit: deterministic routing policy tests and degraded one-model behavior.

## Milestone 11 — Parallel Solution Search

- Competing isolated implementations, independent reviewers, evidence-based judge and integration.
- Exit: difficult fixtures compare actual patches and select using reproducible evidence.

## Milestone 12 — Testing and verifier loop

- Check discovery, build/lint/typecheck/test runners, debugger handoff, bounded repair loop, confidence.
- Exit: seeded failures are diagnosed, repaired, rerun, and reported without fabricated results.

## Milestone 13 — MCP and skills

- MCP server manager, project/session tool grants, skill discovery and versioned manifests.
- Exit: disabled tools are inaccessible and skill inputs are auditable.

## Milestone 14 — Plugins

- Signed/declared plugin manifests, capabilities, isolation, lifecycle and compatibility checks.
- Exit: malicious and incompatible fixtures fail closed.

## Milestone 15 — Browser and frontend verification

- Approved preview targets, screenshots, responsive checks, visual issue loop.
- Exit: fixture UI regression is detected and fixed with captured evidence.

## Milestone 16 — Automations

- Schedules, event triggers, quotas, unattended permission policy, run history.
- Exit: missed-run, duplicate-run, timezone and cancellation tests.

## Milestone 17 — SWARM-100 architecture

- 100-worker scheduler capacity, endpoint health admission, backpressure, fairness, resource dashboard.
- Exit: load tests with real/mock boundary separated; UI never mislabels shared models as distinct.

## Milestone 18 — Benchmarking, performance, and security

- Single vs Smart vs Large comparisons, startup/indexing benchmarks, dependency and security review.
- Exit: published local measurements include methodology, failures, and resource use.

## Milestone 19 — Packaging and release

- Signed Windows/macOS/Linux artifacts, auto-update policy, crash recovery, licenses, reproducible CI.
- Exit: clean-machine install/upgrade/uninstall tests and release checklist.
