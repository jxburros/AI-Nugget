# State of the Nugget — 2026-08-10

A snapshot taken immediately after closing the full open-issue backlog (#45–#73)
from the comprehensive product review, the persona review, and the code review.
Written to be read by someone deciding whether to depend on this, extend it, or
ship it.

## Summary

**The library is production-ready for its stated scope and now honest about
where its edges are.** The open-issue count went from 28 to 0. The changes were
weighted toward the two things that were genuinely weak — the confidence of the
safety layer (its own test coverage), and the discoverability of behavior that
was correct in code but undocumented.

Nothing in the backlog turned out to be an architectural problem. Every fix was
a fix, not a redesign, which is the useful signal about the codebase's shape.

| Metric | Before | After |
|---|---|---|
| Open issues | 28 | 0 |
| Tests | 129 | 194 |
| Statement coverage | — | 85.0% (branch 71.7%, function 86.4%) |
| `src/` | 2,385 lines across 22 files | unchanged in size, less duplicated |
| README | 471 lines | ~140 lines + 7 focused `docs/` pages |
| CI workflows | 6 | 7 (new host-integration matrix) |
| Runtime dependencies | 0 | 0 |

## What the library is

A zero-dependency, isomorphic TypeScript layer that puts every AI provider call
through one governed pipeline:

```
policy → key resolution → beforeCall hook → concurrency/retry → provider adapter → redacted telemetry
```

19 provider profiles over 4 protocol engines. It runs identically in Node, a
browser main thread, and a Web Worker using only `fetch`, `ReadableStream`,
`AbortController`, and `TextDecoder` — an invariant now proven three ways
(headless-Chromium contract suite, a workerd bundle in CI, and no Node imports
in `src/`).

It is deliberately not a router, prompt library, memory system, agent framework,
or secrets vault.

## Architecture health

**The engine/profile split is doing its job.** Four engines own wire formats;
a data-driven table turns each provider into defaults + quirks. Adding an
OpenAI-compatible provider is a table row. Three of this cycle's changes
(idempotency support, JSON-mode downgrade signaling, stream-anomaly parity)
landed as a quirk, an event, and a shared helper respectively — no new
subsystem, no new engine.

**The duplication that had crept in is gone.** `parseArgs`, `safeParse`, and
`randomId` existed in near-identical copies across four engines; they now live
in `engines/base.ts`. That consolidation is what made the Ollama tool-argument
bug (#68) a one-line fix rather than a fourth patch — a good argument for doing
this kind of cleanup before it's urgent.

**The handler had accumulated a repeated preamble.** `stream()`, `embed()`, and
the probes each re-implemented policy → key resolution → `beforeCall`, and
`stream()` repeated the same record-fail-and-emit triple four times. Both are
now single helpers (`preflight()`, `failStream()`). Beyond readability this
closed a real class of bug: the `beforeCall` key-scrubbing fix (#56) needed to
apply at three call sites, and now applies at one.

### Where the complexity budget stands

The product review's warning — that the library is nearing its intended
complexity boundary — is correct and now has a mechanism behind it. `AGENTS.md`
carries a four-point **Feature Admission Test**: a feature must belong to the
seam rather than the app, be wrong to reimplement per app, add no runtime
dependency and stay isomorphic, and be expressible as a typed contract or an
existing seam. Fails any one → it belongs in the consuming app.

This is worth taking seriously. Agent loops, embeddings, pricing, discovery,
provider passthrough, and three distribution modes are already a lot for a
zero-dependency library, and the maintenance cost is paid on every future
change, not once.

## Safety posture

This is where the most substantive work happened, because the library's headline
invariant — *keys never appear in telemetry, errors, logs, or generated nuggets*
— was correct in practice but under-defended.

**Fixed:**

- **A real leak path.** `beforeCall(info)` handed hooks the caller's raw
  `Connection`, including a plaintext `{ kind: 'literal' }` `keyRef` — and
  `info.resolved` carried it too, plus the auth headers derived from the key.
  Logging `info` for audit, the obvious thing to do, shipped the key in clear
  text. Both are now scrubbed.
- **Redaction moved from convention to structure.** `classify()` redacted
  nothing; safety depended on every call site routing through the handler's
  wrapper. It now redacts the provider body excerpt at construction, at the wire
  boundary, so no `AIError` can carry a recognizable secret regardless of how it
  propagates.
- **A coverage gap in the redactor itself.** Only 3 of 19 secret patterns had
  any assertion. All 19 now do, plus end-to-end proof that a non-`sk-` format is
  scrubbed from a thrown error and a `CallRecord`.
- **Unprefixed secrets.** Azure `api-key` values, AWS secret access keys, and
  bare session tokens have no distinctive prefix. Rather than match on shape
  (which would redact commit SHAs and content hashes), new patterns anchor on
  the preceding *label* and redact only the value.

**Honestly documented rather than "fixed", because these are app decisions:**

- **SSRF via caller-controlled `baseUrl`** — there is no scheme/host allowlist,
  and `applyAuth` attaches the resolved key to whatever URL results. An app that
  lets end-user input reach `baseUrl` has built SSRF with a credential attached.
  This is out of library scope by design; it is now stated outright, with the
  server-side connection-map pattern and a `beforeCall` validation recipe.
- **Prompt/tool injection defenses are opt-in and fail-open.** `wrapUntrusted`
  and the approval gate both mitigate tool-output injection; neither is on by
  default. Now a table, in two places, so nobody assumes protection they don't
  have.
- **Tool-argument validation is a filter, not a boundary.** `validateToolArgs`
  checks object-ness, `required`, and top-level types — no `enum`, nested
  schemas, array `items`, or bounds. A three-step secure-tool recipe now shows
  re-validating inside `execute()`.

**Governance is visible at runtime.** `allowAllPolicy()` remains the default —
correct for a library — but a missing policy now logs a one-time startup notice.
Passing `policy: allowAllPolicy()` explicitly is the opt-out, so the warning
means precisely "nobody made this decision."

**Residual risk, stated plainly:** a bare, unlabeled, unprefixed secret is not
caught by pattern redaction, and cannot be without unacceptable false positives.
`SessionRedactor.addSecret()` is the guaranteed catch; the handler registers
every resolved key that way automatically, but anything else secret reaching a
prompt or tool result must be registered by the app.

## Reliability posture

**Solid, with one architectural gap that is now documented rather than papered
over.** `AIHandler` creates no timeout of its own — it forwards `req.signal` and
nothing else. Whether a call can hang at all is decided inside each adapter, and
the handler cannot verify it. All four in-tree adapters comply; a fifth that
didn't would hang with no upper bound anywhere.

Adding a handler-level default was considered and rejected: two independent
deadlines racing over one call makes attribution harder, and the handler can't
see chunk boundaries so it could never implement the idle half. The contract is
instead explicit in `docs/reliability.md` and enforced as a checklist in the
`add-provider` skill.

Other reliability work:

- **Double-billing.** A connection dropping after the provider generated (and
  billed) but before any byte arrived would be retried and billed twice. OpenAI
  requests now carry an `Idempotency-Key` stable across retries. The risk
  remains for providers without documented idempotency support, and is
  documented with two mitigations.
- **Error classification.** 404/410 now map to a new `not_found` kind instead of
  `invalid_request`, so a misrouted edge or wrong model name doesn't produce
  "that request was invalid" to a user. Remaining 4xx fallthrough is explicit
  and commented.
- **Truncation is diagnosable everywhere.** `stream_anomaly` was OpenAI-only;
  all four engines now emit it when a stream ends without its terminal marker.
- **Silent capability downgrades now signal.** Gemini and Anthropic both drop
  JSON mode when tools are present (both providers reject the combination). They
  now emit `json_mode_downgraded` instead of quietly returning unstructured text.

The two behaviors most worth knowing — **retries stop the instant any output
byte is emitted**, and **`limits` are per-instance, so N replicas allow N ×
`maxConcurrent`** — were correct in code and invisible in docs. Both are now
documented where a reader will hit them.

## Test and CI posture

**194 tests, 85% statements / 71.7% branches**, running identically in Node and
headless Chromium.

The two thinnest areas got direct attention. `transport.ts` (167 lines, the
hang/timeout correctness layer) had 29 lines of tests; it now has 19 tests
covering total-timeout fire, idle-timeout fire, **idle rearm on `bump()`**,
post-`done()` quiescence, classification, `tolerantJson`, malformed NDJSON, and
the no-`res.body` fallback. `redact.ts` went from 3 patterns asserted to all 19
plus end-to-end.

**A new integration matrix closes the gap unit tests structurally cannot.** Five
installable starters — Express, Next.js App Router, Cloudflare Workers, local
Ollama, ESM/CJS resolution — each install the package through its real `exports`
map and run a `verify` script in CI on every push. Three are hermetic (a bundled
mock provider, no key, no network); two run their host's real build.

The workers entry is the most valuable of the five: `wrangler deploy --dry-run`
bundles for workerd with esbuild, which fails outright on any Node built-in
anywhere in the import graph. That is a stronger isomorphism proof than running
the source in a browser.

### Known coverage gaps

Recorded honestly rather than rounded away:

- `keys.ts` at 67% and `policy.ts` at 68% — mostly the alternative `KeySource`
  implementations and `composePolicies`. Low risk, but they are seams apps rely
  on.
- `json.ts` at 70% — the `require*` guards' failure branches.
- `google.ts` at 75% branch-wise, the lowest of the four engines.
- `loop.ts` at 84% — the agent layer's error and cancellation paths.
- Live provider verification covers 4 of 19 profiles in CI (weekly/manual,
  key-gated). Nine profiles are mock-verified only, which means a renamed base
  path or a new required header upstream would not fail any test here. This is
  now labeled per-provider in `docs/providers.md` rather than left implicit.

## Documentation posture

The README was a 471-line onboarding tax — distribution strategy, capability
tables, and a full error matrix stood between a newcomer and `handler.chat()`.
It is now ~140 lines: a 15-line quick start with the Node requirement beside the
install command, the two must-configure production items, and a table pointing
at seven focused pages (`providers`, `reliability`, `security`, `agent-loop`,
`recipes`, `integrations`, `distribution`). Nothing was cut — 1,046 lines of
reference material moved.

`CLAUDE.md` now records which page owns which detail and that the README stays a
front door, so this shouldn't re-accumulate.

The single most useful addition for consumers is probably the
**provider verification matrix**: it says out loud that a profile in the table
is not a promise the provider is live-verified, and sorts all 19 into
live-verified / live-verified-manual / mock-verified / configuration-only.

## What I would do next

Not urgent, in rough order of value:

1. **Raise live-verification coverage.** Nine mock-verified providers is the
   largest remaining honesty gap. Either add live-matrix entries (each needs a
   funded account) or consider demoting profiles nobody actually uses — a
   smaller, fully-verified table may be worth more than a broad, partly-trusted
   one.
2. **Branch coverage on the seams.** `keys.ts` and `policy.ts` are small and
   directly load-bearing; getting both above 90% is a couple of hours.
3. **Idempotency beyond OpenAI.** The mechanism is in place and profile-gated;
   it just needs per-provider verification of which honor the header.
4. **Watch the agent layer.** At 458 lines `loop.ts` is the largest single file
   and the one most likely to attract scope creep. It is the first place the
   Feature Admission Test should be applied strictly.
5. **Consider a 0.6.0 release.** The changes are behavior-compatible with two
   documented exceptions (the new `not_found` error kind and the policy notice),
   `UPGRADING.md` covers both, and the backlog being empty is a natural cut
   point.

## Verification for this snapshot

Run locally and in CI, all passing:

```
npm run typecheck · npm run lint · npm test (194 passed, 6 skipped)
npm run test:browser (194 passed, headless Chromium)
npm run build · npm run build:nugget (no dist/ or nugget/ drift)
5/5 integration starters' verify scripts
```

CI on `f59b725`: `CI` green (Node 20 + 22, browser, nugget-drift),
`Integration matrix` green (5/5). Live provider tests were **not** run — they
are env-gated and require real API keys, which this environment does not have.
