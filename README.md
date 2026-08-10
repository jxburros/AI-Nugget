# AI Nugget

**Version 0.6.0** · [What's changed since 0.5.0](#whats-changed-since-050) · [Changelog](./CHANGELOG.md) · [Upgrading](./UPGRADING.md)

A small, zero-dependency, isomorphic TypeScript nugget for talking to AI model
providers through one pipeline:

```
policy → key resolution → beforeCall hook → concurrency/retry → provider adapter → redacted telemetry
```

19 provider profiles over 4 protocol engines. Runs identically in Node, the
browser main thread, and Web Workers using only `fetch`, `ReadableStream`,
`AbortController`, and `TextDecoder`. MIT licensed.

It is intentionally **not** a router, prompt library, memory system, or secrets
vault: apps choose models, own prompts, store secrets, and decide policy.

## Quick start

Requires Node `^20.19.0` or `>=22.12.0` ([why](./docs/distribution.md#requirements)).

```bash
npm install @jxburros/ai-nugget
```

```ts
import { AIHandler, envKeySource } from '@jxburros/ai-nugget';

const handler = new AIHandler({ keySource: envKeySource() });

const conn = { id: 'main', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } };
const req = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello!' }] };

// Non-streaming
const result = await handler.chat(conn, req);
console.log(result.text, result.usage, result.finishReason);

// Streaming (Node route handlers, React, Web Workers — same code)
for await (const event of handler.stream(conn, req)) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log('\n', event.result.usage);
  if (event.type === 'error') console.error(event.error.kind, event.error.message);
}
```

No key? Point at a local model instead — same code, no `keyRef`:

```ts
const conn = { id: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' };
```

CommonJS works too: `const { AIHandler } = require('@jxburros/ai-nugget')`.

For a running server, copy a starter from
[`examples/integrations/`](./examples/integrations/) — Express, Next.js,
Cloudflare Workers, or local Ollama.

## Two things to configure before production

Both are seams the library leaves open on purpose, and both are easy to miss:

1. **Never take `provider` or `baseUrl` from client input.** They decide where
   your resolved API key gets sent. Keep connections on a server-side allowlist
   and let clients pick an id. → [security.md](./docs/security.md#ssrf-caller-controlled-baseurl)
2. **Configure a `GovernancePolicy`.** With none, every provider and model is
   allowed; the handler logs a startup notice so this is visible at runtime.
   → [security.md](./docs/security.md#governance-is-neutral-by-default)

```ts
new AIHandler({
  keySource: envKeySource(),
  policy: allowlistPolicy({ openai: ['gpt-4o', 'gpt-4o-mini'], ollama: ['*'] }),
});
```

## Documentation

| Doc | Covers |
|---|---|
| [providers.md](./docs/providers.md) | The 19 profiles, which are **live-verified vs mock-verified vs config-only**, capabilities, JSON-mode/tools limits, `openai-compat`, model discovery |
| [reliability.md](./docs/reliability.md) | `timeoutMs` vs `idleTimeoutMs`, why retries stop after output is emitted, double-billing and idempotency, why limits are per-instance |
| [security.md](./docs/security.md) | Key handling, redaction coverage, SSRF, opt-in injection defenses, the secure-tool recipe |
| [agent-loop.md](./docs/agent-loop.md) | `runAgent`, tool modes, budgets and what happens mid-step, the approval gate |
| [recipes.md](./docs/recipes.md) | Env-based connections, JSON output + validation, the error-handling matrix, telemetry |
| [integrations.md](./docs/integrations.md) | The host matrix CI runs (Node, Next.js, Workers, local runtime, packaging) |
| [distribution.md](./docs/distribution.md) | Commands, live smoke tests, CI workflows, npm/GitHub Packages/vendored `nugget/`, bundler notes |
| [design.md](./design.md) | The full contract |
| [state-of-the-nugget.md](./docs/state-of-the-nugget.md) | Current health snapshot: architecture, safety and reliability posture, coverage gaps, what's next |
| [UPGRADING.md](./UPGRADING.md) | Version-by-version changes |

## What's in the box

- **Core** — message-based contracts (`types.ts`), typed `AIError` + `classify()`
  with wire-boundary redaction, timeout/idle-timeout/abort merging and SSE/NDJSON
  readers (`transport.ts`), defensive JSON extraction with schema guards
  (`json.ts`), token estimation with an explicit `estimated` flag.
- **Adapters** — four engines (`openaiChat`, `anthropic`, `google`, `ollama`)
  with streaming, native tool-calling, JSON modes, `finishReason` mapping,
  buffered-`stream:true` fallback, reasoning-token channel, first-token latency,
  usage normalization, and truncation detection (`stream_anomaly`). Provider
  differences live in a data-driven profile table, not in copies of the SSE loop.
- **Pipeline (`AIHandler`)** — `chat`, `stream`, `chatParsed`, `embed`,
  `listModels`, `testConnection`, `prewarm`. Every call — success, failure, or
  abandoned stream — produces exactly one redacted `CallRecord`. Retries are
  jittered and honor `Retry-After`; telemetry or `afterCall` failures never
  re-run a completed provider call.
- **Seams** — `KeySource` (env/literal/memory/chain + ref parsing), `Redactor`,
  neutral `GovernancePolicy` (`blocklistPolicy`/`allowlistPolicy`/`composePolicies`),
  `TelemetrySink`, and an optional `pricing` hook. `providerOptions` passes
  provider-native fields through without waiting for a library release.
- **Agent layer** (`@jxburros/ai-nugget/agent`) — `defineTool`, `runAgent()`
  model↔tool loop over the full pipeline, streamed `AgentEvent`s, budgets with
  honest `stopReason`s, an `ApprovalGate` for side-effecting tools, and
  `native`/`promptJson`/`auto` tool modes.

## What's changed since 0.5.0

**0.6.0 is backward-compatible** — every change below is additive. The one thing
to check is the new `not_found` error kind if you `switch` exhaustively over
`AIErrorKind`; see [UPGRADING.md](./UPGRADING.md#05x--060). Full detail lives in
the [changelog](./CHANGELOG.md).

- **Security & correctness** — `beforeCall` hooks now receive a scrubbed
  connection (masked literal `keyRef` and auth headers, safe to log);
  `classify()` redacts provider response excerpts at the wire boundary so an
  `AIError` can never carry an unredacted secret; label-anchored redaction
  covers unprefixed secrets (Azure `api-key`, AWS keys, `client_secret`, session
  tokens); a new `not_found` error kind distinguishes 404/410 from a malformed
  request; and Ollama tool-call arguments coerce through the shared parser so a
  llama.cpp-style backend sending JSON-as-string no longer fails.
- **Observability** — `stream_anomaly` detection now fires on all four engines
  (not just `openaiChat`); Google and Anthropic emit `json_mode_downgraded` when
  a JSON mode is dropped for tools; `AIHandler` logs a startup notice when no
  `GovernancePolicy` is configured; and OpenAI requests carry a stable
  `Idempotency-Key` across retries to mitigate double-billing.
- **Providers & types** — `openai-compat` is now `keyOptional`, matching the
  other local-runtime profiles, so keyless servers (including JX Runtime) work
  without a `keyRef`; `Connection.provider` is typed `KnownProvider | (string &
  {})` for autocomplete and typo-catching with the escape hatch still open.
- **Docs & examples** — `README.md` was trimmed to a front door with reference
  material moved under [`docs/`](./docs/) (`providers`, `reliability`,
  `security`, `agent-loop`, `recipes`, `integrations`, `distribution`), and
  [`examples/integrations/`](./examples/integrations/) added five CI-verified
  starters (Express, Next.js, Cloudflare Workers, local Ollama, ESM/CJS
  packaging check).

## Contributing

`AGENTS.md` is the always-on baseline — invariants, required reading, and the
[admission test](./AGENTS.md#feature-admission-test) a new feature has to pass.
`.claude/skills/` holds task-specific guides (`use-ai-nugget`,
`build-agent-loop`, `add-provider`, `develop-nugget`) that Claude Code loads
automatically and any agent or human can read as plain Markdown.

```bash
npm test              # Node contract suite
npm run test:browser  # same suite in headless Chromium (isomorphism)
npm run build && npm run build:nugget
```

Full command list and CI layout: [distribution.md](./docs/distribution.md).

## Examples

`examples/` has runnable scripts (local Ollama, llama.cpp, `promptJson` vs
native tools, approval gates, telemetry, a model picker), a small chat demo
(`npm run demo:steel-chat`), three mini-apps consuming the published package,
and the CI-verified [integration starters](./examples/integrations/). See
`examples/README.md`.

## Non-goals

Not a full agent framework (no planning/memory/RAG/multi-agent), not a
router/recommender (apps choose models), not a secrets vault (`KeySource` is a
seam), and not a UI. The governance seam ships neutral: it is where an app *can*
enforce rules, not a place the library imposes its own.

<!-- GitHub Pages deployment is configured in .github/workflows/pages.yml. -->
