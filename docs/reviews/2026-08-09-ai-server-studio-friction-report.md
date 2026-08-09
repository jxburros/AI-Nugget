# AI Nugget — Production Friction Report

**Source of evidence:** AI Server Studio (`@jxburros/ai-nugget` consumer)
**Date:** 2026-08-09
**Author:** Claude
**Nugget version in the field:** `@jxburros/ai-nugget@^0.3.1` (consumer pin) · latest published `0.4.1`

> **Status update (2026-08-09):** all 24 library-side suggestions plus the
> library half of #26 were implemented in **0.5.0** (additive, backward-compatible).
> See `UPGRADING.md` and the `0.5.0` `CHANGELOG.md` entry, which reference these
> same numbers. Deferred (need a published release): the AI Server Studio
> dependency bump and its adoption of `prewarm()`/`pricing` (#3, #24, #26
> consumer halves).

---

## TL;DR (verdict)

AI Nugget did its core job well: it is the single, provider-neutral seam through
which AI Server Studio talks to every cloud provider, with retries, redaction,
key resolution, blocklist policy, and per-call telemetry all in one place. Most
integration files use it exactly as intended.

The friction is concentrated and has a **single root cause**: the library had no
way to pass provider-native request options through to a call (most importantly
Ollama's `num_ctx`/`keep_alive`), and it hard-coded local runtimes as
non-tool-capable. Those two gaps were severe enough on the local-model path that
AI Server Studio built and shipped a ~600-line in-repo agent loop to replace the
nugget's own `runAgent`, and it routes plain-chat and embeddings for local models
around the nugget with raw `fetch`. That bypass then *cost* the app its unified
telemetry and blocklist coverage on the local path — a cascade that traces back
to one missing escape hatch.

Everything below is evidence-backed (file/line and dates), followed by **26
numbered suggestions**. The numbers are stable and identical in the companion
visual report, so you can cite them directly when choosing what to implement.

---

## How the two projects fit together

AI Server Studio treats the nugget as its **provider-calling layer** and nothing
more. The documented division of responsibility:

- **AI Nugget** — talks to model providers: retries, streaming, redaction, key
  resolution, telemetry, blocklist policy.
- **AI Server Studio** — owns prompts, model selection/routing, storage, privacy,
  consent, and UI.

The seam lives in `app/backend/src/aiNugget.ts` (the `AIHandler` singleton, key
resolution, blocklist, telemetry) and `app/backend/src/aiNuggetLoader.ts` (the
ESM loader). The nugget's ROOT is used for cloud calls, streaming, and model
discovery. Its `/agent` subpath was **removed from the code path** (see FR‑A).

---

## The friction catalogue

Each item cites the strongest evidence found. `ASS:` = AI Server Studio repo;
`NUG:` = AI Nugget repo. Severity reflects the impact observed downstream.

### Root cause — local-model request fidelity

- **FR‑1 · No provider-options passthrough (High).** The nugget's `ChatRequest`
  has no options escape hatch, and the Ollama adapter's request body hardcodes
  `{temperature, num_predict, top_p, stop}`. `num_ctx`, `num_keep`, and
  `keep_alive` are unreachable — so agent/Intern turns silently ran at Ollama's
  *default* context window while the UI reported 8,192, and preset
  `temperature`/`top_p` were dropped.
  *Evidence:* `ASS: development-docs/architecture.md:1819`,
  `ASS: docs/audit-remediation-plan-2026-08-05.md:39‑44`,
  `ASS: CHANGELOG.md:4311‑4314`, `NUG: src/adapters/engines/ollama.ts:126‑135`.

- **FR‑2 · `nativeTools:false` on every local runtime (High).** The profile
  table marks `ollama`/`openai-compat` as `nativeTools:false`, so
  `toolMode:'auto'` always resolves to the `promptJson` fallback for local
  models — even when discovery read `capabilities:["tools"]` from `/api/show`.
  The raw `{"tool":…}` directive also streamed into the *visible* assistant text
  mid-turn. The adapter itself maps `req.tools` correctly; the profile flag was
  the only blocker.
  *Evidence:* `ASS: CHANGELOG.md:4319‑4322`,
  `ASS: docs/archive/app-flow-simulation-audit-2026-08-05.md:240‑257`,
  `NUG: src/adapters/profiles.ts` (LOCAL_RUNTIME).

- **FR‑3 · `promptJson` omits tool parameter schemas (Med).** The prompt-JSON
  system prompt lists only `name: description`, never each tool's `parameters`
  schema, so the model has to guess argument shape — wasted correction
  round-trips on the library's *default* local path.
  *Evidence:* `NUG: docs/reviews/2026-07-09-audit.md:79‑87`,
  `NUG: src/agent/loop.ts:228‑236`.

### Agent-loop robustness

- **FR‑A · The `/agent` loop was replaced wholesale (High, structural).** Rather
  than wait on FR‑1/FR‑2, AI Server Studio wrote `services/agentLoop.ts`
  (`runAgentLoop`), porting the nugget's tool-dispatch semantics *verbatim*
  (down to pinning its exact error strings for an adversarial suite) while
  fixing the two gaps. `loadAiNuggetAgent` and `aiNuggetAgentTypes.ts` were
  deleted.
  *Evidence:* `ASS: aiNuggetLoader.ts:13‑14`,
  `ASS: development-docs/architecture.md:1804,1811`,
  `ASS: CHANGELOG.md:3983‑3988`.

- **FR‑4 · A tool returning `undefined` crashes the whole run (High).**
  `content: JSON.stringify(executed.result)` becomes the string `"undefined"`;
  the next step's message mapper then calls `.map` on it and the run ends with
  `stopReason:'error'`. Confirmed reproduced; still unguarded in 0.4.1.
  *Evidence:* `NUG: docs/reviews/2026-07-09-audit.md:51‑65`,
  `NUG: src/agent/loop.ts:168`.

- **FR‑5 · A thrown error aborts the loop; no in-turn recovery (Med).** Because
  a throw kills the turn, every `plan_*` tool had to adopt a
  return-errors-never-throw convention (`{ok:false,code,…}`) so the model can
  recover inside the same turn.
  *Evidence:* `ASS: CHANGELOG.md:4537‑4539`, `ASS: planTools.ts:44‑45`.

- **FR‑6 · `AgentResult` has no `error` field (Med).** A run that ends
  `stopReason:'error'` gives the caller no way to see *what* failed without
  replaying the event stream.
  *Evidence:* `NUG: docs/reviews/2026-07-09-audit.md:75‑77`,
  `NUG: src/agent/loop.ts:53‑59`.

- **FR‑7 · Tool results are stringified into context with no framing or size
  cap (Med).** The loop `JSON.stringify`s whatever `execute()` returns straight
  into the next `tool` message — no untrusted-content boundary, no bound. A
  single 2 MB tool return could blow the next turn's window. The app added a
  24 KB cap + untrusted envelope at its own choke point.
  *Evidence:* `ASS: agentTools.ts:293‑317`.

- **FR‑8 · Below-the-loop bookkeeping (Med).** `call_id` is always `null`
  because execution runs beneath the nugget's call bookkeeping, and `tool_denied`
  was effectively dead code until the app forced every tool to `sideEffects:true`
  to make the ApprovalGate fire at all.
  *Evidence:* `ASS: development-docs/architecture.md:3011`,
  `ASS: docs/archive/audit-2026-08-01-agent-system.md:120`,
  `ASS: agentTools.ts:53‑64`.

### Packaging & interop

- **FR‑9 · ESM-only, no `require` condition (Med).** The backend compiles as
  CommonJS; a plain `require` throws `ERR_REQUIRE_ESM`, and `tsc` downlevels even
  a normal dynamic `import()` back into a failing `require`. The app loads the
  package via `new Function('specifier','return import(specifier)')` to keep a
  real native `import()` at runtime.
  *Evidence:* `ASS: aiNuggetLoader.ts:4‑9`,
  `ASS: development-docs/architecture.md:1833`,
  `NUG: package.json` (exports map has no `require`).

- **FR‑10 · Cold-start load blows tight timeouts (Low).** The one-time native
  ESM load, on top of a cold Ollama daemon, made the first `/models/status` and
  discovery calls falsely report "offline"; the app now pre-warms the handler
  and retries once with a longer budget.
  *Evidence:* `ASS: index.ts:663‑666`, `ASS: routes/models.ts:107‑112`.

- **FR‑11 · Private & not vendored (Low).** A security audit could not confirm a
  `tool_denied`-reachability finding against the package because its source
  wasn't available in the checkout; it was downgraded to "needs verification".
  *Evidence:* `ASS: CHANGELOG.md:6667‑6669`,
  `ASS: docs/archive/audit-2026-08-01-agent-system.md:120`.

### Structured output

- **FR‑12 · No schema validation; "constraint tax" (Med).** The nugget maps a
  requested schema onto Ollama's `format`, but grammar-constrained output only
  guarantees *syntactic* validity — it can be well-formed and semantically wrong.
  The app requests constrained output on the first attempt only and keeps its own
  parse-and-retry fallback. There is no built-in typed/validated output.
  *Evidence:* `ASS: services/agentHarness.ts:437‑440`,
  `ASS: CHANGELOG.md:6593‑6595`, `NUG: src/json.ts` (hand-rolled guards only).

### Streaming, timeouts & events

- **FR‑13 · Total-lifetime timeout, not idle (Med).** `streamTimeout` is a single
  total timer, so a slow-but-healthy long stream (common on local Ollama with big
  contexts) is killed at ~120 s and, because output was already emitted, is not
  retried.
  *Evidence:* `NUG: docs/reviews/2026-07-09-audit.md:71‑73`,
  `NUG: src/adapters/engines/base.ts:21‑23`, `NUG: src/transport.ts:3‑29`.

- **FR‑14 · Reasoning & retry events not surfaced (Low).** Anthropic
  `thinking_delta` and OpenAI `reasoning_content` deltas are dropped; the nugget's
  `retry`/`context` stream events were considered and deliberately left unmapped
  by the consumer, but the library offers no stable presentation contract for
  them.
  *Evidence:* `NUG: (audit) I5`, `ASS: CHANGELOG.md:5671‑5674`,
  `ASS: development-docs/archive/changelog/CHANGELOG-2026-07.md:3846`.

### Discovery & profiles

- **FR‑15 · `listModels()` silently empty for Anthropic & Google (Med).** It
  resolves to `[]` (not an error) for those providers, which is easy to miss.
  *Evidence:* `NUG: README.md:110‑120`, `NUG: src/adapters/engines/{anthropic,google}.ts`.

- **FR‑16 · Context window not guaranteed; serial probes (Low).** Discovery
  doesn't always return a `contextWindow` (older Ollama), so the app hardcodes
  `4096`; Ollama `listModels()` probes `/api/show` serially per model.
  *Evidence:* `ASS: routes/models.ts:283‑285`,
  `NUG: src/adapters/engines/ollama.ts:90‑97`.

- **FR‑17 · Missing profiles; Azure hardcode; naive URL join (Low–Med).** No
  built-in profiles for Perplexity/Moonshot/Cohere/Cerebras (they fall through to
  the `openai-compat` escape hatch); Azure's `api-version=2024-10-21` is hardcoded
  with no override; the `openai-compat` engine concatenates URLs without
  trailing-slash normalization, so the app must pre-sanitize `base_url`.
  *Evidence:* `ASS: cloud.ts:167‑196`, `NUG: src/adapters/profiles.ts:58`,
  `ASS: customEndpoints.ts:124‑126`.

### Security & key seam

- **FR‑18 · `keySource.resolve` repurposed as the sole per-call checkpoint
  (Med).** The nugget offers no per-call *connection*-validation hook, so the app
  runs its request-time SSRF/DNS-rebinding re-check inside key resolution — and
  gives auth-less custom endpoints a *fake* stored `KeyRef` (`keyMode:'none'`)
  purely to force that one hook to fire.
  *Evidence:* `ASS: aiNugget.ts:50‑53`, `ASS: CHANGELOG.md:7536‑7539`.

- **FR‑19 · Local calls bypass the blocklist (Med, security).** Because local
  calls go direct (FR‑1), they skip the nugget-anchored `BLOCKED_MODEL_PATTERNS`
  policy — an explicit, still-open tension between blocklist coverage and
  runtime-option fidelity.
  *Evidence:* `ASS: docs/archive/audit-2026-07-09.md:128‑133`,
  `ASS: development-docs/architecture.md:1834`.

### Embeddings (the widest bypass)

- **FR‑20 · No embeddings support at all (High).** The nugget has no `embed()`
  method or `EmbedRequest`/`EmbedResult` types, so AI Server Studio's *entire*
  embeddings/RAG path calls Ollama's `/api/embeddings` directly with raw `fetch`
  — completely outside the nugget's telemetry, policy, key-resolution, and
  redaction layer, despite the stated principle that all model traffic should pass
  through the handler.
  *Evidence:* `ASS: embeddings.ts:63,89`, `NUG:` (no `embed` anywhere in `src/`).

### Telemetry & cost

- **FR‑21 · Local agent steps lose telemetry (Med).** A documented parity cost of
  the bypass: local agent/Intern steps no longer write `ai_call_events` rows;
  cloud steps still do.
  *Evidence:* `ASS: development-docs/architecture.md:1819`,
  `ASS: CHANGELOG.md:4048‑4049`.

- **FR‑22 · No cost accounting on `CallRecord` (Low).** Consumers must re-derive
  spend from token counts and their own price tables.
  *Evidence:* `NUG: (audit) I6`, `NUG: src/handler.ts` (`CallRecord` has no cost).

### Hygiene & smaller defects

- **FR‑23 · A cluster of small library-level items (Low).** `promptJson`/replay
  drops image content parts on some engines; a dead `role==='tool'` branch;
  `403` always non-retryable (documented but terse); MCP-style tool-name
  derivation is order-dependent/unattributed; the README's test count is stale;
  no lint/coverage tooling; example apps use `npm install` without committed
  lockfiles.
  *Evidence:* `ASS: docs/archive/audit-2026-07-11.md:90`,
  `ASS: docs/archive/tools-audit-2026-08-03.md:238‑243`,
  `NUG: docs/reviews/2026-07-09-audit.md:89‑102`.

### Versioning (meta)

- **FR‑24 · Consumer is stranded on an old minor (Med).** The pin `^0.3.1`
  cannot accept `0.4.x` (caret on a `0.x` version), so a 2026-07-11 recommendation
  to bump was never adopted; the field is still on `0.3.1` while `0.4.1` ships.
  *Evidence:* `ASS: app/backend/package.json:29`,
  `ASS: docs/archive/audit-2026-07-11.md:195‑219`.

---

## Numbered suggestions

Each suggestion lists **who acts** (Nugget = library change · Studio = consumer
action · Both), a rough **effort** (S/M/L), and **impact**. "Resolves" points back
to the friction IDs above.

### A. Packaging & interop

**1 · Ship a dual ESM + CJS build (or add a `require` export condition).**
_Nugget · M · High._ A CJS entry (or a small `require`-condition wrapper) removes
the `new Function('return import()')` shim that every CommonJS consumer must
currently invent, and the cold-start double-load penalty that comes with it.
_Resolves FR‑9, contributes to FR‑10._

**2 · Improve distribution transparency.**
_Nugget · S · Med._ Publish a source-inspectable artifact (public source, a
source tarball, or a first-class vendorable `dist/`) and document a vendoring path
that survives strict bundlers (Next.js Turbopack). Lets downstream security
audits verify behavior instead of downgrading findings to "unverifiable".
_Resolves FR‑11._

**3 · Provide a `prewarm()` and lazy-load guidance.**
_Both · S · Med._ A documented warm-up entry point (and a note on first-call
latency) lets consumers pay the one-time load off the hot path instead of blowing
tight status/discovery budgets on cold start.
_Resolves FR‑10._

### B. Local-model request fidelity (the root cause)

**4 · Add a per-call `providerOptions` passthrough.**
_Nugget · M · High._ A typed-but-open escape hatch on `ChatRequest`/agent options
that forwards provider-native fields: Ollama `num_ctx`/`num_keep`/`keep_alive`/
`options.*`, OpenAI `reasoning_effort`, Anthropic `thinking`/`cache_control`,
Google `safetySettings`. **This is the single highest-leverage change** — it is
the missing capability that forced the in-repo agent loop, the direct-`fetch`
local path, the telemetry loss, and the blocklist bypass.
_Resolves FR‑1; unblocks FR‑A, FR‑19, FR‑21._

**5 · Forward samplers & options through `runAgent`/agent turns.**
_Nugget · S · High._ Agent turns currently forward only model/messages/tools/
signal/metadata — not even `temperature`. Passing the same options the plain-chat
path sends gives agent runs parity.
_Resolves FR‑1 (agent path)._

### C. Tool calling for local models

**6 · Drive `nativeTools` from discovered per-model capability.**
_Nugget · M · High._ Read the model's actual `capabilities` (e.g. Ollama
`/api/show` `["tools"]`) instead of a static per-profile `false`, or allow a
per-connection/per-call `nativeTools` override. Capable local models then use a
real `tools` array.
_Resolves FR‑2._

**7 · Never stream raw `promptJson` directives to users; disclose the mode.**
_Nugget · S · High._ Buffer/suppress text that is actually a tool directive so it
never reaches the visible stream, and emit a `tool_mode`
(`native`/`promptJson`/`none`) event so the fallback is disclosed rather than
silent.
_Resolves FR‑2._

**8 · Include each tool's `parameters` schema in the `promptJson` prompt.**
_Nugget · S · Med._ Interpolate the JSON Schema, not just `name`/`description`, so
the model stops guessing argument shape on the library's default local path.
_Resolves FR‑3._

### D. Agent-loop robustness

**9 · Guard non-serializable / `undefined` tool results.**
_Nugget · S · High._ Coerce `JSON.stringify(result) ?? 'null'` (or reject cleanly)
before pushing into the next message, so a tool returning `undefined` can't end
the whole run with `stopReason:'error'`.
_Resolves FR‑4._

**10 · Add an `error` field to `AgentResult`.**
_Nugget · S · Med._ Surface what failed on an errored run without forcing the
caller to replay the event stream.
_Resolves FR‑6._

**11 · Support a recoverable, structured tool-error convention.**
_Nugget · M · Med._ Let a tool signal a non-fatal error (returned, not thrown)
that becomes a `tool_result` the model can recover from in the same turn, instead
of a throw aborting the loop. Document it as first-class.
_Resolves FR‑5._

**12 · Offer an optional tool-result size cap + untrusted-content framing.**
_Nugget · M · Med._ A built-in bound and an untrusted envelope for tool output
would give every consumer the safety the app had to hand-roll at 24 KB.
_Resolves FR‑7._

**13 · Populate `call_id` for tool executions.**
_Nugget · S · Med._ Expose the loop's call bookkeeping to tool steps so clients
and approval flows can correlate without the "always `null`" workaround.
_Resolves FR‑8._

**14 · Make `tool_denied` / `ApprovalGate` reachable by default and clearly
contracted.**
_Nugget · M · Med._ Ensure denials surface as observable `tool_denied` events
without requiring consumers to set `sideEffects:true` on every tool just to wake
the gate; document the contract.
_Resolves FR‑8._

### E. Structured output

**15 · Add optional Standard-Schema typed output with a corrective retry.**
_Nugget · M · High._ A `chatParsed`-style path that validates against a
Standard-Schema (Zod/Valibot-compatible) validator and performs one automatic
corrective retry on failure would absorb the "constraint tax" parse-and-retry
boilerplate every consumer currently writes — with zero mandatory dependency
(accept any Standard-Schema validator the app passes in).
_Resolves FR‑12._

### F. Streaming, timeouts & events

**16 · Add an idle-stream timeout distinct from the total timeout.**
_Nugget · S · High._ Reset the timer on each delta so long-but-healthy local
streams aren't killed mid-generation; keep the total timeout as a separate ceiling.
_Resolves FR‑13._

**17 · Surface reasoning/thinking deltas and give `retry`/`context` a stable
mapping.**
_Nugget · M · Med._ Emit Anthropic `thinking_delta` / OpenAI `reasoning_content`
as first-class events, and document a stable presentation contract for
`retry`/`context` so consumers can render them.
_Resolves FR‑14._

### G. Discovery & profiles

**18 · Implement `listModels()` for Anthropic & Google.**
_Nugget · M · Med._ Return a known/static catalog instead of silently `[]`, so
discovery behaves consistently across providers.
_Resolves FR‑15._

**19 · Parallelize Ollama `/api/show` probes and always return a
`contextWindow`.**
_Nugget · S · Med._ Concurrent probing and a documented default free consumers
from serial-probe latency and from hardcoding `4096`.
_Resolves FR‑16._

**20 · Add built-in profiles for common providers; make Azure `api-version`
overridable.**
_Nugget · M · Med._ First-class profiles for Perplexity, Moonshot, Cohere, and
Cerebras (instead of the `openai-compat` fallback), plus an Azure `api-version`
quirk so the pinned date doesn't break silently on Azure's retirement schedule.
_Resolves FR‑17._

**21 · Normalize base-URL joins in the `openai-compat` engine.**
_Nugget · S · Low._ Use proper URL joining (or strip trailing slashes) so
consumers don't have to pre-sanitize `base_url` to avoid `//chat/completions`.
_Resolves FR‑17._

### H. Security & key seam

**22 · Add an explicit per-call connection-validation hook.**
_Nugget · M · Med._ A `beforeCall` that receives the *resolved* connection
(including `baseUrl`) lets consumers run request-time SSRF/DNS-rebinding re-checks
directly, instead of smuggling them into `keySource.resolve` with fake key refs.
_Resolves FR‑18._

### I. Embeddings

**23 · Add embeddings support.**
_Nugget · L · High._ An `embed()` adapter method plus `EmbedRequest`/`EmbedResult`
types (at minimum for Ollama and OpenAI-compatible providers) would let the entire
RAG/embeddings path run through the same handler — regaining telemetry, policy,
key resolution, and redaction that the raw-`fetch` bypass currently forfeits.
_Resolves FR‑20._

### J. Cost & telemetry

**24 · Add an optional cost-accounting hook to `CallRecord`.**
_Nugget · M · Med._ A price-map hook (or an `estimatedCostUsd` field the consumer
can populate from a table) gives spend visibility without every app re-deriving it.
_Resolves FR‑22 (and, together with #4, restores FR‑21)._

### K. Library hygiene

**25 · Clear the small-defect backlog.**
_Nugget · M · Low._ Forward image content parts on replay in all engines; remove
the dead `role==='tool'` branch; document the `403`-non-retryable policy; stabilize
MCP-style tool-name derivation; refresh the stale README test count; add
lint + coverage tooling; and commit example lockfiles so CI can use `npm ci`.
_Resolves FR‑23._

### L. Versioning & release discipline (meta)

**26 · Adopt clearer SemVer + upgrade notes — and bump the consumer to 0.4.x.**
_Both · S · Med._ Because `^0.3.1` cannot pull `0.4.x`, publish an upgrade guide
and treat behavior-affecting changes as version-noted, so consumers can safely
move; on the Studio side, plan the `0.3.1 → 0.4.x` bump to pick up the fixes above
as they land.
_Resolves FR‑24._

---

## Where to start (quick wins)

Small-effort, high-value items that need no architectural change:
**#5, #7, #8, #9, #10, #16, #19**, and the consumer-side **#26** bump.

The one structural investment that pays back the most is **#4** (provider-options
passthrough): it is the root cause behind the largest downstream workarounds, and
landing it makes it possible to route the local path back through the handler —
reclaiming telemetry (#21) and blocklist coverage (#19-security).

---

## Methodology & sources

This report was assembled from four independent evidence sweeps, cross-checked
against the current source of both repositories:

1. **AI Server Studio `CHANGELOG.md`** — every `ai-nugget` mention and related
   term (`ERR_REQUIRE_ESM`, `runAgent`, `nativeTools`, `num_ctx`, `promptJson`,
   `responseFormat`, `keySource`, …) read in context.
2. **AI Server Studio backend source** — every file that imports the nugget,
   read for workarounds, shims, and re-implementations.
3. **AI Nugget capability baseline** — `README.md`, `design.md`, `CHANGELOG.md`,
   the two audit docs, `package.json`, and all of `src/`, to ground each
   suggestion against what already exists (so nothing here re-recommends a
   feature the library already has).
4. **AI Server Studio docs/audits/roadmap** — `development-docs/architecture.md`,
   `audits/`, `docs/` (incl. archives), confirming architectural decisions and
   dates.

Findings marked with `NUG: docs/reviews/2026-07-09-audit.md` were verified still
open against `src/` at version `0.4.1`.

*Companion:* an attractive, shareable visual version of this report exists with
the **same suggestion numbers**.
