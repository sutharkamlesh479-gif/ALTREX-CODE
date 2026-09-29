# ALTREX CODE V4 — Final Independent Audit (Claude)

Scope: all changes between `phase-11-complete` (`52d4337`, backend/core baseline) and `v4-product-rc1` (`8fb6874`, Codex + GPT-6 Astra product phase), reviewed as a production product, plus the backend behaviour the new UI now exercises.
Date: 2026-09-27. Auditor: Claude (backend/core author, acting as independent reviewer of the product phase).
This document was written **before** any code change. Fix status is recorded in §6.

## 1. What changed

35 files, +6,044 / −11. `packages/contracts/**` and `packages/core/**` are **unchanged** between the tags.

| Area | Files |
|---|---|
| New V4 renderer | `apps/desktop/src/renderer/src/v4/*` (App, Approvals, Changes, Palette, ProjectContext, Settings, TaskCard, WorkPanel, state, useWorkspace, CSS, 33 tests); `main.tsx` mounts it |
| Main process | `index.ts`: smoke-mode-only renderer/viewport assertions and screenshot capture |
| Packaging | `package.json` excludes `out/qa/**`; `verify-windows-release.cjs` asserts the V4 marker, no FakeCore/demo data/legacy bridge in the renderer bundle, bundled fonts and logos |
| QA tooling | `scripts/live-provider-smoke.{cjs,ts}` (opt-in live harness), `docs/qa/*` evidence, `PRODUCT_QA.md`, `PRODUCT_PHASE.md`, `UI_SPEC.md`, `WINDOWS_RELEASE.md` |

## 2. Method

- I read the full diff and every new renderer module line by line, against the contract (`packages/contracts`) and the backend paths the UI drives (`CoreHost`, `ProviderService`, `PermissionCenter`, `CheckpointStore`, `TaskManager`).
- Baseline at `v4-product-rc1`:
  - `pnpm typecheck`: PASS.
  - `pnpm test` (default parallelism), run twice: **715 passed / 1 failed** both times. The failure is a frontend race (M1). It passes in isolation (3/3 runs).
- I searched the repository and temp locations for copied credential material:
  - None in the repository.
  - The harness temp profiles (`%TEMP%/altrex-live-qa-*`) hold only a freshly generated Electron `Local State`. Its hash differs from the real `%APPDATA%/@altrex/desktop/Local State`, so the real one was **not** copied.

## 3. Findings

Severity legend:
- **BLOCKER:** must not ship.
- **HIGH:** a security, privacy or integrity defect under realistic use.
- **MEDIUM:** correctness, reliability or stale state.
- **LOW:** a minor or misleading behaviour.
- **INFORMATIONAL:** a verified property or a note.

No BLOCKER-class engineering defect was found. The release gates in §5 are separate from code defects.

### H1 — HIGH — Custom model selection is sent to the *active* provider, not the provider that owns the model
- **Affected:** `apps/desktop/src/main/provider-service.ts` (`candidatePool` for non-AUTO selections), `renderer/v4/Settings.tsx` ("Use in Custom mode"), `renderer/v4/App.tsx` (`modelSelection: customModel`).
- **Problem:** For any selection other than `AUTO`, `candidatePool` builds exactly one candidate: `{ active profile, model = selection }`. The V4 model list lets the user pick any discovered model from any provider, but it sends only the model id. If the chosen model belongs to a different provider than the active profile, the request still goes to the active profile.
- **Why it matters:**
  - Privacy: a user who picks a *local* Ollama model in Custom mode, while a cloud profile is active, sends the prompt and repository context to the cloud provider.
  - Correctness: the request fails at a provider that does not host that model, or silently uses a same-named model elsewhere.
  - The frontend assumes a guarantee the backend does not provide.
- **Reproduce:**
  1. Configure Google (active) and Ollama.
  2. Open Settings → AI & models → Load models, then choose an Ollama model → "Use in Custom mode".
  3. Pick AI mode Custom and run a task.
  4. The request goes to Google with the Ollama model id.
- **Fix:**
  - Resolve a Custom selection to the configured provider that actually lists the model: the active provider first, then others by discovered catalog or verified registry records.
  - If no configured provider lists the model, fail with a clear message instead of sending anything.
  - Covered by a regression test.

### H2 — HIGH — LOCAL_ONLY (and FREE_ONLY) can fall back to the external Codex engine (cloud)
- **Affected:** `apps/desktop/src/main/provider-service.ts` (`useCodex`).
- **Problem:** In Agent mode, `useCodex` is true when the selection is `AUTO`, no provider profile is usable, and the Codex CLI is installed. It ignores `routingMode`. The V4 composer sends `modelSelection: 'AUTO'` with `routingMode: 'LOCAL_ONLY'`, so with no configured profile (for example a fresh install where Ollama was not yet connected) a "Local only" task runs on OpenAI Codex. The V4 cloud-consent dialog is also skipped, because it only lists configured cloud endpoints.
- **Why it matters:** LOCAL_ONLY is documented as "no cloud endpoint is contacted for that task" (SECURITY_MODEL §6). This violates it silently and sends repository content off the machine.
- **Reproduce:**
  1. Use a profile with no providers and the Codex CLI logged in.
  2. Open a project, set AI mode to Local only, and run a Build task.
  3. The Codex engine starts.
- **Fix:** Never auto-select Codex when the request's routing mode is `LOCAL_ONLY` or `FREE_ONLY`. The task then fails with the existing "no compatible provider" guidance. Covered by a test.

### M1 — MEDIUM — Terminal task state can overtake queued stream events (truncated follow-up history; flaky test)
- **Affected:** `renderer/v4/useWorkspace.ts` (`onEvent`: terminal events call `setTasks` immediately, while other events wait up to 40 ms in the batch queue).
- **Problem:** When a task finishes, the snapshot turns terminal ("Completed", Run enabled) before its last `agent.message_delta` events are ingested.
  - A follow-up sent in that window carries a truncated assistant turn in `history`.
  - The visible answer is briefly incomplete while the task already shows as finished.
- **Evidence:** In `workspace.test.tsx`, "sends follow-up conversation history…" fails under full-suite load. The received assistant content was `"This is a FakeCore demo answer. "`, missing the final chunk. It is deterministic in cause and load-dependent in timing.
- **Why it matters:** The UI state is stale or inconsistent, the model context is wrong, and the regression suite is not reliable at default settings. The rc1 claim of 716 passing depends on reduced parallelism.
- **Fix:** When a terminal event arrives, flush the queued batch synchronously before the snapshot update, so the task never looks finished ahead of its own events. No test is weakened.

### M2 — MEDIUM — The busy-project guard can be bypassed; the backend does not refuse concurrent write tasks in one project
- **Affected:** `renderer/v4/App.tsx` (`send()`), `apps/desktop/src/main/core-host.ts` (`task.start`).
- **Problem:** The Run button is disabled while any task is active in the project (`busyProject`), but Ctrl/Cmd+Enter calls `send()`, which only checks the *current conversation's* running task. A task started from another session runs concurrently in the same working tree. The backend guards only restores (`isProjectBusy`), not new write-capable tasks.
- **Why it matters:**
  - Two agents can edit the same files at once.
  - Each task's checkpoint and "changed by task" attribution includes the other's edits.
  - A task-scoped restore can then revert the other task's work, or report it as conflicts.
- **Reproduce:**
  1. Start a Build task, then start a new session in the same project.
  2. Type a prompt and press Ctrl+Enter.
- **Fix:**
  - `send()` honours `busyProject`.
  - `CoreHost` rejects `task.start` for non-ASK modes with `PROJECT_BUSY` (retryable) while a task is active in that project.

### M3 — MEDIUM — `project.list` omits the most recent project after a restart
- **Affected:** `apps/desktop/src/main/index.ts` (`projectOps.list`).
- **Problem:** The contract documents `project.list` as "projects open in this session (plus the most recent one)". The implementation returns only projects trusted during this process. Previously the legacy UI called `recentProject`; the V4 UI does not. After a restart, every restored session shows "Reopen <path> before continuing", and project-scoped panels are empty until the user reopens the folder.
- **Why it matters:** The backend does not meet its documented contract, and session recovery is degraded.
- **Fix:** `project.list` includes the saved recent project if it still exists, with the same trust rule the legacy recent-project handler applied.

### M4 — MEDIUM — Cloud-data consent is enforced only in the renderer
- **Affected:** `renderer/v4/App.tsx` (localStorage `altrex.v4.cloud-consent`), backend router (no consent input).
- **Problem:**
  - Consent is a UI prompt stored in renderer localStorage. The backend does not enforce it (SECURITY_MODEL §6 `consent.repositoryData` was deferred).
  - The prompt does not cover the Codex engine or legacy chat paths.
  - Clearing localStorage or using another entry point bypasses it.
- **Why it matters:** A privacy guarantee depends on one UI path.
- **Fix (recommended; not a safe local change):** Add a backend consent field per provider profile, enforced by the router as a hard filter, plus contract commands to grant and revoke it. This is an additive contract change, and deferred. H2 closes the most serious bypass.

### M5 — MEDIUM — Event ingestion re-sorts the whole event log on every 40 ms batch
- **Affected:** `renderer/v4/state.ts` (`mergeEvents`), `App.tsx` (`groupedEvents`, per-card `taskView`).
- **Problem:** Each flush rebuilds a Map of up to 20,000 events and sorts all of them. During heavy streaming (command output plus deltas), every batch then re-groups all events and recomputes each visible task card.
- **Why it matters:** The renderer CPU cost grows with history size during long agent runs.
- **Fix:** Add a fast path. When every incoming event is new and follows the last event of the same stream, append without re-sorting. Replay merges keep the full dedupe and sort.

### L1 — LOW — "Endpoint URL (optional)" is offered for fixed presets but ignored by the host
- **Affected:** `renderer/v4/Settings.tsx`.
- **Problem:** The host only honours a user base URL for `custom` and `nim-local` (`userBaseUrl`). For other presets the field is silently discarded, which is a misleading control.
- **Fix:** Show the endpoint field only for presets that accept one.

### L2 — LOW — A hidden approval dialog stays hidden for later approval requests
- **Affected:** `renderer/v4/Approvals.tsx`.
- **Problem:** After Escape, a *new* HIGH-risk request only updates the small reminder button. The request is still pending and safe (nothing runs), but it is easy to miss.
- **Fix:** Re-open the dialog when a different approval arrives.

### L3 — LOW — The error title lower-cases technical detail
- **Affected:** `App.tsx` uses `label(error.detail ?? error.code)`, so validation paths and categories are case-mangled. This is cosmetic. **Fix:** Use a fixed title per code and show `detail` verbatim.

### L4 — LOW — The diff view aligns by common prefix and suffix only
- **Affected:** `Changes.tsx`. This is documented by Codex. Several separate edits in one file render as one large replace block.
- **Recommend:** A bounded Myers or LCS diff (as in core `util/text-diff.ts`).

### L5 — LOW — The legacy `window.altrex` API and legacy renderer remain exposed or shipped
- **Affected:** `preload/index.ts`, `renderer/src/App.tsx`, `useAltrex.ts`, `components/*`. V4 no longer uses them (the verifier asserts the renderer bundle has no `window.altrex.` reference), but the preload still exposes the full legacy IPC surface.
- **Recommend:** Remove the legacy preload API and dead renderer modules in a follow-up. This reduces attack surface and maintenance.

### Informational (verified properties)
- **I1 Contract integrity:**
  - Contracts and core are unchanged.
  - The renderer imports only `@altrex/contracts` and uses `window.altrexCore.invokeResult`.
  - No renderer code calls AI providers, knows provider URLs, or duplicates routing or verification logic.
  - FakeCore is imported only behind `import.meta.env.DEV && ?demo=1`, and the release verifier asserts it is absent.
- **I2 Secrets:**
  - The API key field is an uncontrolled input, read once, cleared immediately, and never stored in React state, localStorage or logs.
  - Provider views show only `hasCredential`.
- **I3 Truthful UI:**
  - `VERIFIED` is displayed only from `task.verified` or a VERIFIED snapshot, never from model text.
  - `COMPLETED_UNVERIFIED` renders neutral, with an explicit "could not fully verify" warning and the backend reason.
  - Health labels come from measured `provider.health_changed` and `provider.list` data.
  - Agents appear only from `agent.*` events.
  - Test counts appear only when `parsed` exists.
  - Tournament ranking text is the backend's.
- **I4 Approvals:**
  - Allow once, Allow for task and Deny map exactly to `permission.respond` scopes.
  - FORBIDDEN cannot be offered.
  - Execution is gated in the main process by `ApprovalBroker.request`, which awaits the response, so the UI cannot cause execution before approval.
  - Denials return a tool error.
  - The UI enables interactive approvals at startup; pending approvals are refetched after a reload.
- **I5 Filesystem:**
  - Diffs use `checkpoint.diff`, which is guarded by `guardedPath`: no traversal, no protected files.
  - Restore always previews first; the backend recomputes conflicts and refuses while busy; undo goes through the safety checkpoint.
  - No direct filesystem access from the renderer.
- **I6 Rendering safety:** There is no `dangerouslySetInnerHTML`, `eval` or `innerHTML`; model output renders as React text. The CSP in `index.html` is unchanged.
- **I7 Terminal:**
  - The manual runner uses `terminal.run` (argv only, policy-checked, FORBIDDEN refused).
  - Cancel uses `terminal.cancel`, or task cancel for task-owned commands.
  - Output is capped at 100,000 characters per stream in the renderer.
- **I8 Live-provider harness:**
  - It is opt-in and redacts output.
  - It cannot decrypt saved keys in an isolated `userData`, because Windows `safeStorage` is bound to the original profile's `Local State` key. The recorded "CREDENTIAL_DECRYPT_FAILED / 0 calls" result is therefore expected, and not a provider verdict.
  - Codex correctly did not copy `Local State`.
  - The leftover `%TEMP%/altrex-live-qa-*` folders contain only fresh, non-sensitive Electron state and can be deleted.
- **I9 Backend timeout claim:** The Phase 8 reviewer-test timeout reported by Codex did not reproduce in two full default-parallelism runs. The failure observed instead was M1.
- **I10 Signing:** The installer and portable executables are unsigned (`NotSigned`), so they will trigger SmartScreen warnings. Signing needs a certificate and is a release gate, not a code defect.

## 4. Live-provider validation — safest method (MOCK and LIVE kept separate)

Mock validation is `pnpm test` (loopback fake providers, zero quota). It is complete and never touches real credentials.

Live validation must be run by a person, deliberately, with test credentials:
1. **Isolated profile.** Launch the packaged app with a separate data directory (for example `"ALTREX CODE.exe" --user-data-dir=%TEMP%\altrex-live-profile`, or a dedicated Windows test account). Never copy `%APPDATA%\@altrex\desktop`, `Local State`, or `credentials\provider.json`.
2. **Manually entered test keys.** In that profile, open Settings → Providers and paste a **test key with a spending cap** for each provider (Gemini, OpenRouter, NVIDIA, Groq, custom). For Ollama, start it locally with a small model.
3. **Minimal synthetic prompts, no repository data.** Use an empty scratch project and Ask mode first, with prompts like "Reply with only the word OK". Then run one Build task in a scratch folder with one tiny file, for example "Create hello.txt containing hi".
4. **Per provider, record:**
   - health after "Check provider health";
   - model discovery count;
   - Ask streaming;
   - a Build tool call;
   - cancellation;
   - one routing-mode switch each for FAST, POWERFUL, FREE_ONLY, LOCAL_ONLY and CUSTOM, including the H1 fix (Custom model routed to its own provider).
5. **Record results** in `docs/live-validation/<date>.md`: provider, model, pass/fail and latency, with no keys and no response text.
6. **Clean up.** Afterwards, disconnect providers in the isolated profile, delete the profile folder, and revoke the test keys.

Alternatively, the existing harness may be run **inside** the isolated profile after step 2. There its own `Local State` and `provider.json` match. Point `ALTREX_LIVE_PROFILES` at that profile's `credentials/provider.json`, with `ALTREX_LIVE_SMOKE=1`.

## 5. Clean-machine validation — required procedure (PENDING)

On a fresh Windows 10 or 11 VM (no Node, no Git, no Ollama):
1. Run the installer.
2. Check the per-user install, shortcuts and SmartScreen prompt (expected while unsigned).
3. On first launch, confirm the splash and V4 workspace appear, with "Set up AI" shown truthfully.
4. Open a scratch project containing a small Git repo and one with no Git.
5. Set up a provider with a test key (as in §4).
6. Run a basic Ask task and a basic Build task (checkpoint created, diff shown, verification outcome honest).
7. Cancel a running task.
8. Restart the app and check:
   - history is visible;
   - the most recent project is available (M3);
   - no task resumes.
9. Restore a checkpoint and undo it.
10. Uninstall from Apps & features, then confirm:
    - the program files are removed;
    - **user projects are untouched**;
    - `%APPDATA%\@altrex\desktop` is kept (`deleteAppDataOnUninstall: false`) and can be deleted manually.
11. Repeat install → first launch with the portable executable.

## 6. Fix status

| Finding | Status | Change | Regression proof |
|---|---|---|---|
| H1 Custom model sent to the active provider | **FIXED** | `provider-service.ts` `candidatePool`: a specific model goes only to a configured provider that offers it (active first, then others by catalog or verified registry). If none offers it, an explicit error is raised and nothing is sent. A single configured provider keeps the previous behaviour for unlisted, typed model ids. | `provider-service.audit.test.ts` (3 tests). 2 of them fail on rc1 code (mutation-checked); 1 guards the unchanged behaviour |
| H2 LOCAL_ONLY / FREE_ONLY could start the Codex cloud engine | **FIXED** | `provider-service.ts`: Codex is never auto-selected for `LOCAL_ONLY` or `FREE_ONLY` routing | 3 tests. Both modes fail on rc1 code; AUTO→Codex is unchanged |
| M1 Terminal state ahead of queued events (flaky follow-up test) | **FIXED** | `useWorkspace.ts`: flush queued events synchronously before the terminal snapshot update | The existing rc1 test now passes in two full default-parallel runs (it failed in both baseline runs) |
| M2 Busy-project guard bypass | **FIXED** | `App.tsx` `send()` checks `busyProject`; `core-host.ts` rejects non-ASK `task.start` with `PROJECT_BUSY` (retryable) | 1 test (fails on rc1 code); Ask is still allowed |
| M3 `project.list` without the recent project after a restart | **FIXED** | `index.ts` `projectOps.list` includes the saved recent project (same trust rule as the legacy recent-project handler) | Electron-only code: verified by review and the packaged smoke run. No unit harness exists for `index.ts` |
| M4 Renderer-only cloud consent | **FIXED (final task)** | Backend enforcement (§7). The UI now only collects the decision through `consent.list` / `consent.grant` | `provider-service.consent.test.ts` (15 tests, mutation-checked) and a UI ordering test |
| M5 Full re-sort on every event batch | **FIXED** | `state.ts` `mergeEvents` fast path for in-order live events; replays still deduplicate and sort | `v4/audit.test.ts` (3 tests) |
| L1 Ignored endpoint field for fixed presets | **FIXED** | `Settings.tsx`: the field is shown only for presets that accept a URL | typecheck, existing Settings tests |
| L2 Hidden approval dialog stays hidden for new requests | **FIXED** | `Approvals.tsx`: re-opens when a different approval arrives (a pending request still never runs) | existing approval tests |
| L3 Error title lower-cases detail | **FIXED** | `App.tsx`: title from the code; `detail` shown verbatim | typecheck |
| L4 Prefix/suffix diff | OPEN (LOW) | recommended follow-up | — |
| L5 Legacy preload API still exposed | OPEN (LOW) | recommended follow-up | — |

Validation after fixes:
- typecheck PASS;
- `pnpm test` at default parallelism, twice: **726 passed / 0 failed** (contracts 115, core 342, desktop 269);
- build PASS;
- Electron smoke PASS at 100 %, 125 % and 150 %;
- Windows packaging PASS (NSIS and portable, built into a scratch directory, `release/` untouched);
- release verifier PASS (3,926 entries, V4 marker, no FakeCore, demo or legacy bridge in the renderer, fonts and logos present, no credentials or QA helpers);
- packaged-executable smoke PASS (`packaged: true`, V4 workspace mounted, no overflow, isolated temp profile).

What the packaged-app check covers: startup, preload bridge, core contract round trip, V4 mount, fonts and branding assets. A provider-driven task workflow (terminal, diff, verification, checkpoint UI) was **not** exercised inside the packaged executable, because that needs live or test credentials in an isolated profile (§4). The same main-process code paths are covered in development mode by the 20 end-to-end scenarios over loopback HTTP and the V4 integration tests.

## 7. M4 fix — cloud-code consent enforced by the backend

Rule: **a task that has a project may send model requests only to local (loopback) endpoints, or to cloud endpoints the user granted consent for.** Tasks without a project send no project code and need no consent.

Enforcement (`apps/desktop/src/main/provider-service.ts`, `packages/core/src/security/consent.ts`):
1. **Consent store:** `ConsentStore` is persisted in `userData/core/consent.json`, keyed per endpoint (provider id + base URL). With no store configured, the default is empty, so project code reaches no cloud endpoint.
2. **Routing filter:** `RoleRouter` receives `consentOf` and `carriesRepositoryData`, so the router's existing `no_repository_consent` hard filter is now live. Tasks route and fall back only to consented or local endpoints.
3. **Candidate filter:** Ask, Agent, Local, Multi-AI and tournament tasks drop non-consented cloud candidates. If none remain, the task fails with code `CONSENT_REQUIRED` **before any model request**.
4. **Provider backstop:** for project tasks, every model call made for the task goes through a guard on `complete` / `stream`, immediately before transmission. This covers the coding agent, repair, reviewer, Director and tournament candidates. The guard refuses non-consented cloud endpoints even if routing were bypassed.
5. **Codex engine:** the external OpenAI Codex engine (a cloud service) needs its own consent (`codex` / `codex-cli`), checked before the checkpoint or the engine starts.
6. **Consent API:** `consent.list`, `consent.grant` and `consent.revoke` (additive; the contract snapshot is regenerated). Only configured cloud endpoints, or the Codex engine, can be granted. The legacy `window.altrex` chat path uses the same `streamChat`, so it is enforced too.

The UI's localStorage consent was removed. The prompt lists backend endpoints without consent and records the decision with `consent.grant` before `task.start`. Saving a provider in Settings (which requires the consent checkbox) grants that endpoint.

Tests: `provider-service.consent.test.ts` covers:
- cloud without consent is blocked;
- cloud with consent is allowed, and revoke blocks again;
- local-only needs no consent;
- a local endpoint plus a non-consented cloud endpoint never falls back to the cloud;
- no project code in any recorded request;
- the Ask, Multi-AI, tournament, Custom, Codex and `task.start` paths;
- the provider-boundary backstop;
- persistence, and the grant whitelist.

Nine of these fail with enforcement disabled; the rest are properties that must hold either way. The UI test proves the grant happens before `task.start` and that dismissing the prompt starts nothing.

Six earlier test setups that use cloud providers with a project for *other* features (checkpoints, task engine, verification, tournaments) now state explicitly that the user has granted consent (`test-consent.ts`). No assertion was changed.

