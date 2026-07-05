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
  model as data), and `native` / `promptJson` / `auto` tool modes. `promptJson`
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

## Distribution

`dist/` is the package output (ESM + `.d.ts`); `nugget/` is the vendorable
single-folder build (`src/` + `VERSION.txt` with a version + content-hash stamp)
for repos that copy the code in rather than depend on the package. Both are
committed and regenerated from `src/`. CI fails if either is stale.

## Non-goals

Not a full agent framework (no planning/memory/RAG/multi-agent — the loop
consumes `messages` and stops there), not a router/recommender (apps choose
models; the handler exposes a `route`/`context` event so apps can report what they
chose), not a secrets vault (`KeySource` is a seam), and not a UI. The governance
seam ships neutral: it is where an app *can* enforce rules, not a place the
library imposes its own.
