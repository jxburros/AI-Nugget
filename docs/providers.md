# Providers

Six **protocol engines** own the wire formats; a data-driven **profile table**
(`src/adapters/profiles.ts`) turns each named provider into defaults + quirks on
top of an engine, so adding an OpenAI-compatible provider is a table row, not
another copy of the SSE loop. `adapterFor(provider)` lives once, in
`src/adapters/index.ts`.

| Engine | Providers | Streaming | Tools | JSON mode |
|---|---|---|---|---|
| `openaiChat` | `openai`, `azure-openai`, `openrouter`, `vercel`, `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `cerebras`, `moonshot`, `meta`, `cohere`, `perplexity`, `lmstudio`, `llamacpp`, `vllm`, `openai-compat` | SSE + `stream_options.include_usage` | `tools`/`tool_calls` deltas | `response_format` (`json_schema` where supported, otherwise `json_object`) |
| `anthropic` | `anthropic` | SSE (`content_block_delta`) | `tool_use` blocks (streamed) | native JSON schema on modern Claude; legacy forced-tool fallback |
| `google` | `google` | SSE (`streamGenerateContent`) | `functionDeclarations` | `responseMimeType` |
| `ollama` | `ollama` | NDJSON | native `tools` | `format: json` |

`Connection.provider` is typed as `KnownProvider | (string & {})`, so IDEs
autocomplete the names above and a typo is a compile error — while an arbitrary
string still resolves through the `openai-compat` escape hatch for endpoints
that have no profile.

New hosted/cloud profiles and their exact endpoints, protocol restrictions and
authentication examples are listed in [Cloud providers](cloud-providers.md).

| Additional engine | Selection | Behavior |
|---|---|---|
| `responses` | `Connection.protocol: responses` | SSE or buffered Responses; complete output-item replay |
| `converse` | `Connection.protocol: converse` | Bedrock EventStream or buffered Converse; native tools and signatures |

## Verification status

**A profile in the table is not a promise that the provider is live-verified.**
Every provider is covered by mocked engine tests (they prove *this library's*
wire handling); far fewer are exercised against the real endpoint. Read this
column before betting a production integration on a profile.

| Tier | What it means | Providers |
|---|---|---|
| **live-matrix configured** | Configured for `tests/live-smoke.test.ts` against the real endpoint in the scheduled live matrix (`.github/workflows/live-matrix.yml`), gated on a repo secret and explicit `*_SMOKE_MODEL` repository variable | `openai`, `anthropic`, `google`, `openrouter` |
| **manual smoke available** | Live-smoke-able locally with a running server, but not in CI (needs a reachable local daemon) | `ollama`, `llamacpp`, `lmstudio`, `vllm` |
| **mock-verified** | Engine behavior covered by the mocked contract suite; the profile's base URL, auth mode, and quirks are believed correct but not continuously checked against the live API | `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `cerebras`, `moonshot`, `meta`, `vercel`, `cohere`, `perplexity` |
| **configuration-only** | No fixed endpoint to verify — behavior depends entirely on what you point it at | `azure-openai` (deployment-specific URL template), `openai-compat` |

The new `minimax`, `zai`, `dashscope`, `huggingface`, `deepinfra`, `sambanova`,
`nvidia`, `cloudflare`, `bedrock`, `vertex` and `azure-openai-v1` profiles are
**mock-verified** by handler-level URL/auth/protocol tests in Node and Chromium.
Their live behavior was not exercised during this release. A configured workflow
or an available smoke command alone is not evidence of a successful live run.

### Provider notes (checked against official docs 2026-11-10)

- **`meta`** — Meta Model API (Muse Spark / Muse Wonder, keys from dev.meta.ai)
  at `https://api.meta.ai/v1`, bearer auth. Chat Completions by default; set
  `protocol: 'responses'` for the Responses API. Sends `max_completion_tokens`
  and native `json_schema`. Muse models always reason: `reasoningEffort: 'none'`
  is a 400; `xhigh`/`max` are accepted. Meta does not expose the chain of
  thought, only `reasoning_tokens` counts.
- **`moonshot`** — Kimi (platform.kimi.ai; `api.moonshot.ai/v1`, mainland-China
  keys use `baseUrl: 'https://api.moonshot.cn/v1'`). Thinking models stream
  `reasoning_content` and require it echoed back on assistant turns in tool
  loops, so the profile preserves assistant state. K3 models take
  `reasoningEffort` `low`/`high`/`max`; K2.x models use
  `providerOptions.thinking`.
- **`deepseek`, `together`, `fireworks`** — preserve assistant reasoning for
  replay (DeepSeek returns 400 on a tool-using history without the earlier
  `reasoning_content`). Reasoning is echoed under the field it arrived in
  (`reasoning_content` or `reasoning`). `together` now defaults to the documented
  `api.together.ai` host.
- **`groq`, `minimax`** — send `max_completion_tokens` (Groq deprecated
  `max_tokens`; MiniMax's legacy field also counts thinking tokens).
- **`vercel`** — Vercel AI Gateway at `https://ai-gateway.vercel.sh/v1`.
- **`perplexity`** — Perplexity ended Sonar Chat Completions support on
  2026-09-27; the default URL still answers (requests are reformulated as Agent
  API calls). For new work use `baseUrl: 'https://api.perplexity.ai/orchestrator/v1'`
  (Chat Completions subset) or `protocol: 'responses'` with
  `baseUrl: 'https://api.perplexity.ai/v1'` (Agent API).

If a mock-verified provider drifts (a renamed base path, a new required header),
the mocked suite will still pass. Report it as a bug with the provider name and
the failing response — a profile row is cheap to fix.

## Provider capabilities

Beyond wire-format `quirks` (auth, URL templates, whether a stream reports
usage), each profile also carries `capabilities` — the higher-level questions
apps need answered before they pick behavior:

```ts
interface ProviderCapabilities {
  nativeTools: boolean;   // reliable native tool/function-calling for this
                          // provider's protocol (not just model-dependent)
  jsonMode: boolean;      // a provider-enforced structured-output mode exists
  local: boolean;         // runs on localhost / user-controlled infra
  embeddable: boolean;    // meant to run as a local sidecar, not a hosted service
}
```

Hosted cloud providers (`openai`, `azure-openai`, `openrouter`, `vercel`, `groq`,
`deepseek`, `mistral`, `together`, `fireworks`, `cerebras`, `moonshot`, `meta`,
`cohere`, `perplexity`, `anthropic`, `google`) ship
`{ nativeTools: true, jsonMode: true, local: false, embeddable: false }`. Local
runtimes (`lmstudio`, `llamacpp`, `vllm`, and the `openai-compat` escape hatch)
ship the conservative `{ nativeTools: false, jsonMode: false, local: true,
embeddable: true }`, since native tool support there is model-dependent, not
protocol-guaranteed. `ollama` is the one exception with `jsonMode: true` — its
`format: 'json'` is engine-enforced regardless of which model is loaded.

Access via `profileFor(provider, baseUrl).capabilities`.

**These are provider-level defaults, not per-model guarantees.** A specific
model behind a "hosted" provider can still lack reliable native tool-calling
(and a specific local model behind a "local" provider can have it) — this
matters most for OpenRouter, Ollama, LM Studio, vLLM, and any `openai-compat`
endpoint, where the model actually loaded is opaque to the profile table. A
caller that knows its model better should pass an explicit `toolMode` (agent
layer) rather than rely on the capability default.

## JSON mode combined with tools

Two providers cannot do both at once, and the nugget drops JSON mode rather than
sending a request the provider will reject:

- **Google/Gemini** rejects `responseMimeType: application/json` alongside
  function declarations.
- **Legacy Anthropic models** implement JSON mode as a forced `json_output` tool,
  which cannot coexist with caller tools. Modern Claude uses native JSON schemas
  and supports both together. Schema-less modern JSON requests emit the same
  downgrade event and use an instruction instead of constrained decoding.

The downgrade is **not silent**: both engines emit a
`{ type: 'context', kind: 'json_mode_downgraded', data: { reason, provider } }`
stream event before the request goes out. Watch for it if you build a
JSON-mode + tools flow:

```ts
for await (const event of handler.stream(conn, req)) {
  if (event.type === 'context' && event.kind === 'json_mode_downgraded') {
    console.warn('structured output was dropped:', event.data);
  }
}
```

## Inline reasoning is stripped at the seam

Every engine already routes a provider's *dedicated* reasoning field (Anthropic
`thinking_delta`, OpenAI `reasoning_content`, Gemini `thought` parts, Ollama
`thinking`) to `{ type: 'reasoning', text }`. Since 0.7.0 the handler also
strips **inline** reasoning — `<think>…</think>`, `<thinking>`, `<reasoning>`,
`<|begin_of_thought|>` blocks a model writes into the answer itself — out of
`delta` events and `ChatResult.text`, and emits it on the same `reasoning`
channel. Tags split across chunks and a template-opened block that only ever
sends its closing tag are both handled (`src/reasoning.ts`, ported from AI
Server Studio's stripper). Pass `new AIHandler({ stripInlineReasoning: false })`
to receive the raw text instead. `stripReasoningBlocks(text)` and
`createReasoningStripper()` are exported for text you buffered yourself.

## Reasoning effort

`ChatRequest.reasoningEffort` (`'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`)
is one vocabulary for "how hard should a thinking-capable model think", mapped
onto each provider's own knob. It is only sent when you set it — non-reasoning
models reject the parameter outright, so the nugget never guesses.

| Engine | Wire field | `'none'` | `'minimal'` … `'high'` |
|---|---|---|---|
| `openaiChat` | `reasoning_effort` | `'none'` | the word as-is |
| `responses` | `reasoning.effort` | `'none'` | the word as-is |
| `anthropic` (modern Claude) | `thinking: { type: 'adaptive' }` + `output_config.effort` | thinking disabled | `minimal` → `low`; others as-is (`xhigh`, `max` included) |
| `anthropic` (older Claude) | `thinking` | `{ type: 'disabled' }` | `{ type: 'enabled', budget_tokens }` from `REASONING_BUDGET_TOKENS` (1 024 / 2 048 / 8 192 / 16 384 / 24 576 / 32 768); `max_tokens` is raised to fit when it would not, and `temperature`/`top_p` are dropped because Anthropic refuses them alongside thinking |
| `google` (Gemini 3+) | `generationConfig.thinkingConfig.thinkingLevel` | `'minimal'` (Gemini 3 cannot fully disable thinking) | `minimal`/`low`/`medium`/`high`; `xhigh`/`max` → `high`. Level support varies by model (3 Pro: `low`/`high` only) |
| `google` (Gemini 2.x) | `generationConfig.thinkingConfig.thinkingBudget` | `0` | the same token tiers |
| `ollama` | `think` | `false` | `true` (Ollama has no graded effort for most models) |

`xhigh` and `max` are sent as-is to OpenAI-compatible providers. OpenAI GPT-5.2+
accepts `xhigh`; Meta Muse, Kimi K3, DeepSeek, Z.AI and Groq (per model) accept
`max`. A provider or model without a tier answers with a typed `invalid_request`
— the nugget does not silently downgrade.

A provider-native value in `providerOptions` (`reasoning_effort`, `thinking`,
`thinkingConfig`, `think`) wins over `reasoningEffort` on collision. The agent
layer forwards `AgentOptions.reasoningEffort` to every turn.

### OpenAI reasoning models and function tools

OpenAI's `/chat/completions` refuses function tools on a reasoning model unless
`reasoning_effort` is `'none'` (the error reads *"Function tools with
reasoning_effort are not supported … use /v1/responses or set reasoning_effort
to 'none'"*), and the provider default is not `'none'`. Rather than let every
app discover this as a 400 on its first tool-using turn, the `openaiChat`
engine retries that one request once with `reasoning_effort: 'none'` and emits
`{ type: 'context', kind: 'reasoning_effort_disabled_for_tools', data: { reason,
requested } }` on the stream so the change is never silent. The retry is
reactive on purpose — sending the parameter up front would 400 on non-reasoning
models — and it only fires when the request carried tools and the effective
effort was not already `'none'`. Set `reasoningEffort: 'none'` yourself on
tool-using turns to skip the extra round trip.

For compatible endpoints, explicitly select `protocol: 'responses'` to preserve
Responses reasoning items and native function calls; see [cloud providers](cloud-providers.md).

### Gemini thought signatures

Gemini 3 attaches an encrypted `thoughtSignature` to model parts and returns a
400 if a function-call turn is replayed without it. Google results now carry the
model turn verbatim in `providerState` (text merged, signatures kept), and the
engine replays it for the same provider and model — `runAgent` copies it
automatically; custom tool loops must copy `result.providerState` onto the
assistant message. A Gemini 3 function-call turn rebuilt without state (history
from another provider, or an app-built transcript) gets Google's documented
`skip_thought_signature_validator` sentinel on its first call, which keeps the
request valid at some cost to reasoning quality.

## Multimodal input and media output

`ContentPart.type` is `'text' | 'image' | 'audio' | 'video' | 'file'`. Non-text
parts carry base64 bytes in `dataBase64` (images also accept the older
`imageBase64`) or a provider-reachable `url`, plus `mimeType`; `file` parts take
an optional `filename`.

```ts
await handler.chat(conn, { model, messages: [{ role: 'user', content: [
  { type: 'text', text: 'Summarize the report and the call.' },
  { type: 'file', dataBase64: pdfB64, mimeType: 'application/pdf', filename: 'q3.pdf' },
  { type: 'audio', dataBase64: mp3B64, mimeType: 'audio/mpeg' },
] }] });
```

| Engine | image | audio | video | file / PDF |
|---|---|---|---|---|
| `openaiChat` | `image_url` (bytes or URL) | `input_audio` (bytes only) | `video_url` (Kimi, Meta, Qwen extension) | `file.file_data` (bytes only) |
| `responses` | `input_image` | — | — | `input_file` (bytes or `file_url`) |
| `anthropic` | `image` (base64 or URL) | — | — | `document` (PDF base64/URL; `text/*` as plain text) |
| `google` | `inlineData` bytes or `fileData` URI — all four kinds |||||
| `converse` | `image` bytes | — | `video` bytes or `s3://` | `document` bytes |
| `ollama` | base64 `images` | — | — | — |

A cell marked — is a typed `invalid_request` before any network call: the nugget
never drops a part from the prompt. A filled cell means the protocol has a shape
for it, not that every model on the provider accepts that media.

Media the model generates in-band is collected on `ChatResult.media`
(`{ type: 'image' | 'audio' | 'file', mimeType, dataBase64?, url?, transcript? }`)
and streamed as `{ type: 'context', kind: 'media', data }` events: Gemini inline
image/audio parts, OpenRouter-style `images` on Chat Completions, Chat
Completions audio output (MIME from `providerOptions.audio.format`; the spoken
text is the `transcript`), and Responses `image_generation_call` results.
Telemetry records never include media bytes. Dedicated image/speech/transcription
endpoints remain out of scope (see the [optional operations plan](plans/optional-operations.md)).

## Stream anomalies

The four original engines emit `{ type: 'context', kind: 'stream_anomaly' }` when a
stream ends without the provider's terminal marker (OpenAI `finish_reason`,
Anthropic `stop_reason`/`message_stop`, Google `finishReason`, Ollama `done`).
The new Responses and Converse engines instead fail with `invalid_response` if
the terminal response/stop reason is missing.

That is the signal for a truncated or dropped connection — the result is still
delivered, but it may be incomplete.

## Wire URL for `openai-compat` and the local runtimes

`openai-compat`, `lmstudio`, `llamacpp`, and `vllm` have no `urlTemplate` in the
profile table, so the `openaiChat` engine falls back to
`POST {baseUrl}/chat/completions` (no `/v1` prefix — include it in `baseUrl`
yourself if your server needs it, e.g. `http://localhost:8080/v1`). This matters
most when standing up a local mock or test server: it has to listen on that
exact path.

### Pointing at a [JX Runtime](https://github.com/jxburros/JX-Runtime) server

JX Runtime serves an OpenAI-compatible API at `http://127.0.0.1:8712/v1` by
default (`/v1/chat/completions`, `/v1/models`, streaming SSE with a `[DONE]`
sentinel — no library changes needed). Connect through the `openai-compat`
profile with the `/v1` suffix included in `baseUrl`:

```ts
const jx = { id: 'jx', provider: 'openai-compat', baseUrl: 'http://127.0.0.1:8712/v1' };
```

JX Runtime allows unauthenticated requests from the local machine, so a
server-side caller on the same host can omit `keyRef` (`openai-compat` is
`keyOptional`).

**Errors.** JX Runtime's error body is
`{ error: { code, message, type, correlationId, details } }` — an OpenAI-style
coarse `type`, a stable JX `code` (e.g. `MODEL_BUSY`, `MODEL_INSUFFICIENT_VRAM`),
a `correlationId` to quote to the operator, and `details` (always carrying
`retryable`, sometimes a `repair` plan). `classify()` maps the failure from the
HTTP status (plus a context-length text check on 400/422) and never reads
`error.type`, so this shape needs no library changes. `AIError.raw` keeps a
redacted excerpt of the first 200 characters of the body, which normally
includes the JX `code`; a long `message` can push `correlationId` past it.

**Browser callers.** JX Runtime sends no CORS headers by default, so a
browser-hosted caller needs its origin added to JX's
`network.cors.allowedOrigins`; server-side callers are unaffected. Since JX
1.5.0 a page on an allow-listed origin is **not** treated as trusted-local: it
must send an access key (pair it, or give it a scoped key) even in
`auth.mode: 'auto'`. Supply that key through your `KeySource` as for any other
provider.

**Streamed token counts.** `openai-compat` does not send
`stream_options.include_usage` by default (many OpenAI-compatible local servers
reject or ignore it), so streamed usage comes back `estimated: true`. JX Runtime
forwards `stream_options` to its engine and passes the engine's usage frame
through, so opt in per call to get the engine's real counts:

```ts
const req = {
  model: 'qwen2.5-7b-instruct',
  messages: [{ role: 'user', content: 'Hello!' }],
  providerOptions: { stream_options: { include_usage: true } },
};
for await (const event of handler.stream(jx, req)) {
  if (event.type === 'done') console.log(event.result.usage); // estimated: false when JX's engine reports it
}
```

Whether a usage frame is produced is the engine's decision (older
`llama-server` builds ignore the field); when none arrives the result is still
honestly `estimated: true`. There is deliberately no dedicated `jx-runtime`
profile: the opt-in is one line on an existing seam, and without it nothing is
hidden or faked.

**Discovery.** `handler.listModels()` reads JX's `/v1/models` through the
standard OpenAI path and returns model ids. JX's non-standard per-model
`capabilities` extension is an object (`{ chat, tools, vision, …,
max_context }`), not the string list `ModelInfo.capabilities` holds, and its
`max_model_len` is not one of the context-window fields the nugget reads — so
neither is mapped onto `ModelInfo`. An app that wants them reads `/v1/models`
itself.

**Grok/xAI is not blocked and is never officially integrated** — point
`openai-compat` at any endpoint if you must; that is your configuration, not a
supported profile.

Model identity is always `(source, model)` — `modelRef(source, model)` gives the
canonical `provider/model` key so the same weights served by different hosts
stay distinct and comparable.

## Model discovery

`ProviderAdapter.listModels` is `?`-optional and `AIHandler.listModels()` falls
back to `[]`, but all four engines implement it against the provider's real
endpoint: `openaiChat` (`GET /models`), `ollama` (`GET /api/tags` +
bounded-concurrency `/api/show` probes for context window/capabilities),
`anthropic` (`GET /v1/models`), and `google` (`GET /v1beta/models`, mapping
`inputTokenLimit` → `contextWindow`). A provider with no listing endpoint (e.g.
`perplexity`) resolves to `[]` rather than erroring, so a model picker built on
`listModels()` should treat an empty result as "no discovery here," not "no
models," and keep an app-configured default ready.

### Letting an app's users pick a model

The nugget deliberately has no concept of "the app's currently selected model" —
that's app policy, same as governance. The pattern that works:

1. **Keep `provider`/`baseUrl` on a server-side allowlist; never take them from
   client input.** See [security.md](./security.md#ssrf-caller-controlled-baseurl)
   — this is the SSRF-with-attached-credential case.
2. **`model` is fine as ordinary client input.** A bad model string comes back as
   a normal provider error, with no equivalent security concern.
3. **Use `handler.listModels(connection)` to populate the picker live**, and fall
   back to an app-configured default for connections without discovery.

See `examples/model-picker.mjs` for a runnable reference.

## Anthropic compatibility

As of 0.7.1, known Claude Opus 4.7/4.8, Opus/Sonnet 5/5.5, Haiku 5.5,
Fable/Mythos 5/5.1 and Mythos Preview omit sampling parameters and use adaptive
thinking plus `output_config.effort` when effort is requested. `minimal` maps to
`low`. `none` rejects always-thinking models with a typed `invalid_request`;
Sonnet 5.5 uses `between_tools` (no up-front thinking), and models that support
thinking off use `disabled`. Native `providerOptions` can set exact thinking and
effort fields; sampling parameters are still omitted on these models.

Modern JSON output with a supplied schema uses `output_config.format` and can
coexist with tools. Supply an Anthropic-compatible JSON schema, including
`additionalProperties: false` on objects. Schema-less JSON is instruction-only
with a `json_mode_downgraded` context event. Legacy JSON keeps its forced-tool
implementation. Explicit forced tools on Opus/Sonnet 5.5 and Fable/Mythos 5.1
fail locally rather than silently becoming automatic tool selection.

The engine classifies Anthropic SSE error events as typed failures (including
mid-stream overloads), and maps refusals to `content_filter`. `providerState`
on results retains complete ordered content blocks, including thinking signatures
and redacted thinking. Custom loops must copy it unchanged to the assistant message;
`runAgent` does so automatically. Do not display, log, or put this state in telemetry.
Do not edit earlier system/tools/history while replaying signed thinking; do not
reuse it across accounts, providers or models. It is in-memory turn state, not a
replacement for an application's conversation persistence policy.

Verification: these changes are mock-verified in Node and Chromium; the historical
live-verified provider row does not claim live coverage of these new model rules.
Sources: [migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide),
[structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
[thinking](https://platform.claude.com/docs/en/build-with-claude/thinking).
