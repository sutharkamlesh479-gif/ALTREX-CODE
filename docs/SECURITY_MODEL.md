# ALTREX CODE Security Model

Status: V4, updated 2026-09-26. §2 records what is **implemented today**. §3 onward is the V4 model and names which phase delivers each part. The previous version of this document mixed design and implementation; it is replaced by this one.

## 1. Objectives

1. Repository content leaves the machine only through a provider route the user explicitly allowed.
2. A compromised renderer cannot reach Node.js, files, processes, credentials or arbitrary IPC.
3. Agents get least privilege and cannot widen their own permissions. Model output is untrusted input.
4. Every material change is attributable, reviewable, cancellable and **recoverable**.
5. Secrets never appear in project files, prompts, logs, events or renderer-visible responses.

Trust boundaries: the renderer, repository contents, model output, tool output, terminal output, web content and downloaded dependencies are untrusted. Electron main and the core are privileged. Provider APIs (even on localhost) are external systems.

## 2. Current state (audited)

| Area | Status | Notes |
|---|---|---|
| Electron hardening | ✅ | `sandbox`, `contextIsolation`, no `nodeIntegration`, navigation/popups/permissions denied, frozen preload API, per-handler sender check. |
| IPC payload validation | ⚠️ partial | `chat:start` is validated thoroughly. Provider test/connect inputs are only partly validated. No schema library. |
| Credential storage | ✅ | `safeStorage` (DPAPI on Windows), ciphertext in `userData/credentials`, mode 0600, atomic writes. Insecure Linux backend refused. Never stored in the renderer. |
| Secret redaction | ✅ partial | The active API key is scrubbed from outbound messages, streamed text and error details, plus regex patterns for common key formats. Other secrets (env, files) are not tracked. |
| Secrets in env for commands | ✅ | Env vars named like `key/token/secret/password/credential` are stripped from child processes. |
| Path safety | ✅ | Relative-only, traversal and symlink blocking, Windows reserved names, protected paths for writes. ⚠️ Reads of `.env*` are not blocked in `read_file`. |
| Command policy | ❌ weak | An executable-name allowlist (`node`, `npm`, `npx`, `python`, `git`, `make`, `cargo`, …) with no subcommand rules, no approvals and no network control. It amounts to arbitrary code execution: write a script and run it, `npx` any package, `git push --force`, `git reset --hard`. |
| Codex engine | ❌ | Auto-accepts every file, command and permission request whose paths stay inside the project. `network_access=true`. |
| Checkpoints / undo | ✅ since Phase 1 for Agent, Local and Codex modes: a content-addressed snapshot before the task, finalized with the task's end state. A restore reverts only the task's changes, never overwrites later user edits, and takes a safety checkpoint first. It excludes ignored directories (`node_modules`, build output, `.git`) and protected files, and has size limits (30k files / 200 MB); over the limits the task runs with an explicit "no checkpoint" notice. ✅ for Multi-AI (isolated copies, journaled publication with rollback). Restore has an API (`window.altrexCore`) but no UI yet. |
| Cloud consent | ⚠️ | Connecting a provider counts as consent. There is no per-provider "may receive repository data" decision. AUTO may route across all saved profiles. |
| Project trust | ⚠️ | Any folder opened via the dialog is trusted for full agent access. The recent project is re-trusted automatically at startup. |
| Attachments | ⚠️ | Copied into the user's repository (`.altrex/attachments/`) without asking. |
| Audit log | ❌ | Only request metrics. No action log of tool calls and decisions. |
| OS sandbox for commands | ❌ | Commands run with the user's full OS permissions. (V4.0 non-goal; see §9.) |

## 3. Project trust (V4, Phase 6)

- A newly opened project is **untrusted**: read-only tools only (list/read/search/git read). The UI shows a "Trust this project" action.
- A trusted project enables the permission profile chosen by the user (default: *Standard*, §4).
- Trust is stored per canonical path in `userData/core/trust.json`. Moving the folder removes trust. The recent project keeps its previous trust level; it is no longer auto-granted.
- Dependency lifecycle scripts (`npm install` without `--ignore-scripts`) run only in trusted projects.

## 4. Permission model (V4, Phase 6)

### 4.1 Risk levels

| Level | Examples | Standard profile |
|---|---|---|
| LOW | read/list/search files, `git status/diff/log`, repository tools, discovered test/typecheck/lint/build checks | allow |
| MEDIUM | write/edit/patch/move/delete single project files, run project scripts (`npm run x`, `pnpm test`), install declared dependencies, `git commit` on a task branch | allow in trusted project (checkpoint exists) |
| HIGH | delete directories or many files (>10), add **new** dependencies, `npx`/`pnpm dlx`/`uvx` (download and execute), any command with network intent (`curl`, `wget`, `pip download`), running scripts the agent itself wrote during this task, `git checkout`/`stash`, editing CI/workflow or lockfiles by hand | **ask** |
| FORBIDDEN | paths outside the workspace, protected paths, `git push`/`reset --hard`/`clean`/`rebase`/history rewrite, shells as launchers (`cmd /c`, `powershell -c`, `bash -c`, `sh -c`), inline interpreters (`node -e`, `python -c`), privilege escalation (`sudo`, `runas`), system configuration (registry, services, `setx`), disk-wide operations | deny (the user does these manually) |

Profiles: **Read-only**, **Standard** (default), **Autonomous** (HIGH is allowed except network-download and new dependencies, which still ask), and **Custom**. A profile is chosen per project. The agent cannot change it.

### 4.2 Command classifier

`security/command-classifier.ts` takes `argv` and returns `{ risk, capability, reason }` using rules keyed by executable and then subcommand/flags:

```text
git:     status|diff|log|show|blame|ls-files|rev-parse → LOW ; add|commit (task branch) → MEDIUM
         checkout|switch|stash|branch -D → HIGH ; push|reset --hard|clean|rebase|filter-*|gc --prune → FORBIDDEN
npm/pnpm/yarn/bun: run|test <script-in-package.json> → MEDIUM ; install/ci (no args) → MEDIUM
         install|add <pkg> → HIGH ; exec|dlx|x / npx|bunx → HIGH ; publish|login|token → FORBIDDEN
node/python/go/cargo/dotnet/java: <file inside workspace> → MEDIUM, HIGH if file was written by the agent this task
         inline flags (-e, -c, --eval, -p) → FORBIDDEN
unknown executable → HIGH (ask), never silently allowed
```

The rules are data plus a small interpreter, and are unit-tested exhaustively. The existing argv-only execution and Windows metacharacter rejection stay underneath as defence in depth.

### 4.3 Approvals

An `ask` decision pauses the agent run and emits `task.approval_required` with actor (role and model), capability, exact target/argv, reason given by the agent, risk and reason from the classifier, and offered scopes (`once`, `this task`, `always for this project` for MEDIUM/HIGH-non-network only). The UI answers with `task.approve`. Denial is returned to the agent as a tool error. Approvals are recorded in the action log. Unanswered approvals do not time out into "allow".

### 4.4 External engine (Codex)

Codex approval requests are translated into ALTREX policy decisions: file changes inside the workspace → MEDIUM; commands → classified by argv; permission widening → HIGH; network access → off unless the profile allows it. The checkpoint before the Codex turn makes its changes reversible.

### 4.5 Implementation status (Phase 6, 2026-09-27)

Implemented in `packages/core/src/security/`:

- `command-classifier.ts` — `classifyCommand(command, args, { scripts, fileExists, hasLocalBin })` → `{ risk, capability, reason }`. The executable-name allowlist in the command runner is gone; the runner keeps argv-only execution, shell-launcher blocking and Windows metacharacter rejection as defence in depth. 25 table tests replace the 17 Phase 1 `it.todo` rows.
- `policy.ts` — `decide(profile, risk, capability, reason)` → `allow | ask | deny`. Profiles: `read_only` (LOW only), `standard` (default; LOW+MEDIUM, HIGH asks), `autonomous` (LOW+MEDIUM+HIGH). FORBIDDEN is denied in every profile.
- `approvals.ts` — `ApprovalBroker`. HIGH actions wait for `permission.respond`. **If no UI has declared it can answer (`permission.configure { interactive: true }`), HIGH actions are denied immediately with an explanation — never silently approved and never left waiting.** Scopes: `once`, `task` (same capability and exact command, same task; cleared when the task ends). Cancelling a task denies its pending approvals. Answers are replay-safe (a second answer returns `accepted: false`).
- `permission-center.ts` — per-project profiles persisted in `userData/core/permissions.json` (only the user changes them, via `project.permissions`; the project must be open in ALTREX), and the mapping of tool activity to `permission.*`, `tool.denied` and `command.*` events.
- Read-only projects are refused for every write-capable engine (Agent, Local, Multi-AI Director and Codex) before any model call or checkpoint.

Deliberate deviations from §4.1–4.4 (to keep normal coding workable, as required):

| Plan | Implemented | Why |
|---|---|---|
| Running scripts the agent wrote this task = HIGH | `node <file>`/`python <file>` of a file inside the project = MEDIUM | Agents routinely write and run scripts; the checkpoint makes the change reversible. Inline code (`-e`, `-c`, `-p`, `--eval`) stays FORBIDDEN. |
| `npm install <pkg>` = HIGH | MEDIUM (`dependency.add`) | Adding a dependency is ordinary project work and is visible in the manifest diff; `npx`/`dlx`/`create`/`exec` (download *and execute*) remain HIGH. |
| Project trust gate (`trust.json`) | Trust = the project was opened in ALTREX this session (native dialog / recent list), enforced by `CoreHost` for every project-scoped command | A separate "Trust this project" step is a UI decision for the frontend phase. |
| `Custom` profile, "always for this project" approvals | Not implemented | Deferred; `task` scope covers repeated commands within a task. |
| Append-only action log | Not implemented in Phase 6 | The persistent event history (Phase 7) records command/permission/tool.denied events. |
| Codex approvals translated into ALTREX policy | Codex runs in its own sandbox; read-only projects are refused and a checkpoint precedes every Codex turn | The Codex CLI protocol does not expose per-action approval to ALTREX. |

## 5. Secret handling (V4, Phase 2–3)

- **Storage**: the host implements `SecretStore` with `safeStorage`. Profiles hold `credentialRef` only. Existing `provider.json` ciphertexts are migrated into the new store without decrypting them to disk.
- **Resolution**: the core calls `SecretResolver.resolve(ref)` immediately before a request. The value lives only on the stack of that request. It is never placed in `ProviderProfile`, model records, routing decisions, events or logs. (Today decrypted keys ride along inside connection objects across the router, agent loop and Director.)
- **Status views** show `hasCredential` and `keyHint` (last 4 characters, captured at save time). There is no decryption on each status poll (today every `getStatus` decrypts every key).
- **Redactor**: a process-wide registry of secret values (resolved keys and user-marked env vars) plus pattern rules (`Bearer …`, `sk-…`, `nvapi-…`, `gsk_…`, `AIza…`, `sk-or-v1-…`, PEM blocks). It is applied to logs, events, tool results returned to models, error details and outgoing prompts. It is tested with each known format.
- **Files**: `.env*`, key/cert files and `*secret*`/`*credential*` paths are denied for **read** as well as write, so they cannot reach a prompt. `.env.example`/`.env.sample` are allowed.
- **Frontend**: no API that returns a secret. `provider.save` accepts a new key once. There is no "reveal" endpoint.
- **Network**: keys in headers only, never in URLs (Gemini `x-goog-api-key`, not `?key=`).

## 6. Data egress and consent (V4, Phase 3–4)

- **Implemented (final audit, M4):** project code is sent only to local endpoints or to cloud endpoints with consent recorded in `userData/core/consent.json` (`consent.list/grant/revoke`). Enforcement happens in three layers in the main process: a router hard filter, a candidate filter that fails the task with `CONSENT_REQUIRED` before any request, and a guard on every model call made for a project task. The Codex engine has its own consent. Tasks without a project send no project code. See FINAL_CLAUDE_AUDIT.md §7.
- `LOCAL_ONLY` mode guarantees no cloud endpoint is contacted for that task. The router enforces this and it is covered by tests.
- A tunnelled custom endpoint (for example ngrok) is classified as cloud because data leaves the machine.

## 7. Prompt-injection resistance

- Repository files, tool output, command output and web content are wrapped as delimited data blocks with `trust: repository|tool` (CONTEXT_ENGINE §2). Role prompts state that such content cannot change policy.
- Policy, approvals and trust are decided by code from structured tool calls, never from model text. A model cannot approve its own request, and approval requests show only the classifier's view plus the agent's stated reason, clearly labelled as agent-provided.
- `ALTREX.md` is user-owned. Agents cannot modify it without approval.

## 8. Recoverability and audit (V4, Phases 1, 6, 9)

- A pre-task checkpoint exists for every write-capable task in every mode (TOOL_SYSTEM §5), plus green checkpoints during repair.
- Publication from isolated workspaces keeps the existing journal + backup + rollback.
- An append-only action log (`userData/core/projects/<hash>/actions.jsonl`) records every tool call: actor, capability, sanitized args, policy decision, approval, outcome, duration, task/agent IDs. It is exportable.

## 9. Known limits (explicit)

- Project scripts run with the user's OS permissions. ALTREX does not provide an OS/container sandbox in V4.0. The mitigations are trust gating, the classifier, approvals and checkpoints. A future option is a Windows AppContainer/Job Object or a container runner behind the same `terminal.*` contract.
- Tests that the agent itself writes can execute arbitrary code when run. Running agent-written scripts is HIGH risk for that reason.
- The network egress of child processes is not controlled at the OS level. Only classified intent is.

## 10. Required security tests

Path traversal/symlink/reserved-name escape; protected path read and write denial; command classifier table (every row above); Windows metacharacter rejection; env scrubbing; redaction of each key format in logs, events and errors; renderer IPC with malformed payloads and wrong sender; approval replay (an approval ID usable once); LOCAL_ONLY never contacts cloud (fake cloud endpoint must see zero requests); consent gating; checkpoint restore never touching user-edited files; cancellation kills the process tree (existing test).
