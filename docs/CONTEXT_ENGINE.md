# Context Engine & Repository Intelligence Specification (V4)

Location: `packages/core/src/context/`, `src/repo/`, `src/memory/`. Evolves from `repository-context.ts` and `providers/context-manager.ts`.

## 1. Problem with the current approach

- The whole repository excerpt is one string glued into the system prompt. The budgeter finds it again by splitting on the literal text `Repository context:\n`.
- Relevance is keyword counting over the first 200 source files. There are no symbols, references, tests or history.
- The input budget is a fixed 6,000 estimated tokens for every model, including 128k–1M context models.
- Tool outputs and old turns are clipped by characters, not by importance.

## 2. Context items and packs

Every piece of context is a typed item with provenance:

```ts
type ContextItem = {
  id: string
  kind: 'instructions' | 'task' | 'plan' | 'acceptance' | 'project-rules' | 'memory'
      | 'file' | 'snippet' | 'symbol' | 'tree' | 'diff' | 'tool-output' | 'test-failure' | 'turn-summary'
  source: { path?: string; range?: [number, number]; hash?: string; toolCallId?: string }
  reason: string                // why it was included: "matched symbol AuthService", "imported by src/login.ts"
  priority: 0 | 1 | 2 | 3       // 0 = pinned (never dropped) … 3 = nice-to-have
  tokens: number                // estimate
  trust: 'system' | 'user' | 'repository' | 'tool'   // repository/tool content is data, not instructions
  content: string
}
type ContextPack = { items: ContextItem[]; budget: Budget; dropped: Array<{ id: string; reason: string }> }
```

Prompts are rendered from packs by role templates. Untrusted items (`repository`, `tool`) are wrapped in delimited blocks labelled as data. Budgeting works on items, never on prompt text.

## 3. Repository intelligence (`repo/`)

### 3.1 File index

- Enumeration: `git ls-files -co --exclude-standard` when Git (fast, respects `.gitignore`). Otherwise a walk with the shared ignore list.
- Per file: path, size, language, sha256 (lazy), mtime, `isTest`, `isGenerated` (heuristics: `dist/`, `*.min.js`, lockfiles, "generated" headers).
- Persistence: `userData/core/index/<projectHash>/files.json`. Incremental refresh uses mtime/size, with a file watcher later.
- Runs off the UI thread. Until the core moves to a utilityProcess, indexing yields between batches (async fs, chunked).

### 3.2 Search

ripgrep (`@vscode/ripgrep`, prebuilt per-platform binary) for literal/regex search with context lines. JS fallback when the binary is missing. Results feed `fs.search` and retrieval.

### 3.3 Symbols and structure

- Phase 5a: a regex-based outline for TS/JS/Python/Go/Rust/Java/C# (exports, classes, functions, methods). This is cheap and covers most needs.
- Phase 5b: `web-tree-sitter` (WASM, so no native rebuild for Electron) with bundled grammars for the same languages. It provides definitions and references by name, and import extraction.
- Import graph: TS/JS (ESM + CJS, tsconfig `paths`, index files), Python (relative + package imports), Go (module path). Stored as edges `file → file`.
- Test mapping: name conventions (`foo.ts` ↔ `foo.test.ts`/`foo.spec.ts`/`__tests__/foo.ts`/`tests/test_foo.py`), plus import-graph reverse edges from test files.
- Git signals: recently changed files (`git log --since=30.days --name-only`), and co-change pairs for a small relevance boost.

### 3.4 Project profile

Detected once per project and refreshed when manifests change: languages, package manager, frameworks, scripts, test runner, build/typecheck/lint commands, monorepo layout. It is stored in project memory and shown to the Planner.

## 4. Retrieval pipeline

For a task or step, retrieval produces candidate items with scores:

1. **Seeds**: terms and identifiers extracted from the request/plan step (camelCase/snake_case split, quoted strings, paths and error messages in the prompt).
2. **Lexical**: ripgrep hits for identifiers → files + line windows.
3. **Symbolic**: symbol-name matches → definition snippets. For each, add callers (references) and callees when budget allows.
4. **Graph expansion**: one hop along imports/importers from top files (today's one-hop relative import following, generalized).
5. **Tests**: related tests for every selected source file.
6. **Config**: manifests, tsconfig, env *examples* (never `.env`), relevant configuration files.
7. **History**: files recently changed together with top files.

Score = weighted sum (lexical, symbolic, graph distance, test relation, recency). Selection is greedy by `score / tokens` under the retrieval budget. Large files contribute **snippets** (symbol ranges or hit windows ±20 lines) rather than whole files. Every item keeps its `reason`, which the UI/debug view can show ("why was this file sent?").

An optional semantic search (embeddings) layer is a later add-on behind the same interface. Vectors record provider and model identity and are never mixed.

## 5. Budgets

```text
contextWindow  = registry.capabilities.contextWindow ?? profile.policy.assumedContext (default 16k, conservative)
inputBudget    = min(contextWindow × 0.75 − outputReservation, profile.policy.maxInputTokens)
outputReservation = role default (Coder 4k, Planner 2k, Reviewer 2k) capped by maxOutput
```

Allocation within `inputBudget` (defaults; roles can override):

| Slice | Share | Content |
|---|---|---|
| pinned | as needed (hard cap 20%) | role instructions, task, plan, acceptance criteria, project rules |
| working set | 35% | files/snippets the task has read or written (latest content wins, older reads superseded) |
| retrieved | 25% | retrieval pipeline items not already in working set |
| history | 15% | recent turns verbatim; older turns as summaries |
| tool outputs | remainder | last tool results; failing test output kept until resolved |

If pinned content alone exceeds the budget, the request fails with a clear error. Requirements are never silently dropped (existing rule, kept). Token estimation stays conservative (`bytes / 3` + 2,048 per image) and is **calibrated** by provider-reported usage per model (exponential moving average of reported/estimated), with the estimate capped at ≥ the reported value.

## 6. Compaction and pruning

- **Supersession**: when a file is re-read or rewritten, earlier copies of the same file in history are replaced by a one-line stub ("content of src/a.ts at turn 4 superseded").
- **Tool-output aging**: the last 3 tool results are kept whole (bounded). Older ones are reduced to a one-line outcome ("run_command `pnpm test` exit 1 — 3 failing tests: …"). Failing-test outputs stay until the failure signature disappears.
- **Turn summaries**: when history exceeds its slice, the oldest assistant/tool groups collapse into a structured summary (`done`, `decisions`, `open issues`, `files touched`). The summary is produced by a small/fast model when available, otherwise extractively by code (today's extractive approach). Summaries are items with `kind: 'turn-summary'` and are regenerated only when inputs change.
- **Important-state preservation**: plan, acceptance criteria, user constraints (every user message is kept at least as its full text if it is short, or as an extractive summary), and unresolved failures are priority 0/1 and are never dropped.
- **Recovery**: on `CONTEXT_TOO_LARGE`, the gateway asks the context engine for the same pack at 65% budget (dropping priority 3, then 2), and records the observed limit on the model (PROVIDER_SPEC §5.1).

## 7. Project memory (`memory/`)

Two layers:

1. **`ALTREX.md` in the repository**: user-owned project rules (conventions, do/don't). Always a pinned item. Agents may *propose* edits, and they are applied only with approval.
2. **Machine memory** in `userData/core/projects/<projectHash>/memory.json`: never written into the user's repository.

```ts
type MemoryFact = {
  key: string                    // 'command.test' | 'framework' | 'convention.naming' | 'failure.<signature>' …
  value: string
  source: 'evidence' | 'user' | 'detected'   // model claims are not a source
  evidenceId?: string            // e.g. the Evidence that proved `pnpm test` works
  confidence: 'confirmed' | 'observed-once'
  lastVerifiedAt: string
}
```

Written at task end from evidence only: commands that passed or failed, detected frameworks, and failure signatures with the diffs that fixed them (which feeds the Debugger). Facts older than 30 days, or contradicted by new evidence, are downgraded or removed. Memory is retrieved like other items: relevant facts by key or term match, not the whole file. The existing Multi-AI `memory-<hash>.json` (spec, components, known issues) is imported once.

### 7.1 Implementation status (Phase 9, 2026-09-27)

`packages/core/src/memory/project-memory.ts` implements the machine memory in `userData/core/projects/<hash>/memory.json` (never in the repository):

- Facts from **evidence** (`check.<name>` = the exact command and PASS/FAIL on the final tree, with its evidence id; `failure.<hash>` = a failure signature a repair fixed, recorded only when the same checks then passed), **detection** (`stack.*` from the project profile; legacy Multi-AI completed tasks and known issues imported once — its model-written spec is not imported) and the **user** (`memory.remember` → `user.<key>`). Model claims are never a source.
- A check fact is `confirmed` only after the same command passed twice; a contradicting result resets it. Facts older than 30 days are downgraded, older than 90 days dropped.
- `ALTREX.md` at the project root is read as user-owned rules (ALTREX never writes it). Rules and relevant facts are rendered as delimited data blocks ahead of the retrieved code for every project task.
- Commands: `memory.list`, `memory.remember`, `memory.forget`; event `memory.updated` after verification.

## 8. Attachments

Attachments stay in `userData/core/attachments/<taskId>/`, not in the user's repository (today they are copied to `<project>/.altrex/attachments/`). Text attachments become `file` items with `trust: 'user'`. Images are passed only to vision-capable endpoints (router requirement), or described first by a vision model (existing local-vision path).

## 9. Metrics

Per model call, the engine logs pack composition (items per kind, tokens per slice, dropped items and reasons). The debug view can show "what the model saw". A later retrieval-quality fixture suite measures whether known-relevant files for seeded tasks were included (recall@budget).
