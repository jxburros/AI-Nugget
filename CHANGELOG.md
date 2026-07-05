# Changelog

All notable changes to `ai-handler` are recorded here. This project follows the
phased build in `development-plan.md`; entries note which phase they advance.

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

- **Headless-browser CI.** The core is written to be isomorphic (only `fetch`,
  `ReadableStream`, `AbortController`, `TextDecoder`; no Node built-ins in
  `src/`), but a headless-Chromium test job (design §10) is not yet wired.
  Recorded as a follow-up rather than claimed.
- **Live env-gated smoke tests** (`AI_HANDLER_LIVE=1`) against local
  Ollama/llama.cpp and one live call per cloud provider are not included; the
  deterministic suite runs entirely on mocked `fetch`.
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
