# ai-handler

`ai-handler` is a small, zero-dependency, isomorphic TypeScript nugget for
talking to AI model providers through one pipeline:

```
policy → key resolution → beforeCall hook → concurrency/retry → provider adapter → redacted telemetry
```

It runs identically in Node ≥ 20, the browser main thread, and Web Workers using
only `fetch`, `ReadableStream`, `AbortController`, and `TextDecoder`. It is
intentionally **not** a router, prompt library, memory system, or secrets vault:
apps choose models, own prompts, store secrets, and decide what policy to enforce.
The package is MIT licensed.

See `design.md` for the full contract. The original evidence base, phased
build/adoption plan, and dev handoff are archived under `docs/archive/`.

## Install / use

```ts
import { AIHandler, envKeySource } from '@jxburros/ai-handler';

const handler = new AIHandler({ keySource: envKeySource() });

// Non-streaming
const result = await handler.chat(
  { id: 'main', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
  { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello!' }] },
);
console.log(result.text, result.usage, result.finishReason);

// Streaming (works in Node route handlers, React, and Web Workers)
for await (const event of handler.stream(conn, req)) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log('\n', event.result.usage);
}
```

Repos that cannot take a package dependency can vendor the generated `nugget/`
folder (see below).

## Providers

Four **protocol engines** own the wire formats; a data-driven **profile table**
turns each named provider into defaults + quirks on top of an engine, so adding
an OpenAI-compatible provider is a table row, not another copy of the SSE loop.

| Engine | Providers | Streaming | Tools | JSON mode |
|---|---|---|---|---|
| `openaiChat` | `openai`, `azure-openai`, `openrouter`, `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `lmstudio`, `llamacpp`, `vllm`, `openai-compat` | SSE + `stream_options.include_usage` | `tools`/`tool_calls` deltas | `response_format` (`json_schema` where supported, otherwise `json_object`) |
| `anthropic` | `anthropic` | SSE (`content_block_delta`) | `tool_use` blocks (streamed) | forced-tool JSON mode |
| `google` | `google` | SSE (`streamGenerateContent`) | `functionDeclarations` | `responseMimeType` |
| `ollama` | `ollama` | NDJSON | native `tools` | `format: json` |

`adapterFor(provider)` lives once, in `adapters/index.ts`. Unknown provider keys
with a `baseUrl` resolve to the `openai-compat` escape hatch. **Grok/xAI is not
blocked and is never officially integrated** — point `openai-compat` at any
endpoint if you must; that is your configuration, not a supported profile.

Model identity is always `(source, model)` — `modelRef(source, model)` gives the
canonical `provider/model` key so the same weights served by different hosts stay
distinct and comparable.

### Provider capabilities

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
`deepseek`, `mistral`, `together`, `fireworks`, `anthropic`, `google`) ship
`{ nativeTools: true, jsonMode: true, local: false, embeddable: false }`. Local
runtimes (`lmstudio`, `llamacpp`, `vllm`, and the `openai-compat` escape hatch)
ship the conservative `{ nativeTools: false, jsonMode: false, local: true,
embeddable: true }`, since native tool support there is model-dependent, not
protocol-guaranteed. `ollama` is the one exception with `jsonMode: true` —
its `format: 'json'` is engine-enforced regardless of which model is loaded.
These are per-provider defaults, not per-model guarantees: a caller that knows
its specific loaded model better should configure behavior explicitly (e.g.
`toolMode: 'native'`) rather than rely on the default.

Access via `profileFor(provider, baseUrl).capabilities`.

**These are provider-level defaults, not per-model guarantees.** A specific
model behind a "hosted" provider can still lack reliable native tool-calling
(and a specific local model behind a "local" provider can have it) — this
matters most for OpenRouter, Ollama, LM Studio, vLLM, and any
`openai-compat` endpoint, where the model actually loaded is opaque to the
profile table. A caller that knows its model better should pass an explicit
`toolMode` (agent layer) rather than rely on the capability default.

**`listModels()` is optional per adapter — two engines never return anything.**
`ProviderAdapter.listModels` is `?`-optional, and `AIHandler.listModels()`
falls back to `[]` when an adapter doesn't implement it. Concretely: the
`openaiChat` and `ollama` engines implement it (`GET /models` /
`GET /api/tags`); the `anthropic` and `google` engines currently don't, so
`handler.listModels()` for those providers always resolves to `[]`, not an
error. This is easy to miss because `capabilities` doesn't surface it — an
app building a model picker on top of `listModels()` should treat an empty
result as "this provider doesn't support discovery," not "this provider has
no models," and have a fallback (e.g. an app-configured default model per
connection) ready for `anthropic`/`google` rather than showing an empty list.

### Letting an app's users pick a model (best practice)

The nugget deliberately has no concept of "the app's currently selected
model" — that's app policy, same as governance (see Non-goals). The pattern
that has worked well for apps building a model-picker UI on top of
`AIHandler`:

1. **Keep `provider`/`baseUrl` on a server-side allowlist; never take them
   from client input.** A `Connection`'s `provider`/`baseUrl` decide where
   the server's resolved API key gets sent (via `KeySource` → `applyAuth`);
   letting a client control either directly is effectively letting it
   redirect a real credential to an arbitrary endpoint (SSRF plus key
   exposure). Define your app's available connections server-side (e.g. a
   small config list, each with its own `KeyRef`), and only let the client
   choose a `connectionId` out of that list.
2. **`model` is fine as ordinary client input.** Unlike `provider`/`baseUrl`,
   a bad or unexpected `model` string just comes back as a normal provider
   error (unknown model) from `chat()`/`stream()` — there's no equivalent
   security concern, so there's no need to allowlist it server-side beyond
   what the provider itself enforces.
3. **Use `handler.listModels(connection)` to populate the picker live**, and
   fall back to an app-configured default model for connections whose engine
   doesn't implement discovery (see above).

## What's implemented

- **Core:** message-based contracts (`types.ts`), typed `AIError` + `classify()`,
  timeout/abort merging and SSE/NDJSON readers (`transport.ts`), defensive JSON
  extraction with array support + schema guards (`json.ts`), token estimation with
  an explicit `estimated` flag (`tokens.ts`).
- **Adapters:** all four engines with streaming, native tool-calling, JSON modes,
  `finishReason` mapping, buffered-`stream:true` fallback, first-token latency,
  and usage normalization; the full v1 provider profile table. The
  OpenAI-compatible engine only sends `stream_options: { include_usage: true }`
  when the profile's `supportsUsageInStream` quirk confirms the server expects
  it — local servers (llama.cpp, LM Studio, vLLM) that don't have the quirk set
  never receive the option. The OpenAI and Azure OpenAI profiles send
  `max_completion_tokens` for `maxTokens`; local/OpenAI-compatible profiles keep
  `max_tokens` for compatibility. Google receives `responseSchema` for JSON mode
  only when native tools are absent, avoiding Gemini's JSON-with-tools rejection.
- **Pipeline (`AIHandler`):** policy → keys → `beforeCall` → concurrency/min-interval
  → jittered retry (honoring `Retry-After`) → redacted `CallRecord` telemetry →
  `afterCall`, with `chat`, `stream`, `listModels`, `testConnection`. Every call —
  success, failure, or consumer-abandoned stream — produces one redacted telemetry
  record. Retries stop once user-visible output has been emitted, and telemetry
  or `afterCall` failures never re-execute an already-successful provider call.
  `listModels()` and `testConnection()` use explicit operation IDs
  (`__listModels__`, `__testConnection__`) so policy and telemetry can see those
  key-bearing probes too.
- **Seams:** `KeySource` (`env`/`literal`/`memory`/chain + ref parsing),
  `Redactor` (default secret patterns + session-resolved key redaction),
  neutral `GovernancePolicy` (`blocklistPolicy`/`allowlistPolicy`/`composePolicies`).
  `allowlistPolicy` fails closed for providers omitted from the configured map;
  use `'*'` in a provider's prefix list to allow non-chat operation IDs.
  The default redactor covers common provider token formats and generic bearer
  tokens, with session-resolved keys always added exactly.
- **Agent layer (`@jxburros/ai-handler/agent`):** `defineTool` + light JSON-schema
  arg validation (object-ness, `required`, top-level `properties[key].type` —
  not full JSON Schema: no `enum`, nested schemas, `oneOf`, bounds, `pattern`,
  array `items`, or `additionalProperties`; validate again inside
  `tool.execute` if you need stricter guarantees), `runAgent()` model↔tool loop
  over the full handler pipeline,
  streamed `AgentEvent`s, budgets (`maxSteps`/`maxTokens`/`deadlineMs`) with honest
  `stopReason`s, `ApprovalGate` for side-effecting tools (deny is fed back to the
  model as data), and `native` / `promptJson` / `auto` tool modes. `auto` (the
  default) resolves per call from the connection's provider capability profile
  (`profileFor(provider).capabilities.nativeTools`) — hosted providers get
  `native`, local runtimes and the `openai-compat` escape hatch get
  `promptJson`, and an explicit `toolMode` always overrides the default.
  `promptJson` mode accepts a single `{"tool","input"}` directive or a batched
  `{"tools":[…]}` (a bare array works too), so the model can request several
  tools in one turn just like native tool-calling. Prompt-JSON history is
  serialized as plain text turns, not provider-native tool-call wire format.

```ts
import { runAgent, defineTool } from '@jxburros/ai-handler/agent';
```

## Commands

```bash
npm install
npm test            # Vitest contract suite in Node (97 tests; live tests skipped unless env-gated)
npm run test:browser   # same suite in headless Chromium (proves isomorphism)
npm run build       # tsc → dist/ (also the typecheck)
npm run build:nugget   # writes a vendorable nugget/ stamped with version + content hash
```

### Live smoke tests (optional, env-gated)

`tests/live-smoke.test.ts` exercises the real wire path against a live provider.
It is **skipped unless `AI_HANDLER_LIVE=1`**, so it never runs in the default
suite or in CI:

```bash
# Local Ollama (defaults: provider=ollama, model=llama3.2)
AI_HANDLER_LIVE=1 npm run test:live

# A cloud provider, with JSON-mode and agent tool-loop checks enabled
AI_HANDLER_LIVE=1 AI_HANDLER_LIVE_PROVIDER=openai AI_HANDLER_LIVE_MODEL=gpt-4o-mini \
  AI_HANDLER_LIVE_KEY_ENV=OPENAI_API_KEY AI_HANDLER_LIVE_JSON=1 AI_HANDLER_LIVE_TOOLS=1 \
  npm run test:live
```

Config env vars: `AI_HANDLER_LIVE_PROVIDER`, `AI_HANDLER_LIVE_MODEL`,
`AI_HANDLER_LIVE_BASE_URL`, `AI_HANDLER_LIVE_KEY` (literal) or
`AI_HANDLER_LIVE_KEY_ENV` (key from an env var), `AI_HANDLER_LIVE_JSON`,
`AI_HANDLER_LIVE_TOOLS`.

**Live provider matrix (`.github/workflows/live-matrix.yml`).** The default
CI workflow only exercises mocked fetch responses, so subtle live-wire
behavior differences (OpenAI, Anthropic, Google, OpenRouter, and local
runtimes each drift independently) can't surface there. `live-matrix.yml`
runs the same `tests/live-smoke.test.ts` suite against real endpoints —
manually (`workflow_dispatch`) or on a weekly schedule — never on push/PR, so
it can't block or flake a normal CI run. Each matrix entry reads its API key
from a same-named repository secret (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_API_KEY`, `OPENROUTER_API_KEY`) and skips itself with a notice if that
secret isn't configured, so you only need to add secrets for the providers
you actually use. Local runtimes (Ollama, llama.cpp, LM Studio, vLLM) aren't
in the matrix since they need a reachable server; smoke-test those manually
with the local `test:live` invocation above.

## Distribution

Two supported paths, in order of preference:

1. **GitHub Packages (primary).** `@jxburros/ai-handler` publishes to GitHub
   Packages on every published GitHub release (`.github/workflows/publish.yml`).
   Consuming apps add a project `.npmrc`:

   ```
   @jxburros:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

   (GitHub Packages requires an authenticated token even for public-repo
   packages.) Then `npm install @jxburros/ai-handler@^0.3.0` and update via
   ordinary version-bump PRs — fix once here, bump the dependency in each app.
2. **Vendored `nugget/` (fallback).** `nugget/` is a generated single-folder
   build (`src/` + `VERSION.txt` with a version + content-hash stamp) for repos
   that cannot take a package dependency. Copy it in; `VERSION.txt` makes drift
   from the source of truth detectable.

`dist/` (ESM + `.d.ts`) is the package's own build output. `dist/` and
`nugget/` are both committed and regenerated from `src/`; `prepublishOnly`
rebuilds both, and CI fails if either is stale.

## Examples

`examples/` has runnable scripts against local Ollama and llama.cpp servers,
`promptJson` vs. native tool-calling, an `ApprovalGate`, and telemetry — see
`examples/README.md`.

## Non-goals

Not a full agent framework (no planning/memory/RAG/multi-agent — the loop
consumes `messages` and stops there), not a router/recommender (apps choose
models; the handler exposes a `route`/`context` event so apps can report what they
chose), not a secrets vault (`KeySource` is a seam), and not a UI. The governance
seam ships neutral: it is where an app *can* enforce rules, not a place the
library imposes its own.
