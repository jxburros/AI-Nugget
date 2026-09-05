# Providers

Four **protocol engines** own the wire formats; a data-driven **profile table**
(`src/adapters/profiles.ts`) turns each named provider into defaults + quirks on
top of an engine, so adding an OpenAI-compatible provider is a table row, not
another copy of the SSE loop. `adapterFor(provider)` lives once, in
`src/adapters/index.ts`.

| Engine | Providers | Streaming | Tools | JSON mode |
|---|---|---|---|---|
| `openaiChat` | `openai`, `azure-openai`, `openrouter`, `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `cerebras`, `moonshot`, `cohere`, `perplexity`, `lmstudio`, `llamacpp`, `vllm`, `openai-compat` | SSE + `stream_options.include_usage` | `tools`/`tool_calls` deltas | `response_format` (`json_schema` where supported, otherwise `json_object`) |
| `anthropic` | `anthropic` | SSE (`content_block_delta`) | `tool_use` blocks (streamed) | forced-tool JSON mode |
| `google` | `google` | SSE (`streamGenerateContent`) | `functionDeclarations` | `responseMimeType` |
| `ollama` | `ollama` | NDJSON | native `tools` | `format: json` |

`Connection.provider` is typed as `KnownProvider | (string & {})`, so IDEs
autocomplete the names above and a typo is a compile error — while an arbitrary
string still resolves through the `openai-compat` escape hatch for endpoints
that have no profile.

## Verification status

**A profile in the table is not a promise that the provider is live-verified.**
Every provider is covered by mocked engine tests (they prove *this library's*
wire handling); far fewer are exercised against the real endpoint. Read this
column before betting a production integration on a profile.

| Tier | What it means | Providers |
|---|---|---|
| **live-verified** | Covered by `tests/live-smoke.test.ts` against the real endpoint in the scheduled live matrix (`.github/workflows/live-matrix.yml`), gated on a repo secret being present | `openai`, `anthropic`, `google`, `openrouter` |
| **live-verified (manual)** | Live-smoke-able locally with a running server, but not in CI (needs a reachable local daemon) | `ollama`, `llamacpp`, `lmstudio`, `vllm` |
| **mock-verified** | Engine behavior covered by the mocked contract suite; the profile's base URL, auth mode, and quirks are believed correct but not continuously checked against the live API | `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `cerebras`, `moonshot`, `cohere`, `perplexity` |
| **configuration-only** | No fixed endpoint to verify — behavior depends entirely on what you point it at | `azure-openai` (deployment-specific URL template), `openai-compat` |

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

Hosted cloud providers (`openai`, `azure-openai`, `openrouter`, `groq`,
`deepseek`, `mistral`, `together`, `fireworks`, `cerebras`, `moonshot`,
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
- **Anthropic** implements JSON mode as a forced `json_output` tool, which can't
  coexist with the caller's own tools.

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

## Reasoning effort

`ChatRequest.reasoningEffort` (`'none' | 'minimal' | 'low' | 'medium' | 'high'`)
is one vocabulary for "how hard should a thinking-capable model think", mapped
onto each provider's own knob. It is only sent when you set it — non-reasoning
models reject the parameter outright, so the nugget never guesses.

| Engine | Wire field | `'none'` | `'minimal'` … `'high'` |
|---|---|---|---|
| `openaiChat` | `reasoning_effort` | `'none'` | the word as-is |
| `anthropic` | `thinking` | `{ type: 'disabled' }` | `{ type: 'enabled', budget_tokens }` from `REASONING_BUDGET_TOKENS` (1 024 / 2 048 / 8 192 / 16 384); `max_tokens` is raised to fit when it would not, and `temperature`/`top_p` are dropped because Anthropic refuses them alongside thinking |
| `google` | `generationConfig.thinkingConfig.thinkingBudget` | `0` | the same token tiers |
| `ollama` | `think` | `false` | `true` (Ollama has no graded effort for most models) |

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

The `/v1/responses` API keeps reasoning *and* tools; a `responses` engine is the
planned long-term path and is not in this release.

## Stream anomalies

All four engines emit `{ type: 'context', kind: 'stream_anomaly' }` when a
stream ends without the provider's terminal marker (OpenAI `finish_reason`,
Anthropic `stop_reason`/`message_stop`, Google `finishReason`, Ollama `done`).
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
connect({ provider: 'openai-compat', baseUrl: 'http://127.0.0.1:8712/v1' });
```

JX Runtime allows unauthenticated requests from the local machine, so `keyRef`
can be omitted (`openai-compat` is `keyOptional`). Its error body is
`{ error: { code, message, details } }` — no `type` field — which `classify()`
handles fine since it only reads HTTP status and body text, not `error.type`.
Note JX Runtime does not send CORS headers by default, so a browser-hosted
caller needs JX Runtime's CORS config enabled for that origin; server-side
callers are unaffected.

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
