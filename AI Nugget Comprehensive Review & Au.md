# AI Nugget Comprehensive Review & Audit

**Repository:** https://github.com/jxburros/AI-Nugget  
**Version audited:** `0.4.0` (commit `HEAD` at clone time)  
**Audited:** 2026-07-09  
**Scope:** `src/`, `tests/`, `examples/`, `package.json`, `tsconfig.json`, CI workflows, build/distribution, security posture, and runtime environment.

---

## Executive Summary

AI Nugget is a well-architected, zero-runtime-dependency, isomorphic TypeScript library for AI model calls. It cleanly separates protocol engines (OpenAI-compatible, Anthropic, Google, Ollama) from provider profiles, enforces a consistent handler pipeline with policy, key resolution, retries, telemetry, and redaction, and ships a lightweight agent loop. The codebase is small, focused, and well-documented.

**Validation run in this session (after switching to Node 22):**
- `npm run build` — pass
- `npm run typecheck` — pass
- `npm test` — 105 passed, 6 skipped (live-gated)
- `npm run test:browser` — 105 passed in headless Chromium
- `npm run build:nugget` — pass
- `npm run test:live` — skipped (no `AI_HANDLER_LIVE` env)
- `npm audit` — 0 vulnerabilities
- No secrets found in code (only fake test tokens)

**Most important findings:**
1. `package.json` declares `engines: { node: ">=20" }`, but the current dependency tree (vitest → rolldown) requires `^20.19.0 || >=22.12.0`. On Node 20.18.1 the lockfile cannot resolve `rolldown` native bindings.
2. No lint/format tooling is configured; only `tsc --noEmit` and vitest enforce quality.
3. A small `crypto.randomUUID()` inconsistency in `src/agent/loop.ts` vs. `globalThis.crypto?.randomUUID?.()` used elsewhere may trip in non-Node/browser runtimes.
4. A few edge cases where malformed provider responses are silently swallowed rather than surfaced as errors.

No critical security bugs were found. The key-hygiene, redaction, and pipeline design are sound. Issues below are mostly **operational, code-quality, or hardening** opportunities.

---

## 1. Architecture & Design

### Strengths

- **Isomorphic core.** `src/` uses only `fetch`, `ReadableStream`, `AbortController`, `TextDecoder` and global `crypto`. No `fs`, `path`, `process` (except `util.globalEnv()`), or Node buffers. The browser test suite proves this.
- **Engine/profile split.** `src/adapters/engines/` contains four protocol engines; `src/adapters/profiles.ts` contains provider-specific defaults, auth, and quirks. Adding a new OpenAI-compatible provider is a table row.
- **Pipeline is enforced.** `AIHandler.stream` always goes through `policy → key resolution → beforeCall → concurrency/min-interval → retry → provider → telemetry → afterCall`. No adapter bypasses the pipeline.
- **Neutral governance.** The library ships `allowAllPolicy` by default; blocklists/allowlists are app-level. This matches the stated non-goals.
- **Honest failures.** Missing keys, denied policy, and unavailable models become typed `AIError`s, never fake success.
- **Comprehensive redaction.** `SessionRedactor` adds session-resolved keys to the default pattern set; telemetry/error metadata are redacted. Good test coverage in `tests/handler.test.ts` and `tests/handler-pipeline.test.ts`.
- **Agent loop is minimal and flexible.** `runAgent` supports native, promptJson, and auto tool modes, budgets, approval gates, and streamed events without becoming a framework.

### Concerns

- **No `routes`/`loadModel` abstraction.** The design intentionally avoids routing, but the `examples/steel-chat/` and `examples/npm-mini-apps/` have a lot of duplicated connection setup. This is mitigated by `envConnection()` in `src/connect.ts` added in 0.4.0.
- **Provider profile defaults are conservative.** Local runtimes (`lmstudio`, `llamacpp`, `vllm`, `openai-compat`) get `nativeTools: false`, `jsonMode: false` by default. This is correct for protocol-level defaults, but callers need to know to override `toolMode` when they know their model supports tools.

### Code locations
- `src/handler.ts` — pipeline core
- `src/adapters/profiles.ts` — provider table
- `src/adapters/engines/*.ts` — protocol engines
- `src/agent/loop.ts` — agent loop

---

## 2. Code Quality

### Strengths

- `tsconfig.json` uses `strict: true`, `noUncheckedIndexedAccess: true`, `NodeNext` module resolution, `declarationMap`, `sourceMap`. This is a solid config.
- Types are clean and public surface is small: `types.ts`, `errors.ts`, `handler.ts`, `keys.ts`, `connect.ts`, `policy.ts`, `redact.ts`, `json.ts`, `tokens.ts`, `agent/`.
- No `any` in production code (search shows only `as any` casts in tests for `events.at(-1)`).
- Test fixtures are well-organized and reused across engines (`tests/helpers.ts`).
- Mocked tests cover retries, policy, redaction, key resolution, concurrency, and error classification.

### Concerns

1. **No lint/format tooling.** `package.json` has `test`, `build`, `build:nugget`, `typecheck`, but no `lint` or `format`. Consider adding `eslint` + `typescript-eslint` or `biome` for consistent style and to catch unused imports/vars.
2. **No coverage reporting.** Vitest has `coverage` provider; enabling it in CI would give confidence about untested branches.
3. **Hardcoded Anthropic default `max_tokens`.** `src/adapters/engines/anthropic.ts:133` sets `max_tokens: req.maxTokens ?? 4096`. This is reasonable but undocumented in `README`/`design.md` and could surprise callers expecting to omit `maxTokens`.
4. **Inconsistent `crypto.randomUUID()` usage.** Most source uses `globalThis.crypto?.randomUUID?.() ?? fallback` (`handler.ts`, `openaiChat.ts`, `anthropic.ts`, `google.ts`, `ollama.ts`). `src/agent/loop.ts:271` calls `crypto.randomUUID()` directly without fallback. This is fine in Node 20+ and browsers, but breaks runtime consistency for other runtimes or older bundlers.

### Code locations
- `src/agent/loop.ts:271` — bare `crypto.randomUUID()`
- `src/adapters/engines/anthropic.ts:133` — default `max_tokens`
- `package.json` — missing lint/format scripts

---

## 3. Security Audit

### Strengths

- **API keys never live in connection objects.** `Connection` carries `KeyRef`; `ResolvedConnection` carries the resolved `apiKey` and `headers`.
- **Redaction is layered.** `SessionRedactor` captures resolved keys; `DefaultRedactor` covers common patterns (OpenAI, Anthropic, Google, Groq, xAI, HF, Nvidia, GitHub, GitLab, AWS, Slack, Stripe, JWT, PEM, generic bearer). All telemetry and error metadata are redacted.
- **No secrets in repository.** `grep` for real-looking tokens found only fake test values in `tests/handler.test.ts`, `tests/handler-pipeline.test.ts`, and `tests/keys-redact.test.ts` (e.g., `sk-abcdefghijklmnopqrstuvwxyz`).
- **SSRF prevention is documented.** README and `design.md` correctly state that `provider`/`baseUrl` must not come from client input and must be server-side allowlisted.
- **Policy fails closed.** `allowlistPolicy` denies unknown providers; `blocklistPolicy` blocks by regex.
- **Telemetry hooks cannot re-execute provider calls.** `AIHandler.record` catches all errors and ignores them, so telemetry/afterCall failures do not trigger retries.
- **No CORS/server concerns in core.** The library is consumer-side; there is no server code that exposes keys or endpoints.

### Concerns

1. **Secret redaction patterns are not exhaustive.** No pattern for `xai-*` with X (it's present), but newer providers (e.g., `nvapi-*`, `hf_*`) are covered. Good coverage overall.
2. **JWT regex is broad.** `/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/` will match any base64url string beginning with `eyJ`. This is safe for redaction but could over-redact legitimate base64 strings in telemetry or logs. Acceptable trade-off.
3. **`promptJson` tool list in prompt.** `src/agent/loop.ts:232` interpolates `tool.name` and `tool.description` into the system prompt without escaping. If an app constructs tool names/descriptions from user input, prompt injection is possible. However, `ToolSpec` is app-defined, not user-defined, so this is an app-level concern. Still worth noting in the agent skill/README.
4. **Tool args are not deeply validated.** `validateToolArgs` only checks top-level `type`, `required`, and `properties`. It does not enforce `enum`, `pattern`, `minimum`, `additionalProperties`, nested schemas, or array `items`. The README documents this limitation, but apps may miss it. The examples use `execute` with destructured args without further validation, which is acceptable for demos but risky in production.
5. **`parseArgs` silently returns `{}` on malformed JSON.** In `openaiChat.ts`, `anthropic.ts`, `ollama.ts`, `parseArgs` returns `{}` if `JSON.parse` fails. If a model emits malformed tool arguments, the tool receives an empty object and may fail with a misleading validation error. Consider returning an error or `raw` object.
6. **Error `.raw` redaction.** `redactedError` redacts `error.raw` if `string`. If `raw` is an object or array, it is not redacted because it is passed through unchanged. But `error.raw` is typed `string` in `AIError`, so it should be a string.
7. **`listModels`/`testConnection` can leak keys to health endpoints.** `testConnection` uses `adapter.listModels` or `adapter.health` with the resolved `headers` containing the key. This is necessary for authenticated endpoints, but for `testConnection` with an arbitrary `baseUrl` it can leak the key to an unintended host. This is the documented SSRF concern: apps must not let users control `provider`/`baseUrl`.

### Code locations
- `src/redact.ts` — redaction patterns
- `src/agent/loop.ts:232` — promptJson system prompt
- `src/agent/tools.ts` — light validation
- `src/adapters/engines/openaiChat.ts:205` — `parseArgs` fallback
- `src/handler.ts:356` — `redactedError`

---

## 4. Correctness & Edge Cases

### Strengths

- Retry behavior is thorough: `Retry-After` honored, exponential backoff with jitter, retries stop once output is emitted, and abort/cancel is handled.
- Concurrency/min-interval logic is correct and `AbortSignal` aware.
- `chat()` is implemented as a fold over `stream()`, so both paths share the same pipeline.
- `adapterFor` factory is the single source of adapter selection.
- `modelRef` canonicalizes model identity by `(provider, model)`.
- Every call, including `listModels` and `testConnection`, produces exactly one redacted `CallRecord`.

### Concerns

1. **`handler.ts` `acquire` sets `lastStarted` before sleeping.** If `sleep` is aborted, `this.lastStarted` is already advanced by `Date.now() + wait`, potentially delaying subsequent calls for a full `minIntervalMs` even though the call never started. Should set `lastStarted = Date.now()` only after the sleep succeeds.
2. **`transport.ts` `textLines` silently ignores decoder errors.** `decoder.decode(value, { stream: true })` throws on invalid UTF-8 byte sequences; it would propagate as an `AIError` via `fromUnknown`. Good. But `textLines` does not handle the case where `res.body` is null and `res.text()` is empty; it yields nothing. Fine.
3. **`transport.ts` `tolerantJson` returns `{ text: raw }` for invalid JSON.** `fetchJson` uses this for non-2xx responses already thrown; for `listModels`/`health` it can return an object with a `text` property, which `asRecord` treats as a record. Then `asRecord(data).data` is `undefined` and `items` is `[]`. So a non-JSON `listModels` response yields empty list. This is graceful but hides provider misconfiguration.
4. **`sseLines` silently drops malformed JSON lines.** `openaiChat.ts` `safeParse` returns `undefined` for malformed lines and `continue`s. If a provider sends malformed chunks, the user may see a truncated stream without an error. Better to emit `context` or `error`.
5. **`openaiChat.ts` buffered fallback** handles non-`text/event-stream` responses. Good. But it does not check `content-type` for `application/json` and could parse HTML error pages as `raw` text.
6. **`google.ts` `firstCandidate`/`promptFeedback` safety.** `if (!firstCandidate(record) && promptFeedback?.blockReason) finish = 'SAFETY';` sets `finish` to `SAFETY` when the response is blocked and no candidate exists. But `mapFinish` maps `SAFETY` to `content_filter`. Good. However, if `firstCandidate` exists but `promptFeedback.blockReason` is set, the block reason is ignored. Should be rare.
7. **`testConnection` for Google is a no-op.** `GoogleAdapter` has neither `listModels` nor `health`, so `testConnection` returns `{ ok: true }` without any network call. This is misleading; a caller may think the endpoint is reachable. Consider adding a lightweight `health` probe to Google or changing `testConnection` to return `{ ok: false, message: 'Provider does not support health checks' }` when no probe is implemented.
8. **`ollama.ts` `listModels` is slow with many models.** It sequentially probes `/api/show` for each model. This is fine for a local server but could be slow. Document or add a timeout.

### Code locations
- `src/handler.ts:277` — `lastStarted` set before `await sleep`
- `src/transport.ts:142` — `tolerantJson`
- `src/adapters/engines/openaiChat.ts:213` — `safeParse` ignoring malformed JSON
- `src/adapters/engines/google.ts` — `testConnection` no-op

---

## 5. Dependencies & Build

### Strengths

- **Zero runtime dependencies.** Production package ships only `dist/` and `nugget/`. `package.json` has only `devDependencies`.
- `npm audit` reports 0 vulnerabilities.
- `build` and `build:nugget` are deterministic; `nugget/` gets `VERSION.txt` with version and content hash.
- `dist/` and `nugget/` are committed and CI checks they are up to date (`nugget-drift` job).
- `package.json` exports `types` first, `import` second, `default` third.

### Concerns

1. **`engines: { node: ">=20" }` is too permissive.** `vitest@4.1.9` -> `rolldown@1.1.3` requires `^20.19.0 || >=22.12.0`. On Node 20.18.1 (this session's default), `npm ci` produces a missing native binding error. Change to `">=22"` or `">=20.19.0"` (or add an `.nvmrc` with `22` and update CI accordingly). This is the **most important operational issue** found.
2. **No lockfile per example.** `examples/npm-mini-apps/*/package.json` depend on `^0.3.1` and the workflow uses `npm install`, not `npm ci`. `DEVELOPMENT_REPORT.md` already flags this.
3. **`examples/npm-mini-apps` pin to `0.3.1`.** They cannot use `envConnection` (added in 0.4.0) until the published version is updated. This is already tracked in `CHANGELOG.md` under "Not completed".
4. **Browser tests require manual Playwright install.** CI handles it, but local dev environment needs `npx playwright install chromium`. The README does not mention this explicitly.

### Code locations
- `package.json` — `engines` and `devDependencies`
- `package-lock.json` — `rolldown` and `vite` engine requirements

---

## 6. Tests

### Strengths

- 105 unit tests across 13 files, plus 6 env-gated live tests.
- Browser suite runs the same contract tests in Chromium, proving isomorphic core.
- Tests cover: handler pipeline (`handler-pipeline.test.ts`), `AIHandler` redaction (`handler.test.ts`), all four engines (`engine-*.test.ts`), profiles, JSON extraction, keys, errors, transport, agent loop, and `envConnection`.
- `live-smoke.test.ts` is env-gated and never runs in CI by default.

### Concerns

1. **No coverage threshold.** `vitest.config.ts` does not enable `@vitest/coverage-v8` or set thresholds. Some branches (e.g., `auth` path, `api-key-header`, `x-goog-api-key`, `x-api-key`) are likely only indirectly covered.
2. **Tests use `as any` casts.** Not a production issue, but weakens type safety in tests.
3. **Live tests are not run in this session.** Could not verify real wire behavior without a provider key.

### Code locations
- `vitest.config.ts`
- `vitest.browser.config.ts`
- `tests/live-smoke.test.ts`

---

## 7. Documentation

### Strengths

- `README.md` is comprehensive: install, providers, capabilities, recipes, JSON validation, error matrix, agent usage, commands, distribution, and examples.
- `design.md` contains the full contract, goals, non-goals, and architecture.
- `CHANGELOG.md` follows a consistent format and links to `DEVELOPMENT_REPORT.md`.
- `AGENTS.md` and `CLAUDE.md` provide clear agent instructions and invariants.
- `.claude/skills/` has four skill files for agent/consumer/development guidance.

### Concerns

1. **README does not mention Playwright installation.** Add `npx playwright install chromium` before `npm run test:browser`.
2. **README `engines` note does not mention Node 22 requirement.** Update the "Commands" section or add a `.nvmrc`/`package.json` fix.
3. **No architecture diagram.** Not required, but a small pipeline diagram would help new consumers.
4. **The `README`/`design.md` mention `route` event in `StreamEvent` but it is not emitted by the current code.** `StreamEvent` has `context` with `kind`/`data` so an app can emit it, but there is no built-in `route` event. Minor doc/impl mismatch.

---

## 8. CI/CD

### Strengths

- `.github/workflows/ci.yml` tests on Node 20 and 22, runs typecheck, build, unit tests, and nugget-drift check.
- `.github/workflows/browser.yml` (inside `ci.yml`) installs Playwright Chromium and runs browser tests on Node 22.
- `.github/workflows/publish.yml` validates tag matches version, then publishes to npmjs and GitHub Packages.
- `.github/workflows/live-matrix.yml` runs real provider tests weekly, keyed by repository secrets, with graceful skip.
- `.github/workflows/npm-mini-apps.yml` verifies example apps install and `verify` script works.

### Concerns

1. **CI `test` matrix uses Node 20 and 22.** If `engines` is fixed to `>=22`, the matrix can drop Node 20 or use `20.19`+.
2. **`nugget-drift` and `publish` run on Node 22.** Good.
3. **No dependency update workflow.** Renovate/Dependabot is not configured. With only dev dependencies, risk is low but worth enabling.

---

## 9. Environment & Tooling

This session's environment had Node 20.18.1. The first `npm install` produced an engine warning and `npm test` failed with a missing `rolldown` native binding. Switching to Node 22.12.0 via `nvm` and installing Playwright Chromium resolved the issue.

**Recommended blueprint:**
- `nvm use 22` / `nvm install 22`
- `npx playwright install chromium` for browser tests
- `npm install`

Note: the `update_environment_config` tool did not accept `exec_dir` in this session, so the blueprint was not persisted. A manual blueprint or `.nvmrc` + `package.json` engine bump is recommended.

---

## 10. Recommendations (Prioritized)

### High Priority

1. **Fix Node engine mismatch.** Change `package.json` `engines.node` to `">=22"` or `">=20.19.0"` and regenerate `package-lock.json` if needed. Also consider adding `.nvmrc` with `22`.
2. **Add lint/format tooling.** Add `eslint` + `typescript-eslint` or `biome` and a `npm run lint` script. Enforce in CI.
3. **Add test coverage.** Enable `@vitest/coverage-v8` and a coverage threshold in CI.

### Medium Priority

4. **Fix `crypto.randomUUID()` inconsistency in `src/agent/loop.ts`.** Use `globalThis.crypto?.randomUUID?.() ?? fallback`.
5. **Fix `acquire` `lastStarted` ordering bug.** Set `lastStarted` only after `sleep` succeeds.
6. **Surface malformed SSE/JSON lines.** In `openaiChat.ts` and other adapters, consider emitting a `context`/`stream_anomaly` event or throwing `invalid_response` when parsing fails, rather than silently skipping.
7. **Improve `testConnection` for Google.** Either add a `health` probe or return a more honest `ok` message when no probe is available.
8. **Update `README` with Playwright install instruction.**

### Low Priority

9. **Escape tool names/descriptions in `promptJson` system prompt** if they are ever derived from user input, or document that `ToolSpec` must be app-controlled.
10. **Consider `parseArgs` returning a parse error** instead of `{}` for malformed tool arguments.
11. **Add Renovate/Dependabot** for dev dependencies.
12. **Commit lockfiles for `examples/npm-mini-apps`** and update the workflow to `npm ci`.

---

## 11. Conclusion

AI Nugget is a solid, well-maintained package. The architecture is clean, the security model is correct (keys via `KeySource`, redacted telemetry, no SSRF by default), and the test suite is strong. The main issues are operational: the Node engine declaration is too low, linting is absent, and a few minor edge cases could be tightened. No security vulnerabilities or critical bugs were found in the core.

**Validation summary:**
- Build, typecheck, node tests, browser tests, and nugget build all pass on Node 22.
- `npm audit` clean.
- No real secrets in code.

---

*End of audit.*
