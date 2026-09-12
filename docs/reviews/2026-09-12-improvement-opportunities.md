# AI Nugget — Improvement Opportunities Report

**Date:** 2026-09-12
**Author:** Claude
**Nugget version reviewed:** `0.7.0` (`b49d444`)
**Inputs:** AI Server Studio (`main`, 2026-09-12), JX Runtime (`main`, 2026-09-12),
provider API documentation and comparable open-source libraries (web research,
2026-09-12).

> This is a report, not a plan of record. Every candidate below is scored
> against the [Feature Admission Test](../../AGENTS.md#feature-admission-test)
> so the maintainer can accept or reject items individually. Nothing in this
> document has been built.

---

## 1. Executive summary

AI Nugget's shape is holding: both sibling projects still route cloud calls
through it, and the two sibling-driven changes in 0.7.0 (reasoning effort,
inline `<think>` stripping) landed as seam features rather than subsystems.
The evidence gathered here points at **five themes** where the library is now
behind what its consumers and the wider ecosystem expect of a provider seam:

| # | Theme | Why now | Where the evidence comes from |
|---|---|---|---|
| 1 | **Usage and cost fidelity** — cached-token and reasoning-token breakdown, provider-reported cost, structured provider errors | The `pricing` hook cannot price cached calls; Studio re-parses `classify()` strings to recover provider error bodies | Studio, OpenAI/Anthropic/Gemini/DeepSeek/OpenRouter usage fields, Vercel AI SDK usage shape |
| 2 | **A Responses-family engine** — OpenAI `/v1/responses` and the Open Responses subset | Reasoning + tools on one request is still Studio's open ask; OpenRouter, Groq, Ollama, vLLM, LM Studio, Cloudflare already serve `/responses` | Studio, OpenAI OpenAPI spec, Open Responses spec |
| 3 | **Local-runtime capability negotiation** — read `capabilities` from `/v1/models` and `/api/show`, honor runtime-reported retryability and request IDs | Studio built a 1,200-line adapter layer because `openai-compat` is one flat profile; JX Runtime publishes exactly the metadata the nugget hardcodes | Studio `runtime/`, JX Runtime `docs/compatibility.md` |
| 4 | **Agent-loop parity** — parallel tool execution, error event, tool-argument streaming, tool-result truncation, required-tool stop reason | Studio's in-repo loop diverged for reasons that are now stale (F1/F3 are fixed) plus a handful of small features the nugget lacks | Studio `services/agentLoop.ts`, Vercel AI SDK, Anthropic tool runner |
| 5 | **Reasoning dialect drift** — `reasoning_content` vs `reasoning`, thinking-block replay, `budget_tokens` deprecation, wider effort enums | The 0.7.0 effort mapper already targets fields that providers have since renamed or deprecated | Anthropic release notes, OpenAI spec, DeepSeek/Kimi/OpenRouter docs |

Alongside those, §7 lists a set of **honesty and hygiene fixes** discovered in
passing (a documented `connect()` that does not exist, an unimplemented `route`
event promised in `design.md`, an `Idempotency-Key` sent to OpenAI that the
OpenAI spec does not document, a Perplexity profile that will break on
2026-09-27). These are cheap and should go first.

The recommended first release (§8) is a **0.8.0 that is entirely additive**:
usage breakdown, structured provider error, capability-aware local profiles,
and the agent-loop parity items. The Responses engine is a 0.9.0-sized piece
of work and the natural next one.

---

## 2. What AI Server Studio has learned that the nugget can absorb

Studio (`app/backend`) pins `@jxburros/ai-nugget@^0.6.0`
(`app/backend/package.json:43`), so it has not yet adopted 0.7.0 and still
carries its own 252-line `services/reasoningFilter.ts`. The items below are
things Studio built *around* the nugget; each is a candidate to pull back.

### 2.1 A second adapter layer for non-Ollama local runtimes (High)

`app/backend/src/runtime/types.ts` defines nine runtime kinds (`ollama`,
`openai-compatible`, `llamacpp`, `vllm`, `sglang`, `lmstudio`, `koboldcpp`,
`jx`, `remote-studio`) with a `RuntimeCapability` probe set
(`chat | stream | embed | vision | tools | discover | load-unload | native-options`).
`runtime/openAICompatibleAdapter.ts` (~1,200 lines) knows the per-server
discovery quirks the nugget's single `openai-compat` profile does not: LM
Studio `/api/v0/models`, llama.cpp `/props`, KoboldCpp `/api/v1/model`, SGLang
`/get_server_info`, and JX Runtime's `capabilities` block on `/v1/models`.
Studio moved discovery and health **off** `handler.listModels()` /
`testConnection()` onto this layer on 2026-08-10
(`development-docs/architecture/models-and-runtimes.md:29`).

**Nugget shape:** profile-table rows (`sglang`, `koboldcpp`, `jx-runtime`)
with a per-profile `discoveryPath`/`healthPath` quirk, and a
`ModelInfo.capabilities` field populated from whatever the runtime reports
(`/api/show` for Ollama, `capabilities` on `/v1/models` for JX/vLLM). No new
engine. This directly feeds `runAgent`'s existing `modelCapabilities` upgrade
path (`src/agent/loop.ts:357-364`), so `toolMode: 'auto'` stops guessing.

### 2.2 Agent-loop features the in-repo loop added (Medium, several small items)

`services/agentLoop.ts` (987 lines) ported `runAgent` and then grew:

- An **`error` event** emitted before the loop closes with an honest
  `stopReason` (`:421-432`). The nugget's `AgentEvent` union has no `error`
  member (`src/agent/loop.ts:75-84`); callers must inspect `AgentResult.error`.
- `tool_mode` carries a third value, **`'none'`** (`:623-627`), for turns
  where no tools are offered.
- **`requiredToolIds`** with one stricter-reminder retry and a new stop reason
  **`tool_not_used`** (`:86-91`, `:445-484`).
- **`thinking` progress** (`{type:'thinking', chars}`, throttled) and a
  **`notice`** event (`{kind, message}`) for disclosures such as
  "reasoning effort disabled for tools" (`:238-245`, `:338-343`, `:386-393`).
  The nugget already emits the disclosure as a `context` event; the gap is only
  the `thinking` progress counter.
- **promptJson whole-step buffering** and `parsePromptJsonStep` — a
  string-aware balanced scan restarted at every `{`/`[` so a chain of thought
  that quotes the tool contract does not fool the parser (`:734-780`), plus
  narration detection that ends the run cleanly (`:100-109`).
- **Tool-call dedupe** by `(name, JSON.stringify(args))` with synthesized
  per-step ids (`:289-290`, `:704-714`).
- **`kind === 'canceled'`** treated as cancel, not error (`:935-944`).
- **Tool-result truncation with an in-band notice**: `agentTools.ts:435-444`
  caps at 24,000 chars and tells the model to re-run with narrower arguments.
  The nugget has `toolResult.maxChars` but off by default and silent.

Studio's stated reasons for keeping its own loop (`agentLoop.ts:18-24`, "F1"
provider options and "F3" native tools on local runtimes) are **stale**: the
nugget merges `providerOptions` into Ollama `options`
(`src/adapters/engines/ollama.ts:173-177`) and `modelCapabilities` upgrades
`auto` to native (`src/agent/loop.ts:27-32`). The surviving reason is the
multi-runtime layer in §2.1. Closing §2.1 and the bullets above is the path to
Studio re-adopting `@jxburros/ai-nugget/agent`.

### 2.3 Structured provider errors (High)

`services/providerError.ts:11,49` re-parses the nugget's own `classify()`
message (`HTTP <status>: <first 200 chars>`) to recover the provider's error
JSON, and notes that at 200 characters "the JSON never closes, so
`JSON.parse` fails" (`src/errors.ts:47` is the truncation). Every consumer that
wants the provider's `code`/`type`/`param` will write this parser.

**Nugget shape:** `AIError.providerError?: { code?, type?, param?, message?,
raw? }` parsed (and redacted) at the wire boundary in `classify()`, with the
excerpt limit applied to `message` rather than to the JSON. Zero-dep,
contract-shaped, strictly additive.

### 2.4 Per-call preflight hook, not `keySource.resolve` abuse (Medium)

`aiNugget.ts:69-73,120-135` documents that Studio abuses `keySource.resolve`
as "the one async checkpoint ai-nugget runs on EVERY call" to re-run DNS
rebinding and SSRF checks on `baseUrl`. `beforeCall` exists but is
synchronous-shaped and receives a scrubbed connection. An **async `beforeCall`
that may return `'deny'` or a replacement `baseUrl`/headers** — or a dedicated
`fetch` override on `HandlerOptions` — is what Studio actually wants. See also
§3.1 for the JX `safeFetch` pattern.

### 2.5 Usage and cost accounting (High)

`cloud/pricing.ts` is a static $/MTok sheet with admin overrides and
**explicitly documents** that it cannot price cached input, batch, long-context
tiers, or per-request search. `cloud/usage.ts` `createCloudUsageEvent` has a
*required* `disclosure` parameter so the typechecker proves every dispatch
declares one; `cloud/dispatchGuard.ts:22` notes the choke point had to sit
above `buildConnection` "because the last two do not go through ai-nugget at
all". The nugget's `Usage` is `{inputTokens?, outputTokens?, estimated}`
(`src/types.ts`), so cached/reasoning tokens are invisible to the `pricing`
hook. See §5 item U1.

### 2.6 Context-window management (App-side, but one helper is seam-shaped)

`modelTraffic.ts` `effectiveContextWindow`, `fitModelToPrompt`,
`promptFit.ts`, and compaction thresholds in `chatTurnPrepare.ts:139-141`
are app concerns (model choice). Two small pieces are not:

- `routes/conversationStream.ts:668-696` strips image parts across the whole
  history with a visible in-context marker when the model is not
  vision-capable. Given `ContentPart` already exists, a
  `degradeUnsupportedParts` helper (or a `parts_dropped` context event) is
  seam-shaped.
- Prompt-token estimation before dispatch. `estimateTokens` exists; a
  `context_length` *pre-check* using `ModelInfo.contextWindow` when known would
  turn a provider 400 into a typed `context_length` error before the call.

### 2.7 Remaining bypasses and why

| Path | Files | Reason today |
|---|---|---|
| All local inference | `runtime/ollamaAdapter.ts`, `ollamaClient.ts` | Multi-runtime layer (§2.1); documented parity cost: local agent steps write no `ai_call_events` |
| Embeddings | `embedding/*.ts` | Originally "nugget has no embeddings" (now stale); layer adds dimension pinning and index-aligned batching with nulls |
| Discovery/health | `runtime/registry.ts` | Superseded `listModels`/`testConnection` (§2.1) |
| Cloud catalogs | `managedProviders.ts` | Pricing, curated fallbacks — app-side |
| Voice, images, music, MCP, web search | `services/voiceCloud.ts`, `media/*`, `mcpClient.ts` | Out of nugget scope (no audio/image APIs) |

Two loader notes: `aiNuggetLoader.ts:1-27` still builds a `new Function`
dynamic import because the nugget was ESM-only; the nugget now ships a
`require` condition (`package.json:33-46`), so the shim is removable once
Studio bumps. And Studio backstops the redactor's 6-character minimum
(`src/redact.ts:55,73`) in `cloud/keys.ts:300-302` (Studio #793).

### 2.8 Friction recorded since 0.6.0

- Cloud reasoning "returned in a separate field that the ai-nugget handler does
  not surface as text" (`CHANGELOG-2026-09.md:1257`) — addressed by 0.7.0's
  `reasoning` events (the `openaiChat` engine reads both `reasoning_content`
  and `reasoning` deltas, `src/adapters/engines/openaiChat.ts:93-95`), **but**
  that reasoning is never replayed on assistant history, which some hosts
  require for multi-turn tool calls (see §4.5).
- `agentLoop.ts:603-621` sends both `reasoningEffort` and
  `providerOptions.reasoning_effort` so the fix "does not wait on a package
  release" — a version-straddle that a published 0.7.0 bump resolves.
- Providers Studio added that ride the generic engine without a profile:
  `meta` (Muse Spark), and it treats `moonshot`/`perplexity` as generic
  (`cloud/providers.ts:102-111`).
- Recent Studio capabilities that imply new provider-layer demands: cloud
  TTS/STT, managed image generation, MCP in both directions with OAuth 2.1,
  multi-model "Rooms" fan-out with `responseFormat: {type:'json'}`, and nightly
  model-intelligence probes. Of these only **structured output reliability**
  and **capability metadata** are seam-shaped; audio and image generation are
  separate contracts (§6).

---

## 3. What JX Runtime has learned that the nugget can absorb

JX Runtime is a dependency-free local/LAN model runtime exposing an
OpenAI-compatible `/v1` surface plus a `/runtime` management surface. Its
boundary ("the runtime executes; the application decides",
`docs/product-spec.md:44`) mirrors the nugget's, and it was built with the
nugget as a target client (`src/config.js:62` names AI Nugget as the
motivating CORS case). Its client-facing contract is the most concrete
specification the nugget has for "what a well-behaved local runtime says".

### 3.1 SSRF-safe fetch (`src/safeFetch.js`)

Checks, in order: `http(s)` only; no credentials in the URL; optional host
allowlist with subdomain matching (`:130`); DNS-resolve **every** address and
require public unicast with full IANA special-range coverage including
IPv4-mapped, 6to4 and NAT64 unwrapping (`:76-110`); manual redirect following so
hops 2..N are re-checked (`:196-250`); **`Authorization` dropped on
cross-origin redirect** (`:240`). Residual risk (DNS rebinding between check and
connect) is documented (`:28-33`).

The nugget documents SSRF via caller-controlled `baseUrl` as out of scope
(`docs/security.md:80-90`). DNS resolution is Node-only, so the full pattern
fails the isomorphism test. Two pieces do not: **(a)** an opt-in
`baseUrlPolicy: { schemes, hostAllowlist }` checked in `preflight()` and
**(b)** a `fetch` override on `HandlerOptions` so Node hosts can inject their
own resolver-checking fetch (and JX's PEM trust anchor, §3.5). Both are
contract-shaped and keep the library's default neutral.

### 3.2 `details.retryable` and stable `code` on every error (`src/errors.js`)

Every JX error is `{ error: { code, message, type, correlationId, details: {
retryable, … } } }` (`:95-104`). `retryable` is computed server-side with
deliberate overrides: `MODEL_BUSY` (409) **is** retryable; the four 507
"won't fit" codes and `REQUEST_CANCELLED` are not (`:160-200`). The nugget
infers retryability purely from status class (`src/errors.ts:60-72`), so
against JX it will retry a 507 to exhaustion and never retry a 409.

**Nugget shape:** in `classify()`, when a parsed body carries
`error.details.retryable` (boolean) honor it; when it carries `error.code`,
copy it into `providerError.code` (§2.3). Falls out of the structured-error
work for free.

### 3.3 Request IDs and correlation (`src/requestId.js`)

JX accepts a caller `X-Request-Id` (validated `^[A-Za-z0-9._:-]+$`, ≤128) and
echoes it; every error's `correlationId` matches. The nugget already has a
`callId`; sending it as `X-Request-Id` per attempt (behind a profile quirk,
like `supportsIdempotencyKey`) and surfacing the echoed header plus any
`correlationId` on `AIError`/`CallRecord` makes runtime logs joinable with
nugget telemetry. Note the CORS caveat in §3.6.

### 3.4 Capability discovery on `/v1/models`

Model objects carry `capabilities: { chat, completion, embeddings, vision,
tools, reasoning, rerank, structured_output, max_context }`, plus
`max_model_len` (vLLM convention), `loaded`/`state`, `active_context` (the
window actually loaded, often far below `max_context`), `embedding_dimension`,
`max_embedding_tokens` (`docs/compatibility.md:58-206`). `tools` is
heuristic; a tools request to a build without `--jinja` returns `501
NOT_SUPPORTED`. This is the same negotiation source Studio probes (§2.1) and
should populate `ModelInfo.capabilities` and `contextWindow` when present.

### 3.5 Pairing token flow and TLS trust anchor

`POST /runtime/pairing/claim` takes a single-use `JX-XXXX-XXXX` code and
returns `{ runtime, endpoint, apiBase, token, permissions, certificate: { pem,
fingerprint, … } }` (`src/pairing.js:335-348`). Keys are long-lived (optional
`expiresAt` → `TOKEN_EXPIRED` 401); there is no refresh. A **`pairing`
KeySource** (claim once, persist `token` + `baseUrl`) is a natural addition to
the `keys.ts` family. TLS: the runtime publishes its self-signed PEM; Node
clients need a `ca`/dispatcher escape hatch, which is the same `fetch` override
as §3.1(b).

### 3.6 Interop facts the nugget should encode as quirks or docs

- **Only `Retry-After`, never `X-RateLimit-*`** — the nugget's retry already
  reads `Retry-After`; do not build header-adaptive pacing on JX.
- `keep_alive` accepted with Ollama grammar; **no per-request `num_ctx`**,
  read `active_context` instead. Preflight refuses oversized prompts with
  `details.code: "context_length_exceeded"` + `maxContext`/`promptTokens` —
  worth mapping to the nugget's `context_length` kind with those numbers.
- `n > 1` rejected; both `max_tokens` names accepted but not with different
  values; bodies capped at 20 MB.
- `QUEUE_FULL` 503 and `MODEL_BUSY` 409 both mean "retry with backoff".
- `GET /runtime/health` returns `authRequired`/`authMode` so a client can learn
  whether it needs a key before it has one — `testConnection` could report it.
- **CORS is off by default** and only `Content-Type, Authorization` are allowed
  request headers (`src/app.js:346`) — a browser-hosted nugget sending
  `X-Request-Id` would fail preflight. Any new default header needs a
  browser-safe fallback or a quirk.
- The discovery HTTP envelope is `{"discovery": {...}}` while the announce
  file is bare; this broke Studio's detector (Studio #906).
- Roadmap: `/v1` and discovery are additive-only; `GET /v1/runtime` is marked
  for possible reversal (JX #226); `MODEL_LOAD_FAILED` moved 500→504 this
  release; dual-engine installs may present two instances on 8712/8713.

---

## 4. Provider API landscape (what changed upstream)

Verification levels: **[spec]** read from the official OpenAI OpenAPI document;
**[notes]** read from Anthropic's API release notes; **[repo]** read from the
`ollama/ollama` docs; **[summary]** from search-result summaries of official
pages that were egress-blocked in this session (Gemini, OpenRouter, most
third-party providers). Treat [summary] items as leads to confirm before
building on them.

### 4.1 OpenAI

- Chat Completions is **not deprecated** [spec], but new features land on
  Responses first and the Assistants API shut down 2026-08-26 [summary]. A
  Responses engine is the primary path; keep `openaiChat` as the compat engine.
- `reasoning_effort` enum is now `none|minimal|low|medium|high|xhigh|max` on
  both endpoints [spec]. The nugget's `ReasoningEffort` stops at `high`.
- Responses request shape [spec]: `input` items, `instructions`,
  `previous_response_id`, `store`, `background`, `include[]`
  (`reasoning.encrypted_content`, …), `reasoning: {effort, summary}`,
  `text.format` (json_schema with `strict`), `max_output_tokens`,
  `max_tool_calls`, `parallel_tool_calls`, `context_management` (compaction),
  `prompt_cache_key`, `prompt_cache_retention`, `safety_identifier`,
  `service_tier` (`auto|default|flex|priority`).
- Streaming is a typed `response.*` event grammar with `sequence_number`
  [spec]: `output_text.delta`, `function_call_arguments.delta`,
  `reasoning_summary_text.delta`, `refusal.delta`, and built-in tool
  lifecycle events (`web_search_call.*`, `mcp_call.*`, `code_interpreter_call.*`).
- Usage: `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`
  (Chat: `prompt_tokens_details.cached_tokens`) [spec].
- **`Idempotency-Key` appears in the spec only on the Agents `sessions/{id}/events`
  endpoint**, not on `/chat/completions` or `/responses` [spec]. The nugget's
  `supportsIdempotencyKey: true` on `openai` (`src/adapters/profiles.ts:92`) and
  the 0.6.0 double-billing claim need re-verification (§7).
- Batch API accepts `/v1/responses` too; 24h window; webhooks [spec]. App-side.

### 4.2 Anthropic [notes]

- **Prompt caching**: `cache_control: {type:'ephemeral', ttl:'5m'|'1h'}`, max 4
  breakpoints, or a top-level `cache_control` that auto-caches the last
  cacheable block; usage `cache_creation_input_tokens` /
  `cache_read_input_tokens`.
- **Thinking**: `thinking: {type:'adaptive', display: …}`; **`budget_tokens` is
  deprecated on 4.6 and rejected (400) on newer models**; effort is
  `output_config.effort: low|medium|high|xhigh|max`. Thinking blocks carry a
  `signature` and must be echoed back verbatim on the same model. `usage.output_tokens_details.thinking_tokens`.
  **The 0.7.0 mapper emits `thinking.budget_tokens` from `REASONING_BUDGET_TOKENS`
  (`src/util.ts:114`) — this will 400 on current models.**
- **Tools**: `tool_choice: any|tool` returns 400 on the newest models — use
  `auto` plus `strict: true`; fine-grained tool streaming is
  `eager_input_streaming: true` on the tool definition.
- **Structured outputs are GA**: `output_config.format: {type:'json_schema',
  schema}`; the nugget's forced `json_output` tool (`anthropic.ts:181-185`) is
  now the fallback path, not the primary one.
- Server tools (`web_search_*`, `web_fetch_*`, `code_execution_*`,
  `computer_toolset_*`, `memory_*`), `mcp_servers` connector, Files API
  (`document`/`image` with `source.type:'file'`), PDFs as base64 `document`
  blocks, `stop_reason: 'refusal' | 'pause_turn'`, mid-conversation
  `role:'system'` messages on some models, `count_tokens`, Batches.
- Models API now returns `max_input_tokens`, `max_tokens`, `capabilities` —
  `listModels` can populate `ModelInfo.contextWindow` for free.
- Rate-limit headers `anthropic-ratelimit-*-{limit,remaining,reset}` plus
  `retry-after`.

### 4.3 Google Gemini [summary]

- An **Interactions API** is reported GA and recommended for new projects,
  with `generateContent` "legacy but supported"; responses are `steps[]`,
  server-side state via `previous_interaction_id`. Unverified in detail.
- `thinking_level` is the recommended control; `thinking_budget` still accepted
  but mutually exclusive (400 if both). `thought_signature` on parts must be
  replayed. The nugget emits `thinkingConfig.thinkingBudget`.
- Function-calling modes `AUTO|ANY|NONE|VALIDATED`; `responseJsonSchema`
  preferred over `responseSchema`; implicit caching on by default with
  `cachedContentTokenCount` in usage; built-in `google_search`, `url_context`,
  `code_execution`, `file_search`.

### 4.4 Ollama [repo]

- `think` accepts `true|false|"low"|"medium"|"high"|"max"`; `format` takes a
  JSON schema; tool calls have an `index` but **no `id`**, and tool results are
  `{role:'tool', tool_name, content}`. Streaming interleaves `thinking`,
  `content`, `tool_calls` chunks.
- **Cloud models (`:cloud`) do not support `format` schema** — fall back to
  `promptJson`. Remote host `https://ollama.com` needs `Authorization: Bearer`;
  the `ollama` engine profile is `auth: 'none'` today.
- `/api/show` returns `capabilities[]` (`completion`, `vision`, `tools`,
  `thinking`, `embedding`).
- OpenAI compat now includes **`/v1/responses`** (non-stateful, streaming,
  tools, reasoning summaries) and an Anthropic-compat `/v1/messages` — so a
  Responses engine can be contract-tested locally with no key.
- Cached-prompt token reporting landed in a recent release [summary].

### 4.5 OpenAI-compatible ecosystem [summary unless noted]

- **Responses adopters**: OpenRouter, Groq, Ollama [repo], vLLM, LM Studio,
  Hugging Face, Cloudflare Workers AI, Bedrock, xAI. The **Open Responses**
  spec formalizes the subset — the right target for a fifth engine.
- **Reasoning field drift**: DeepSeek, Fireworks, Azure use `reasoning_content`;
  OpenRouter, vLLM/SGLang, NIM, Kimi K2.6 use `reasoning` (OpenRouter also
  `reasoning_details[]`). Multi-turn tool calling on DeepSeek/Kimi/Qwen requires
  **replaying** that field on the assistant message. The `openaiChat` engine
  already reads both into `reasoning` events, but `toOpenAiMessage`
  (`openaiChat.ts:208-220`) never sends them back and `ChatMessage` has no
  field to carry them, so multi-turn tool loops on those providers can break.
- **Reasoning controls per host**: OpenRouter `reasoning: {effort, max_tokens,
  exclude}`; Groq `reasoning_format: parsed|raw|hidden`; Cerebras
  `reasoning_effort` incl. `none`; Qwen `enable_thinking`; Z.ai `thinking:
  {type}`; xAI `xhigh`. A per-profile "reasoning dialect" quirk is the shape.
- **Usage extensions**: DeepSeek `prompt_cache_hit_tokens`; OpenRouter always
  returns `usage.cost` and cached tokens and passes `cache_control` through.
- **Perplexity retires its Sonar endpoints 2026-09-27** in favor of an Agent
  API — the current `perplexity` profile will break.
- Azure Foundry `/openai/v1` still requires a preview `api-version`; the
  profile's `2024-10-21` may need a bump.
- Fireworks streaming is reported to leak `<think>` into `content` — the 0.7.0
  stripper covers this.
- New profile candidates: Vertex `global` endpoint (Claude + Gemini), MiniMax
  (Anthropic-compat), Kimi/GLM/Qwen (OpenAI-compat with dialect), Hugging Face
  router, GitHub Models (preview), Meta (Studio already uses it). Bedrock needs
  SigV4 and fails the zero-dep test unless the app supplies a signer via the
  `fetch` override (§3.1).

### 4.6 Cross-cutting

- **MCP** spec 2026-07-28 changed headers and `tools/list` caching. Provider-side
  MCP (`mcp_servers`, `type:'mcp'` tools) is a passthrough shape; a client-side
  MCP→`defineTool` bridge is app-shaped.
- **OpenTelemetry GenAI conventions** are still *Development*; the attributes
  `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`
  / `output_tokens` are stable in practice. Vercel moved OTel out of core into
  `@ai-sdk/otel` — the same split (a documented `CallRecord → gen_ai.*`
  mapping, no dependency) fits the nugget.
- **Usage shape** convergence: `{inputTokens, outputTokens, totalTokens,
  reasoningTokens, cachedInputTokens, inputTokenDetails.{cacheReadTokens,
  cacheWriteTokens}}` (Vercel AI SDK, LangChain `usage_metadata`).
- **`tool_choice` normalization**: OpenAI `auto|none|required|{fn}`, Anthropic
  `auto|any|tool|none` (any/tool rejected on newest models), Gemini
  `AUTO|ANY|NONE|VALIDATED`, Ollama compat ignores it. The nugget has
  `'auto'|'none'|{name}` and no `'required'`.
- Three SSE grammars now coexist (Chat `choices[].delta`, Responses
  `response.*`, Anthropic `content_block_*`); Gemini Live is WebSocket and out
  of scope.

---

## 5. Comparable projects and the feature ideas they suggest

Projects examined: Vercel AI SDK 7 (the reference point), Token.js, LiteLLM,
OpenRouter SDK/agent, Portkey, llm.js, hoangvvo/llm-sdk, multi-llm-ts, Mozilla
any-llm, aisuite, Mastra, OpenAI Agents SDK (JS), Anthropic SDK tool runner,
LangChain.js 1.x, Genkit, Pydantic AI, BAML, Instructor-js, ollama-js, and the
Braintrust/Helicone/Cloudflare gateways. Source links are in Appendix A.

The closest in spirit is **Token.js** (OpenAI-format client, 12 providers,
zero governance); the closest in ambition is **Vercel AI SDK core** (minus its
UI and framework layers). Nobody else combines zero dependencies, isomorphism,
key redaction, and a neutral governance seam — that combination remains the
nugget's differentiator and should not be traded away for feature count.

### 5.1 Candidates that pass the Feature Admission Test

Each row: what, who has it, why it belongs to the seam, and the smallest shape.
Priority is the author's judgement: **P1** = consumers are already paying for
its absence; **P2** = clear value, no consumer blocked; **P3** = nice to have.

| ID | Candidate | Who has it | Why seam-shaped | Smallest shape | Pri |
|---|---|---|---|---|---|
| **U1** | **Usage breakdown**: `cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens`, `totalTokens`, and provider-reported `cost` | AI SDK, LangChain, OpenRouter, Anthropic, DeepSeek | The `pricing` hook is wrong on cached calls today; every consumer re-derives it | Optional fields on `Usage`; engines fill from provider usage objects | P1 |
| **U2** | **Structured provider error** on `AIError` (`providerError: {code, type, param, message}`) and honor `details.retryable` when present | AI SDK `APICallError`, Pydantic `ModelHTTPError`, JX Runtime | Studio re-parses `classify()` strings; JX 507/409 semantics are inverted today | Parse + redact in `classify()`; excerpt limit on message not JSON | P1 |
| **C1** | **Capability metadata on `ModelInfo`** (`capabilities`, `contextWindow`, `activeContext`) from `/api/show`, `/v1/models` extensions, Anthropic Models API | LangChain `.profile`, Pydantic `ModelProfile`, LiteLLM `supports_*`, Studio, JX | Turns `toolMode:'auto'` from a guess into a lookup; enables a `context_length` pre-check | Read-only; no bundled table (apps supply overrides) | P1 |
| **C2** | **Local-runtime profile family**: `sglang`, `koboldcpp`, `jx-runtime` rows with `discoveryPath`/`healthPath` quirks | Studio `runtime/`, Mastra custom providers | Studio built 1,200 lines because `openai-compat` is one flat row | Profile rows + two quirks; no engine | P1 |
| **R1** | **Reasoning replay** for OpenAI-compat hosts: carry the model's `reasoning_content`/`reasoning` on `ChatMessage` (e.g. `reasoning?: string`) and send it back on assistant turns when the profile requires; same mechanism carries Anthropic thinking `signature` blocks and Gemini `thought_signature` | any-llm, OpenRouter, LibreChat issue trail, Anthropic/Gemini docs | Broken multi-turn tool calls on DeepSeek/Kimi/Qwen and rejected history on newest Anthropic/Gemini models | Optional `ChatMessage.reasoning`; quirk `replayReasoning: 'reasoning_content' \| 'reasoning'`; `runAgent` keeps it on the assistant message | P1 |
| **R2** | **Fix the Anthropic/Google effort mapping**: `output_config.effort` (not `budget_tokens`), `thinking_level` (not `thinkingBudget`), widen `ReasoningEffort` to `xhigh`/`max`; replay Anthropic thinking `signature` blocks | Anthropic release notes, OpenAI spec, AI SDK `reasoning` setting | 0.7.0's mapper targets deprecated/rejected fields | Change mapper; `reasoning` blocks kept on the assistant message in `runAgent` | P1 |
| **A1** | **Parallel tool execution** within a step, bounded by the handler's concurrency limiter, results in call order | AI SDK, Genkit, LangChain, Studio (dedupe) | `for (const call of calls)` is the slowest correct implementation | `Promise.all` over `mapWithConcurrency` (already in `util.ts`) | P1 |
| **A2** | **`error` AgentEvent**, `tool_mode: 'none'`, `stopReason: 'tool_not_used'` + `requiredTools`, tool-call dedupe, truncation notice on by default | Studio, AI SDK `ToolChoiceViolationError`, `hasToolCall` | Parity items Studio needed; each is an event or an option | Additive event/option; default `toolResult.maxChars` with in-band notice | P1 |
| **A3** | **Tool-argument streaming deltas** (`tool_call_delta` event) | AI SDK `tool-input-delta`, Anthropic `inputJson`, OpenRouter | UIs render tool intent early; all engines already receive the deltas | New stream event kind; whole `tool_call` still emitted at end | P2 |
| **A4** | **`repairToolCall(call, error)` hook** before failing a step | AI SDK | Complements `validateToolArgs` and the Ollama JSON-string coercion | Optional `AgentOptions` hook | P2 |
| **A5** | **Per-tool and per-step timeouts** (`timeout.stepMs`, `toolMs`, per-tool override) | AI SDK, OpenAI Agents, Pydantic AI | `deadlineMs` only interrupts tools that honor `ctx.signal`; a tool that ignores it hangs the run | Wrap `execute` in `withTimeout`; abort via existing `ctx.signal` | P2 |
| **S1** | **Structured-output feedback retry**: `chatParsed` re-asks with the validation error, bounded by `maxRepairs` (default 1, today's behavior) | Instructor, LangChain `handleErrors`, Pydantic `ModelRetry`, AI SDK `NoObjectGeneratedError` | Makes `promptJson` robust on small local models; keeps double-billing visible | Extend existing one-retry to N with the error text in the re-ask | P2 |
| **S2** | **Anthropic native structured outputs** (`output_config.format`) as primary, forced tool as fallback; Gemini `responseJsonSchema` | AI SDK `structuredOutputMode`, LangChain `ProviderStrategy` | Provider-native JSON schema is stricter and cheaper than a forced tool | Engine change behind `supportsJsonSchema` quirk | P2 |
| **P1** | **Portable prompt-cache hint**: `cache?: 'ephemeral' \| {ttl}` on a message/part or the system prompt → Anthropic `cache_control`, OpenAI `prompt_cache_key`, OpenRouter passthrough; ignored elsewhere; `cache_unsupported` context event | AI SDK Anthropic provider, OpenAI Agents `promptCacheOptions`, Cloudflare | The single largest cost lever on Anthropic; wrong to reimplement per app | Field on `Message`/`ContentPart` + `ChatRequest.cacheKey`; pairs with U1 | P2 |
| **E1** | **OpenAI Responses engine** (`openaiResponses`), targeting the Open Responses subset; message→item mapper; typed event adapter; `previous_response_id` passthrough; tolerate non-function output items | OpenAI Agents (default), any-llm `responses()`, AI SDK, OpenRouter/Groq/Ollama/vLLM/LM Studio/Cloudflare | Reasoning + tools on one request — the open ask since 0.7.0; contract-testable against Ollama locally | Fifth engine; profile quirk `supportsResponses`; `openai` default stays `openaiChat` until verified | P2 |
| **T1** | **`tool_choice: 'required'`** normalized per engine, degraded with a context event where a provider rejects it | AI SDK, OpenAI, Gemini `ANY`, Anthropic `any` (with the 400 caveat) | Consumers cannot force a tool call today without `providerOptions` | Add to the union; per-engine mapping | P2 |
| **F1** | **`file` content part** (`{type:'file', mediaType, data \| fileId}`) for PDFs/audio; `degradeUnsupportedParts` helper with a `parts_dropped` context event | AI SDK 7, llm-sdk, Anthropic Files/document, Gemini `file_data`, Studio's history stripper | `image` exists; PDFs are now first-class on two engines | Additive part type; engines that cannot carry it drop with a signal | P2 |
| **H1** | **`fetch` override + opt-in `baseUrlPolicy`** on `HandlerOptions` | JX `safeFetch`, AI SDK `fetch` option, Bedrock signers | Studio abuses `keySource.resolve` for SSRF checks; Node hosts need CA pinning | One option; default `globalThis.fetch`; policy is neutral | P2 |
| **H2** | **`X-Request-Id` per attempt** (profile-gated) and `correlationId`/echoed id on `AIError` + `CallRecord`; also `retryAfterMs` already exists — document it | JX, AI SDK `responseHeaders`, Helicone session headers | Joinable logs across runtime and app | Quirk `supportsRequestId`; browser CORS caveat documented | P3 |
| **K1** | **`pairing` KeySource** for JX Runtime (claim once, persist token + apiBase + PEM) | JX pairing flow | Keys must enter through `KeySource`; this is a new entry path, not a vault | New `keys.ts` factory; storage stays app-side | P3 |
| **M1** | **Public mock engine / scripted-fetch test helper** (`mockProvider`, `simulateStream`) | AI SDK `MockLanguageModelV4`, Pydantic `TestModel`, LiteLLM `mock_response` | Downstream apps cannot unit-test without live keys; `tests/helpers.ts` already exists privately | Export under `@jxburros/ai-nugget/testing` subpath | P3 |
| **M2** | **`wrapEngine` middleware seam** (`transformRequest`, `wrapStream`) | AI SDK `wrapLanguageModel`, LangChain `wrapModelCall`, Genkit, Portkey hooks | `beforeCall`/`afterCall` cannot observe or replace the stream (output guardrails, caching) | One optional wrapper array on `HandlerOptions`; engines untouched | P3 |
| **M3** | **Documented `CallRecord → gen_ai.*` mapping** recipe (no OTel dependency) | AI SDK `@ai-sdk/otel` split, LangChain, Genkit | A `TelemetrySink` should be able to emit conformant spans | Docs + a 30-line example in `examples/telemetry.mjs` | P3 |
| **M4** | **Fallback connections on retryable failure** (`fallbackConnections?: Connection[]`, only before any output was emitted, `fallback_used` context event) | Pydantic `FallbackModel`, Mastra fallback arrays, Genkit Fallback, Cloudflare `cf-aig-step` | Stays inside "apps choose models" because the app supplies the list and order | Extend the retry loop; no scoring or routing | P3 |
| **M5** | Per-call throughput stats on `timing` (`outputTokensPerSecond`, `timeBetweenChunksMs` max/mean) | AI SDK step stats | Telemetry-only, cheap, useful for Studio's model-intelligence probes | Two numbers computed in the handler | P3 |

### 5.2 Candidates that fail the test (keep app-side; document the shape)

- **Model routing, load balancing, canary, semantic caching, budgets/spend
  limits, virtual keys, guardrail catalogs** (Portkey, LiteLLM, Helicone,
  Cloudflare AI Gateway). Gateway state. `GovernancePolicy` + `beforeCall` is
  the correct seam; a *recipe* showing a spend-limit policy and a cache-lookup
  `beforeCall` would cover the common ask.
- **Bundled price / capability tables** (LiteLLM JSON at 2.26 MB, llm.js
  `fetchModels`, Pydantic `genai-prices`). Data churn conflicts with
  zero-dep/vendorable. Keep the `pricing` hook; document LiteLLM's JSON as an
  app-side source. C1 stays read-from-provider only.
- **MCP client, code mode, hosted-tool catalogs, agent harnesses, HITL state
  serialization, memory/summarization, handoffs, multi-agent** (AI SDK, OpenAI
  Agents, LangChain, Claude Agent SDK, Mastra). Above the seam; `ApprovalGate`
  and `AgentEvent` are the integration points. One exception worth a later
  look: passing through **provider-executed tool results** (search sources,
  citations) as a `source` event, since they arrive on the wire regardless.
- **Batch APIs, audio (TTS/STT), image/video generation, Live/WebSocket
  sessions.** Different contracts with async job or socket lifecycles. If ever,
  separate optional packages — not `AIHandler` methods.
- **OTel SDK, devtools UI, hosted tracing.** Sinks, not seams (M3 is the
  documentation half).

---

## 6. Things not to build, restated

For the record, so future reviews do not re-litigate them: the library should
remain **not** a router, prompt library, memory/RAG system, secrets vault, UI,
or full agent framework (`design.md:23-28`). Every P1 item above is a field, an
event, a quirk, or a profile row. E1 (Responses engine) is the one genuinely
large item and is admissible because it is *how a provider call is made*, not
what the app does with it.

---

## 7. Honesty and hygiene fixes found in passing

Cheap, and several are correctness issues in what the docs promise today.

1. **`docs/providers.md:173` shows `connect({ provider, baseUrl })`; no
   `connect()` export exists** (only `envConnection`, `src/connect.ts:34`).
2. **`design.md:26` promises a `route` stream event; it is not implemented**
   (`src/types.ts:184-196`). Either add it as a `context` kind or remove the
   promise.
3. **`docs/providers.md:122` names `REASONING_BUDGET_TOKENS` as a public
   constant; `src/util.ts` is not exported.** Moot if R2 removes budget tokens.
4. **`Idempotency-Key` on OpenAI is undocumented in the OpenAI spec** for
   `/chat/completions` and `/responses` (§4.1). The 0.6.0 changelog and
   `docs/reliability.md` claim double-billing mitigation; either find
   documentation or soften the claim to "sent, effect unverified".
5. **Anthropic `budget_tokens` will 400 on current models** (§4.2). This is a
   live bug in 0.7.0's `reasoningEffort` mapping, not just a hygiene item.
6. **Perplexity profile breaks 2026-09-27** (§4.5). Mark it and decide whether
   to demote or re-point.
7. **`ChatResult.raw` appears never to be populated on chat** (the
   `openaiChat` result builder at `openaiChat.ts:266` sets no `raw`; embed
   does). Confirm, then either populate it (redacted) or document that it is
   embed-only.
8. **Redactor minimum of 6 characters** (`src/redact.ts:55,73`) is backstopped
   by Studio (#793). Document it in `docs/security.md` or lower it with a
   false-positive note.
9. **`parseArgs` returns `{}` on unparsable tool arguments** (`base.ts:80-89`)
   — still open from the 0.4.0 audit (#10). A `tool_error` with the raw string
   is the honest result.
10. **Studio is on `^0.6.0`.** Publishing 0.7.0 (if not yet on the registry)
    and bumping Studio removes its duplicated `reasoningFilter.ts` and the
    `reasoningEffort` double-send.
11. **Ollama cloud models**: `auth: 'none'` on the `ollama` profile means
    `https://ollama.com` cannot be used; `keyOptional` + `bearer` is the fix.
12. `state-of-the-nugget.md` is dated 2026-08-10 and predates 0.7.0; refresh
    alongside the next release.

---

## 8. Suggested sequencing

**0.8.0 — additive, no new engine (P1 set + hygiene).** U1, U2, C1, C2, R1,
R2, A1, A2, and §7 items 1–9. Every item is a new optional field, event, quirk,
or profile row; the only behavior changes are R2 (fixes a live 400) and the
truncation notice default in A2. Studio can then drop its own agent loop's
remaining justifications, and JX Runtime interop stops retrying 507s.

**0.9.0 — Responses engine and structured output (E1, S1, S2, T1, P1, A3).**
Contract-test E1 against Ollama's `/v1/responses` in CI (no key), then live
against OpenAI and OpenRouter. P1 and U1 together make the `pricing` hook
correct for cached calls.

**1.0.0 — seams and packaging (H1, H2, K1, M1–M5, F1, A4, A5).** Wider
seams (`fetch` override, `wrapEngine`, testing subpath) are the last things to
add before freezing the contract, because each one is a promise about
extension points.

Estimated effort (author's judgement, not measured): 0.8.0 is on the order of
the 0.6.0 backlog closure; 0.9.0 is dominated by E1, which is roughly one
engine's worth of adapter plus tests (compare `openaiChat.ts` at ~300 lines).

---

## Appendix A — Sources

**Sibling repositories (read directly):**
AI Server Studio `app/backend/src/{aiNugget.ts, aiNuggetLoader.ts,
services/agentLoop.ts, services/agentTools.ts, services/providerError.ts,
services/modelTraffic.ts, services/modelCapabilities.ts, cloud/pricing.ts,
cloud/usage.ts, cloud/dispatchGuard.ts, runtime/*, embedding/*}`,
`development-docs/architecture/models-and-runtimes.md`, `guides/sse-events.md`,
`docs/archive/changelog/CHANGELOG-2026-0{7,8,9}.md`.
JX Runtime `src/{safeFetch.js, errors.js, ratelimit.js, requestId.js,
pairing.js, tls.js, scheduler.js, auth.js, app.js, routes.js,
api/inference.js, api/management/health.js}`, `docs/{compatibility.md,
ollama-compatibility.md, version-compatibility.md, roadmap.md,
ai-server-studio-compatibility-plan.md}`.

**Provider documentation:**
OpenAI OpenAPI spec — https://github.com/openai/openai-openapi [spec];
OpenAI Responses migration — https://developers.openai.com/api/docs/guides/migrate-to-responses [summary];
OpenAI prompt caching — https://developers.openai.com/api/docs/guides/prompt-caching [summary];
Anthropic API release notes — https://platform.claude.com/docs/en/release-notes/api [notes];
Anthropic prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching;
Anthropic MCP connector — https://platform.claude.com/docs/en/agents-and-tools/mcp-connector;
Anthropic rate limits — https://platform.claude.com/docs/en/api/rate-limits;
Gemini Interactions — https://ai.google.dev/gemini-api/docs/interactions-overview [summary];
Gemini changelog — https://ai.google.dev/gemini-api/docs/changelog [summary];
Gemini tool combination — https://ai.google.dev/gemini-api/docs/tool-combination [summary];
Ollama API — https://github.com/ollama/ollama/blob/main/docs/api.md [repo];
Ollama OpenAI compat — https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx [repo];
Ollama structured outputs — https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx [repo];
Ollama cloud — https://github.com/ollama/ollama/blob/main/docs/cloud.mdx [repo];
Open Responses — https://www.openresponses.org/specification;
OpenRouter reasoning — https://openrouter.ai/docs/guides/best-practices/reasoning-tokens [summary];
OpenRouter usage accounting — https://openrouter.ai/docs/cookbook/administration/usage-accounting [summary];
DeepSeek thinking mode — https://api-docs.deepseek.com/guides/thinking_mode/;
Kimi K2.6 — https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart;
Groq reasoning — https://console.groq.com/docs/reasoning;
Cerebras reasoning — https://inference-docs.cerebras.ai/capabilities/reasoning;
Perplexity changelog — https://docs.perplexity.ai/docs/resources/changelog;
Azure API lifecycle — https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle;
MCP changelog — https://modelcontextprotocol.io/specification/2026-07-28/changelog;
OpenTelemetry GenAI — https://opentelemetry.io/blog/2026/genai-observability/;
Reasoning field drift trail — https://github.com/danny-avila/LibreChat/issues/12775.

**Comparable projects:**
Vercel AI SDK docs (middleware, tools, structured data, settings, telemetry,
testing, MCP, batch, 7.0 migration) — https://github.com/vercel/ai/tree/main/content/docs/03-ai-sdk-core;
Token.js — https://github.com/token-js/token.js;
LiteLLM — https://github.com/BerriAI/litellm;
OpenRouter SDK — https://github.com/OpenRouterTeam/typescript-sdk and https://github.com/OpenRouterTeam/typescript-agent;
Portkey gateway — https://github.com/portkey-ai/gateway;
llm.js — https://github.com/themaximalist/llm.js;
llm-sdk — https://github.com/hoangvvo/llm-sdk;
multi-llm-ts — https://github.com/nbonamy/multi-llm-ts;
any-llm — https://github.com/mozilla-ai/any-llm;
aisuite — https://github.com/andrewyng/aisuite;
Mastra models — https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/models/index.mdx;
OpenAI Agents JS — https://github.com/openai/openai-agents-js;
Anthropic SDK helpers — https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md;
LangChain.js docs — https://github.com/langchain-ai/docs/tree/main/src/oss/langchain;
Genkit — https://github.com/genkit-ai/docsite;
Pydantic AI — https://github.com/pydantic/pydantic-ai/tree/main/docs;
BAML — https://github.com/BoundaryML/baml;
Instructor-js — https://github.com/567-labs/instructor-js;
ollama-js — https://github.com/ollama/ollama-js;
Helicone AI Gateway — https://github.com/Helicone/ai-gateway;
Cloudflare AI Gateway docs — https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/docs/ai-gateway;
Braintrust proxy (deprecated) — https://github.com/braintrustdata/braintrust-proxy.

## Appendix B — Verification notes

- Repository claims were checked by reading the cited files at the stated
  revisions; line numbers are as of 2026-09-12.
- Several documentation hosts (`developers.openai.com`, `ai.google.dev`,
  `openrouter.ai`, `docs.ollama.com`, `vercel.com`, `ai-sdk.dev`) were
  unreachable from this session's egress proxy. Where possible the same content
  was read from the vendor's GitHub source (OpenAI OpenAPI YAML, Ollama docs,
  Vercel AI SDK docs). Items marked **[summary]** rest on search-result
  summaries only and should be re-confirmed before implementation.
- Not verified: whether any current OpenAI model is Responses-only; Gemini
  Interactions field-level shape; Together AI Responses support; exact
  reasoning field names for Cohere, NIM, SambaNova, Nebius, Novita, Baseten.
- No code was changed and no tests were run for this report.
