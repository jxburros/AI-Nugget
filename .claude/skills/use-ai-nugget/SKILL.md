---
name: use-ai-nugget
description: Integrate the AI Nugget into an app — install or vendor it, make chat/stream calls, resolve keys, request JSON output, and handle typed errors. Use when writing app code that calls AI model providers through this library, or when wiring up connections, key sources, policy, or telemetry.
---

# Using AI Nugget in an app

`@jxburros/ai-nugget` is a small, zero-dependency, isomorphic TypeScript library
for calling AI model providers through one pipeline:

```
policy → key resolution → beforeCall hook → concurrency/retry → provider adapter → redacted telemetry
```

It runs identically in Node ≥ 20, browsers, and Web Workers. It is deliberately
NOT a router, prompt library, memory system, or secrets vault — the app owns
model choice, prompts, secret storage, and policy.

## Install or vendor

Two supported paths (see `README.md` → Distribution):

1. **GitHub Packages (preferred).** Add a project `.npmrc`:
   ```
   @jxburros:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```
   then `npm install @jxburros/ai-nugget`.
2. **Vendored `nugget/` (fallback).** Copy the repo's generated `nugget/` folder
   into the consuming repo. Its `VERSION.txt` carries a version + content hash so
   drift from the source of truth is detectable. Never hand-edit vendored files —
   fix upstream and re-vendor.

## Core calls

```ts
import { AIHandler, envKeySource } from '@jxburros/ai-nugget';

const handler = new AIHandler({ keySource: envKeySource() });

const conn = { id: 'main', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } };

// Non-streaming
const result = await handler.chat(conn, {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
});
// result: { text, toolCalls?, finishReason, usage, timing, model, source }

// Streaming — identical in Node route handlers, React, and Web Workers
for await (const event of handler.stream(conn, req)) {
  if (event.type === 'delta') out += event.text;
  if (event.type === 'error') handle(event.error);   // typed AIError
  if (event.type === 'done') use(event.result.usage);
}
```

Also on the handler: `listModels(conn)` and `testConnection(conn)` (their policy
operation IDs are `__listModels__` / `__testConnection__`).

**Never bypass the handler pipeline for model calls** — no raw `fetch` to
provider endpoints. The pipeline is what guarantees policy, key hygiene,
retries, and redacted telemetry.

## Connections and providers

A `Connection` is `{ id, provider, baseUrl?, keyRef?, timeoutMs?, headers? }`.
Supported providers (see `src/adapters/profiles.ts` for the full table):

- Hosted: `openai`, `azure-openai`, `openrouter`, `groq`, `deepseek`, `mistral`,
  `together`, `fireworks`, `anthropic`, `google`
- Local runtimes: `ollama`, `lmstudio`, `llamacpp`, `vllm` (no key needed)
- Escape hatch: any unknown provider name **with a `baseUrl`** resolves to
  `openai-compat`

Model identity is always `(source, model)`; `modelRef(source, model)` gives the
canonical `provider/model` key. `profileFor(provider, baseUrl).capabilities`
answers `{ nativeTools, jsonMode, local, embeddable }` — these are
provider-level defaults, not per-model guarantees.

## Keys

Keys enter ONLY through the `KeySource` seam and must never appear in logs,
errors, telemetry, or prompts. Built-ins (`src/keys.ts`): `envKeySource()`,
`literalKeySource()`, `memoryKeySource(values)`, `chainKeySources(...)`, and
`parseKeyRef(string)`. `KeyRef` kinds: `none | env | literal | stored | brokered`.
A missing key produces a typed failure (`AIError` kind `no_key`), never fake
success — do not "fix" that by inventing fallbacks.

## JSON output from models

AI JSON must be parsed and validated before app state or tools consume it:

- Request structured output with `responseFormat: { type: 'json', schema? }`.
  The adapter maps it to each provider's native mode (`response_format`,
  forced-tool, `responseMimeType`, `format: json`).
- Parse defensively with `extractJson(text)` (fenced/embedded/array tolerant)
  and validate with `extractJsonWithSchema(text, parse)` plus the `require*`
  guards in `src/json.ts`. Never `JSON.parse(result.text)` raw model output.

## Errors and retries

All failures are `AIError` with a `kind`
(`no_key | auth | rate_limit | timeout | canceled | network | server | bad_request | parse | policy | unsupported`),
plus `retryable`, `status?`, `retryAfterMs?`. The handler already does jittered
retries honoring `Retry-After`; don't wrap calls in your own retry loop.
Branch on `error.kind`, not on message strings.

## App-owned seams (optional)

- **Policy:** `blocklistPolicy(patterns)`, `allowlistPolicy(prefixesByProvider)`
  (fails closed for unlisted providers; `'*'` allows non-chat operation IDs),
  `composePolicies(...)`. The library ships no policy defaults — policy is the
  app's decision, configured at construction.
- **Telemetry:** pass a `TelemetrySink`; every call (success, failure, or
  abandoned stream) yields exactly one redacted `CallRecord`.
- **Redaction:** the default `Redactor` covers common token formats and always
  adds session-resolved keys exactly; extend rather than replace it.

Runnable end-to-end scripts live in `examples/` (Ollama, llama.cpp, agent
loops, approval gate, telemetry) — see `examples/README.md`.
