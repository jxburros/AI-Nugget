# Changelog

All notable changes to `ai-handler` are recorded here. This project follows the
phased build in `development-plan.md`; entries note which phase they advance.

## 2026-07-05 - Claude

### Changed

- Fixed deployment-readiness blockers from the AI-Nugget review: handler telemetry now records before `done`, records abandoned streams, removes aborted queue waiters, reserves concurrency slots before min-interval sleeps, stops retrying after visible output, caps `Retry-After`, and redacts yielded handler errors.
- Updated provider and agent correctness: OpenAI/Azure use `max_completion_tokens` and JSON schema response format where supported; Google avoids JSON MIME with tools, sends `responseSchema` when safe, and maps prompt safety blocks; Anthropic/Google batch parallel tool results; OpenRouter has a default `HTTP-Referer`; promptJson history is plain text; integer tool args and approval-modified args are validated; `deadlineMs` now drives an abort signal.
- Added MIT licensing, Node `>=20`, package `main`/`types`/`default` fallbacks, metadata, `sideEffects: false`, package-file pruning, pinned GitHub Actions, CI read permissions, release tag/package-version checking, `prepublishOnly` nugget rebuilds, and a structure-aware nugget hash.
- Routed `listModels()` and `testConnection()` through the governed pipeline with explicit operation IDs so key-bearing probes now hit policy, hooks, redaction, and telemetry.
- Backfilled regression coverage for the lifecycle, provider, key/policy, probe, and agent cases above. Node suite is now 97 deterministic tests plus 6 env-gated live skips.

### Not completed

- npmjs.org publishing was not enabled; GitHub Packages remains the configured registry.

### Notes

- Validation so far: `npm run typecheck`; `npm test` (97 passed, 6 env-gated skips).

## 2026-07-05 - Claude

Closes the v0.3 "adoption-ready" punch list: `toolMode: 'auto'` now does
something real, provider profiles carry capability metadata, the
OpenAI-compatible adapter respects it, and distribution is decided and
documented. Bumped `version` to `0.3.0`.

### Changed

- **`toolMode: 'auto'` is now real.** Previously anything other than
  `'promptJson'` (including `'auto'` and the default) sent native tools
  unconditionally. `runAgent` now resolves `'auto'` per call from
  `profileFor(connection.provider, connection.baseUrl).capabilities.nativeTools`:
  hosted providers (openai, anthropic, google, azure-openai, openrouter, groq,
  deepseek, mistral, together, fireworks) resolve to `native`; local runtimes
  (ollama, lmstudio, llamacpp, vllm) and the `openai-compat` escape hatch
  resolve to `promptJson`, since native tool support there is model-dependent,
  not protocol-guaranteed. An explicit `toolMode: 'native' | 'promptJson'`
  still always wins.
- **Provider capability metadata.** Added `ProviderProfile.capabilities`
  (`nativeTools`, `jsonMode`, `local`, `embeddable`) alongside the existing
  wire-format `quirks`, so apps (and the agent loop) can answer "does this
  provider support native tools / a real JSON mode / run locally?" without
  hardcoding a provider list. `profileFor()` fallback (`openai-compat` and
  unknown providers) gets the conservative local-runtime defaults.
- **OpenAI-compatible adapter respects `supportsUsageInStream`.** The engine
  previously sent `stream_options: { include_usage: true }` on every request
  regardless of profile. It's now conditional on the quirk (only set for
  `openai` and `openrouter` today), so llama.cpp/LM Studio/vLLM/other local
  OpenAI-compatible servers that don't expect the option no longer receive it.
- **Distribution decided: GitHub Packages is the primary path.** Removed
  `"private": true`; added `repository`, `publishConfig` (GitHub Packages
  registry), a `prepublishOnly` build step, and
  `.github/workflows/publish.yml` (publishes on GitHub release). The
  vendorable `nugget/` folder remains the documented fallback for repos that
  can't take a package dependency. README's "Distribution" section spells out
  both paths and the `.npmrc` an app needs.
- **Examples.** Added `examples/` with runnable scripts against `dist/`:
  local Ollama, local llama.cpp, `promptJson` tool-calling, native
  tool-calling (via `auto`), an `ApprovalGate`, and telemetry — see
  `examples/README.md`. None run in CI (they hit real local/hosted
  endpoints), matching the live-smoke-test convention.
- **Tests.** Added coverage for `auto` resolving to native for a hosted
  provider and to `promptJson` for a local-runtime provider, for an explicit
  `toolMode` overriding the resolved default, for capability metadata per
  profile, and for the `stream_options` quirk gating (79 tests, was 72).

### Not completed

- None.

### Notes

- Validation: `npm test` (79 passed, 6 env-gated skips), `npm run test:browser`
  (79 passed in headless Chromium), `npm run build`, `npm run build:nugget` —
  `dist/` and `nugget/` regenerated so the committed builds are not stale.
  Live smoke tests skipped (env-gated, not run). Manually ran each new example
  under `examples/` against `dist/`; without local Ollama/llama.cpp or an API
  key present they fail honestly (a typed/logged error, not a crash or a
  silent no-op).

## 2026-07-05 - Claude

### Changed
- **`promptJson` mode can request several tools per turn.** `callsFromPromptJson`
  now parses the batched `{"tools":[…]}` form and a bare array of directives in
  addition to the single `{"tool","input"}` object, so a promptJson-mode model
  reaches parity with native multi-tool calling. Malformed entries are skipped,
  not thrown. The injected system instruction now documents both forms. Added an
  agent test covering two tools from one promptJson turn (72 tests, was 71).
- **Archived background docs.** Moved `report.md`, `development-plan.md`, and
  `ai-handler-handoff.md` under `docs/archive/`; `design.md` remains the living
  contract. Updated `README.md` and `design.md` cross-references accordingly.

### Not completed
- None.

### Notes
- Validation: `npm test` (72 passed, 6 env-gated skips), `npm run test:browser`
  (72 passed), `npm run build`, and `npm run build:nugget` — `dist/` and
  `nugget/` regenerated so the committed builds are not stale. Live smoke tests
  skipped (env-gated, not run).

## 2026-07-05 - Claude (follow-up: browser CI + live smoke)

Resolves the two items left open in the entry below — headless-browser CI and
env-gated live smoke tests (design §10 / development-plan Phase 2).

### Changed

- **Headless-Chromium test run.** Added `vitest.browser.config.ts` (Playwright
  provider via `@vitest/browser-playwright`) and a `test:browser` script that
  runs the full contract suite in a real browser, proving the isomorphism claim.
  The config prefers a pre-provisioned Chromium (`CHROMIUM_PATH` /
  `/opt/pw-browsers/chromium`) and otherwise falls back to Playwright's own
  download, so it works both in sandboxes and in GitHub CI. Added a `browser`
  CI job (`npx playwright install --with-deps chromium` → `npm run test:browser`).
  Dev-only deps added: `@vitest/browser`, `@vitest/browser-playwright`,
  `playwright` (no runtime deps changed).
- **Env-gated live smoke tests.** Added `tests/live-smoke.test.ts` (+ `test:live`
  script), skipped unless `AI_HANDLER_LIVE=1`, exercising the real wire path
  against a live provider (local Ollama by default; any profile via
  `AI_HANDLER_LIVE_PROVIDER`/`_MODEL`/`_BASE_URL`/`_KEY`/`_KEY_ENV`). Covers
  connection health, model listing, streaming (deltas/usage/timing), buffered
  `chat()`, and optional JSON-mode (`AI_HANDLER_LIVE_JSON=1`) and agent tool-loop
  (`AI_HANDLER_LIVE_TOOLS=1`) checks. Excluded from the browser project.

### Not completed

- None.

### Notes

- Validation: `npm test` → 71 pass, 6 live tests skipped (gate off).
  `npm run test:browser` → **71 pass in headless Chromium**. `npm run build`
  clean. The live gate was confirmed to *activate* under `AI_HANDLER_LIVE=1`
  (it ran and failed honestly with no local Ollama present), proving it exercises
  the wire path rather than silently skipping. No live provider runs in CI.
- `dist/`/`nugget/` are unchanged this round (no `src/` edits); only tests,
  config, docs, and dev dependencies changed.

## 2026-07-05 - Claude

Completes the `ai-handler` nugget from the working scaffold described in
`ai-handler-handoff.md` up to the v0.2.0 milestone (core pipeline + provider
contract suite + agent layer). Bumped `version` to `0.2.0`.

### Changed

- **Transport (Phase 1 hardening).** Streaming now keeps the merged
  timeout+abort signal alive for the *whole* stream lifetime instead of only the
  connection handshake, so external cancellation and the timeout apply
  mid-stream. Replaced `postJsonResponse` (which cleaned up its own timeout in a
  `finally`, severing the abort link before the body streamed) with
  `postResponse`, and moved timeout ownership into each engine's `stream()` via
  the shared `streamTimeout`/`streamError` helpers in `adapters/engines/base.ts`.
- **Anthropic engine (Phase 2).** Implemented the full SSE event sequence
  (`message_start`, `content_block_start/delta/stop`, `message_delta`,
  `message_stop`), native `tool_use` streaming via `input_json_delta`
  accumulation keyed by content-block index, and the **forced-tool JSON mode**
  for `responseFormat: { type: 'json' }` (a synthetic `json_output` tool with
  `tool_choice`) — closing the portfolio-wide "Anthropic has no JSON mode" gap.
  Added `stop_reason` → `finishReason` mapping, tool-call/tool-result message
  round-tripping, and the required `anthropic-version` header to the profile.
- **Google/Gemini engine (Phase 2).** Added `functionCall` part parsing into
  `tool_call` events, `functionResponse`/`functionCall` message round-tripping,
  `toolConfig.functionCallingConfig` from `toolChoice`, `finishReason` mapping
  (incl. `SAFETY` → `content_filter`), stop sequences, and non-SSE array body
  handling.
- **Ollama engine (Phase 2).** Fixed the native tools payload to the
  `{ type: 'function', function: {…} }` shape, added `/api/show`
  context-window + capability probing to `listModels` (best-effort, degrades
  gracefully), `done_reason` → `finishReason` mapping, tool-call arg handling,
  and JSON-schema `format` passthrough.
- **OpenAI-compatible engine (Phase 2).** Added `finish_reason` mapping
  (`length`/`content_filter`/`tool_calls`), a `stream_anomaly` context event
  when a stream ends without a terminal `finish_reason`, tolerance for malformed
  SSE frames, and tool `name` passthrough on tool-result messages.
- **Handler pipeline (Phase 3).** Key-resolution failures
  (`missing`/`locked`/`denied`) are now recorded as a `CallRecord` and yielded as
  an `error` event instead of throwing out of `stream()` — the "one record per
  call, including failures" contract now holds for every seam. Made metadata
  redaction robust: non-JSON-serializable metadata (circular refs, BigInt) is
  replaced with a sentinel instead of crashing the telemetry path.
- **Agent loop (Phase 3b).** Fixed a latent bug where `return yieldDone(...)`
  returned the terminal sub-generator from the async generator without
  delegating to it — so `agent_done` was never emitted and the `result` promise
  never resolved. Now delegates with `yield*`. Added handling for handler-level
  failures surfaced as `error` events (auth, policy, cancellation) so the loop
  stops with an honest `stopReason` rather than a silent empty completion. Tool
  result messages now carry the tool `name` (needed for Gemini round-trips).
- **Types.** Added an optional `ChatMessage.name` (tool-result naming) — a
  backward-compatible extension used by the OpenAI and Gemini engines.
- **Repo hygiene (Phase 0).** Added `.gitignore`, this `CHANGELOG.md`, and a
  GitHub Actions CI workflow (typecheck/build + contract tests on Node 18/20/22,
  plus a `nugget-drift` job that fails if committed `dist/`/`nugget/` are stale).
- **Docs.** Rewrote `README.md` to reflect the completed engines, agent layer,
  provider matrix, and validation commands.

### Not completed

- **Headless-browser CI** and **live env-gated smoke tests** — both addressed in
  the follow-up entry above (this entry's original state is preserved for
  history).
- **Downstream adoption (Phases 4–8).** No changes were made to the five
  portfolio repos (AI-model-test, AI-Server-Studio, Blobsmith, locus-os,
  ai-agent-skills); those are separate per-repo efforts governed by each repo's
  own process. This change completes only the shared nugget itself.
- **Git tags `v0.1.0`/`v0.2.0`** were not pushed (outward-facing repo mutation);
  the milestone is reflected in `package.json` version `0.2.0`.

### Notes

- Validation: `npm run build` (tsc, clean) and `npm test` (Vitest) both pass —
  **71 tests across 12 files** (up from 9/4 at handoff). New suites:
  `engine-openai`, `engine-anthropic`, `engine-google`, `engine-ollama`,
  `profiles`, `agent`, `handler-pipeline`, plus the original transport/json/
  keys-redact/handler tests. `npm run build:nugget` regenerates the stamped
  `nugget/`. No live network calls were made.
- Contract coverage per engine: happy-path streaming, buffered-despite-`stream`,
  native tool-call round-trip, forced-tool JSON mode (Anthropic), 401/429/500
  classification, Retry-After, malformed frames, stream anomaly, first-token
  latency, usage normalization, and mid-stream abort.
- Governance still ships **neutral** — no default block patterns; only the
  `blocklistPolicy`/`allowlistPolicy`/`composePolicies` constructors. No
  xAI/Grok profile is shipped, per the support policy in `design.md` §1.
