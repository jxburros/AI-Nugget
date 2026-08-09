# AI Nugget — Field Review

**Version reviewed:** 0.5.0
**Date:** 2026-08-09
**Author:** Claude
**Scope:** `src/`, `docs/`, `README.md`, `AGENTS.md`, CI workflows, and a live run
of the validation commands, read cold as a reviewing engineer and then re-run
through five developer personas who'd actually reach for the library.

**Validation run in this session:**

- `npm install` — clean
- `npm test` — 128 passed, 6 skipped (live-gated)
- `npm run build` — pass
- `npm run lint` — pass, no findings
- `npm audit` — 0 vulnerabilities
- Runtime `dependencies` — 0

---

## Verdict

AI Nugget is a genuinely well-built provider-calling library that undersells
itself with its name. It does one narrow job — the pipe between an app and an
AI provider — and does it with a discipline that's rare in this space: zero
runtime dependencies, one enforced call pipeline, honest typed errors instead
of silent fallbacks, and a redaction layer that's actually been thought
through rather than bolted on. It has already survived contact with a real
consumer app (see
[`2026-08-09-ai-server-studio-friction-report.md`](./2026-08-09-ai-server-studio-friction-report.md))
and had every one of that report's 26 suggestions implemented in the very next
release — that's a stronger adoption signal than most libraries this size ever
get.

It is *not* a framework, and it knows it: no router, no memory, no secrets
vault, no UI, no default governance policy. That restraint is the correct call
for a "nugget," but it means the library is only as good as the app wrapping
it — and the docs are honest about that boundary rather than papering over it.

| | |
|---|---|
| Core pipeline & safety invariants | **Strong** |
| Test discipline & CI matrix | **Strong** |
| Day-one onboarding for beginners | **Mixed** |

---

## My review

### What's working

- **One pipeline, no back doors.** `AIHandler.stream()` is the only path to a
  provider call, and every exit — policy block, key failure, a throwing
  `beforeCall` hook, retry exhaustion, consumer-abandoned stream — routes
  through the same `recordFailure`/`recordSuccess` so telemetry never gets
  skipped. Traced all the early-return branches in `src/handler.ts:76–186`;
  none of them leak past redaction.
- **Redaction is layered, not decorative.** A static pattern set (18 provider
  token shapes, PEM keys, JWTs, generic bearer tokens) plus a per-session set
  that adds every key actually resolved during the run, so even a key format
  the static list doesn't recognize still gets caught once it's been used once
  (`src/redact.ts`).
- **Data-driven provider table.** Four wire-protocol engines (`openaiChat`,
  `anthropic`, `google`, `ollama`) with a profile table on top — adding an
  OpenAI-compatible provider is a row, not a forked copy of the SSE loop. 16
  providers ship today; the escape hatch (`openai-compat`) means an unlisted
  one is a config change, not a fork (`src/adapters/profiles.ts`).
- **The agent loop stops honestly.** `stopReason` is one of `finished /
  max_steps / budget / deadline / canceled / error` — never a silent empty
  completion. A `promptJson`-mode tool directive is filtered out of the
  visible delta stream but still parsed, which closes a real bug class (raw
  JSON leaking into chat UI) cleanly (`src/agent/loop.ts:106–271`).
- **It's been dogfooded, and it listened.** The friction report from AI Server
  Studio (a real consumer) catalogued 26 specific gaps — provider-options
  passthrough, native tools on capable local models, idle-stream timeouts —
  with file/line evidence. All 26 landed in 0.5.0. That loop, evidenced in the
  repo rather than claimed, is worth more than any amount of unit-test
  coverage on its own.

### What isn't

- **The README is thorough to the point of being a second onboarding tax.**
  450+ lines covering distribution channels, bundler quirks, capability
  tables, and a full error-mapping matrix before a newcomer reaches anything
  resembling "hello world." Everything in it earns its place, but there's no
  20-line quick-start distinct from the reference doc — a first-time reader
  has to skim past governance and distribution strategy to find the one
  `handler.chat()` call they wanted.
- **Concurrency and rate limiting are process-local.** `maxConcurrent`/
  `minIntervalMs` live on the `AIHandler` instance's in-memory queue
  (`src/handler.ts:382–416`). That's the correct scope for a library with no
  external dependencies, but it's not stated anywhere near the limits option
  itself — a team running multiple instances behind a load balancer could
  reasonably assume it's shared and get surprised by burst behavior under
  scale-out.
- **Tool-arg validation is intentionally shallow.** `defineTool`'s schema
  check covers object-ness, `required`, and top-level `properties[key].type`
  — no `enum`, nested objects, array `items`, or numeric bounds
  (`src/agent/tools.ts`). This is disclosed plainly in the README, which is
  the right way to ship a deliberate limitation, but it means a model that
  hallucinates an out-of-range value sails through the framework layer and
  the tool author has to catch it themselves every time.
- **npm scope is a personal account.** `@jxburros/ai-nugget` publishes under a
  personal npm scope, not an org. Fine for a solo maintainer's tool; worth a
  conscious decision before a company standardizes on it as shared
  infrastructure, since transfer/ownership continuity isn't the same story as
  an org-owned package.

> The one thing I'd push back on if this were a PR: the design is *correct*
> for "small library, app owns policy," but that correctness is invisible
> until you've read the non-goals section. Nothing in the type signatures
> stops a team from skipping `GovernancePolicy` entirely and shipping with
> `allowAllPolicy()` silently active in production. That's a reasonable
> default for a library — but it's the kind of default that should probably
> come with a startup-time warning log when no policy is configured, not just
> a README paragraph.

---

## Five developers, five reactions

Same library, five different jobs to be done. Ratings are out of 5 and
reflect fit for *that* persona's actual task, not the library in the
abstract.

### Priya — bootcamp grad, first AI feature (3.5 / 5)

*Wiring a "summarize this" button into a class project, has never called an
LLM API before.*

- **Liked:** the four-line quick-start in the README actually ran on the
  first try, once found. Error kinds map to plain English (`context_length` →
  "shorten your input") without her writing that logic.
- **Struggled with:** didn't know what a `KeySource` or `Connection` was
  supposed to represent versus just pasting a key inline — one indirection
  more than her mental model needed on day one. The provider capability
  table, retry/backoff internals, and CJS/ESM distribution notes all sit
  above the fold before "here's your first call" — she closed the tab twice
  before finding `envKeySource()`.
- *"It worked once I found the right 10 lines — but I read like 200 lines of
  stuff about bundlers and OpenRouter before I got there."*

### Marcus — junior full-stack dev, feature deadline (4.5 / 5)

*Adding an AI chat panel to an existing SaaS app on a two-week sprint.*

- **Liked:** the "Recipes" section (JSON output + validation, error-handling
  matrix) is copy-pasteable and covers exactly the two things he always has
  to build by hand. Streaming worked the same in his Node route handler and
  in a quick React test. `chatParsed()` with a Zod schema removed a whole
  retry-loop he was about to hand-roll.
- **Struggled with:** picking a model provider for the model-picker UI
  required reading the capabilities table closely to understand why
  `listModels()` returns `[]` for Perplexity — not a bug, but not obvious
  without the README section explaining it.
- *"This is the first AI library where the error handling section saved me
  actual time instead of being a stub I had to rewrite."*

### Elena — staff engineer, platform adoption call (4 / 5)

*Deciding whether to standardize three internal services on this instead of
three separate provider SDKs.*

- **Liked:** zero runtime dependencies and an isomorphic core that's actually
  tested in headless Chromium, not just claimed. The governance seam
  (`GovernancePolicy`, `blocklistPolicy`/`allowlistPolicy`) is exactly the
  shape she'd want to plug an internal compliance policy into without forking
  the library. One redacted `CallRecord` per call, success or failure, is the
  audit trail her security team will ask for — enforced structurally, not
  left to each call site to remember.
- **Struggled with:** in-memory concurrency limits mean each service instance
  rate-limits independently — she'll need a shared limiter or a per-instance
  budget in front of it for a horizontally-scaled service. Personal npm scope
  (`@jxburros`) is a governance question for procurement, not a code problem,
  but worth raising before three teams depend on it.
- *"The invariants in AGENTS.md read like something we'd write ourselves for
  an internal platform library. That's the strongest signal in the whole
  repo — someone is enforcing discipline, not just hoping for it."*

### Devon — solo founder, shipping an MVP this weekend (4.5 / 5)

*Building a niche SaaS tool alone, wants to try local models to keep costs at
zero pre-revenue.*

- **Liked:** swapping Ollama for OpenAI at launch is a one-line `Connection`
  change, not a rewrite — validated by running `examples/ollama.mjs` then
  pointing the same code at OpenAI. `providerOptions` passthrough (new in
  0.5.0) reaches Ollama's `num_ctx`/`keep_alive` directly. The vendorable
  `nugget/` folder means he isn't locked into npm if he later needs to embed
  this in a repo that can't take dependencies.
- **Struggled with:** no CLI or scaffolding — every connection, key source,
  and policy is hand-assembled in code. For someone optimizing for speed over
  control, that's a few more minutes than a "just works" SDK, though it paid
  off once he needed the local/hosted swap.
- *"I built against Ollama for free, then flipped one object to OpenAI for
  the demo. That's the whole pitch, and it actually held up."*

### Sam — agent/tools engineer (4 / 5)

*Building a tool-calling agent that has to run against both GPT-4o and a
local Llama model behind the same code path.*

- **Liked:** `toolMode: 'auto'` resolving per-provider — native tool-calling
  on GPT-4o, `promptJson` fallback on the local model — meant one call site
  instead of a branch for every provider's tool-calling quirks.
  `modelCapabilities` upgrading a capable local model past the conservative
  profile default is exactly the override he needed once he'd confirmed via
  `/api/show` that his loaded model actually supports tools. `ApprovalGate`'s
  three-way outcome (`allow` / `deny` / rewrite arguments) let him quarantine
  a risky file-delete tool call instead of just blocking it.
- **Struggled with:** tool argument validation stops at top-level types — he
  still writes his own bounds-checking inside `execute()` for anything the
  model could plausibly hallucinate out of range, which the docs do warn
  about but he'd still rather not repeat per tool. `maxSteps` defaults to 8;
  fine for demos, but he had to reason from the loop source (not the README)
  about what happens to an in-flight tool call when a step budget is hit
  mid-turn.
- *"The promptJson fallback is the first one I've used where the JSON
  directive doesn't leak into the chat UI. Small thing, saved me a regex."*

---

## Side by side

| Reviewer | Onboarding | Docs depth | Safety / governance | Local-model fit | Prod readiness |
|---|---|---|---|---|---|
| Myself (audit) | Dense | Thorough | Strong | Solid | Ready |
| Priya (beginner) | Rough | Too much, too soon | not evaluated | not evaluated | not evaluated |
| Marcus (junior) | Smooth | Recipes helped | assumed, not tested | not evaluated | Ready |
| Elena (staff) | not the point | Matches internal bar | Strong seam | Needs shared limiter | Ready, with caveats |
| Devon (indie) | Code-first, no CLI | Enough to ship | not a priority yet | Excellent | Ready |
| Sam (agent eng) | not the point | Loop internals under-documented | Approval gate is real | Excellent | Ready |

---

## What I'd fix next

In priority order — none of these are architectural; all are reachable
without breaking the public contract.

1. **Split a 15-line quick-start from the reference README.** Priya's and (to
   a lesser extent) Devon's friction is the same problem: the correct
   information exists, but a first-time reader has to wade through
   capability tables and bundler notes to find it. A separate "Quick start"
   doc or top-of-README fold would fix this without cutting anything from the
   reference material.
2. **Log a warning when no `GovernancePolicy` is configured.**
   `allowAllPolicy()` being the silent default is the right library default,
   but a one-line startup notice ("no governance policy configured — all
   models allowed") would catch the case Elena's team is most likely to trip
   on: someone shipping to prod having never read the non-goals section.
3. **Document that concurrency/rate limits are per-instance, next to the
   option itself.** Currently this is knowable by reading the implementation;
   it should be a doc comment on `HandlerOptions.limits`, since it changes
   how a horizontally-scaled deployment should be architected.
4. **Add a one-paragraph "what happens mid-budget" note to the agent loop
   docs.** Sam's question (what happens to an in-flight tool call when
   `maxSteps`/`deadlineMs` hits) is answered correctly by the code but isn't
   stated anywhere a caller would look first.
