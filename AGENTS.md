# AGENTS.md

## Skills

Task-specific guides for AI agents live in `.claude/skills/` (Claude Code
loads them automatically; other agents can read the `SKILL.md` files directly):

- `use-ai-nugget` — integrating the nugget into a consuming app
- `build-agent-loop` — tool-calling / agent loops via `@jxburros/ai-nugget/agent`
- `add-provider` — adding or changing a provider profile
- `develop-nugget` — invariants, validation, and changelog for changes to this repo

## Required Reading

- Read `README.md` before changing public behavior.
- Read `src/types.ts` before changing contracts.
- Read `src/handler.ts` before changing lifecycle, retries, policy, keys, redaction, or telemetry.
- Read `src/adapters/profiles.ts` before adding or renaming providers.

## Principles

- Keep the core isomorphic: no Node-only runtime APIs in `src/`.
- Keep runtime dependencies at zero unless a maintainer explicitly changes that rule.
- Never bypass the handler pipeline for model calls.
- Keys must enter through `KeySource` and must not appear in telemetry, errors, logs, reports, or generated nuggets.
- AI JSON must be parsed and validated before app state or tools consume it.
- Missing keys or unavailable local models should produce honest typed failures, not fake success.

## Feature Admission Test

The library is at its intended complexity boundary. Agent loops, embeddings,
pricing hooks, discovery, provider passthrough, and three distribution modes
already carry real maintenance load, and every addition is paid for again on
every future change. So a new feature has to earn its place.

**A feature is admissible only if it makes provider execution safer or more
reusable.** Concretely, it must clear all four:

1. **Belongs to the seam, not the app.** It concerns *how a provider call is
   made, governed, or observed* — not what the app does with the result.
   Prompts, model choice, memory, retrieval, routing, and UI are app concerns.
2. **Wrong to reimplement per app.** Every consumer would otherwise write it,
   and at least one would write it wrong in a way that leaks a key, hangs a
   request, fakes a success, or silently drops output.
3. **No new runtime dependency, and isomorphic.** Zero deps is a hard rule; no
   Node-only APIs in `src/`.
4. **Contract-shaped.** It can be expressed as a typed contract or an existing
   seam (`KeySource`, `Redactor`, `GovernancePolicy`, `TelemetrySink`, a profile
   quirk, a stream event) rather than a new subsystem.

Fails any one → it belongs in the consuming app, or in a separate package.

If it passes, prefer the smallest shape: a profile-table row over a new engine,
a quirk over a branch, a `context` stream event over a new event type, an
optional field over a new method. Consolidating an existing concept (moving
duplicated helpers into `base.ts`) is not a new feature and doesn't need the
test; introducing a new concept always does.

## Validation

Run these before handing off meaningful changes:

```bash
npm test              # Node contract suite
npm run test:browser  # same suite in headless Chromium (isomorphism)
npm run build
npm run build:nugget
```

Live smoke tests are env-gated (`AI_HANDLER_LIVE=1 npm run test:live`) and never
run by default. Record any skipped validation honestly.
