# AI Model Handling Across the Portfolio — Comparison Report

**Scope:** How `AI-model-test`, `AI-Server-Studio`, `Blobsmith`, `locus-os`, and `ai-agent-skills` contact, control, and present AI models; what each can learn from the others; and what should be extracted into a shared, reusable AI handler (designed in `design.md`, planned in `development-plan.md`).

**Method:** Each repository was read directly (code, not docs claims). File paths and line references below point at the current state of each repo's default branch as of 2026-07-05.

---

## 1. The one-paragraph verdict

The five repos are strikingly **complementary rather than redundant**. Each solved a different slice of the "talk to an AI model" problem well, and each is missing exactly the slice another repo already has:

- **AI-model-test** has the best *transport layer* (5 provider adapters behind one interface, timeout+abort merging, streaming with first-token latency, retry/backoff/throttling) — but a prompt-string-only interface and a factory copy-pasted into three files.
- **AI-Server-Studio** has the best *observability and policy layer* (a rich SSE event contract, encrypted key storage, per-project cloud policies with budgets, audit logging) — but its Ollama calls are duplicated inline `fetch` loops with no retries and no timeout.
- **Blobsmith** has the best *output handling and model governance* (3-tier defensive JSON extraction, schema validators, provider allowlists/blocklists, request queue with throttle and retries) — but the whole layer exists twice (main thread vs. worker) and has drifted, with no abort, no timeout, and no real streaming.
- **locus-os** has the best *safety lifecycle* (propose → approve → execute with re-authorization at every step, a single redaction choke point, brokered secrets that never expose plaintext to the AI plane, undo, full audit) — but the actual model-call seam is deliberately **empty**: no model is ever contacted.
- **ai-agent-skills** contains no runtime code at all, but already *documents the doctrine* the other four imply (BYOK vs. backend-keys vs. brokered-references taxonomy, "AI JSON must be validated before mutating state", "missing keys must never break the deterministic path") and provides the packaging/validation conventions a shared module's guidance should ship in.

A shared handler that combines AI-model-test's transport, AI-Server-Studio's event contract, Blobsmith's parsing/governance, and locus-os's hooks for redaction/approval would directly fix the top weakness of every repo at once.

---

## 2. Per-repo profiles

### 2.1 AI-model-test — the eval lab (Node, TypeScript, better-sqlite3)

**Architecture of AI contact.** All model calls flow through a minimal adapter interface (`src/types/index.ts:74`):

```ts
interface ModelAdapter {
  generate(model: string, prompt: string, options: GenerateOptions,
           fetchOpts?: { signal?: AbortSignal }): Promise<GenerateResult>;
}
```

Five adapter classes in `src/adapters/httpAdapters.ts` cover eight providers: `OpenAICompatibleAdapter` (openai, lmstudio, openrouter, groq, and any vLLM/llama.cpp endpoint), `OllamaAdapter` (native `/api/generate` NDJSON), `AnthropicAdapter`, `GoogleAdapter`, and `GenericHttpAdapter` as fallback. An `adapterFor(cfg)` switch maps provider → adapter — **duplicated identically in three files** (`evalRunner.ts:16`, `judgeScorer.ts:4`, `dashboardServer.ts:224`); CLAUDE.md documents the three-location sync as a standing hazard.

**Best-in-portfolio pieces:**

- `withTimeout(timeoutMs, externalSignal)` (`httpAdapters.ts:12`) merges a per-request timeout controller with an external cancellation signal and guarantees cleanup — the single most reusable primitive in the portfolio.
- Streaming done right: SSE parsing for OpenAI-compatible providers records **first-token latency**, reads `usage` from `stream_options`, and gracefully falls back if the server ignored `stream: true` (`httpAdapters.ts:157-176`). Ollama NDJSON streaming likewise.
- Real request lifecycle: one retry with failure classification (`classifyRunFailure`, `evalRunner.ts:123`), exponential backoff on HTTP 429, adaptive concurrency that ratchets down on throttle signals, a local-model mutex so only one local model occupies RAM at a time, and warm-up probes that separate cold-start from warm latency.
- Key hygiene by design: `apiKeyEnvVar` resolution distinguishes env references from literals (`src/config/apiKeys.ts:22`), keys go in headers never query strings, and literal keys are swapped for a fail-closed sentinel (`LITERAL_API_KEY_REDACTED`) before any run config is persisted.
- Traceability as a contract: every prompt gets a `model_responses` row **including failures** (`error_state` set, `evalRunner.ts:516-527`); every score links to a `response_id`; a `run_events` table logs warm-ups, throttles, backoffs, and batch mismatches.

**Weaknesses:**

- The adapter interface is **single-shot prompt-string only** — no `messages[]`, no system-role separation (the runner string-concatenates system prompts), no tool calls, no images, despite a `vision_multimodal` suite existing.
- `adapterFor()` triplication (above).
- **A real key-leak edge:** `loadBootstrapData` (`dashboardData.ts:481`) ships `config.models` — including `apiKeyEnvVar` — to the browser without redaction. Env-var *names* are harmless, but a literal key stored in that field would reach the UI.
- The LLM-as-judge path parses free-text scores with regexes and defaults to `3` when nothing parses (`judgeScorer.ts:18-107`) — brittle, given the proxy elsewhere in the same repo already understands `response_format: json_object`.
- Error classification is string-matching on messages instead of typed errors with status codes.
- Token metrics are missing for the non-streaming adapters (Anthropic/Google report `firstTokenLatencyMs: null`; the generic adapter reports no usage at all).

### 2.2 AI-Server-Studio — the local AI workstation (Express backend + React frontend)

**Architecture of AI contact.** The Express backend is the sole network boundary; the frontend only ever calls `/v1/*`. But "the Model Traffic Manager" from the docs is really three loosely-coupled things: a `trafficState` in-memory load singleton (`routes/models.ts:10-16`), inline selection functions in `routes/conversations.ts` (`pickAutoModel`, `pickCloudFallbackModel`), and a *separate, unwired* suggestion engine in `routes/routing.ts`. Ollama is called by literal `fetch` in **four different files**, two of which hardcode `http://127.0.0.1:11434` and ignore the `OLLAMA_BASE_URL` env var that the other two honor. Cloud providers (OpenAI/Anthropic/Gemini) go through one clean `callCloudModel()` dispatcher (`cloud.ts:348-450`) — non-streaming, buffered into a single SSE delta.

**Best-in-portfolio pieces:**

- **The SSE event contract** is the strongest UI-facing design in the portfolio. One stream carries `route` (which model was picked and why, including load-based downgrades), `delta`, `done` (with duration and RAG citations), `error`, plus context-transparency events: `rag_context`, `multimodal_context`, `memory_context` (with per-source relevance and reasons), `multimodal_fallback`. The Inspector panel renders all of it — the user can always see *why the model saw what it saw*.
- **Key security:** provider keys AES-256-GCM encrypted at rest, encryption secret required from env (server refuses to work without it), only `last4` + label ever exposed, `server_key` vs. `user_byok` modes, per-project cloud policy (`cloud_enabled`, `allowed_providers`, `daily_budget_usd`, `require_explicit_escalation`, fallback policy), cost estimation per call, and an `audit_events` row for every cloud call.
- **Load-aware routing:** auto-selection consults `trafficState.inFlightTotal` and picks smaller models under load, reporting `downgraded` + `reason` to the UI.
- **Graceful degradation everywhere:** embeddings, memory retrieval, RAG, and summarization all return null / fall back to recency / skip rather than failing the user's turn when Ollama is down.
- Memory scope enforcement in SQL (user/project/model scopes at the query level), matching the project's stated privacy principle.

**Weaknesses:**

- The Ollama NDJSON parse loop is pasted twice (project chat `conversations.ts:777-825`, personal chat `:1097-1141`); base-URL declarations drift across four files.
- **No retries anywhere, and no timeout on the main chat stream** — a hung Ollama socket resolves only when the client disconnects.
- The ethics blocklist (`BLOCKED_MODEL_PATTERNS` in `routing.ts:68-76`) and the task-preference routing engine gate only the routing-template CRUD, **not the live chat path** — the actual inference call never consults them.
- Vision/capability detection is duplicated substring matching (`isVisionModel` in conversations.ts vs. `inferCapabilities` in models.ts) that can silently drift.
- Cloud calls are buffered (single delta), so cloud UX degrades vs. local streaming.
- Thin telemetry: `messages` rows persist no model tag, duration, tokens, or citations (all SSE-transient); local calls have zero usage tracking (only cloud does).
- Protocol drift is already happening: `project_index_context` is emitted but no parser handles it; the personal-chat parser handles a different event subset than the project one.

### 2.3 Blobsmith — the browser BYOK app builder (Vite/React SPA)

**Architecture of AI contact.** All provider I/O lives in `src/services/ai.ts` — and *again*, drifted, in `src/workers/ai.worker.ts`, which is the active path (`FEATURE_FLAGS.workerAiExecution: true`). One dispatch function `runModelPrompt(prompt, options)` covers four providers: Gemini (via `@google/genai` SDK), Anthropic (raw fetch with `anthropic-dangerous-direct-browser-access: true`), and OpenAI + custom/Ollama through a shared OpenAI-compatible path. Connections (`{id, name, provider, apiKey?, model?, baseUrl?}`) are stored as **plaintext JSON in localStorage**.

**Best-in-portfolio pieces:**

- **Defensive JSON extraction:** `extractJsonObject()` tries direct parse → fenced ```json block → brace slice, with a schema-validating wrapper (`extractJsonObjectWithSchema<T>`) and typed field guards (`requireString`, `requireNumber`, …). Nearly every AI feature degrades to a friendly Bob-flavored fallback instead of crashing.
- **Model governance:** the worker enforces `BLOCKED_MODEL_PATTERNS` (bans Grok/xAI — same policy as AI-Server-Studio's blocklist, independently implemented) and a per-provider `MODEL_PREFIX_ALLOWLIST` (`ai.worker.ts:42-98`).
- **Request discipline (worker only):** serial FIFO queue with a 300 ms minimum inter-request interval, exponential-backoff retries (`withRetry`, 3 attempts), and token estimation (`ceil(len/4)`) accumulated into runtime usage metrics.
- **Prompt architecture:** one canonical personality prompt (`BOB_BASE_SYSTEM_PROMPT`) composed by ~12 task prompts; the rule "personality goes in `explanation`, never in generated code" is enforced in three separate prompts. Provider differences in system-prompt placement (dedicated field vs. system-role message) are handled correctly.
- Native structured output where the provider supports it (Gemini `responseMimeType: application/json`, OpenAI `response_format: json_object`), with the schema *also* embedded in the prompt as the primary contract.

**Weaknesses:**

- **The duplication is the headline problem:** `ai.ts` and `ai.worker.ts` reimplement the same providers, and only the worker has retries, queueing, metering, and governance. Flipping the feature flag off silently removes the Grok block and the allowlist.
- **No `AbortController`, no timeout, anywhere.** A hung provider hangs the serial queue with no escape and no user-facing cancel.
- No real streaming — the typewriter effect animates an already-complete response, adding latency.
- Anthropic: `max_tokens: 4096` hardcoded (will truncate large app generations) and no structured-output mechanism (no tool-use JSON mode) — it leans entirely on brace extraction, which can't recover top-level arrays.
- Keys in plaintext localStorage, and `anthropic-dangerous-direct-browser-access` exposes the Anthropic key to any script on the page.
- The preview iframe has no `sandbox` attribute — generated JS runs with more privilege than needed.

### 2.4 locus-os — the governed AI seam (local-first web OS)

**Architecture of AI contact: there isn't one — on purpose.** No provider layer, no HTTP client for models, no SDK. Provider selection (None/Local/Cloud) persists but is self-labeled "inert in v1"; a second routing model in `platform.ts` (route classes quick/reasoning/embedding/sensitive → targets) records "No requests are dispatched in this build." The assistant is a deterministic regex intent parser. What locus-os *does* have is everything the other repos lack:

**Best-in-portfolio pieces:**

- **The proposal lifecycle** (`src/core/broker.ts`): every AI-initiated change is an `ActionProposal` with a declarative effect (create/update/delete/external). `propose()` redacts and security-gates; `approve()` **re-authorizes** ("policy may have tightened"); `execute()` authorizes a **third** time, applies the effect, and captures an undo snapshot. Every transition writes an audit row. Trusted Actions are named, opt-in, disabled-by-default automations with an effect-kind allowlist (deletes/external never auto-run unless explicitly listed).
- **One redaction choke point:** `redactText()` in Secrets Core applies 14 secret patterns (OpenAI/Stripe/AWS/GitHub/JWT/private-key/…) *plus vault-aware substring redaction of the user's actual stored secrets*, and registers itself into the audit and notification sinks at module load. Broker summaries and every line of AI context assembly pass through it.
- **Brokered secrets:** real WebCrypto vault (PBKDF2 600k iters → non-extractable AES-GCM). The AI plane can only ask "does `secret://provider/name` exist," list refs, or request brokered use — which fails closed when locked and is denied unless the user set that secret's `aiAccess: "brokered"` (default `none`). `secrets.reveal` is a hard-forbidden action type at the security gate.
- **Permission model as data:** five tiers (`readable → suggestible → writableWithApproval → trusted → forbidden`) per app-declared capability manifest, user-overridable, all audited.
- **Honest degradation:** with no registered executor, an approved external action records "approved (no runtime)" and does nothing — never a faked success.

**Weaknesses:**

- The model-call seam is empty — request construction, response parsing, streaming, retries, timeouts, and cancellation all have to come from somewhere else. (That somewhere is the shared handler.)
- **Two overlapping routing systems** (`ai.ts` keyword `RoutingRule`s vs. `platform.ts` route-class table) and **two credential brokers** (real `secrets.ts` vs. mock `credentials.ts`) that a real runtime would need reconciled.
- Redaction is regex + known-plaintext only, and vault-substring redaction only works while unlocked.
- No token accounting, cost, rate limiting, or context-window budgeting — the `AIContextPacket` is assembled but never serialized against a real prompt budget.

### 2.5 ai-agent-skills — the doctrine and packaging layer

39 documentation-only skills (SKILL.md + `agents/openai.yaml` each), zero executable code, machine-validated structure. Relevant here for two reasons:

1. **It already states the portfolio's AI-handling doctrine** — scattered across `ai-provider-api-key-safety`, `issues-handler-ai-triage-contract`, `qai-ality-orchestrator-operator`, and `ai-permission-audit-broker`: the BYOK / backend-keys / brokered-references / CI-key credential taxonomy; "never write raw keys to SQLite, reports, artifacts, exports, or logs"; "AI JSON must be validated before it mutates state"; "missing AI keys must never fail the deterministic path"; "AI output is never canonical without approval." These are exactly the invariants the shared handler should turn from prose into defaults.
2. **Its conventions are the right way to ship the handler's guidance:** description-as-trigger frontmatter, fixed section shape, a validation gate, and the "drift rule" (hardcode only stable facts — schema versions, script names; point at the owning file for volatile values).

Caveats: HANDOFF.md admits every cross-repo fact map is unverified against the real repos ("written from memory" in one case), and the manifests are Codex/OpenAI-only.

---

## 3. Side-by-side comparison

| Dimension | AI-model-test | AI-Server-Studio | Blobsmith | locus-os |
|---|---|---|---|---|
| **Providers** | 8 via 5 adapters (openai-compat ×4, ollama, anthropic, google, generic) | Ollama + OpenAI/Anthropic/Gemini + ComfyUI | Gemini/OpenAI/Anthropic/custom-Ollama | None (inert placeholders) |
| **Interface shape** | `generate(model, promptString)` — single-shot | Inline per-route; cloud unified in `callCloudModel` | `runModelPrompt(prompt, {history, systemInstruction, json})` | n/a |
| **Messages / roles** | ✗ (string concat) | ✓ (Ollama messages incl. images) | ✓ (history mapped per provider) | n/a |
| **Streaming** | ✓ SSE + NDJSON, first-token latency, buffered fallback | ✓ local NDJSON; ✗ cloud (buffered) | ✗ (faux typewriter) | n/a |
| **Timeout** | ✓ per-model, merged with abort | Partial (probes only; chat stream has none) | ✗ | n/a |
| **Cancellation** | ✓ run-level AbortSignal threaded through | ✓ client-disconnect abort | ✗ | n/a |
| **Retries / backoff** | ✓ classified retry + 429 exponential backoff + adaptive throttle | ✗ | ✓ worker-only (3×, capped backoff) | n/a |
| **Concurrency control** | ✓ three nested limiters + local-model mutex | ✓ per-user/per-project gates + load state | ✓ serial worker queue + 300 ms throttle | n/a |
| **Structured output** | ✗ (regex-parsed judge text) | ✗ | ✓ JSON modes + 3-tier extraction + schema guards | n/a |
| **Model governance** | Judge-eligibility flags | Blocklist exists but not on live path | ✓ allowlist + blocklist (worker only) | Five-tier permission model (no model calls) |
| **Key storage** | Env-var indirection + literal-redaction sentinel | AES-256-GCM in DB, last4-only exposure | Plaintext localStorage | Encrypted vault + brokered refs |
| **Key redaction on output paths** | ✓ persist-time (✗ one bootstrap read path) | ✓ list endpoints | ✗ | ✓ single choke point wired into all sinks |
| **Telemetry / traceability** | ✓ every call incl. errors → DB rows + event log | Partial (cloud usage only; SSE-transient) | In-memory estimates only | ✓ full audit of proposals (no calls to log) |
| **Cost / budget** | ✗ | ✓ per-call estimate + daily budget enforcement | ✗ | ✗ |
| **UI transparency** | Quick-test, run events, drift screens | ✓ route/memory/RAG/multimodal events + Inspector | Mood/typewriter/error toasts | ✓ context inspector, proposal diffs, audit log |
| **Approval / undo of AI actions** | n/a (lab) | ✗ | ✗ | ✓ propose/approve/execute + snapshots |
| **Health / discovery** | ✓ multi-runtime probes + provider model listing | ✓ tags/status polling + capability inference | ✓ testConnection via model listing | ✗ |

---

## 4. What each repo should learn from the others

### Into AI-model-test
1. **From Blobsmith:** structured judge output. Replace regex score parsing with JSON-mode requests plus `extractJsonObject`-style defensive parsing and schema validation. The default-to-3 fallback silently corrupts benchmark data today.
2. **From locus-os:** a redaction choke point on *read* paths, not just persist paths — fixes the `loadBootstrapData` literal-key leak by construction rather than by remembering to call `redactLiteralApiKeys` at each site.
3. **From AI-Server-Studio:** a messages/roles request shape (needed anyway for the vision suite), and per-call cost estimation to enrich benchmark economics.
4. **Internal:** one exported `adapterFor()`; typed errors (`{status, kind, retryable}`) instead of string matching.

### Into AI-Server-Studio
1. **From AI-model-test:** the adapter pattern and `withTimeout`. Extract the four inline Ollama fetch sites into one adapter with timeout+abort merging and retry/backoff; normalize the base-URL env handling. Stream cloud providers instead of buffering.
2. **From Blobsmith:** wire the ethics blocklist and allowlists into the *live* inference path (Blobsmith's worker shows the shape: governance runs inside the request pipeline, not beside it).
3. **From AI-model-test:** persist per-message telemetry (model tag, duration, tokens, citations) — its `model_responses`/`run_events` schema is the template; local calls currently vanish from the record.
4. **Internal:** unify `isVisionModel`/`inferCapabilities`; parse (or remove) `project_index_context`; make one stream parser serve both project and personal paths.

### Into Blobsmith
1. **From AI-model-test:** `withTimeout` + AbortController threading, and real streaming (its SSE/NDJSON readers are directly portable). This unhangs the serial queue and enables a genuine progressive UI.
2. **Internal, enabled by the shared handler:** collapse `ai.ts`/`ai.worker.ts` onto one provider-agnostic core imported by both, so governance, retries, and metering apply on every path regardless of the feature flag.
3. **From AI-Server-Studio / locus-os:** raise key custody — at minimum an obfuscation boundary and explicit "keys live in this browser profile" UX; ideally a WebCrypto passphrase vault (locus-os has the reference implementation).
4. **From AI-model-test:** make Anthropic's `max_tokens` configurable and adopt tool-use JSON mode for structured output instead of prompt-only extraction.
5. Sandbox the preview iframe.

### Into locus-os
1. **From everyone: fill the seam.** The propose/approve/execute broker is exactly the wrapper the shared handler's lifecycle hooks were designed for; adopting the handler gives locus-os transport, streaming, retries, timeouts, and token accounting in one step, behind its existing governance.
2. **Internal:** reconcile the two routing systems (`RoutingRule` keywords vs. `platform.ts` route classes) into the handler's single routing hook; retire the mock `credentials.ts` in favor of the real Secrets Core as the handler's `KeySource`.
3. **From AI-Server-Studio:** context-window budgeting for the `AIContextPacket` (its load-aware memory token budget is the model).

### Into ai-agent-skills
1. Verify the AI-provider fact map against this report (the HANDOFF.md task) — this document supplies the verified ground truth for the five repos it covers.
2. Add a skill for the shared handler once built (usage rules, guardrails, validation commands), following the drift rule: point at the handler's own modules for volatile values.
3. Add `agents/anthropic.yaml` siblings so the guidance serves both agent platforms.

---

## 5. Convergent evolution — the strongest argument for extraction

Four patterns were independently invented two or more times, which is the clearest signal they belong in one shared module:

1. **The OpenAI-compatible chat adapter** — written three times (AI-model-test `OpenAICompatibleAdapter`, AI-Server-Studio `callCloudModel` openai branch, Blobsmith `generateWithOpenAICompatible`), each with different capabilities (streaming/usage vs. buffered vs. JSON mode).
2. **The Anthropic adapter** — written three times, with three different `max_tokens` defaults (1024 / 2048 / 4096) and three different response-content joins.
3. **The Grok/xAI blocklist** — written twice (Blobsmith worker, AI-Server-Studio routing), enforced on the live path in neither-or-one of them.
4. **Intra-repo duplication of the model layer itself** — twice (Blobsmith main-thread vs. worker; AI-Server-Studio project vs. personal chat loops), both already drifted.

Every duplication above is a bug factory: the copies have *already* diverged in behavior. The shared handler's primary job is to make each of these exist exactly once.

---

## 6. Requirements the shared handler inherits

Distilled from the strengths above, the handler (designed in full in `design.md`) must provide:

- **One `ProviderAdapter` interface, message-based**, with streaming and non-streaming paths, model listing, and health checks (AI-model-test's seam, upgraded to AI-Server-Studio/Blobsmith's message shape).
- **Transport primitives:** timeout+abort merging, SSE and NDJSON line readers, first-token latency capture, buffered-fallback tolerance.
- **Lifecycle:** classified typed errors, retry with jittered backoff, 429 handling, queue/concurrency limits, cancellation end-to-end.
- **A normalized event stream** modeled on AI-Server-Studio's SSE contract (`route`/`delta`/`done`/`error` + extensible context events) usable by any UI.
- **Structured output:** provider-native JSON modes where available plus Blobsmith's extraction/validation ladder as the universal fallback.
- **Pluggable custody and policy:** `KeySource` (env / literal / browser storage / encrypted vault / brokered ref), `Redactor` choke point on every outbound log/telemetry path, `GovernancePolicy` (allow/block lists) enforced *inside* the pipeline, and before/after lifecycle hooks that let locus-os's broker wrap calls in propose/approve/execute.
- **Telemetry as a first-class sink:** every call — including failures — emits a structured record (AI-model-test's traceability contract), with provider-reported usage when available and estimation as a labeled fallback.
- **Isomorphic, zero-dependency TypeScript** so the same core runs in Node (AI-model-test, AI-Server-Studio), a browser main thread and Web Worker (Blobsmith), and a local-first SPA (locus-os).

---

*Companion documents: `design.md` (the AI handler nugget design) and `development-plan.md` (phased build & adoption plan).*
