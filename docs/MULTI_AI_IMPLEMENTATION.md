# ALTREX provider engine and Multi-AI

Implemented in the existing Electron main process and React interface. No simulated workers or generated success states exist in production. Deterministic model responses exist only in `*.test.ts` fixtures.

## Provider changes

The previous adapter used a single 45-second request deadline and passed large histories, repository excerpts and attachment text directly into completions. The request manager now budgets every generation before transmission, including tool schemas and output reservations. Token counts use a conservative UTF-8 estimate; they are not a provider tokenizer or a claim about advertised model capacity.

Defaults: 6,000 estimated input tokens, 2,048 output tokens, 20-second connection, 180-second first-token, 90-second idle and 600-second overall deadlines. Groq starts conservatively at 3,500 input / 1,024 output / one concurrent request. All values can be changed in Connect AI → Request budgets and timeouts. These are application budgets, not account quotas.

Native HTTP/HTTPS distinguishes socket connection establishment from response latency. Incoming stream chunks reset the idle deadline. AbortSignal cancels requests, queued admissions and retry delays. The overall deadline bounds the entire request, including queue time and backoff.

413 and context-limit responses shrink optional context and the output reservation before retrying. Reported numeric limits are considered. Requests do not blindly replay the same oversized body. Required task instructions and earlier user requirements are retained; if those alone exceed the budget, the request fails explicitly instead of silently discarding them. Optional repository material, old assistant/tool groups and attachment excerpts are compacted. Repository retrieval searches bounded source content and follows relative imports from top matches. Large files can be read by line range and edited by exact segment or appended chunks.

429 honors Retry-After and introduces provider cooldown; transient failures use bounded exponential backoff with jitter. Authentication and invalid requests do not retry. A stream with delivered content is not restarted. Known API keys are redacted from model input and provider text responses. Metrics contain only provider/model, timings, estimated token counts, attempts and result categories.

Multiple explicitly connected profiles are encrypted with the existing Electron safeStorage mechanism. AUTO in Multi-AI may route across those saved connections; the connection dialog states this consent. Disconnect all removes their credentials. Existing Agent/Codex and Ask flows remain available. Connection testing performs a tiny generation with no repository context.

Model registry entries distinguish unknown capabilities/capacities (`null`) from observed tool support. Role ranking uses accepted/failed task history with a neutral prior. The existing model-name heuristic seeds catalog candidates; it is not measured benchmark performance. No fictional capability scores are shown.

## Director execution

1. Copy the selected project source into a run-specific integration directory. Ignore dependencies, generated output, symlinks and common secret files.
2. Ask the Director model for a compact master specification and task DAG. Validate IDs, ownership patterns, expected outputs, acceptance criteria and acyclic dependencies before any worker starts.
3. Schedule at most three independent workers. Provider queues impose their own concurrency limits. Tasks owning overlapping file scopes are serialized, including Windows case variants.
4. Create a separate source copy for each worker attempt. Send its task contract, authoritative architecture and dependency outputs. Workers receive no unrelated worker transcript.
5. Run reads/writes through the existing ProjectToolBroker with additional enforced ownership. Worker commands are disabled; commands run only in Director-controlled verification. Missing interfaces use `request_dependency`; the Director reuses or creates an explicit dependency task and validates the resulting graph.
6. Run discovered project checks and a separate model acceptance review. Reviewers have read-only tools. Check failures, no edits, scope violations and invalid review results reject the attempt. Three worker attempts allow repair/reassignment from fresh integration state.
7. Compare content hashes and merge accepted task edits into integration. No unverified worker files reach the original project.
8. Run final checks and an independent integrated review. A failed final review can generate up to two bounded integration-repair tasks.
9. Recheck original file hashes, create a publication journal and byte backups, then publish verified changes. Concurrent user edits stop publication. In-process publication failures roll back files that still match the attempted publication.

Task failures block dependents but do not stop independent tasks. Final publication requires every required task to complete. The UI displays actual task counts, assignments, dependencies, owned/changed files, actions, command exits and review outcomes. It does not display private reasoning.

During RUNNING, Send change/Enter sends a revision to the Director. Changed contracts and their dependents are cancelled/requeued; unrelated workers continue. Final verification closes the revision window. Up to five revisions are supported per run.

Stop propagates through Director and worker controllers, queues, provider retries and command process trees. Normal application shutdown also cancels active work.

## Durable files

Under Electron userData:

- `credentials/provider.json`: active encrypted profile; legacy format is retained.
- `credentials/provider.json.profiles`: other explicitly saved encrypted profiles.
- `multi-ai/<runId>/run.json`: versioned master specification, tasks, action/result history and verification evidence.
- `multi-ai/<runId>/base.json`: original source fingerprints.
- `multi-ai/<runId>/workers/`: isolated attempt source copies.
- `multi-ai/<runId>/integration/`: accepted staged source.
- `multi-ai/<runId>/publication.json` and `publication-backup/`: publication journal and original changed files.
- `multi-ai/memory-<projectHash>.json`: accepted architecture, output/component registry, API contracts and known issues.
- `multi-ai/models.json`, `request-metrics.json`: measured role outcomes and sanitized request metrics.

Settings → AI & models → Project runs exposes retained runs. Interrupted runs do not resume automatically. Restart unfinished tasks reuses accepted staged work only when the original source fingerprint still matches and no publication journal requires inspection. A crash during publication is retained for inspection, not silently resumed.

## Validation and remaining gates

Local tests cover single-agent regression; real loopback HTTP discovery, tiny generation, SSE and tool completions; 413 compaction; >45-second streaming; retries/cancellation; provider concurrency; Director planning, dependency expansion, parallelism, shared-file serialization, scope rejection, fallback, selective revision, failed-task restart, final-QA repair, crash state and concurrent user edits. Orchestration fixtures use real filesystem edits and Node verification commands. Separate tests prove actual passing/failing Node assertions and Windows child-process cancellation. React tests exercise Multi-AI events, revisions and Stop through the typed bridge.

Live validation found one saved NVIDIA NIM profile and no saved Groq profile. The saved Qwen3 Coder model returned HTTP 410. After native gzip/br/deflate decoding was added, Nemotron generation passed in 2.9 seconds, but its tool-call check received a provider-side unavailable response. Other sampled catalog candidates were unavailable or unreadable. Isolated Agent and Multi-AI fixtures therefore failed and are not claimed as successful; no live ecommerce build is claimed. The diagnostic entry point `ALTREX_PROVIDER_CHECK=1` makes only small generation checks, and requires explicit approval after that rejection.

Current limits:

- Multi-AI needs a connected OpenAI-compatible tool-capable model. Codex CLI and image attachments remain supported through Agent mode, not the Director adapter.
- Source copies are limited to 200 MB, 30,000 files and 20 MB per file; no symlinks. This works without Git and preserves uncommitted source, but is not a container/OS sandbox.
- Verification commands retain the application's existing OS permissions. File scope enforcement applies to broker writes and integrated diffs; arbitrary project scripts are not confined by a new OS security boundary.
- Isolated dependency installation disables lifecycle scripts. Projects requiring those scripts or non-discovered build/test systems may fail verification and need explicit project setup. No executable checks means the result clearly says source review only.
- Unknown model capabilities are not invented. Tool compatibility and long-form generation quality still require live validation on the configured endpoint.
- Total tasks are bounded at 24, worker rounds at 24, attempts at three, and final integration repairs at two. Oversized required specifications produce a clear budget error.
- Restart deliberately stops when user source changed or a publication journal exists. Retained work can be inspected; there is no automatic destructive reset or opaque conflict resolution.
- Visual QA currently consists of source review and available project checks, not a browser-driving specialist.

Provider reference background: [Groq rate limits](https://console.groq.com/docs/rate-limits) and [NVIDIA NIM LLM APIs](https://docs.api.nvidia.com/nim/reference/llm-apis).

Live validation commands: launch Electron with `ALTREX_PROVIDER_CHECK=1` for tiny saved-profile generation checks, or `ALTREX_WORKFLOW_CHECK=1` for real Agent and Multi-AI sum-module fixtures against the active saved provider. Diagnostics use separate temporary orchestration state and generated fixture directories, never the user's selected repository. Each workflow has a six-minute cancellation deadline and independent Node assertions. These requests consume normal provider quota and require approval to use the saved credential after the current execution-review block.

