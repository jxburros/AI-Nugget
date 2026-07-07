# AI Nugget — Reusable AI Model Handler Nugget: Design

**Status:** Design (v1). Companion to `docs/archive/report.md` (evidence base) and `docs/archive/development-plan.md` (build/adoption phases).

**Revision note (v1):** Per maintainer direction: (a) no shipped Grok/xAI blocklist — the governance seam is neutral and empty by default, and Grok is simply never an officially supported provider; (b) provider coverage widened via a protocol-engine + provider-profile architecture (OpenRouter, llama.cpp, LM Studio, Groq, vLLM, DeepSeek, Mistral, Together, Fireworks, Azure OpenAI as named providers); (c) an agent layer (`@jxburros/ai-nugget/agent`) is now in scope — native tool-calling in the core plus a composable agent loop with approval gates.

**Working name:** `AI Nugget`. One small, zero-dependency, isomorphic TypeScript library that owns "talk to an AI model" — and the primitive for building agentic behavior on top of it — for the whole portfolio: AI-model-test, AI-Server-Studio, Blobsmith, locus-os, and any future project.

---

## 1. Design goals and non-goals

### Goals

1. **One implementation of each provider protocol.** Wire protocols (OpenAI-compatible chat, Anthropic messages, Gemini generateContent, Ollama native) each exist exactly once as a *protocol engine*; the long tail of providers are thin, data-driven *profiles* on top (see §6). Today the OpenAI-compatible protocol alone is implemented three separate times across the portfolio (report §5).
2. **Message-based, streaming-first, tool-capable.** `messages[]` with roles, image parts, and tool calls; every adapter can stream; non-streaming providers are normalized into the same event stream (the AI-Server-Studio pattern: buffered result → single `delta` → `done`).
3. **Isomorphic and dependency-free.** Runs identically in Node ≥ 20, browser main thread, and Web Workers, using only `fetch`, `ReadableStream`, `AbortController`, and `TextDecoder`. No SDKs (Blobsmith drops `@google/genai` for a raw-fetch Gemini adapter). No Node built-ins in the core.
4. **Policy inside the pipeline, not beside it.** Governance, redaction, telemetry, and approval hooks run on *every* call path by construction — the lesson from Blobsmith's worker-only governance and AI-Server-Studio's unwired routing rules. The pipeline ships **neutral**: the policy seam is where an app *can* enforce rules, not a place the library imposes its own.
5. **Agentic behavior as a primitive, not a framework.** The nugget ships the *mechanics* every agent needs — tool schemas, the model↔tool loop, step/budget limits, approval gates, streamed agent events — so each app can build full or custom agents without reinventing the loop. What the agent *does* (its tools, prompts, memory, UI) stays app-side.
6. **Honest failure.** Typed, classified errors; failures always reach the telemetry sink (AI-model-test's "errors get a row too" contract); deterministic fallbacks are the caller's job but the handler must never mask a failure as success (locus-os's "no pretend runtime" principle).
7. **Vendorable.** Small enough to copy into a repo as a generated folder (`nugget` distribution) for projects that can't take a package dependency.

### Non-goals

- **Not a full agent framework.** The agent layer provides the loop, tools, budgets, and approval seams — it does **not** provide planning strategies, memory/RAG stores, multi-agent orchestration, or prompt libraries. (AI-Server-Studio's enrichment pipeline and Blobsmith's prompts stay in their apps and feed the loop.)
- **Not a router/recommender.** Model *selection* stays app-side (AI-model-test's benchmark-informed `recommendModel`, AI-Server-Studio's load-aware `pickAutoModel`, locus-os routing rules). The handler exposes a `route` event so apps can report what they chose; it doesn't choose.
- **Not a secrets vault.** It defines the `KeySource` seam; vault implementations (locus-os Secrets Core, AI-Server-Studio AES-GCM table, env vars) live outside.
- **Not a UI.** It emits a normalized event stream; screens stay per-app.

### Provider support policy

- Officially supported providers are those with a shipped engine or profile **and** contract-test coverage (§6).
- **Grok/xAI is not blocked, and will never be officially integrated.** No profile, no fixtures, no docs beyond this line. Anyone determined can point the generic `openai-compat` profile at any endpoint — that's their configuration, not our support surface.
- New providers earn a profile when a portfolio repo needs them or the profile is trivial (OpenAI-compatible with known defaults). Profiles are cheap by design; the bar is deliberately low — *except* where this policy says otherwise.

---

## 2. Package shape

```
ai-nugget/
├── src/
│   ├── types.ts          # All public types (below)
│   ├── errors.ts         # AIError + classify()
│   ├── transport.ts      # withTimeout, fetchJson, sseLines, ndjsonLines
│   ├── json.ts           # extractJson, schema guards (from Blobsmith, + array support)
│   ├── tokens.ts         # estimateTokens fallback, usage normalization
│   ├── handler.ts        # AIHandler: pipeline, retry, queue, hooks
│   ├── adapters/
│   │   ├── engines/
│   │   │   ├── openaiChat.ts     # the OpenAI-compatible chat protocol (SSE, tools, JSON mode)
│   │   │   ├── anthropic.ts      # /v1/messages (SSE, tool_use, forced-tool JSON mode)
│   │   │   ├── google.ts         # Gemini generateContent / streamGenerateContent (raw fetch)
│   │   │   └── ollama.ts         # native /api/chat NDJSON (+ /api/tags, /api/show)
│   │   ├── profiles.ts           # provider profile table (defaults, auth, quirks) — §6
│   │   └── index.ts              # adapterFor(provider) — THE one factory
│   ├── agent/
│   │   ├── tools.ts      # ToolSpec, defineTool, arg validation against JSON schema
│   │   ├── loop.ts       # runAgent(): the model↔tool loop, budgets, approval gates
│   │   └── index.ts      # subpath export: @jxburros/ai-nugget/agent
│   ├── keys.ts           # KeySource implementations: env, literal, memory; ref parsing
│   ├── redact.ts         # default secret patterns (locus-os's 14) + Redactor seam
│   └── index.ts
├── tests/                # contract tests: one fixture set shared by all engines/profiles
└── package.json          # "type": "module", zero runtime deps
```

Distribution: a private npm package (GitHub Packages) **plus** a generated single-folder `nugget/` build for vendoring. Target ~2500–4000 lines total (the agent layer and profile table buy the increase over v0's budget). If it grows past that, it's doing too much.

---

## 3. Core types

The shapes below are the contract; everything else is implementation detail.

```ts
// ---------- requests ----------
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ContentPart {
  type: 'text' | 'image';
  text?: string;
  imageBase64?: string;   // Ollama images[], Anthropic/Gemini/OpenAI image parts
  mimeType?: string;
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  // assistant messages may carry tool calls; tool messages answer them
  toolCalls?: ToolCall[];        // role: 'assistant'
  toolCallId?: string;           // role: 'tool'
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;            // parsed JSON args (raw string kept in .raw)
  raw?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: object;            // JSON Schema for the arguments
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];        // system messages allowed; engines relocate
                                  // them per provider (field vs. role) — the
                                  // detail Blobsmith already handles correctly
  temperature?: number;
  maxTokens?: number;             // REQUIRED default injected for Anthropic
  topP?: number;
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: object };
  tools?: ToolSchema[];           // native tool-calling where the provider/model
  toolChoice?: 'auto' | 'none' | { name: string };   // supports it; see §7 fallback
  stopSequences?: string[];
  signal?: AbortSignal;           // external cancellation (merged with timeout)
  metadata?: Record<string, unknown>;  // flows into telemetry untouched
}

// ---------- connection (unifies Blobsmith AIConnection + AI-model-test ModelConfig) ----------
export interface Connection {
  id: string;
  provider: string;               // any key of the profile table (§6), e.g. 'openai',
                                  // 'anthropic', 'google', 'ollama', 'openrouter',
                                  // 'llamacpp', 'lmstudio', 'groq', 'vllm', 'deepseek',
                                  // 'mistral', 'together', 'fireworks', 'azure-openai',
                                  // or the escape hatch 'openai-compat'
  baseUrl?: string;               // profile default when omitted
  keyRef?: KeyRef;                // never a raw key on this object
  timeoutMs?: number;             // default 120_000
  headers?: Record<string, string>;  // merged over profile headers (e.g. OpenRouter attribution)
}

export type KeyRef =
  | { kind: 'none' }
  | { kind: 'env'; name: string }            // Node: process.env / injected env map
  | { kind: 'literal'; value: string }       // discouraged; redacted in telemetry
  | { kind: 'stored'; ref: string }          // app storage (localStorage, DB) via KeySource
  | { kind: 'brokered'; ref: string };       // locus-os style secret:// reference

export interface KeySource {
  resolve(ref: KeyRef): Promise<
    | { ok: true; apiKey: string | null }    // null = no key needed (local endpoints)
    | { ok: false; reason: 'missing' | 'locked' | 'denied' }
  >;
}

// ---------- results ----------
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  estimated: boolean;             // true when ceil(len/4), false when provider-reported
}

export interface ChatResult {
  text: string;
  toolCalls?: ToolCall[];         // present when finishReason === 'tool'
  finishReason: 'stop' | 'length' | 'tool' | 'content_filter' | 'error' | 'canceled';
  usage: Usage;
  timing: { firstTokenMs: number | null; totalMs: number };
  model: string;
  source: ModelSource;            // provenance — always travels with the result
  raw?: unknown;                  // engine-scrubbed; never persisted by the handler
}

// ---------- model provenance ----------
// The same model can be served by different sources (llama-3.1-70b direct from a
// provider, via OpenRouter, via Together, or locally through Ollama/llama.cpp) and
// behave differently — quantization, sampling defaults, context handling, and
// middleware all vary by host. Model identity is therefore ALWAYS (source, model),
// never a bare model id.
export interface ModelSource {
  provider: string;               // profile key: 'openrouter', 'ollama', …
  connectionId: string;           // distinguishes two connections to the same
                                  // provider kind (e.g. two Ollama hosts)
  baseUrl?: string;
}

export function modelRef(source: ModelSource, model: string): string;
// canonical display/storage key: '<provider>/<model>', e.g.
// 'openrouter/meta-llama/llama-3.1-70b-instruct' vs 'ollama/llama3.1:70b' —
// the same weights, two distinct entries, comparable but never conflated.

// ---------- the normalized event stream (AI-Server-Studio's contract, generalized) ----------
export type StreamEvent =
  | { type: 'start'; callId: string; provider: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }              // emitted once per fully-parsed call
  | { type: 'context'; kind: string; data: unknown }   // app-extensible: rag_context,
                                                       // memory_context, route, …
  | { type: 'retry'; attempt: number; reason: AIErrorKind; delayMs: number }
  | { type: 'done'; result: ChatResult }
  | { type: 'error'; error: AIError };

// ---------- errors (replaces string-matching classification everywhere) ----------
export type AIErrorKind =
  | 'auth' | 'rate_limit' | 'timeout' | 'network' | 'server'
  | 'invalid_request' | 'invalid_response' | 'context_length'
  | 'canceled' | 'policy_blocked' | 'key_unavailable'
  | 'tool_error' | 'budget_exceeded';                  // agent layer (§8)

export class AIError extends Error {
  kind: AIErrorKind;
  status?: number;                // HTTP status when applicable
  retryable: boolean;             // rate_limit, timeout, network, server → true
  provider?: string;
  raw?: string;                   // first 200 chars of body, pre-redacted
}

// ---------- the adapter seam ----------
export interface ProviderAdapter {
  readonly provider: string;
  chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
  stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
  listModels?(conn: ResolvedConnection): Promise<ModelInfo[]>;
  health?(conn: ResolvedConnection): Promise<{ ok: boolean; detail?: string }>;
}

export interface ModelInfo {
  id: string;
  source: ModelSource;            // which connection listed it — models discovered
                                  // from different sources are distinct entries
  contextWindow?: number;
  capabilities?: string[];        // populated where discoverable (Ollama /api/show,
}                                 // OpenRouter model metadata)
```

Notes on deliberate choices:

- **`AsyncIterable<StreamEvent>`, not callbacks.** It works in Node route handlers (`for await` → write SSE frames), React (`for await` → setState), and workers (`for await` → postMessage). AI-Server-Studio's SSE emitter and Blobsmith's worker client both become thin transcriptions of this iterable.
- **`usage.estimated` is explicit.** Blobsmith's `len/4` guess and AI-model-test's provider-reported counts stop being indistinguishable in stored data.
- **Provenance is unforgettable by construction.** `ChatResult.source`, `ModelInfo.source`, and the `provider`/`connectionId` fields on every `CallRecord` mean no result, listing, or telemetry row can exist without knowing where it came from. Apps that store results app-side get `modelRef()` as the canonical `(source, model)` key. This exists because the same model behaves differently per host — and conversely a single source tends to behave *consistently* across its models, so both groupings (same model across sources, same source across models) must be recoverable from stored data.
- **Tool-calling is v1 core** (revised from v0, where it was deferred). The agent layer requires it, and implementing Anthropic JSON mode via forced tool-use means the tool plumbing exists anyway. Engines map one `ToolSchema` shape to each provider's native format: OpenAI `tools`/`tool_calls`, Anthropic `tool_use` blocks, Gemini `functionDeclarations`, Ollama `tools`. Streaming engines accumulate partial tool-call deltas internally and emit one `tool_call` event per completed call — apps never see half-parsed JSON arguments.

---

## 4. The pipeline (`AIHandler`)

The handler is the only public entry point apps use day-to-day. It composes the seams around the adapter:

```ts
export interface HandlerOptions {
  keySource: KeySource;
  policy?: GovernancePolicy;      // model/request checks — enforced on EVERY path
  redactor?: Redactor;            // applied to telemetry, errors, and raw bodies
  telemetry?: TelemetrySink;      // receives one CallRecord per call, incl. failures
  hooks?: {
    beforeCall?(info: CallInfo): Promise<void | 'deny'>;  // locus-os broker wrap point
    afterCall?(record: CallRecord): Promise<void>;
  };
  retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number }; // default 3 / 250 / 30_000, jittered; retries only when error.retryable
  limits?: { maxConcurrent?: number; minIntervalMs?: number };  // Blobsmith worker queue, generalized
}

export class AIHandler {
  constructor(opts: HandlerOptions);
  chat(conn: Connection, req: ChatRequest): Promise<ChatResult>;
  stream(conn: Connection, req: ChatRequest): AsyncIterable<StreamEvent>;
  listModels(conn: Connection): Promise<ModelInfo[]>;
  testConnection(conn: Connection): Promise<{ ok: boolean; message: string }>;
}
```

**Fixed pipeline order** (every call, both `chat` and `stream`):

```
1. policy.checkModel(provider, model)        → AIError('policy_blocked') if denied
2. keySource.resolve(conn.keyRef)            → AIError('key_unavailable') if missing/locked/denied
3. hooks.beforeCall(info)                    → deny short-circuits (approval seam)
4. acquire concurrency slot (limits)
5. attempt loop:
     adapter.chat/stream with withTimeout(conn.timeoutMs, req.signal)
     on retryable AIError: emit {type:'retry'}, jittered backoff
       (rate_limit honors Retry-After when present, else exp backoff — AI-model-test's rateLimitBackoffMs, plus jitter)
6. build CallRecord (success OR failure), pass through redactor
7. telemetry.record(record); hooks.afterCall(record)
```

`listModels()` and `testConnection()` run through the same key, policy,
`beforeCall`, concurrency, redaction, telemetry, and `afterCall` seams using
operation IDs (`__listModels__`, `__testConnection__`) in the `model` field.
Apps using `allowlistPolicy` can permit those deliberately with a `'*'` prefix
for the provider.

```ts
export interface GovernancePolicy {
  checkModel(provider: string, model: string):
    { allowed: true } | { allowed: false; reason: string };
}
// Ships NEUTRAL: no default block patterns. The library provides constructors —
//   blocklistPolicy(patterns: RegExp[]), allowlistPolicy(prefixesByProvider) —
// but which models an app refuses is app policy, configured at the seam.
// (Blobsmith's per-provider prefix allowlist becomes one line of config;
// any repo that wants to keep a blocklist keeps it as ITS config, not ours.)

export interface Redactor { redact(text: string): string }
// Shipped default: locus-os's 14 SECRET_PATTERNS + any literal keys the KeySource
// has resolved this session (vault-aware substring redaction, generalized).

export interface TelemetrySink { record(r: CallRecord): void | Promise<void> }
export interface CallRecord {
  callId: string; connectionId: string; provider: string; model: string;
  startedAt: number; timing: ChatResult['timing'];
  usage: Usage; finishReason: ChatResult['finishReason'];
  error?: { kind: AIErrorKind; status?: number; message: string };  // pre-redacted
  attempts: number;
  metadata?: Record<string, unknown>;   // ChatRequest.metadata passthrough
  promptChars: number; responseChars: number;   // sizes, never content —
}                                               // content storage is the app's decision
```

**Why the telemetry record carries sizes, not content:** AI-model-test *wants* full prompt/response text in `model_responses` (it's the product); AI-Server-Studio and Blobsmith must *not* log response bodies (CLAUDE.md rules). So the handler reports metadata and lets each app persist content from the `ChatResult` it already holds. Errors always produce a record — the traceability contract survives.

---

## 5. Transport primitives (`transport.ts`)

Directly lifted, with attribution in comments, from AI-model-test:

```ts
// Merge a timeout with an optional external signal; guaranteed cleanup.
export function withTimeout(ms: number, external?: AbortSignal):
  { signal: AbortSignal; done(): void; timedOut(): boolean };

// POST JSON, classified errors, tolerant parse. Body excerpt pre-redacted.
export async function fetchJson(url: string, init: RequestInit & { timeoutMs: number }):
  Promise<{ data: unknown; status: number; totalMs: number }>;

// Async iterables over the two wire formats in use across the portfolio.
export async function* sseLines(res: Response): AsyncIterable<string>;    // strips "data:", skips [DONE]
export async function* ndjsonLines(res: Response): AsyncIterable<unknown>; // buffered partial-line handling
```

Behavioral requirements carried over:

- First-token latency is captured by the engine at the first delta that yields visible text (AI-model-test `postStream`).
- If a server ignores `stream: true` and returns a buffered body, the engine must still succeed (AI-model-test's fallback; also covers Ollama endpoints proxied through openai-compat gateways).
- A stream ending without a terminal sentinel is a `done` with whatever accumulated, plus a `context` event noting the anomaly — not a hang, not a hard error (AI-Server-Studio's tolerance, made explicit).

---

## 6. Adapters — engines and provider profiles

**The architecture that makes "as many adapters as we can" cheap:** four *protocol engines* own wire formats; a data-driven *profile table* turns each named provider into defaults + quirks on top of an engine. Adding an OpenAI-compatible provider is a table row plus fixtures — not another copy of the SSE loop (which is how the portfolio ended up with three).

### Protocol engines

| Engine | Wire format | Streaming | Tools | JSON mode |
|---|---|---|---|---|
| `openaiChat` | `{base}/chat/completions` | SSE + `stream_options.include_usage` | `tools` / `tool_calls` deltas | `response_format: {type:'json_object'}` |
| `anthropic` | `{base}/v1/messages` | SSE (`content_block_delta`) — **new; no repo has it today** | `tool_use` blocks | **forced-tool pattern** — fixes the portfolio-wide "Anthropic has no JSON mode" gap |
| `google` | `{base}/v1beta/models/{m}:generateContent` / `:streamGenerateContent?alt=sse` | SSE — new | `functionDeclarations` | `generationConfig.responseMimeType` |
| `ollama` | `{base}/api/chat` | NDJSON | `tools` (model-dependent) | `format: 'json'` |

### Provider profiles (v1 shipped set)

```ts
interface ProviderProfile {
  engine: 'openaiChat' | 'anthropic' | 'google' | 'ollama';
  defaultBaseUrl: string;
  auth: 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'api-key-header' | 'none';
  defaultHeaders?: Record<string, string>;
  quirks?: {
    keyOptional?: boolean;        // local servers
    modelOptional?: boolean;      // llama.cpp serves one model
    urlTemplate?: string;         // azure-openai deployment paths
    supportsUsageInStream?: boolean;
    maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
    supportsJsonSchema?: boolean;
    maxTokensRequired?: boolean;  // anthropic
  };
  listModelsPath?: string;        // '/models', '/api/tags', '/v1/models'
  healthPath?: string;            // llama.cpp '/health', ComfyUI-style probes stay out
}
```

| Provider key | Engine | Default base URL | Auth | Notes / quirks |
|---|---|---|---|---|
| `openai` | openaiChat | `https://api.openai.com/v1` | bearer | reference profile; sends `max_completion_tokens`; supports JSON schema response format |
| `azure-openai` | openaiChat | (required) | `api-key` header | deployment URL template + `api-version` query; sends `max_completion_tokens`; supports JSON schema response format |
| `openrouter` | openaiChat | `https://openrouter.ai/api/v1` | bearer | attribution headers (`HTTP-Referer`, `X-Title`) from profile defaults, overridable via `conn.headers`; rich `/models` metadata → `ModelInfo.contextWindow`/`capabilities`; one key fronting hundreds of models makes this the **broadest-coverage cloud profile** — a first-class citizen, not an afterthought |
| `groq` | openaiChat | `https://api.groq.com/openai/v1` | bearer | |
| `deepseek` | openaiChat | `https://api.deepseek.com/v1` | bearer | |
| `mistral` | openaiChat | `https://api.mistral.ai/v1` | bearer | |
| `together` | openaiChat | `https://api.together.xyz/v1` | bearer | |
| `fireworks` | openaiChat | `https://api.fireworks.ai/inference/v1` | bearer | |
| `lmstudio` | openaiChat | `http://localhost:1234/v1` | none | keyOptional; `/v1/models` listing |
| `llamacpp` | openaiChat | `http://localhost:8080/v1` | none | keyOptional; **modelOptional** (server hosts one model); native `/health` endpoint for `health()`; llama-server's OpenAI-compat layer is the target (AI-model-test already probes this runtime — the profile makes it first-class) |
| `vllm` | openaiChat | `http://localhost:8000/v1` | none | keyOptional |
| `ollama` | ollama (native) | `http://localhost:11434` | none | native path kept for `images[]`, `keep_alive`, `options.num_ctx`; `listModels` = `/api/tags` + `/api/show` context-window probing (AI-Server-Studio's discovery). Ollama's `/v1` OpenAI-compat endpoint also works via the `openai-compat` escape hatch |
| `anthropic` | anthropic | `https://api.anthropic.com` | x-api-key | `anthropic-version` header; `maxTokens` required (default 4096, always overridable — ends the 1024/2048/4096 triplication). Browser callers may set `anthropic-dangerous-direct-browser-access` via `conn.headers` — the handler never sets it silently |
| `google` | google | `https://generativelanguage.googleapis.com` | x-goog-api-key | raw fetch; drops the `@google/genai` SDK dependency |
| `openai-compat` | openaiChat | (required) | bearer or none | the escape hatch: any unlisted OpenAI-compatible endpoint. Unsupported-but-unblocked providers (see §1 support policy) live here, on the user's own configuration |

`adapterFor(provider)` lives **once**, in `adapters/index.ts`, replacing AI-model-test's three copies and the scattered per-file dispatch elsewhere. Unknown provider keys with a `baseUrl` resolve to `openai-compat`.

**Model provenance across profiles:** wide provider coverage makes the same model reachable through several rows of this table — `llama-3.1-70b` via `openrouter`, `together`, `groq`, or a local `ollama`/`llamacpp`. These are **distinct model entries** (see `ModelSource`/`modelRef()` in §3): listings, results, and telemetry always carry their source, and nothing in the handler ever merges entries by bare model id. Hosts differ in quantization, sampling defaults, context handling, and middleware, so per-source results are the ground truth; any "same weights, different source" comparison is an app-level analysis over `modelRef` keys.

**Contract-test economics:** engines carry the heavy fixture suite (streaming, tools, errors, aborts). Profiles get a light per-profile suite (URL/auth/header construction, quirk behavior, model-listing parse) — so broad provider coverage doesn't multiply test burden.

---

## 7. Structured output (`json.ts`)

Blobsmith's ladder, promoted to the shared layer and extended:

```ts
export function extractJson(text: string): unknown | null;
// 1. direct JSON.parse
// 2. fenced ```json block
// 3. first-{ .. last-}  OR  first-[ .. last-]   ← array support added
export function extractJsonWithSchema<T>(text: string, parse: (v: unknown) => T): T;
// throws AIError('invalid_response') with the field-level message
```

Plus the typed field guards (`requireString`, `requireNumber`, `requireStringArray`, `requireOptionalString`) as exported helpers. When `responseFormat.type === 'json'`, the handler:

1. asks the engine for native JSON mode (all four engines have one after the Anthropic forced-tool implementation),
2. runs `extractJson` on the result anyway (defense in depth), and
3. surfaces a parse failure as a **retryable** `invalid_response` so the standard retry loop gets one more attempt before the app's fallback logic runs.

The same ladder doubles as the **tool-calling fallback**: when a model/provider lacks native tool support (common with small local models), the agent layer (§8) can run in `promptJson` mode — tools are described in the system prompt, the model answers in JSON, and `extractJson` + schema guards recover the call. Same `ToolSpec`, same events, degraded transport.

This directly upgrades AI-model-test's judge (regex parsing → schema-validated JSON) and closes Blobsmith's Anthropic gap.

---

## 8. The agent layer (`@jxburros/ai-nugget/agent`)

A separate subpath export built entirely on the public core — nothing in `handler.ts` knows agents exist. It packages the mechanics every portfolio agent currently hand-rolls or lacks: Blobsmith's ReAct loop (5-step, prompt-JSON, in-memory tool registry) is the existing prototype; locus-os's propose/approve broker is the governance model it must plug into.

### Tools

```ts
export interface ToolSpec<A = unknown, R = unknown> {
  name: string;
  description: string;
  parameters: object;                 // JSON Schema; args validated before execute
  sideEffects?: boolean;              // true → subject to the approval gate
  execute(args: A, ctx: ToolContext): Promise<R>;
}

export function defineTool<A, R>(spec: ToolSpec<A, R>): ToolSpec<A, R>;  // type helper

export interface ToolContext {
  signal: AbortSignal;                // aborting the agent aborts running tools
  callId: string; step: number;
  metadata?: Record<string, unknown>;
}
```

Argument validation runs against the JSON schema *before* `execute` — a malformed model call becomes a `tool_error` result fed back to the model (it gets a chance to correct itself), never an unvalidated invocation. This generalizes the portfolio doctrine "AI JSON must be validated before it mutates state."

### The loop

```ts
export interface AgentOptions {
  handler: AIHandler;
  connection: Connection;
  model: string;
  tools: ToolSpec[];
  messages: ChatMessage[];            // seed conversation (system prompt included here)
  toolMode?: 'native' | 'promptJson' | 'auto';   // auto: native if the profile/model
                                                 // supports it, else promptJson (§7)
  budget?: {
    maxSteps?: number;                // default 8
    maxTokens?: number;               // accumulated usage across all calls
    deadlineMs?: number;              // wall-clock, enforced via the shared AbortSignal
  };
  approval?: ApprovalGate;            // required if any tool has sideEffects
  onEvent?: (e: AgentEvent) => void;  // optional tap; the iterable is the primary API
  signal?: AbortSignal;
}

export type ApprovalGate = (req: {
  call: ToolCall; tool: ToolSpec; step: number;
}) => Promise<'allow' | 'deny' | { modifiedArguments: unknown }>;
// locus-os: this is where propose() lives — the gate can suspend for user approval.
// Blobsmith: a simple confirm dialog. Server contexts: policy tables.

export type AgentEvent =
  | StreamEvent                                      // model deltas pass straight through
  | { type: 'step_start'; step: number }
  | { type: 'tool_start'; step: number; call: ToolCall }
  | { type: 'tool_result'; step: number; call: ToolCall; result: unknown; isError: boolean }
  | { type: 'tool_denied'; step: number; call: ToolCall; reason: string }
  | { type: 'agent_done'; result: AgentResult };

export interface AgentResult {
  finalText: string;
  messages: ChatMessage[];            // full transcript incl. tool turns — resumable:
                                      // feed it back as the seed of a later run
  usage: Usage;                       // accumulated
  steps: number;
  stopReason: 'finished' | 'max_steps' | 'budget' | 'deadline' | 'canceled' | 'error';
}

export function runAgent(opts: AgentOptions): AsyncIterable<AgentEvent> & { result: Promise<AgentResult> };
```

**Loop mechanics** (one step = one model call, then zero or more tool executions):

```
while not done:
  1. handler.stream(connection, {messages, tools, …})   ← full pipeline applies per call:
        governance, keys, redaction, retry, telemetry — agents get it all for free
  2. finishReason 'stop'  → agent_done(finished)
     finishReason 'tool'  → for each toolCall:
        a. validate args against schema        → invalid: tool_error result to model
        b. sideEffects && approval gate        → deny: tool_denied result to model
        c. execute(args, ctx)                  → result (or caught error → tool_error)
        d. append role:'tool' message
  3. budget check (steps / accumulated tokens / deadline) → stop with the honest stopReason
```

Design rules carried over from the portfolio:

- **Honest termination.** Hitting a budget is a first-class `stopReason`, never dressed up as `finished` (locus-os's no-pretend principle). `budget_exceeded` is a typed error kind for callers that want to throw.
- **Deny is data, not an exception.** A denied tool call goes back to the model as a tool result saying so — the model can plan around it (matches locus-os, where a denial is an audited outcome, and the broker's refused proposals don't crash the assistant).
- **Every model call in the loop is a normal handler call** — it appears in telemetry with `metadata.agentStep`, obeys the app's governance, and redacts through the same choke point. There is no agent-specific bypass.
- **Resumability over memory.** `AgentResult.messages` is the complete transcript; persistent memory, summarization, and RAG stay app-side (AI-Server-Studio already has them; the loop just consumes `messages`).

### What each repo builds with it

- **Blobsmith:** replaces `runReActAgentLoop` — same three tools (`read_code_section`, `write_code_section`, `update_ui_state`) become `defineTool` specs; gains native tool-calling on capable models, schema-validated args, budgets, and cancellation.
- **locus-os:** the assistant's write path becomes tools whose `ApprovalGate` calls `broker.propose()` and suspends until the user approves in the Approvals tab — the agent loop and the proposal lifecycle compose instead of competing.
- **AI-Server-Studio:** tool-broker route (`tools.ts`) can expose ComfyUI jobs, RAG search, and file ops as agent tools behind its existing policy gates.
- **AI-model-test:** agentic eval suites become possible — score a model's tool-use competence with the same traceability (every step is a telemetry record).

---

## 9. How each repo consumes the nugget

**AI-model-test** — delete `src/adapters/httpAdapters.ts` and all three `adapterFor()` copies; `ModelAdapter.generate(model, prompt)` becomes a thin shim over `handler.chat` with `messages: [{role:'user', content: prompt}]` (then migrate the runner to real messages for system prompts and the vision suite). `TelemetrySink` writes `run_events`; `model_responses` keeps storing full text app-side. Judge moves to `responseFormat: json` + schema guards. `KeySource` = env resolver with the existing literal-redaction sentinel behavior. Its provider list grows for free (OpenRouter/llama.cpp/vLLM were already half-supported; DeepSeek/Mistral/Together/Fireworks become new benchmark targets). OpenRouter models register as **distinct config entries**, and every stored result keys on `modelRef` — which unlocks two analyses the lab couldn't express before: the same model benchmarked across sources head-to-head, and per-source consistency (does one host behave uniformly across all its models?).

**AI-Server-Studio** — the four inline Ollama fetch sites and `cloud.ts:callCloudModel` collapse into `handler.stream`; the route handler transcribes `StreamEvent`s into its existing SSE frames and keeps emitting its app-specific context events through the same wire. Cloud becomes streaming for free. Governance: its routing rules become *its* configured policy at the seam (the handler ships none). `KeySource` = the AES-GCM `provider_keys` table. `TelemetrySink` fixes the local-call telemetry gap.

**Blobsmith** — `ai.ts` and `ai.worker.ts` both import the one handler (the worker keeps its postMessage transport; the drift disappears). Gains abort, timeout, real streaming for the terminal overlay, its allowlist enforced on both paths via `allowlistPolicy(...)` config, Anthropic JSON mode, and the agent layer for its ReAct features. `KeySource` = localStorage-backed `stored` refs (with a documented upgrade path to a passphrase vault).

**locus-os** — the empty seam gets filled: AI Core's `RouteTarget` resolves to a `Connection`; `hooks.beforeCall` + the agent layer's `ApprovalGate` route side-effect-bearing behavior through the broker's propose/approve; `KeySource` = Secrets Core brokered refs (`secret://…`, fails closed when locked — the `'locked' | 'denied'` results exist for exactly this); `Redactor` = the existing `redactText` choke point; `TelemetrySink` = audit rows. The mock `credentials.ts` broker retires.

**ai-agent-skills** — gains Agent Skills for AI Nugget (usage rules, guardrails, validation commands) and updates the provider map with verified facts from this effort.

---

## 10. Testing strategy

- **Engine contract tests over fixtures:** one shared suite runs every engine against recorded wire fixtures (happy path, streaming, buffered-despite-stream, native tool-call roundtrip, 401/429/500, malformed JSON, truncated stream, abort mid-stream, abandoned stream cancellation).
- **Profile tests:** light per-profile assertions — URL/auth/header construction, quirk behavior (llama.cpp modelOptional, Anthropic maxTokens injection, Azure URL template), model-listing parse. This keeps wide provider coverage cheap.
- **Agent-loop tests:** scripted mock adapter drives the loop deterministically — tool roundtrip, invalid-args self-correction, approval deny-and-continue, each budget stopReason, mid-tool abort, promptJson fallback parity with native mode.
- **Live smoke tests (optional, env-gated):** against local Ollama / llama.cpp when present; never in CI by default (the "missing keys never fail the deterministic path" doctrine applies to the handler's own tests).
- **Ports of existing tests:** Blobsmith's `extractJsonObject` cases and AI-model-test's adapter/timeout behaviors become regression tests here, so adoption can delete them downstream without losing coverage.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The agent layer grows into a framework | Hard non-goals (§1): loop/tools/budgets/approval only; planning, memory, RAG, multi-agent stay app-side. It lives in a subpath so the core is consumable without it |
| Profile sprawl (providers nobody uses) | Profiles are table rows with light tests — cheap to keep; but each shipped profile needs at least fixture-based tests, and the support-policy bar (§1) gates additions |
| Adoption stalls and copies drift again | Adopt in dependency order (dev plan phases); each adoption *deletes* the local copy in the same PR — no transition period with both paths |
| Provider API changes break all repos at once | That's a feature (one fix), but pin engines with contract fixtures and keep the `raw` escape hatch |
| Tool-calling shape differences across providers | The engine layer owns the mapping; the contract suite's tool roundtrip fixtures run per engine; `promptJson` fallback is the universal floor |
| Browser/Node divergence (fetch/stream quirks) | CI runs the contract suite in Node and a headless browser (the repos already have Playwright/Chromium available) |
| Vendored `nugget/` copies drift | Vendored builds are generated, stamped with version + hash; a validation script (ai-agent-skills style) can flag stale vendored copies |
