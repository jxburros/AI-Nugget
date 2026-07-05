# `ai-handler` — Development Plan

Companion to `report.md` (evidence) and `design.md` (the contract, revised v1: neutral governance with no shipped blocklist, engine + provider-profile adapter architecture, and an agent layer with native tool-calling). Phases are ordered by dependency and by risk: build the core against the richest existing test surface first, then adopt repo-by-repo, deleting the local copy in the same change every time.

Effort estimates are in **agent-sessions** (one focused Claude Code session on one repo), since that's how this portfolio is developed. Each phase ends with a concrete, verifiable exit criterion.

---

## Phase 0 — Home and scaffold (½ session)

**Decision to make first: where the nugget lives.** Recommended: a **new repository `jxburros/ai-handler`** — it's consumed by four repos, so it can't live inside any one of them without tangling dependency direction. (Alternative if a new repo is undesirable: a `packages/ai-handler` folder in `AI-model-test` published independently; workable but couples release cadence to the lab.)

- Scaffold: TypeScript strict, `"type": "module"`, zero runtime deps, Vitest, dual exports (ESM + types), a `build:nugget` script that emits a single vendorable folder stamped with version + content hash.
- CI: typecheck + contract tests in Node and headless Chromium (both environments already exist in the portfolio's tooling).
- Seed `AGENTS.md`/`CLAUDE.md` following the portfolio conventions (required reading, changelog format, "smallest safe change"), and state the non-goals from `design.md` §1 as standing cautions so future agent sessions don't grow it into a framework.

**Exit:** empty package builds, tests run in both environments, repo has its instruction docs.

## Phase 1 — Core: types, errors, transport, JSON (1–2 sessions)

Build in this order, porting behavior (and tests) from the repos that already got it right:

1. `types.ts`, `errors.ts` — the contract from `design.md` §3, `classify(status, body)` replacing string-matching classification (port the case tables from AI-model-test's `classifyRunFailure`/`classifyQuickTestFailure` as tests).
2. `transport.ts` — `withTimeout` (port from `AI-model-test/src/adapters/httpAdapters.ts:12` + its cleanup semantics), `fetchJson`, `sseLines`, `ndjsonLines` (port the buffered-partial-line handling from AI-Server-Studio's NDJSON loop and AI-model-test's SSE loop).
3. `json.ts` — port Blobsmith's `extractJsonObject` + schema guards; add top-level array support; port Blobsmith's parsing edge cases as tests.
4. `tokens.ts` — `estimateTokens` fallback with the explicit `estimated` flag.

**Exit:** unit tests green in Node + browser; the ported test cases from Blobsmith and AI-model-test all pass.

## Phase 2 — Engines, profiles + contract suite (2–3 sessions)

- Write the shared **engine contract test suite first** (fixtures: happy path, streaming, buffered-despite-`stream:true`, native tool-call roundtrip, 401/429/500, malformed JSON, truncated stream, mid-stream abort), then implement the four protocol engines: `openaiChat` (SSE + tool_calls deltas), `anthropic` (SSE streaming and tool_use, incl. the forced-tool JSON mode — all new to the portfolio), `google` (raw fetch, streaming, functionDeclarations), `ollama` (native NDJSON + tools).
- Build the **provider profile table** and its light per-profile tests (URL/auth/header construction, quirks, model-listing parse): `openai`, `azure-openai`, `openrouter` (attribution headers + rich `/models` metadata), `groq`, `deepseek`, `mistral`, `together`, `fireworks`, `lmstudio`, `llamacpp` (modelOptional + `/health`), `vllm`, `anthropic`, `google`, `ollama`, and the `openai-compat` escape hatch. Single `adapterFor()`.
- Per the support policy: **no xAI/Grok profile** — not blocked, never shipped.
- Wire fixtures from real recorded responses where possible (run against local Ollama and llama.cpp, and, with keys, one live call per cloud provider to capture current wire shapes — OpenRouter can cover several model families with one key).
- Env-gated live smoke tests (`AI_HANDLER_LIVE=1`), never default-on.

**Exit:** all four engines pass the full contract suite (including tool roundtrips); every shipped profile passes its profile tests; first-token latency, usage normalization, and abort verified per engine.

## Phase 3 — Pipeline: `AIHandler`, policy, keys, redaction, telemetry (1–2 sessions)

- `handler.ts` pipeline in the fixed order from `design.md` §4: policy → key resolution → beforeCall hook → concurrency slot → attempt loop (jittered backoff, Retry-After) → redacted CallRecord → telemetry + afterCall.
- `keys.ts`: `env`, `literal`, `memory` KeySources + ref parsing (port the `${VAR}`/`$VAR`/bare-caps/literal discrimination from `AI-model-test/src/config/apiKeys.ts`).
- `redact.ts`: locus-os's 14 secret patterns as the default Redactor, plus session-resolved-key substring redaction.
- Governance ships **neutral**: no default block patterns. Provide the `blocklistPolicy(patterns)` / `allowlistPolicy(prefixesByProvider)` constructors so apps configure their own policy at the seam.

**Exit:** an end-to-end test drives `handler.stream` against a mock adapter through every seam: a policy-denied model (via a test-configured policy), a locked key, a denied beforeCall, a 429-retry-then-success, and a failure — and asserts one redacted CallRecord per call including the failure. **Tag v0.1.0.**

## Phase 3b — Agent layer (`ai-handler/agent`) (1–2 sessions)

- `tools.ts`: `ToolSpec`, `defineTool`, JSON-schema argument validation (invalid args → `tool_error` result back to the model, never an unvalidated execute).
- `loop.ts`: `runAgent()` per design §8 — model↔tool loop over `handler.stream`, `AgentEvent` stream, budgets (maxSteps / accumulated tokens / deadline) with honest `stopReason`s, `ApprovalGate` for `sideEffects` tools (deny is data fed back to the model, not an exception), `toolMode: 'native' | 'promptJson' | 'auto'` with the `extractJson`-based promptJson fallback for models without native tool support.
- Agent-loop test suite on a scripted mock adapter: tool roundtrip, invalid-args self-correction, approval deny-and-continue, every budget stopReason, mid-tool abort, promptJson/native parity.
- One live-ish demo test against local Ollama (env-gated) exercising a two-tool loop end-to-end.

**Exit:** agent suite green in Node + browser; every loop model-call verifiably passes through the full handler pipeline (governance/keys/redaction/telemetry visible in the mock's records). **Tag v0.2.0.**

## Phase 4 — First adoption: AI-model-test (1–2 sessions)

Chosen first because it has the strongest test suite (`npm test` covers scorer, storage, runner) and is pure Node.

- Replace `src/adapters/httpAdapters.ts` and all three `adapterFor()` copies with the package; keep `ModelAdapter` as a thin shim initially so `evalRunner`, `judgeScorer`, and the dashboard change minimally.
- Route the runner's event logging through a `TelemetrySink` that writes `run_events`; keep `model_responses` full-text storage app-side, unchanged.
- **Fix the bootstrap key leak** (`dashboardData.ts:481`): pass bootstrap models through redaction (literal `apiKeyEnvVar` values → sentinel) — this is the highest-severity finding in the report and lands naturally here.
- Upgrade the judge to `responseFormat: 'json'` + schema guards; keep `basicScorer` untouched (deterministic offline fallback is a hard rule).
- Register the newly first-class providers (llama.cpp, vLLM as named profiles; DeepSeek/Mistral/Together/Fireworks/Azure as available benchmark targets) in the config schema — the lab is the natural proving ground for profile breadth.
- **Model provenance in benchmark data** (decided): OpenRouter models are distinct config entries, and every model entry carries its source marker. Storage and insights key on `modelRef` (`(source, model)`), never bare model id — via `ensureColumn` additions where `model_responses`/insight queries need the source dimension. This enables two new insight views: same model compared across sources, and per-source consistency (whether one host behaves uniformly across its models). Existing rows backfill their source from the config's provider field.
- Per repo rules: run `npm test` + `npm run build`, update `CHANGELOG.md`, `architecture.md` (adapter layer moved to external package), README if commands change.

**Exit:** full suite green; a live eval run against local Ollama produces identical DB shape; the three-location sync caution in CLAUDE.md can be retired.

## Phase 5 — AI-Server-Studio (2 sessions)

- Session A (backend transport): replace the four inline Ollama fetch sites and `cloud.ts:callCloudModel` with `handler.stream`; SSE route handlers transcribe `StreamEvent`s to the existing wire events (protocol unchanged for the frontend); cloud becomes streaming; the chat path gains timeout + retries; normalize `OLLAMA_BASE_URL` handling. Governance: **retire the hardcoded Grok patterns** (per the new portfolio stance) and route any model policy the app keeps through the handler's `GovernancePolicy` seam, so whatever policy exists is actually enforced on live inference. KeySource = the existing AES-GCM `provider_keys` store.
- Session B (telemetry + cleanup): TelemetrySink persisting per-message model tag/duration/usage (fills the local-telemetry gap); unify `isVisionModel`/`inferCapabilities`; fix or remove the unparsed `project_index_context` event; converge the project/personal stream parsers.
- Per repo rules: both SSE emitter and parser change together; update `architecture.md` and `CHANGELOG.md`; browser + curl verification of streaming.

**Exit:** frontend behavior unchanged (except cloud now streams); blocklist verified on the live path; messages carry telemetry.

## Phase 6 — Blobsmith (1–2 sessions)

- Both `ai.ts` and `ai.worker.ts` import the shared handler; delete the duplicated provider code (worker keeps only its postMessage transport). Retries, queueing, and metering now apply on *both* paths. Governance: drop the hardcoded Grok patterns; keep the per-provider prefix **allowlist** as Blobsmith's own `allowlistPolicy(...)` config at the seam — now enforced everywhere, not just in the worker.
- Gains: abort + timeout (add a user-facing cancel), real streaming into the terminal overlay (replacing the faux typewriter), Anthropic JSON mode, configurable `maxTokens`.
- Migrate `runReActAgentLoop` to `ai-handler/agent`: the three existing tools become `defineTool` specs; gains native tool-calling on capable models, schema-validated args, budgets, and cancellation (promptJson mode preserves behavior on local models without tool support).
- KeySource = localStorage-backed `stored` refs; document the custody model honestly in README; note the passphrase-vault upgrade path as a future candidate (Phase-scope rule: don't build it unprompted).
- Adjacent hardening while in the area (small, flagged in CHANGELOG): `sandbox` attribute on the preview iframe.
- Per repo rules: `npm test`/`npm run lint` (tsc), manual browser verification of generation/preview/patch flows, Bob-voice untouched, `CHANGELOG.md` with `[Anthropic Claude Code]` entries.

**Exit:** one provider implementation; feature flag no longer changes safety behavior; generation verified in browser.

## Phase 7 — locus-os (1–2 sessions)

The seam-filling phase — the reason the handler has hooks.

- Implement the AI Core runtime: `RouteTarget`/`RoutingRule` resolve to a `Connection`; assistant "Ask" turns call `handler.stream`; side-effect-bearing intents become `sideEffects: true` agent tools whose `ApprovalGate` calls `broker.propose()` and suspends until the user approves in the Approvals tab — plus `hooks.beforeCall` as the belt-and-suspenders enforcement point so *no* call can bypass propose/approve.
- KeySource = Secrets Core brokered refs (`secret://…`; `locked`/`denied` map to honest failures). Redactor = the existing `redactText` choke point. TelemetrySink = audit rows.
- Reconcile the two routing systems into one (keep `ai.ts` rules as the user-facing layer; retire or fold `platform.ts`'s table); retire the mock `credentials.ts` broker in favor of Secrets Core.
- Per repo rules: consult `architecture.md` first, `npm run typecheck`, honest CHANGELOG (`Agent: Claude Code (Claude)`), no claims beyond what the code proves — the registry's AI Core entry gets updated to describe real inference only once it works.

**Exit:** a real local model (Ollama) answers an Ask turn end-to-end through redaction + audit; a write intent still requires approval; typecheck green.

## Phase 8 — ai-agent-skills + closeout (½–1 session)

- Add a `portfolio-ai-handler` skill (SKILL.md + manifests): when to use the handler, the seam contracts, guardrails (never bypass the pipeline, never set browser-CORS headers silently, keys only via KeySource), validation commands. Follow the drift rule: point at `ai-handler` source for volatile values.
- Update the `ai-provider-api-key-safety` provider map with the now-verified facts (this also discharges part of HANDOFF.md Task 1 for these five repos).
- Run `scripts/validate-all.ps1` equivalent validation; update `catalog/` indexes.

**Exit:** skills validate; catalog in sync.

---

## Sequencing summary

```
Phase 0   scaffold                    ─┐
Phase 1   core primitives              ├─ ai-handler repo   (~4–6 sessions)
Phase 2   engines + profiles + tests   │
Phase 3   pipeline, v0.1.0             │
Phase 3b  agent layer, v0.2.0         ─┘
Phase 4   AI-model-test  ← first adopter, richest tests     (1–2 sessions)
Phase 5   AI-Server-Studio                                   (2 sessions)
Phase 6   Blobsmith      ← incl. ReAct → agent-layer move    (2 sessions)
Phase 7   locus-os       ← fills the empty seam              (1–2 sessions)
Phase 8   ai-agent-skills + closeout                         (~1 session)
                                              Total: ~12–15 sessions
```

Phases 4, 5, and 7 need only v0.1.0 (Phase 3); Phases 6 and 7's agent pieces need v0.2.0 (Phase 3b). Adoption phases are independent of each other and can be reordered or parallelized across sessions; the order above goes lowest-risk → highest-novelty. If agent capability is wanted sooner, Phase 3b can run in parallel with Phase 4, since the core contract is frozen at v0.1.0.

## Standing rules for every adoption phase

1. **Delete the local copy in the same change** that introduces the handler — no dual-path transition periods (that's how Blobsmith's drift happened).
2. **Wire protocols don't change without both sides** — AI-Server-Studio's SSE contract and Blobsmith's worker messages stay stable; the handler slots in beneath them.
3. **Each repo's CLAUDE.md/AGENTS.md process applies**: consult development-docs, smallest safe change, run the repo's validation, update `CHANGELOG.md` and `architecture.md`, record anything unverified honestly.
4. **No new capabilities smuggled in.** Adoption phases swap implementation, not scope; roadmap-gated features (vaults, tool-calling, routing intelligence) stay future candidates until explicitly scheduled.

## Open questions (decide before or during Phase 0)

1. **New repo vs. package-in-AI-model-test** for the nugget's home (recommendation: new repo).
2. **Publish mechanism:** GitHub Packages npm registry vs. vendored-folder-only. (Recommendation: both; backends consume the package, constrained frontends vendor the generated folder.)
3. **v2 scope:** an embeddings interface (AI-Server-Studio's `/api/embeddings` calls are the only current consumer), agent conveniences beyond the loop (transcript summarization helpers, parallel tool execution), and any further provider profiles portfolio repos actually request. (Native tool-calling was v2 in the v0 design; it is now v1 core because the agent layer requires it.)
4. **Whether AI-Server-Studio's ComfyUI client** ever belongs in the nugget. Current answer: no — it's a job-graph protocol, not a chat protocol; revisit only if a second repo needs image generation. (A ComfyUI job could still be exposed to agents as an app-defined `ToolSpec` — that needs no nugget support.)
