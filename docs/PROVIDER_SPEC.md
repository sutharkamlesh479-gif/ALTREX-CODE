# Provider & Model Infrastructure Specification (V4)

Location: `packages/core/src/gateway/` and `packages/core/src/router/`. Shared view types: `packages/contracts/src/provider.ts`.

> **Implementation status (Phase 2, 2026-09-27).** `ModelGateway` (`core/gateway/gateway.ts`) is the single model path: `run()` / `stream()` produce `GatewayStreamEvent`s (`text-delta`, `reasoning-delta`, `tool-call`, `usage`, `finish`). Reliability (budget, queue, deadlines, retries, circuit) is the proven `RequestManager`, moved into core as `gateway/request-executor.ts`. Wire parsing is in `gateway/adapters/openai-compatible.ts` + `sse.ts` + `tool-call-assembler.ts`. **Streamed tool calls work**: fragments are reassembled by index and released only when complete and valid; malformed calls raise `TOOL_CALL_MALFORMED` and are never partially emitted. Error categories keep the existing `ProviderErrorCategory` names (not the §5 names) and add `STREAM_MALFORMED`, `STREAM_INTERRUPTED`, `TOOL_CALL_MALFORMED` and `OUTPUT_TRUNCATED`. Timeout phases are distinguished in `technicalDetails`. Model turns stream by default. A model whose streamed tool calls are unreadable is recorded as `supportsStreamingTools=false` and uses non-streamed tool turns; Ollama carries that as an adapter hint.

> **Implementation status (Phase 3, 2026-09-27).**
> - **Adapters:** OpenAI-compatible (OpenRouter with attribution headers, NVIDIA hosted, **self-hosted NIM** preset `nim-local`, Groq, Ollama, custom) and **native Gemini** (`gateway/adapters/gemini.ts`), which is the default for `google` profiles. `additionalFields.api = 'openai-compatible'` opts back into Google's compatibility layer.
> - **ngrok and other tunnels:** not a provider; they are `custom` endpoints in the `cloud` privacy class.
> - **Discovery metadata:** OpenRouter (context, max output, tools, structured output, reasoning, image input, free pricing), Groq (context, inactive filtered), vLLM `max_model_len`, Gemini `models.list` limits, and Ollama `/api/show` (tools, vision, context). Discovery fills only unknown capabilities; probes and real use win.
> - **Health:** the 8 states in §7.1 are implemented in the executor. It starts `UNKNOWN`; `AUTH_ERROR`, `QUOTA_EXHAUSTED` and `UNSUPPORTED` (`ENDPOINT_NOT_FOUND`) are latched until retest; the breaker opens after 3 failures in 60 s with a 30 s cooldown doubling to 5 min and a half-open trial. Health is persisted in `provider-health.json`; latched states survive a restart, and other observations older than 15 min come back `UNKNOWN`. Every change publishes `provider.health_changed`.
> - **404 classification:** a generic 404 (empty, HTML, "Not Found", FastAPI `{"detail":"Not Found"}`) or a 405 means the base URL is wrong, not that a model is unavailable. A detailed 404 (such as NVIDIA "Function … not found for account") stays model-level. Gemini `400 API_KEY_INVALID` becomes `INVALID_API_KEY`.
> - **Precise disconnect:** `RequestManager.abortProvider` fails in-flight calls to that provider with `PROVIDER_DISCONNECTED`, and routers exclude it and fail over. Only requests with no other candidate are cancelled.
> - **Credentials:** a key hint (last 4 characters) is stored at save time. Legacy profiles are migrated with one decryption, the ciphertext is unchanged, and status never decrypts.
> - **Deviation from this spec:** the planned `SecretResolver` / `credentialRef` split was not done. The existing `safeStorage` ciphertext profile store is kept, and resolved keys still travel inside connection objects in the main process. They never reach the renderer, logs or events. Deferred to hardening.

## 1. Concepts

| Concept | Meaning | Contains secrets? |
|---|---|---|
| **Adapter** | Code that speaks one wire protocol (`openai-compatible`, `gemini`). | no |
| **Preset** | A data record: default base URL, adapter kind, auth style, extra headers, docs URLs, known quirks. Examples: `openrouter`, `nvidia-hosted`, `groq`, `ollama`, `gemini`, `custom`. | no |
| **Profile** | A user-configured connection: preset + base URL + `credentialRef` + options + privacy class. Multiple profiles per preset are allowed (for example two custom endpoints). | only `credentialRef` |
| **Model endpoint** | `(profileId, modelId)`: the unit of routing, health and capability. | no |
| **Credential** | A secret held by the host `SecretStore` (Electron `safeStorage`). The core gets it through `SecretResolver.resolve(credentialRef)` at request time. | yes |

```ts
type ProviderProfile = {
  id: string                         // stable, e.g. "openrouter-1"
  preset: PresetId                   // 'gemini'|'openrouter'|'nvidia-hosted'|'groq'|'ollama'|'custom'|… 
  adapter: 'openai-compatible' | 'gemini'
  displayName: string
  baseUrl: string                    // normalized; HTTPS required unless loopback
  credentialRef: string | null       // null for keyless local servers
  privacy: 'local' | 'cloud'         // loopback host ⇒ local, else cloud (user may not downgrade)
  enabled: boolean
  headers?: Record<string,string>    // non-secret extras, e.g. OpenRouter X-Title
  policy?: Partial<RequestPolicy>    // timeouts/budgets overrides
  consent: { repositoryData: boolean; grantedAt: string | null }   // cloud profiles need consent to receive repo content
}
```

**ngrok / tunnels / local NIM / vLLM / LM Studio**: all are `custom` profiles whose base URL points at the server. The loopback check applies to the literal host. A tunnel URL is a *cloud* privacy class because traffic leaves the machine.

## 2. Adapter interface

```ts
interface ProviderAdapter {
  readonly kind: AdapterKind
  listModels(ctx: AdapterContext): Promise<DiscoveredModel[]>          // with metadata where the API exposes it
  validateCredentials(ctx: AdapterContext): Promise<CredentialCheck>   // cheapest authenticated call
  stream(req: WireRequest, ctx: AdapterContext): AsyncIterable<GatewayStreamEvent>
  chat?(req: WireRequest, ctx: AdapterContext): Promise<GatewayResponse>   // only if non-streaming differs materially
  capabilityHints(model: DiscoveredModel): Partial<ModelCapabilities>   // static knowledge; never overrides observed facts
  normalizeError(input: RawFailure): GatewayError
}

type AdapterContext = {
  profile: ProviderProfile
  apiKey: string | null          // resolved just-in-time; adapters must not store it
  signal: AbortSignal
  transport: Transport           // injected; tests pass a fake
  deadlines: DeadlineController  // gateway-owned; adapter calls touch() on bytes
}
```

Adapters do **not** retry, route, budget context or log. The gateway does all of that.

### 2.1 OpenAI-compatible adapter (base)

Built from the existing `openai-compatible.ts` + `request-manager.ts` + `provider-protocol.ts`:

- `POST {baseUrl}/chat/completions` with `stream: true` by default. `stream_options.include_usage` is sent only when the endpoint is known to accept it.
- SSE parser handles `\n\n` and `\r\n\r\n` boundaries, multi-line `data:`, comments (`:` keep-alives, e.g. OpenRouter), `[DONE]`, and frames split across TCP chunks.
- **Streamed tool calls**: accumulates `delta.tool_calls[i].{id,function.name,function.arguments}` by `index`, validates JSON at finish, and emits `tool-call` events. This is missing today and is required so agent turns can stream.
- Reasoning deltas (`delta.reasoning`, `delta.reasoning_content`) become `reasoning-delta`. They are not shown by default and are never fed back into prompts unless the model requires it.
- Output-token parameter selected per model through registry data (`max_tokens` vs `max_completion_tokens`). This replaces today's regex on `gpt-5`/`o*`.
- Model-specific extra body parameters (for example NVIDIA Nemotron thinking flags) move from code into **model parameter profiles** (data in the registry, overridable by the user). No model-name `if` statements in adapter code.
- Tool-call-in-content fallback (today used for Ollama) is kept as an opt-in `toolCallFallback: 'json-content'` capability. It is recorded as such so the router knows the tool support is emulated.

Presets on this adapter and their discovery metadata:

| Preset | Base URL | Model discovery metadata |
|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1` | `/models` → `context_length`, `pricing` (free = prompt and completion `0`), `supported_parameters` (contains `tools`, `response_format`), `architecture.input_modalities` (image) |
| `nvidia-hosted` | `https://integrate.api.nvidia.com/v1` | `/models` → IDs only; capabilities come from probes |
| `groq` | `https://api.groq.com/openai/v1` | `/models` → `context_window`, `active` |
| `ollama` | `http://127.0.0.1:11434/v1` | `/v1/models` IDs + native `/api/show` → context length and `capabilities` (`tools`, `vision`) on current Ollama versions |
| `custom` | user supplied | `/models` if present, else manual model ID; probes decide capabilities |
| `openai`, `cerebras`, `sambanova`, `cloudflare` | existing presets | kept for migration compatibility; marked "community-tested" until conformance passes |

### 2.2 Gemini adapter (native)

`generativelanguage.googleapis.com/v1beta`: `models.list` (gives `inputTokenLimit`, `outputTokenLimit`, `supportedGenerationMethods`), `models/{id}:streamGenerateContent?alt=sse`, function declarations mapped to/from the normalized tool schema, `x-goog-api-key` header (the key never goes in the URL, because URLs get logged), system instruction mapping, and the safety-block finish reason mapped to `finish: 'content_filter'`. Until the native adapter passes conformance, the existing OpenAI-compatibility endpoint stays available as the preset `gemini-openai-compat`.

## 3. Normalized request, response and stream

```ts
type GatewayRequest = {
  endpoint: { profileId: string; modelId: string }
  messages: NormalizedMessage[]          // system|user|assistant|tool; content parts: text | image(ref) 
  tools?: ToolSchema[]                   // JSON Schema; gateway rejects if endpoint lacks tool support
  toolChoice?: 'auto' | 'none' | { name: string }
  responseFormat?: { type: 'json_schema'; schema: JsonSchema } // only if supported; else prompt-based + validation
  maxOutputTokens?: number
  temperature?: number
  metadata: { taskId?: string; agentRunId?: string; role?: string; purpose: 'agent'|'probe'|'summary' }
}

type GatewayStreamEvent =
  | { type: 'start'; requestId: string; profileId: string; modelId: string; attempt: number }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }   // complete, JSON-validated
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null; source: 'provider' | 'estimate' }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' }
  | { type: 'status'; code: 'retrying' | 'waiting_rate_limit' | 'compacting_context'; detail: string }

type GatewayResponse = { text: string; toolCalls: ToolCall[]; finish: FinishReason; usage: Usage; endpoint: EndpointRef; attempts: number }
```

Errors are thrown as `GatewayError` (see §5), not yielded. Consumers never see provider JSON.

## 4. Model registry and capabilities

```ts
type ModelCapabilities = {
  chat: Tri; streaming: Tri; tools: Tri | 'emulated'; parallelTools: Tri; vision: Tri
  structuredOutput: Tri; reasoning: Tri
  contextWindow: number | null; maxOutput: number | null
  outputTokenParam: 'max_tokens' | 'max_completion_tokens' | null
}
type Tri = true | false | null     // null = unknown. Never guessed as true.

type ModelRecord = {
  key: string                       // `${profileId}:${modelId}`
  profileId: string; modelId: string; displayName: string
  capabilities: ModelCapabilities
  capabilitySource: Record<keyof ModelCapabilities, 'probe' | 'discovery' | 'hint' | 'user' | 'usage' | null>
  cost: { free: boolean | null; inputPerMTok: number | null; outputPerMTok: number | null }
  tier: 'small' | 'medium' | 'large' | 'frontier' | null   // from discovery/user; null if unknown
  paramProfile?: Record<string, unknown>                    // extra body params (data, not code)
  availability: 'listed' | 'unlisted' | 'retired' | 'unknown'
  health: ModelHealth               // see §7
  roleStats: Record<RoleId, { ok: number; failed: number; totalMs: number }>
  lastDiscoveredAt: string | null
}
```

Precedence when sources disagree: `user` > `probe` > `usage` > `discovery` > `hint`. A failed probe sets `false` with the error code attached. A later successful use can set it back to `true`.

No hard-coded model IDs in code. Defaults such as "suggested model for this preset" live in a data file (`presets.json`), are shown as suggestions, and are dropped automatically if discovery doesn't list them.

Persistence: `userData/core/models.json`, written asynchronously and debounced (max one write per second). The existing `multi-ai/models.json` is migrated once; role history is preserved.

## 5. Error normalization

```ts
type GatewayErrorCode =
  | 'AUTH_INVALID'          // 401, or a key-invalid body on 400/403
  | 'AUTH_FORBIDDEN'        // 403 without a quota/key signal: account or region lacks access
  | 'QUOTA_EXHAUSTED'       // 402, or 429/403 with billing/daily-quota signals
  | 'RATE_LIMITED'          // 429 transient
  | 'MODEL_NOT_FOUND'       // 404 + model wording, 400 model-unknown
  | 'MODEL_UNAVAILABLE'     // 404 without model wording, 410, "model overloaded/unavailable"
  | 'ENDPOINT_NOT_FOUND'    // 404 on /models or /chat/completions path itself (bad base URL)
  | 'CONTEXT_TOO_LARGE'     // 413, or 400 with context-length wording (with tokenLimit when parseable)
  | 'UNSUPPORTED_FEATURE'   // 400/422 on tools|vision|json|param, with `feature`
  | 'BAD_REQUEST'           // other 400/422
  | 'TIMEOUT_CONNECT' | 'TIMEOUT_FIRST_TOKEN' | 'TIMEOUT_IDLE' | 'TIMEOUT_OVERALL'   // plus 408
  | 'NETWORK'               // DNS, refused, reset, TLS
  | 'PROVIDER_ERROR'        // 500
  | 'PROVIDER_UNAVAILABLE'  // 502/503/504/529
  | 'STREAM_MALFORMED'      // unparsable SSE/JSON, empty response
  | 'STREAM_INTERRUPTED'    // disconnect after bytes were delivered
  | 'TOOL_CALL_MALFORMED'   // tool arguments not valid JSON / unknown tool name
  | 'OUTPUT_TRUNCATED'      // finish_reason=length with no usable result
  | 'CONTENT_FILTERED'
  | 'CANCELLED'
  | 'UNKNOWN'

class GatewayError extends Error {
  code: GatewayErrorCode
  httpStatus: number | null
  retryAfterMs: number | null
  tokenLimit?: number; feature?: 'tools' | 'vision' | 'json' | 'param'
  endpoint: EndpointRef
  userMessage: string       // plain language, no provider jargon
  detail: string            // redacted, ≤1200 chars, for developer view
  delivered: boolean        // whether any content reached the consumer
}
```

The existing classifier corpus in `shared/provider-errors.ts` is migrated into `gateway/errors.ts` with a table-driven test covering every row below.

### 5.1 Handling policy

| Code | Retry same endpoint | Fallback | Circuit effect |
|---|---|---|---|
| AUTH_INVALID / AUTH_FORBIDDEN | no | other profile | profile → `AUTH_ERROR` until credentials change or manual retest |
| QUOTA_EXHAUSTED | no | other profile | profile → `QUOTA_EXHAUSTED` until retest or `retryAfter` |
| RATE_LIMITED | once if `retryAfter ≤ 20 s` (else no) | yes | profile cooldown = `retryAfter` or 30 s |
| MODEL_NOT_FOUND / MODEL_UNAVAILABLE | no | other model | model endpoint → unavailable (not the whole profile) |
| ENDPOINT_NOT_FOUND | no | other profile | profile → `OFFLINE` (misconfigured) |
| CONTEXT_TOO_LARGE | once with a smaller context pack | larger-context model | none; records the observed limit on the model |
| UNSUPPORTED_FEATURE | no | a model with the feature | model capability ← false |
| BAD_REQUEST | no | one other model at most | model degraded |
| TIMEOUT_* / NETWORK / PROVIDER_* | up to 2 with backoff (1 s, 3 s, ±25% jitter) | yes | counts toward the breaker |
| STREAM_MALFORMED | once | yes | counts toward the breaker |
| STREAM_INTERRUPTED (delivered) | **no transparent replay** | agent loop decides: resume turn on same/fallback model with the partial output discarded | counts |
| TOOL_CALL_MALFORMED | no gateway retry | agent loop returns a tool error to the model (bounded) | model degraded after repeats |
| CANCELLED | never | never | none |

Budgets bound every retry: at most 3 transport attempts per request, at most 4 endpoints per routing chain, and every wait must fit inside the overall deadline and the task deadline. Retry sleeps are abortable.

## 6. Timeouts

Defaults (overridable per profile and per model; local models get longer first-token timeouts because of model load):

| Deadline | Cloud default | Local default | Meaning |
|---|---|---|---|
| connect | 15 s | 5 s | socket + TLS established |
| first token | 60 s (120 s if model `reasoning: true`) | 300 s | first streamed byte of content, reasoning or tool call |
| idle | 60 s | 120 s | gap between stream chunks (keep-alive comments reset it) |
| request overall | 10 min | 15 min | one model request including retries |
| probe | 30 s | 120 s | a single health probe |

Timeouts raise distinct `TIMEOUT_*` codes, so logs show which phase stalled.

## 7. Health system

### 7.1 States

Profile level: `HEALTHY`, `DEGRADED`, `RATE_LIMITED`, `QUOTA_EXHAUSTED`, `AUTH_ERROR`, `OFFLINE`, `UNSUPPORTED`, `UNKNOWN`.
Model endpoint level: `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, `INCOMPATIBLE` (missing a capability for its roles), `UNKNOWN`.

`UNKNOWN` is the initial state, and it is shown as "not checked", never as healthy. Every state carries `checkedAt`, `source: 'probe' | 'traffic'` and the evidence (error code, latency).

### 7.2 Probes (cheapest first; stop at the first hard failure)

| Level | Probe | Sets |
|---|---|---|
| `connectivity` | TCP/TLS to base URL | OFFLINE on failure |
| `auth` | `validateCredentials` (usually `GET /models`) | AUTH_ERROR |
| `catalog` | `listModels` | model availability, discovery metadata |
| `model` | selected model listed (if catalog available) | model UNAVAILABLE |
| `completion` | 1-shot "reply OK", `maxOutput 16` | chat |
| `streaming` | same request streamed | streaming |
| `tools` | forced single call to `echo` tool | tools / `emulated` |
| `vision` (opt-in) | 8×8 PNG, "what color?" | vision |
| `structured` (opt-in) | `json_schema` response | structuredOutput |

Probes run on explicit "Test", after connecting a profile, and lazily before the router first binds an endpoint whose required capability is `null`. They never run on a timer by default, to avoid quota spend. Passive traffic updates health continuously (success → HEALTHY, classified failures → per §5.1).

Persisted to `userData/core/health.json`. On restart, persisted states older than 15 min are downgraded to `UNKNOWN` except `AUTH_ERROR` and `QUOTA_EXHAUSTED`, which stay until retested.

### 7.3 Circuit breaker

Per profile and per model endpoint:

```text
CLOSED --(3 consecutive breaker-counted failures within 60 s)--> OPEN(cooldown)
OPEN --(cooldown elapsed: 30 s, doubling up to 5 min)--> HALF_OPEN
HALF_OPEN --(1 trial request succeeds)--> CLOSED   (cooldown reset)
HALF_OPEN --(trial fails)--> OPEN(next cooldown)
```

`AUTH_ERROR` and `QUOTA_EXHAUSTED` are latched states, not breaker states. Only a retest or a credential change clears them. State changes emit `provider.circuit_changed`.

## 8. Router

> **Implementation status (Phase 4, 2026-09-27).** `route()` in `core/router/router.ts` is pure and deterministic.
> - **Hard filters, each with a recorded reason:** excluded endpoint or provider, CUSTOM pin, unusable provider health, unavailable model, missing capability, context too small, LOCAL_ONLY cloud, FREE_ONLY unknown or paid price, repository-data consent, and obvious non-chat models (a labelled name heuristic that observed chat support overrides).
> - **Scoring:** Laplace-smoothed per-role success, load, degradation, confirmed capabilities, a mode-specific tier fit (from a labelled name-size heuristic), local preference for trivial AUTO tasks, and reviewer independence.
> - **Fallback order:** provider-diverse, so one outage does not exhaust the chain.
> - **Execution:** `RoleRouter` asks `route()` for every role call, then probes, streams, falls back, and emits `provider.selected`, `model.selected`, `route.changed`, `fallback.started`, `fallback.completed` and `fallback.failed`.
> - **Lazy local runtime:** Ollama is started only by `RoleRouter.beforeUse` right before a selected local endpoint is called. Routing and discovery never start it.
> - **Modes:** `ChatRequest.routingMode` (default AUTO; an explicit model means CUSTOM; LOCAL mode means LOCAL_ONLY). `router.preview` explains a decision without calling a model.
> - **Deviation:** difficulty is a text heuristic (`classifyDifficulty`) until the Planner supplies it (Phase 7). Repository-data consent is treated as granted for every saved profile, because saving a profile is the existing consent act. `selectCodingModelCandidates` remains only for suggesting a model when a connection is first tested.

```ts
type RoutingMode = 'AUTO' | 'FAST' | 'POWERFUL' | 'FREE_ONLY' | 'LOCAL_ONLY' | 'CUSTOM'
type RoutingRequest = {
  role: RoleId
  mode: RoutingMode
  requires: { tools?: boolean; vision?: boolean; streaming?: boolean; structuredOutput?: boolean; minContext?: number }
  difficulty: 'trivial' | 'standard' | 'hard'        // from Planner/Manager, not regex on prompt text
  estimatedInputTokens: number
  carriesRepositoryData: boolean
  exclude: EndpointRef[]                              // already failed in this chain
  pinned?: EndpointRef                                // CUSTOM mode or user role pin
  preferDifferentFrom?: EndpointRef                   // reviewer independence
}
type RoutingDecision = {
  primary: EndpointRef | null
  fallbacks: EndpointRef[]                            // max 3
  reasons: string[]                                   // human-readable, e.g. "tools required", "OpenRouter rate-limited until 14:02"
  rejected: Array<{ endpoint: EndpointRef; reason: RejectReason }>
  mode: RoutingMode
}
```

Algorithm (pure, deterministic for a given snapshot):

1. **Hard filters**: profile enabled; circuit not OPEN; state not AUTH/QUOTA/OFFLINE; model not unavailable; required capabilities not `false`, and not `null` unless probing is allowed; `contextWindow ≥ minContext` when known; `LOCAL_ONLY` → privacy `local`; `FREE_ONLY` → `cost.free === true` or local; `carriesRepositoryData` → local or consent granted; `CUSTOM`/`pinned` → only the pinned endpoint (fallback only if the user allowed it).
2. **Score**: `roleSuccess` (Laplace-smoothed from `roleStats`, from the current `ModelRegistry.rank`) + `tierFit(difficulty, mode)` + `latencyFit(mode)` + `costFit(mode)` + small locality bonus. `FAST` weights latency and small tiers; `POWERFUL` weights large/frontier tiers and success; `AUTO` balances, using local for `trivial` when a local tool-capable model is healthy.
3. **Diversity**: fallbacks prefer a *different profile* first, so one provider outage doesn't consume the whole chain.
4. Unknown tier/cost count as neutral, never as best. The old model-name regex scoring survives only as a labelled weak prior (`reason: "name heuristic"`) when no metadata or history exists.

`router.preview(request)` exposes the decision to the UI without executing anything.

## 9. Gateway call lifecycle

```text
route() → for endpoint in [primary, ...fallbacks]:
   breaker.allow(endpoint)? → resolve secret → build context pack for endpoint.contextWindow
   → adapter.stream() under deadlines → normalize events → on error: classify → policy §5.1
   → emit model.selected / model.request_failed / model.fallback events
→ all exhausted → GatewayError(code of the most relevant failure, userMessage:
   "No available model could complete this step: OpenRouter is rate-limited until 14:02; Groq key was rejected.")
```

Fallback mid-task preserves the conversation, tool results and file state. The new model gets a short system note that it is continuing another model's work (already done today in `RoleRouter`).

## 10. Local AI

- Ollama is a profile, not a special mode. The runtime is started **lazily** on the first request or probe of an Ollama profile (today it is awaited at app startup), and only a process ALTREX started is stopped on quit.
- Approved-model gating (`isApprovedLocalModel`) applies only to one-click *downloads*. Any model already installed in Ollama can be used, with capabilities from `/api/show` + probes.
- `LOCAL_ONLY` must work end-to-end. When no local model has tool support, agent modes are refused with a clear explanation (read-only question answering still works).

## 11. Security requirements (provider-specific)

- The core never persists or logs a key. A `Redactor` registers each resolved key and scrubs all outbound logs, events, errors and tool outputs, and also scrubs prompts before sending (existing behaviour, generalized).
- `baseUrl` validation: no userinfo, HTTPS unless loopback; the query string is stripped.
- Keys go in headers only, never in URLs.
- Status views expose `hasCredential: boolean` and `keyHint` (last 4) computed once at save time and stored with the profile, so no decryption is needed to show status.

## 12. Conformance suite

Every adapter must pass `gateway/conformance.test.ts` against `testing/fake-openai-server.ts` (and a fake Gemini server for the Gemini adapter). Scenarios: success (non-stream and stream), multi-chunk SSE with split frames and keep-alive comments, streamed tool calls (single, parallel, split arguments), usage reporting, 401, 403-quota, 404 model, 404 path, 410, 413 with limit, 429 with and without Retry-After, 500, 503, connect timeout, first-token stall, mid-stream stall, malformed SSE, disconnect after partial content, tools-unsupported 400, `finish_reason: length`, cancellation at each phase. Live-provider tests are opt-in (`ALTREX_LIVE=1` + saved profile) and never part of `pnpm test`.

## crax-gpt native preset (post-release patch)

- Preset `crax-gpt`: base URL `https://gpt.crax.lol/v1`, `Authorization: Bearer <key>`, cloud privacy, no hard-coded model. Every model comes from `GET /v1/models`.
- **Official login flow: not available.** crax-gpt's site has only internal account endpoints (password/CAPTCHA login and Discord linking); there is no third-party OAuth, device-code or token-exchange flow. ALTREX therefore opens `https://gpt.crax.lol/` in the default browser ("Sign in and create an API key") and asks for one field: the API key. It never reads browser cookies or sessions.
- Catalog fields used: `id`, `name` (display name), `context_length`, `inRate`/`outRate` (free only when both are known and zero; otherwise not eligible for FREE ONLY), `reasoning`, and `available: false` (skipped).
- Capabilities: streaming is recorded as a provider hint, since the gateway documents it for its OpenAI-compatible endpoint; this avoids one probe request per model on a rate-limited gateway. Tools and vision stay unknown until observed (probed per model on first use), so models are not all assumed capable.
- Catalog refresh is authoritative: models no longer listed become unavailable, are hidden from `model.list` and are not routed. New models appear automatically. Catalogs are cached for 10 minutes; "Refresh models" forces a refresh.
- Rate limits: 429 responses are classified RATE_LIMITED, Retry-After is respected by the executor, health is updated, and routing falls back to other eligible providers.
- Cloud-code consent (FINAL_CLAUDE_AUDIT §7) applies: no project code reaches crax-gpt until consent is granted.
- Tests: `apps/desktop/src/main/provider-service.crax.test.ts` (real loopback HTTP, crax catalog shape; no real key).
