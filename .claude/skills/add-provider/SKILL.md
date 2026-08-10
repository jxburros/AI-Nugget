---
name: add-provider
description: Add or modify an AI provider in AI Nugget's profile table — engines, quirks, capabilities, auth modes, and the tests that must accompany a profile change. Use when asked to support a new model provider, change a provider's defaults, or debug provider-specific wire behavior.
---

# Adding or changing a provider

Read `src/adapters/profiles.ts` in full before touching providers (this is a
hard rule from `AGENTS.md`).

## Architecture: engines vs profiles

Four **protocol engines** own the wire formats (`src/adapters/engines/`):
`openaiChat`, `anthropic`, `google`, `ollama`. A data-driven **profile table**
(`PROVIDER_PROFILES` in `src/adapters/profiles.ts`) turns each named provider
into defaults + quirks on top of an engine.

**Adding an OpenAI-compatible provider is a table row, not a new engine.** Do
not copy the SSE loop or add per-provider `if` branches in engines; encode
differences as declarative `quirks`. Only a genuinely new wire protocol
justifies a new engine (rare — discuss first).

`adapterFor(provider)` lives once, in `src/adapters/index.ts`. Unknown provider
names with a `baseUrl` already resolve to the `openai-compat` escape hatch, so
many "new providers" need no code at all — check that first.

## A profile row

```ts
myprovider: {
  engine: 'openaiChat',
  defaultBaseUrl: 'https://api.myprovider.com/v1',
  auth: 'bearer',            // bearer | x-api-key | x-goog-api-key | api-key-header | none
  listModelsPath: '/models',
  capabilities: HOSTED_CLOUD, // or LOCAL_RUNTIME — see below
  quirks: { supportsUsageInStream: true, supportsJsonSchema: true },
},
```

Available `quirks`: `keyOptional`, `modelOptional`, `urlTemplate`,
`supportsUsageInStream`, `maxTokensRequired`,
`maxTokensParam: 'max_tokens' | 'max_completion_tokens'`, `supportsJsonSchema`.
Only set `supportsUsageInStream` when the server actually accepts
`stream_options.include_usage` — local servers that don't must never receive it.

## Capabilities

`capabilities: { nativeTools, jsonMode, local, embeddable }` answers the
higher-level questions apps ask (and drives the agent loop's `toolMode: 'auto'`).
Conventions:

- Hosted cloud providers: `HOSTED_CLOUD` = `{ nativeTools: true, jsonMode: true, local: false, embeddable: false }`.
- Local runtimes: `LOCAL_RUNTIME` = `{ nativeTools: false, jsonMode: false, local: true, embeddable: true }` —
  conservative because tool support there is model-dependent, not
  protocol-guaranteed. (`ollama` is the one exception with `jsonMode: true`;
  its `format: 'json'` is engine-enforced.)

These are per-provider defaults, not per-model guarantees — don't "upgrade" a
local runtime's capabilities because one model happens to support tools.

## Writing or changing an engine: the timeout contract

`AIHandler` never creates a timeout of its own. It forwards `req.signal` and
nothing else, so **whether a call can hang at all is decided entirely inside the
adapter** — and the handler cannot verify or enforce it. An adapter that skips
this leaves a provider that opens a connection and never writes hanging with no
upper bound anywhere in the system.

Every adapter must:

- Open the scope with `streamTimeout(conn, req.signal)` (applies
  `conn.timeoutMs ?? DEFAULT_TIMEOUT_MS` plus `conn.idleTimeoutMs`) and pass
  `timeout.signal` — not `req.signal` — to `postResponse`.
- Call `timeout.bump()` on **every** received chunk, so `idleTimeoutMs` rearms
  and a slow-but-healthy stream isn't killed.
- Call `timeout.done()` in a `finally`, only after the body is fully consumed.
- Pass an explicit `timeoutMs` to every `fetchJson` (including `listModels` and
  `health` probes — cap probes lower, e.g. `Math.min(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000)`).
- Wrap failures with `streamError(error, timeout, conn.provider)` so a fired
  timeout is reported as `kind: 'timeout'` rather than a generic abort.

Shared engine helpers live in `src/adapters/engines/base.ts` — `parseArgs`
(string-or-object tool arguments), `safeParse`, `randomId`, `streamAnomaly`,
`streamError`, `streamTimeout`, `listOpenModels`, `health`. Import them; don't
re-implement them per engine.

Emit `streamAnomaly()` when a stream ends without the provider's terminal
marker, so truncation is diagnosable identically across engines. If the engine
silently downgrades a requested capability (Gemini and Anthropic drop JSON mode
when tools are present), emit a `json_mode_downgraded` context event rather than
changing behavior in silence.

## Policy boundaries

- **Grok/xAI is intentionally neither blocked nor integrated.** Users can point
  `openai-compat` at any endpoint; that is their configuration, not a supported
  profile. Do not add it.
- Do not bake provider blocklists/allowlists into the library — governance is
  the app's seam (`blocklistPolicy` / `allowlistPolicy`), never a library default.

## Required follow-through for any provider change

1. Update `tests/profiles.test.ts` (and the relevant `tests/engine-*.test.ts`
   if wire behavior changes) — mocked-fetch contract tests, no live calls.
2. Update the provider table **and the verification-status table** in
   `docs/providers.md` — a new row is `mock-verified` or `configuration-only`
   until it is actually exercised live. Do not list it as live-verified without
   live-matrix coverage.
3. Consider adding the provider to `.github/workflows/live-matrix.yml` if it is
   hosted and worth a weekly live smoke test (keyed by a same-named repo secret).
4. Run the full validation from `AGENTS.md`: `npm test`,
   `npm run test:browser`, `npm run build`, `npm run build:nugget`.
5. Optionally smoke it live:
   `AI_HANDLER_LIVE=1 AI_HANDLER_LIVE_PROVIDER=… AI_HANDLER_LIVE_MODEL=… AI_HANDLER_LIVE_KEY_ENV=… npm run test:live`.
