# ai-handler

`ai-handler` is a small, zero-dependency, isomorphic TypeScript nugget for
talking to AI model providers through one pipeline:

```
policy → key resolution → beforeCall hook → concurrency/retry → provider adapter → redacted telemetry
```

It runs identically in Node ≥ 18, the browser main thread, and Web Workers using
only `fetch`, `ReadableStream`, `AbortController`, and `TextDecoder`. It is
intentionally **not** a router, prompt library, memory system, or secrets vault:
apps choose models, own prompts, store secrets, and decide what policy to enforce.

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
| `openaiChat` | `openai`, `azure-openai`, `openrouter`, `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `lmstudio`, `llamacpp`, `vllm`, `openai-compat` | SSE + `stream_options.include_usage` | `tools`/`tool_calls` deltas | `response_format: json_object` |
| `anthropic` | `anthropic` | SSE (`content_block_delta`) | `tool_use` blocks (streamed) | forced-tool JSON mode |
| `google` | `google` | SSE (`streamGenerateContent`) | `functionDeclarations` | `responseMimeType` |
| `ollama` | `ollama` | NDJSON | native `tools` | `format: json` |

`adapterFor(provider)` lives once, in `adapters/index.ts`. Unknown provider keys
with a `baseUrl` resolve to the `openai-compat` escape hatch. **Grok/xAI is not
blocked and is never officially integrated** — point `openai-compat` at any
endpoint if you must; that is your configuration, not a supported profile.

Each profile declares **static capabilities** (`nativeTools`, `jsonMode`), read
via `providerCapabilities(provider, baseUrl)`. These drive real behavior: the
agent's `toolMode: 'auto'` resolves to native tool-calling on providers that
advertise `nativeTools` and to the `promptJson` floor otherwise (local/model-
dependent servers), and the OpenAI engine only sends `response_format` where a
`jsonMode` exists. Provider **quirks** likewise shape the wire request, not just
the URL — `supportsUsageInStream` gates `stream_options`, `modelOptional` omits
the `model` field for single-model llama.cpp servers, and `urlTemplate` builds the
Azure deployment path. See **`docs/providers.md`** for the local/self-hosted
providers (Ollama, llama.cpp, openai-compat) documented separately.

Model identity is always `(source, model)` — `modelRef(source, model)` gives the
canonical `provider/model` key so the same weights served by different hosts stay
distinct and comparable.

## What's implemented

- **Core:** message-based contracts (`types.ts`), typed `AIError` + `classify()`,
  timeout/abort merging and SSE/NDJSON readers (`transport.ts`), defensive JSON
  extraction with array support + schema guards (`json.ts`), token estimation with
  an explicit `estimated` flag (`tokens.ts`).
- **Adapters:** all four engines with streaming, native tool-calling, JSON modes,
  `finishReason` mapping, buffered-`stream:true` fallback, first-token latency,
  and usage normalization; the full v1 provider profile table.
- **Pipeline (`AIHandler`):** policy → keys → `beforeCall` → concurrency/min-interval
  → jittered retry (honoring `Retry-After`) → redacted `CallRecord` telemetry →
  `afterCall`, with `chat`, `stream`, `listModels`, `testConnection`. Every call —
  success or failure — produces exactly one redacted telemetry record.
- **Seams:** `KeySource` (`env`/`literal`/`memory`/chain + ref parsing),
  `Redactor` (default secret patterns + session-resolved key redaction),
  neutral `GovernancePolicy` (`blocklistPolicy`/`allowlistPolicy`/`composePolicies`).
- **Agent layer (`@jxburros/ai-handler/agent`):** `defineTool` + JSON-schema arg
  validation, `runAgent()` model↔tool loop over the full handler pipeline,
  streamed `AgentEvent`s, budgets (`maxSteps`/`maxTokens`/`deadlineMs`) with honest
  `stopReason`s, `ApprovalGate` for side-effecting tools (deny is fed back to the
  model as data), and `native` / `promptJson` / `auto` tool modes. `auto` (the
  default) resolves per connection from provider capabilities — native where the
  provider supports function-calling, promptJson otherwise. `promptJson`
  mode accepts a single `{"tool","input"}` directive or a batched
  `{"tools":[…]}` (a bare array works too), so the model can request several
  tools in one turn just like native tool-calling.

```ts
import { runAgent, defineTool } from '@jxburros/ai-handler/agent';
```

## Commands

```bash
npm install
npm test            # Vitest contract suite in Node (71 tests)
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

## API stability

The public contract is the exported surface of `@jxburros/ai-handler` and
`@jxburros/ai-handler/agent` — the types in `src/types.ts`, the `AIHandler`
pipeline, the seams (`KeySource`, `GovernancePolicy`, `Redactor`, `TelemetrySink`),
the `adapters/index.ts` factory + profile helpers (`profileFor`,
`providerCapabilities`), and the agent layer (`runAgent`, `defineTool`,
`ApprovalGate`). `design.md` is the authoritative description of these shapes.

- **Pre-1.0 (current, `0.x`):** the shapes above are stable enough to build on;
  additive changes (new providers, new optional fields, new capabilities) land in
  minor versions. Any breaking change to an existing shape is called out in
  `CHANGELOG.md` with a migration note and bumps the minor while `0.x`.
- **Everything else is implementation detail** — engine internals, `raw` bodies,
  and non-exported helpers may change without notice. Depend only on the exported
  surface, and pin an exact version (or a vendored `VERSION.txt` hash) so a
  provider API change is one intentional bump, not a surprise across repos.

## Distribution

**Decision: ship both, package-first.** `ai-handler` is distributed as a private
package **and** a vendorable folder, and both are first-class:

- **Package** — `dist/` is the package output (ESM + `.d.ts`), published as
  `@jxburros/ai-handler` (private, GitHub Packages). This is the default path for
  any repo that can take a dependency; it gets versioned upgrades and dedupes one
  copy across the portfolio.
- **Vendored** — `nugget/` is the single-folder build (`src/` + `VERSION.txt` with
  a version + content-hash stamp) for repos that cannot take a dependency. Copy it
  in; the ai-agent-skills drift check flags a stale vendored copy against its hash.

Both are committed and regenerated from `src/` by `npm run build` /
`npm run build:nugget`; the identical API means vendoring only changes the import
path. CI fails if either committed build is stale (`nugget-drift` job). See
`docs/MIGRATION.md` for choosing a model per repo.

## Docs & examples

- **`docs/providers.md`** — Ollama, llama.cpp, and openai-compat documented
  separately, plus capabilities/quirks reference and how to add a provider.
- **`docs/MIGRATION.md`** — adoption steps, seam wiring, and behavioral migration
  notes.
- **`examples/`** — runnable integrations: basic chat/stream, an SSE route, an
  agent with tools + approval, a keyless local Ollama run, and the governance/
  telemetry seams.
- **`design.md`** — the full contract; `docs/archive/` holds the evidence base and
  phased build/adoption plan.

## Non-goals

Not a full agent framework (no planning/memory/RAG/multi-agent — the loop
consumes `messages` and stops there), not a router/recommender (apps choose
models; the handler exposes a `route`/`context` event so apps can report what they
chose), not a secrets vault (`KeySource` is a seam), and not a UI. The governance
seam ships neutral: it is where an app *can* enforce rules, not a place the
library imposes its own.
