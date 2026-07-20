# AI Nugget QA

AI Nugget is a zero-runtime-dependency TypeScript library. Its public contract
must work in supported Node versions and in a real browser; it has no
standalone product UI, local storage, or IndexedDB flow to test.

## Required checks

For every change, install from the lockfile and run:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Changes to source, provider adapters, request handling, streaming, policy,
redaction, telemetry, or agent loops must also run:

```bash
npm run test:browser
npm run build:nugget
git diff --exit-code -- dist nugget
```

The browser suite requires Chromium. In CI, install it with
`npx playwright install --with-deps chromium`. If Chromium is unavailable
locally, record that skip and rely on the required CI browser job before
merging.

## Invariants

- Keep `dependencies` empty; development-only test tooling belongs in
  `devDependencies`.
- Never put provider keys in browser code, fixtures, snapshots, or logs.
- Preserve server/app ownership of provider allowlists and model selection.
- Keep retry, timeout, redaction, and telemetry behavior deterministic.
- Regenerate both `dist/` and `nugget/` whenever public source changes.

## Optional live checks

`npm run test:live` is intentionally environment-gated. Run it only with an
explicitly configured test provider. A missing provider or API key is a skip,
not proof that the live path passed.

This repository does not require a separate style linter. TypeScript
type-checking, deterministic tests, generated-artifact drift checks, and the
Node/browser contract suites are the code-quality gates.
