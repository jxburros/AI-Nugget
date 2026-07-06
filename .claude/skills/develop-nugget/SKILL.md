---
name: develop-nugget
description: Contribute changes to the ai-handler nugget itself — invariants to preserve, required reading order, validation commands (Node + browser tests, build, nugget regen), and the changelog format. Use before making any change to src/, tests/, or the build in this repository, and when preparing a change for handoff.
---

# Developing the nugget itself

## Required reading before you edit

Per `AGENTS.md`, read these before changing the corresponding area:

- `README.md` — before changing any public behavior
- `src/types.ts` — before changing contracts
- `src/handler.ts` — before changing lifecycle, retries, policy, keys,
  redaction, or telemetry
- `src/adapters/profiles.ts` — before adding or renaming providers (see the
  `add-provider` skill)
- `design.md` — the full contract, when a change touches design-level behavior

## Invariants — never violate these

1. **Isomorphic core.** No Node-only runtime APIs in `src/` (no `fs`, `path`,
   `process` beyond guarded env reads, `Buffer`, Node streams). Only `fetch`,
   `ReadableStream`, `AbortController`, `TextDecoder`. `npm run test:browser`
   exists to catch violations.
2. **Zero runtime dependencies.** Do not add packages to `dependencies` —
   that rule changes only by explicit maintainer decision.
3. **Never bypass the handler pipeline** for model calls, in library code,
   tests, or examples.
4. **Key hygiene.** Keys enter only via `KeySource` and must not appear in
   telemetry, errors, logs, reports, or generated nuggets.
5. **Validated JSON.** AI JSON is parsed (`extractJson`) and validated before
   app state or tools consume it.
6. **Honest failures.** Missing keys or unavailable local models produce typed
   `AIError` failures, never fake success or silent fallbacks.
7. **Every call yields exactly one redacted telemetry record** — success,
   failure, or abandoned stream.
8. **No provider policy as a library default.** Blocklists/allowlists are the
   app's configuration at the governance seam.

Also from `CLAUDE.md`: make the smallest safe change that preserves the public
contract.

## Validation before handoff

```bash
npm test               # Vitest contract suite in Node (mocked fetch; live tests env-gated off)
npm run test:browser   # same suite in headless Chromium — proves isomorphism
npm run build          # tsc → dist/ (also the typecheck)
npm run build:nugget   # regenerates the vendorable nugget/ with version + content hash
```

Run all four for any meaningful change. `dist/` and `nugget/` are **committed
generated output** — regenerate and commit them when `src/` changes; CI fails
if either is stale. Never hand-edit `dist/` or `nugget/`.

Update tests when changing transport, parsing, retries, policy, redaction, or
agent-loop behavior. Update `README.md` when setup, exports, provider support,
or user-facing behavior changes.

Live smoke tests are optional and env-gated (`AI_HANDLER_LIVE=1 npm run
test:live`); they never run by default or in normal CI. Record any skipped
validation honestly.

## Changelog

Append an entry to `CHANGELOG.md` in exactly this format (newest first):

```markdown
## YYYY-MM-DD - Claude

### Changed
- ...

### Not completed
- None.

### Notes
- Validation: ...
```

The `Notes` line records which validation commands ran and their results;
`Not completed` records anything skipped or deferred — honestly.
