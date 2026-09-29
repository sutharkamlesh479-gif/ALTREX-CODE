# Tool System Specification (V4)

Location: `packages/core/src/tools/`, `src/workspace/`, `src/security/`. Evolves from `project-tool-broker.ts`, `project-command-runner.ts`, `multi-ai/workspace.ts`.

## 1. Tool contract

```ts
type ToolDefinition<A, R> = {
  name: string                         // namespaced: 'fs.read', 'terminal.run', 'git.diff'
  description: string                  // model-facing
  args: ZodSchema<A>                   // → JSON Schema for the model; validated on every call
  capability: Capability               // 'fs.read' | 'fs.write' | 'fs.delete' | 'process.execute' | 'git.read' | 'git.write' | 'git.destructive' | 'network' …
  risk: (args: A, ctx: ToolContext) => Risk   // 'LOW' | 'MEDIUM' | 'HIGH' | 'FORBIDDEN' — may depend on args
  run: (args: A, ctx: ToolContext) => Promise<ToolResult<R>>
  timeoutMs: number
}
type ToolContext = { taskId: string; agentRunId: string; workspace: WorkspaceLease; signal: AbortSignal; emit: EventEmitter; policy: PolicyEngine; readLedger: ReadLedger }
type ToolResult<R> = { ok: true; data: R; forModel: string } | { ok: false; error: { code: ToolErrorCode; message: string }; forModel: string }
```

Execution pipeline (in the `ToolExecutor`, never skipped):

```text
validate args (zod) → resolve paths (guard) → risk = def.risk(args)
→ policy.decide(capability, risk, target, profile) → allow | ask (emit task.approval_required, pause) | deny (tool.denied)
→ re-validate target right before execution (TOCTOU) → run with timeout + signal
→ redact result → emit tool.completed → return `forModel` (bounded) to agent
```

Model-facing names are the flat versions (`read_file`, `write_file`, `edit_file`, …) for compatibility with existing prompts and smaller models. The executor maps them to namespaced definitions.

## 2. Filesystem tools

| Tool | Notes |
|---|---|
| `fs.list` | Recursive with `glob`, `maxDepth`, `limit` (default 500). Respects `.gitignore` (via `git ls-files` when Git) plus the shared ignore list. |
| `fs.read` | Line ranges (existing), 2 MB cap, binary detection. Records `(path, sha256, mtime)` in the **ReadLedger**. |
| `fs.search` | ripgrep-backed (`@vscode/ripgrep` binary; JS fallback). Regex or literal, glob filter, context lines, capped matches. |
| `fs.write` | Create or overwrite. **Overwrite requires the ReadLedger hash to match the current file** (stale-write protection). Create fails if the file exists unless `overwrite: true`. |
| `fs.edit` | Exact unique replacement (existing semantics) plus `edits[]` for several replacements in one atomic call. Preserves line endings (detects CRLF/LF and BOM). |
| `fs.patch` | Apply a unified diff. Hunks must match (limited fuzz, whitespace-tolerant context). The whole patch fails atomically. |
| `fs.delete` | Single file; MEDIUM. Directories or globs are HIGH and require approval. Protected paths are always denied. |
| `fs.move` | Rename/move inside the workspace; destination must not exist. |

Shared guards (from `safePath`/`guardedPath`, consolidated in `security/path-guard.ts`): relative paths only, no traversal, no symlink traversal, no Windows reserved names or trailing dots/spaces, protected paths (`.git/`, `.altrex/` internals, `.env*`, `*secret*`, `*credential*`, `*.pem`, `*.key`) denied for write and **read** (reading secrets into a prompt is also a leak). One `IGNORE_DIRECTORIES` constant replaces the four duplicated lists.

Limits per task (existing, kept): 40 writes, 5 MB written, 1 MB per file. These are configurable per permission profile.

### 2.1 External-edit safety

- The ReadLedger compares on write. If the user edited a file after the agent read it, the write fails with `STALE_FILE`, and the agent must re-read.
- Before a task starts, the task checkpoint records the tree. At publication/finish, files the user changed during the task are reported as conflicts, never overwritten silently. This is the existing Director publication rule, extended to all modes.

## 3. Terminal tools

| Tool | Notes |
|---|---|
| `terminal.run` | argv array (no shell), cwd inside workspace, timeout (default 120 s, max 10 min), streams `command.output` events in ≤8 KB chunks, keeps full output in an artifact file, returns a failure-focused compaction to the model (existing `compactCommandOutput`). |
| `terminal.start` | Background process (dev server, watcher). Returns a handle. Output is buffered in a ring and streamed. Killed at task end. |
| `terminal.read` | Read new output from a handle since a cursor. |
| `terminal.stop` | Kill the process tree for a handle. |

Execution reuses `project-command-runner.ts` unchanged at first: `shell: false`, Windows `.cmd` shims through `cmd /d /s /c` with metacharacter rejection, env scrubbing of secret-looking names plus explicitly registered secrets, output caps, and tree kill (`taskkill /T /F` / process group). Additions:

- Executable resolution is cached per task (today it spawns `where.exe` per call).
- A process registry tracks every child per task. Cancellation and app quit kill all of them, and the task waits for exit before `task.cancelled`.
- The environment gains `ALTREX_TASK_ID` and loses `ELECTRON_RUN_AS_NODE` and similar variables.

**Policy:** see SECURITY_MODEL §4. The executable-name allowlist is replaced by an argv classifier (`security/command-classifier.ts`) that assigns risk by executable **and** subcommand/flags.

## 4. Git tools

All Git calls use `git -C <workspace>` with argv arrays, `GIT_TERMINAL_PROMPT=0`, and no pager.

| Tool | Risk | Notes |
|---|---|---|
| `git.status`, `git.diff`, `git.log`, `git.show`, `git.blame` | LOW | diff supports `--stat`, path filters, and checkpoint-relative diffs |
| `git.branch.create`, `git.commit` (task branch only) | MEDIUM | commit only when the user enabled "commit results" |
| `git.checkout` of existing branches, `git.stash` | HIGH | ask |
| `git.reset --hard`, `git.clean`, `git.push`, `git.rebase`, history rewrite | FORBIDDEN for agents | the user does these |

## 5. Checkpoints

`workspace/checkpoints.ts` provides `create(label) → CheckpointRef`, `diff(ref, to?)`, `restore(ref, { paths?, onConflict })`, `list()`, `prune(policy)`.

**Git repositories** (no effect on user index/HEAD/branch):

```text
GIT_INDEX_FILE=<tmp> git add -A            # includes untracked, respects .gitignore
tree=$(GIT_INDEX_FILE=<tmp> git write-tree)
commit=$(git commit-tree $tree -p HEAD -m "altrex checkpoint <task> <label>")
git update-ref refs/altrex/checkpoints/<taskId>/<n> $commit
```

Restore computes `diff(checkpoint, worktree)`, restores only paths changed since the checkpoint, and refuses paths whose current content differs from both the checkpoint and the task's last written version (user edits) unless the user confirms. It never uses `reset --hard`.

**Non-Git projects**: snapshot copy into `userData/core/checkpoints/<projectHash>/<id>/`, using the existing `snapshot`/`copyWorkspace` (hash manifest + bytes, same limits: 200 MB / 30k files / 20 MB per file). Restore uses the journaled publication path with rollback (`publishWorkspace`).

Automatic checkpoints: `pre-task` (before the first write), `green-<n>` (after each passing TESTING), and `pre-publish` (before applying parallel/tournament results). Retention is the last 20 per project plus all checkpoints of unfinished tasks. Pruning resolves exact refs/paths before deleting.

## 6. Isolated workspaces

`workspace/lease.ts` provides `acquire({ taskId, kind: 'main' | 'worktree' | 'copy' }) → WorkspaceLease { root, kind, baseRef, release() }`.

- `main`: the user's tree (single-agent default, with a pre-task checkpoint).
- `worktree`: `git worktree add --detach <userData>/core/worktrees/<id> <checkpointCommit>`. Uncommitted user changes are included because the worktree starts from the checkpoint commit. Integration: `git diff` from the worktree applied to the main tree with conflict detection (three-way on the checkpoint base).
- `copy`: the existing Director copy workspace for non-Git projects.

Leases are tracked. Orphaned worktrees/copies are cleaned on startup after verifying exact paths under `userData/core/`.

## 7. Testing tools

| Tool | Notes |
|---|---|
| `test.discover` | From project profile: package scripts (`test`, `typecheck`, `lint`, `build`, `check`), `pytest`, `cargo test`, `go test ./...`, `dotnet test`, `mvn -q test`, `gradle test`. Skips scripts containing `watch`/`dev`/`start`/`serve`. |
| `test.run` | Runs one check. Optional `target` (file or test name) for runners that support filtering (vitest/jest/pytest/go/cargo). Returns Evidence. |
| `build`, `lint`, `typecheck` | Thin wrappers over discovered commands, returning Evidence. |

Output parsers (best effort, versioned) for vitest, jest, node:test (TAP), pytest, go test and cargo test extract pass/fail counts and failing test IDs. If none recognizes the output, `parsed` is omitted and only the exit code is reported.

Dependency installation during verification keeps `--ignore-scripts` by default (existing). Projects needing lifecycle scripts require the user to trust the project (SECURITY_MODEL §3).

## 8. Repository tools

`repo.symbols(query)`, `repo.definition(symbol)`, `repo.references(symbol)`, `repo.imports(file)`, `repo.importers(file)`, `repo.related_tests(file)`, `repo.project_profile()`. All LOW risk, backed by the repository index (CONTEXT_ENGINE §3).

## 9. Timeouts (tools)

| Operation | Default | Max |
|---|---|---|
| fs tools | 10 s | 30 s |
| `terminal.run` | 120 s | 10 min |
| dependency install | 10 min | 20 min |
| check (test/build/typecheck/lint) | 10 min | 30 min |
| git (non-network) | 30 s | 2 min |

## 9a. Implementation status (Phase 6, 2026-09-27)

Model-facing tools (`packages/core/src/tools/project-tools.ts`, `ProjectToolBroker`):

| Tool | Risk | Notes |
|---|---|---|
| `list_files` | LOW | non-recursive listing, or `recursive`/`glob` via the repository index |
| `read_file` | LOW | line ranges, 2 MB cap, records the file hash in the read ledger |
| `search_files`, `find_symbol` | LOW | repository intelligence (Phase 5) |
| `git_status`, `git_diff` | LOW | `git/git.ts` |
| `write_file`, `edit_file`, `append_file`, `apply_patch`, `move_file`, `delete_file` | MEDIUM | denied in read-only projects; **stale-write protection**: a file changed outside the task since the agent read or wrote it is refused with `STALE`; CRLF preserved on LF edits; `apply_patch` is atomic (all hunks or nothing, tolerant of stale line numbers); delete/move remove directories they leave empty |
| `run_command` | classifier | classifier → profile → approval; `command.started` / `command.output` (≤8 KB chunks) / `command.completed` events; timeout default 120 s, max 600 s; 15 commands per task |

Workspace and Git (`packages/core/src/git/git.ts`, `workspace/`):

- Checkpoints: the content-addressed snapshot store remains the default (it is fast and works without Git). Projects over the snapshot limits fall back to **Git-backed checkpoints** (temp-index commit of the working tree pinned under `refs/altrex/checkpoints/<id>`; the user's index, HEAD and branch are untouched; protected paths are excluded). Large non-Git projects get a clear `TOO_LARGE` explanation suggesting `git init`. Restores now **remove directories created by the task** once they are empty; unrelated user changes are preserved (task scope) or reported as conflicts.
- `workspace/lease.ts`: `acquireWorkspace` (detached Git worktree of a snapshot commit, including uncommitted work; source copy otherwise), `leaseChanges`, `applyLease` (refuses — applying nothing — if the user changed the same files meanwhile), `releaseWorkspace` (only deletes inside the leases root). Used by parallel agents / tournament in Phase 9.
- Attachments are copied to `userData/core/attachments/`, **never into the user's repository** (Phase 1 issue #10).

Not implemented yet: background processes (`terminal.start/read/stop`), `test.discover/run` evidence wrappers (Phase 8 verification owns them), git commit/branch tools for agents, ripgrep `context` lines.

## 10. Later (seams only)

Browser/visual testing (`browser.*`, capability `browser.inspect`), MCP servers (`mcp.call`, per-server grants), language-server integration for `repo.*`. The ToolDefinition contract already covers them.
