# AGENTS.md

## Skills

Task-specific guides for AI agents live in `.claude/skills/` (Claude Code
loads them automatically; other agents can read the `SKILL.md` files directly):

- `use-ai-handler` — integrating the nugget into a consuming app
- `build-agent-loop` — tool-calling / agent loops via `@jxburros/ai-handler/agent`
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
