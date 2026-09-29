# ALTREX CODE V4 — product release candidate

Date: 2026-09-27. Backend baseline: `52d4337` / `phase-11-complete`.
Frontend implementation commit: `5e9e049`; final QA changes are recorded in the commit carrying tag `v4-product-rc1`.

The V4 workspace is implemented and integrated with the real contract-v1 bridge. It is **not yet declared PRODUCT COMPLETE**: live-provider compatibility and clean-machine install/uninstall remain unverified. Fixture results below are not live-provider results.

## Validation

| Check | Result / evidence |
| --- | --- |
| Original regression coverage | All original 683 tests retained and passing in the bounded run |
| New frontend/integration coverage | 33 tests passing; desktop total 259 |
| Full regression | **716 passed**: contracts 115, core 342, desktop 259; `pnpm -r test --maxWorkers=2`, `qa/regression-bounded.log` |
| Default parallel run | One unchanged backend Phase 8 reviewer test exceeded its existing 15-second timeout; 715 passed. Earlier concurrent packaging also caused timeouts. No backend assertion or timeout was weakened; complete two-worker run passed |
| Typecheck | PASS, `pnpm typecheck`, `qa/typecheck.log` |
| Production build | PASS as part of Windows distribution build, `qa/package-build.log` |
| Development Electron | PASS: real preload bridge, V4 shell, composer viewport assertions |
| 100% scaling | PASS: 1524×921 CSS viewport, no horizontal overflow; `qa/electron-100.json` and PNG |
| 125% scaling | PASS: 1524×796 CSS viewport, no horizontal overflow; `qa/electron-125.json` and PNG |
| 150% scaling | PASS: 1270×662 CSS viewport, no horizontal overflow; `qa/electron-150.json` and PNG |
| Packaged executable | PASS: isolated startup and mounted V4 workspace; `qa/packaged.json` and PNG |
| Portable launcher | PASS: extracted runtime startup and mounted V4 workspace; `qa/portable.json` and PNG |
| NSIS installer | Built successfully. Clean-machine installation/uninstallation NOT TESTED |
| Release contents | Verifier checks runtime archive, V4 marker, no fixture/legacy bridge, bundled fonts/logos, no credentials or QA helpers; SHA256SUMS generated |
| Browser interaction | Explicit development FakeCore: task submission/evidence, approval prompt and denial dispatch, terminal output, Settings, Escape focus restoration, Ctrl+K search/Enter to Agents; no captured console errors |
| Responsive browser | 1366×768 CSS viewport: no horizontal overflow. Compact 914×514 view retains scrolling and controls |
| Accessibility | Labels, focus styles, dialog focus trap/restore, keyboard palette/tabs, IME-safe submission, text status and reduced-motion support. Keyboard interactions checked; no independent screen-reader audit |
| Performance | Stream updates batched 40ms; events capped 20,000 with warning; terminal streams capped 100,000 characters; history/conversation progressive mounting; tested 1,000-file and 10,000-line views. No formal CPU/memory benchmark |

Screenshots at each Electron scale were visually reviewed after painted capture. Browser screenshots are explicitly simulated data: `qa/demo-terminal.png`, `qa/demo-agents-1366.png`.

## Product surfaces

| Surface | Implementation and validation |
| --- | --- |
| Projects | Native open/list, current project selector, Git branch and context; contract command tested |
| Chat | Build/Ask/Local/Multi-AI composer, streaming, keyboard submit, cancellation, same-session follow-up history; FakeCore integration |
| Agents | Actual agent events, roles, model/provider, progress and result; fixtures plus browser inspection |
| Providers | One-time secret input cleared immediately, encrypted host storage, measured health, discover/test/disconnect, classified errors; mocked integration, live validation blocked |
| Model modes | Auto/Fast/Powerful/Free/Local/Custom; routing preview and unknown capability labels; LOCAL_ONLY request verified |
| Approvals | Risk, exact summary, attributed agent reason, once/task/deny; all response scopes tested; forbidden cannot be allowed |
| Terminal | Command stdout/stderr/exit/duration, manual executable+argv, real cancellation ids; deterministic UI and existing real-host tests |
| Files/diffs | Backend checkpoint diffs with line numbers, +/- text, filter, paginated files/lines, later-edit warnings; large-list tests |
| Tests/problems | Real check attempts, failures, repair/review findings, error classification, checks.run; no manufactured pass counts |
| Verification | Backend verdict/evidence/review independence, explicit unavailable checks and unverified outcome; model prose cannot promote result |
| Checkpoints | List, preview, explicit restore, preserved-conflict warning and safety checkpoint undo; ordered preview/restore integration plus backend regression |
| Sessions/history | Persisted session/task lists, project/text filtering, lazy replay hydration and token deduplication; restart/follow-up tests |
| Recovery | Interrupted state and explanation, no automatic rerun, restored pending approvals, stream-restart refresh |
| Tournament | Candidate status/checks/scores/ranking/winner from real contract events; fixture UI and existing core/host tournament tests |

## Live providers — separate from regression

The opt-in harness uses the existing ModelGateway, synthetic prompts only, at most 128 output tokens, no repository content, no tool execution, and redacted reports. It is excluded from distribution.

| Saved profile | Live result |
| --- | --- |
| Google Gemini | NOT TESTED — isolated Electron credential decryption failed |
| NVIDIA | NOT TESTED — isolated Electron credential decryption failed |
| OpenRouter | NOT TESTED — isolated Electron credential decryption failed |
| Groq | NOT TESTED — isolated Electron credential decryption failed |
| Ollama | NOT TESTED — harness stopped at stored credential decryption before networking |
| Other providers | NOT TESTED — no live run |

`qa/live-providers.json` records zero network calls for every attempted profile. Authentication, discovery, chat, streaming, tool calls, cancellation and health remain unverified. The automatic approval reviewer rejected copying the existing encrypted Electron Local State into an isolated test profile because it contains sensitive encryption material and requires explicit approval for that approach. That copy was not performed; approval is pending. This is a QA authorization limitation, not evidence that the providers fail.

## Remaining limitations / known issues

- Contract v1 does not expose an attachment picker, full file-tree/read API, standalone checkpoint creation, local-runtime install/start UI commands, or structured acceptance/plan events. Available context/search and automatic checkpoints are used. Ollama setup currently requires external runtime/model installation.
- Full original prompts are held only in the active renderer session. On restart the persisted task title (up to 200 characters) is the available user-message summary; complete user-prompt persistence requires a backend contract addition.
- Manual terminal/check events have taskId null and no project identity; the panel explicitly labels them app-wide.
- Diffs use linear matching prefix/suffix alignment, not minimal edit-distance alignment. Large views are paginated.
- Event history beyond 20,000 is dropped from the renderer with a partial-history notice. Persisted task snapshots remain authoritative.
- A denial in FakeCore acknowledges the permission response and continues its canned success script. This browser scenario proves UI dispatch/dismissal only; real denial behavior is covered by unchanged host policy tests.
- Default highly parallel regression execution can hit the existing backend timeout on this machine; the full two-worker suite passes without changes to backend tests.
- Both executables report `NotSigned` in Get-AuthenticodeSignature. Build-tool signing-stage log lines are not proof of an Authenticode signature. Clean Windows install/uninstall, independent screen-reader testing and live end-to-end provider tasks remain release gates.

## Reproduce

Run `pnpm typecheck`, `pnpm -r test --maxWorkers=2`, `pnpm dist:win`, then `pnpm --filter @altrex/desktop verify:release`. See WINDOWS_RELEASE.md for the isolated Electron/portable smoke environment variables. No normal provider profile or project is modified by startup smoke tests. No release was uploaded or published.
