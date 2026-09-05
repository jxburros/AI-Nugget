# Upgrading

## 0.6.x → 0.7.0

**Backward-compatible for ordinary consumers.** Two additive changes and one
default-behaviour change worth knowing about:

- **Inline reasoning is stripped by default.** A model that writes
  `<think>…</think>` (or `<thinking>`, `<reasoning>`, `<|begin_of_thought|>`)
  into its answer no longer has that text in `delta` events or
  `ChatResult.text`; it arrives as `{ type: 'reasoning', text }` events, the
  same channel a provider-native thinking field already used. If your app
  parsed or displayed those tags itself, either delete that code or pass
  `new AIHandler({ stripInlineReasoning: false })` to keep the raw text.

- **`ChatRequest.reasoningEffort`** (and `AgentOptions.reasoningEffort`) — a
  new optional field. Nothing is sent to any provider unless you set it. If you
  already pass `reasoning_effort` / `thinking` / `thinkingConfig` / `think`
  through `providerOptions`, that keeps winning on collision.
- **A new `context` stream event, `reasoning_effort_disabled_for_tools`** — the
  `openaiChat` engine emits it when it retried a tool-using request with
  `reasoning_effort: 'none'` after OpenAI refused the first attempt. Ignoring
  it keeps the old behaviour minus the 400. If you *want* the hard failure
  instead (to route to `/v1/responses` yourself), set `reasoningEffort: 'none'`
  explicitly on tool-using turns — then no retry happens and any 400 is yours.

## 0.5.x → 0.6.0

Behavior-compatible for ordinary consumers, with **two things worth checking**.

### 1. `not_found` is a new `AIErrorKind`

404 and 410 responses now classify as `not_found` instead of
`invalid_request`, so a wrong `baseUrl`/model or a misrouted edge is
distinguishable from a malformed request body. It is non-retryable by default.

- **If you `switch` exhaustively over `AIErrorKind`** (with a `never` default),
  TypeScript will require a new branch. Map it like `auth`/`key_unavailable` —
  it's a *server-side configuration* problem, not the caller's fault:

  ```ts
  case 'not_found': return { status: 502, message: 'The AI service is not configured correctly.' };
  ```

- **If you switch non-exhaustively** with a fallback, nothing breaks: a 404 that
  used to produce "that request was invalid" now falls into your default branch
  instead. That is the intended improvement, but check the resulting message
  still reads correctly.

### 2. A startup notice when no policy is configured

`new AIHandler({ keySource })` with no `policy` now logs one line at
construction: every provider and model is allowed. `allowAllPolicy()` is still
the default — nothing is blocked. To silence it, say what you mean:

```ts
new AIHandler({ keySource, policy: allowAllPolicy() });        // deliberate, no warning
new AIHandler({ keySource, silencePolicyWarning: true });      // same, if you prefer
```

### Also new, no action required

- **`Connection.provider` is now typed** `KnownProvider | (string & {})`. You get
  autocomplete and typo-catching; arbitrary strings still compile and still
  resolve through `openai-compat`.
- **`beforeCall` hooks get a scrubbed connection.** `info.connection.keyRef` is
  masked for literal refs, and `info.resolved.headers` masks auth headers. If a
  hook was reading `info.connection.keyRef.value` to get the key — don't; resolve
  it through your `KeySource` instead.
- **`Idempotency-Key` on OpenAI requests.** One key per logical call, reused
  across retries. A header you set yourself on `Connection.headers` wins.
- **New `context` stream events**: `json_mode_downgraded` (Google/Anthropic drop
  JSON mode when tools are present) and `stream_anomaly` on all four engines
  (previously `openaiChat` only). Both are informational; ignoring them keeps
  the old behavior.
- **Documentation moved.** `README.md` is now a front door; reference material
  lives under `docs/` (`providers`, `reliability`, `security`, `agent-loop`,
  `recipes`, `integrations`, `distribution`). Deep links into the old README
  anchors will need updating.

## 0.4.x → 0.5.0

**0.5.0 is backward-compatible.** Every change below is additive — new optional
fields, new methods, new exports, and a new `require` entry point. No existing
signature changed and no default behavior changed, so an app on 0.4.x can bump
without code edits and adopt the new capabilities as needed.

The numbers in brackets are the suggestion numbers from the AI Server Studio
production friction report (`docs/reviews/2026-08-09-ai-server-studio-friction-report.md`),
so you can trace each change back to the friction it resolves.

### Packaging

- **[1] Dual ESM + CommonJS build.** The package now exposes a `require`
  condition (`dist/cjs/`) in addition to ESM. CommonJS hosts can
  `const { AIHandler } = require('@jxburros/ai-nugget')` with no dynamic-import
  shim. ESM consumers are unaffected.
- **[2] Vendorable compiled output.** `npm run build:nugget` now emits both
  `nugget/src` (TypeScript) and `nugget/dist` (compiled ESM `.js` + `.d.ts`), so
  bundlers that can't resolve `.ts` via `.js`-suffixed imports (e.g. Turbopack)
  can vendor `nugget/dist`.

### Requests & providers

- **[4] `ChatRequest.providerOptions`.** A provider-native passthrough merged
  into the outgoing request body (shallow top-level; one level deep into Ollama
  `options` and Google `generationConfig`). Reach fields the nugget doesn't
  model — Ollama `num_ctx`/`keep_alive`, OpenAI `reasoning_effort`, Anthropic
  `thinking`, Google `safetySettings` — without waiting for a release.
- **[16] `Connection.idleTimeoutMs`.** An idle timeout for streams, distinct from
  the total `timeoutMs`: it aborts only when no chunk arrives for that long, and
  resets on every chunk — so a slow-but-healthy long local generation isn't
  killed mid-stream.
- **[17] `reasoning` stream events.** Reasoning/thinking tokens (Anthropic
  `thinking_delta`, OpenAI `reasoning_content`, Gemini `thought` parts, Ollama
  `thinking`) surface as `{ type: 'reasoning', text }` instead of being dropped
  or blended into `delta`.
- **[18] `listModels()` for Anthropic & Google.** Both now query the real
  endpoints (`/v1/models`, `/v1beta/models`) instead of returning `[]`.
- **[19] Faster Ollama discovery.** `/api/show` probes run with bounded
  concurrency instead of serially.
- **[20] New provider profiles + Azure api-version override.** Added `cerebras`,
  `moonshot`, `cohere`, and `perplexity`. The Azure `api-version` is now
  overridable per call via `providerOptions.apiVersion` (default unchanged).
- **[21] Safer URL joining** in the `openai-compat` engine (no accidental double
  slash even if `baseUrl` ends in `/`).
- **[23] Embeddings.** `AIHandler.embed(conn, req)` plus `EmbedRequest` /
  `EmbedResult`, implemented for Ollama (`/api/embed`) and OpenAI-compatible
  providers (`/embeddings`) — through the same policy/key/telemetry pipeline as
  chat. Providers without embeddings throw a typed `invalid_request` error.

### Structured output & typed results

- **[15] `AIHandler.chatParsed(conn, req, schema)`.** Requests JSON, extracts it,
  and validates against any [Standard Schema](https://standardschema.dev)
  validator (Zod / Valibot / ArkType) — with one automatic corrective retry on a
  validation miss. No schema library is bundled; you pass your own.

### Agent loop (`@jxburros/ai-nugget/agent`)

- **[5] Option passthrough.** `AgentOptions` now forwards `temperature`,
  `maxTokens`, `topP`, `stopSequences`, and `providerOptions` to every turn.
- **[6] Capability-aware `toolMode`.** `AgentOptions.modelCapabilities` — when
  `toolMode: 'auto'`, a model advertising `"tools"` uses native tool-calling even
  on a local runtime whose profile default is `promptJson`.
- **[7] No leaked directives + `tool_mode` event.** In `promptJson` mode, tool
  directives are withheld from the visible `delta` stream, and a `tool_mode`
  event discloses the resolved protocol.
- **[8] Parameter schemas in the `promptJson` prompt**, so the model isn't
  guessing argument shape.
- **[9] `undefined` tool results no longer crash a run.**
- **[10] `AgentResult.error`** is populated when `stopReason === 'error'`.
- **[11] Structured tool errors.** A tool returning `{ ok: false, ... }` is
  surfaced with `isError: true` so the model can recover in-turn.
- **[12] `AgentOptions.toolResult`.** Opt-in `maxChars` cap and `wrapUntrusted`
  framing for tool results re-entering context.
- **[14] `AgentOptions.approvalMode: 'all'`.** Gate every tool (not just
  `sideEffects` ones) so `tool_denied` is reachable without per-tool flags.

### Handler, telemetry & security

- **[3] `AIHandler.prewarm(conn)`.** A no-throw warm-up (health probe) to move
  cold DNS/TLS/daemon-spin-up cost off the first real call.
- **[22] `CallInfo.resolved`.** The `beforeCall` hook now receives the resolved
  connection (base URL + headers, key omitted) so it can validate the effective
  endpoint — e.g. a request-time SSRF re-check — without hijacking `keySource`.
- **[24] `HandlerOptions.pricing`.** An optional cost estimator whose result is
  recorded on `CallRecord.costUsd`.

### Tooling & hygiene

- **[25]** Assistant messages with both content parts and tool calls no longer
  drop their text/image parts on replay (Anthropic & Google); dead `role:'tool'`
  branches removed; the `403 → non-retryable` policy is documented; ESLint and
  Vitest coverage are wired up (`npm run lint`, `npm run test:coverage`).

### Not changed (deliberately)

- No provider policy ships as a library default (blocklists/allowlists remain the
  app's configuration at the seam).
- Zero runtime dependencies — everything above is implemented with the isomorphic
  core (`fetch`/`ReadableStream`/`AbortController`/`TextDecoder`) only.
