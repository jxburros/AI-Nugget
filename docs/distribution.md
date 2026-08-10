# Distribution, build, and test commands

## Requirements

Node `^20.19.0` or `>=22.12.0` (see `engines` in `package.json` and `.nvmrc`).
The toolchain's build step (`vitest` → `rolldown`) needs a native binding
unavailable on older Node 20 patch releases; on those you get a cryptic
native-binding failure from `npm run build`/`npm run test:browser` rather than a
clear version error.

## Commands

```bash
npm install
npm test                        # Vitest contract suite in Node (live tests skipped unless env-gated)
npx playwright install chromium # one-time, before test:browser
npm run test:browser            # same suite in headless Chromium (proves isomorphism)
npm run build                   # tsc → dist/ (ESM + CJS; also the typecheck)
npm run build:nugget            # writes a vendorable nugget/ stamped with version + content hash
npm run lint
```

## Live smoke tests (optional, env-gated)

`tests/live-smoke.test.ts` exercises the real wire path against a live provider.
It is **skipped unless `AI_HANDLER_LIVE=1`**, so it never runs in the default
suite or in the standard CI workflow:

```bash
# Local Ollama (defaults: provider=ollama, model=llama3.2)
AI_HANDLER_LIVE=1 npm run test:live

# A cloud provider, with JSON-mode and agent tool-loop checks enabled
AI_HANDLER_LIVE=1 AI_HANDLER_LIVE_PROVIDER=openai AI_HANDLER_LIVE_MODEL=gpt-4o-mini \
  AI_HANDLER_LIVE_KEY_ENV=OPENAI_API_KEY AI_HANDLER_LIVE_JSON=1 AI_HANDLER_LIVE_TOOLS=1 \
  npm run test:live
```

Config env vars: `AI_HANDLER_LIVE_PROVIDER`, `AI_HANDLER_LIVE_MODEL`,
`AI_HANDLER_LIVE_BASE_URL`, `AI_HANDLER_LIVE_KEY` (literal) or
`AI_HANDLER_LIVE_KEY_ENV` (key from an env var), `AI_HANDLER_LIVE_JSON`,
`AI_HANDLER_LIVE_TOOLS`.

## CI workflows

| Workflow | Runs on | Proves |
|---|---|---|
| `ci.yml` | push / PR | Node 20 + 22 contract suite, build, headless-Chromium suite (isomorphism), `dist/`+`nugget/` drift check |
| `integrations.yml` | push / PR | The package resolves, builds, and executes inside real host toolchains — Node/Express, Next.js route handlers, a Workers-style edge bundle, and a CJS `require` path. See [integrations.md](./integrations.md). |
| `npm-mini-apps.yml` | PRs touching `examples/npm-mini-apps/**` | The three published-package mini-apps still install and import |
| `live-matrix.yml` | manual / weekly schedule | Real endpoints for OpenAI, Anthropic, Google, OpenRouter — never on push/PR, so it can't block or flake normal CI |
| `dependency-vulnerability-scan.yml`, `publish.yml`, `pages.yml` | — | Supply-chain scan, release publishing, docs site |

`live-matrix.yml` exists because mocked fetch responses can't catch live-wire
drift. Each matrix entry reads its API key from a same-named repository secret
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`)
and skips itself with a notice if that secret isn't configured. Local runtimes
aren't in the matrix since they need a reachable server; smoke-test those with
the local `test:live` invocation above.

## Distribution paths

Three supported paths, in order of preference:

1. **npm registry (primary).** `@jxburros/ai-nugget` publishes to
   [npmjs.org](https://www.npmjs.com/package/@jxburros/ai-nugget) on every
   published GitHub release (`.github/workflows/publish.yml`):

   ```bash
   npm install @jxburros/ai-nugget
   ```

   This is the default dependency path for apps: fix once here, bump the
   dependency in each app, and let npm resolve it normally.
2. **GitHub Packages (kept).** The same release workflow also publishes to
   GitHub Packages for GitHub-native workflows and existing portfolio consumers.
   Those apps add a project `.npmrc`:

   ```
   @jxburros:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

   (GitHub Packages requires an authenticated token even for public-repo
   packages.)
3. **Vendored `nugget/` (fallback).** `nugget/` is a generated single-folder
   build for repos that cannot take a package dependency. It contains **both**
   `nugget/src/` (TypeScript source) **and** `nugget/dist/` (compiled ESM `.js` +
   `.d.ts`), plus `VERSION.txt` (version + content-hash stamp) so drift from the
   source of truth is detectable. Copy it in and point your bundler at whichever
   suits it: `nugget/src` for TypeScript-aware toolchains, `nugget/dist` for
   bundlers that don't resolve `.ts` via `.js`-suffixed imports.

`dist/` (ESM + CJS + `.d.ts`) is the package's own build output. `dist/` and
`nugget/` are both committed and regenerated from `src/`; `prepublishOnly`
rebuilds both, and CI fails if either is stale.

### ESM and CommonJS

Both entry points ship, so `import` and `require` both work:

```ts
import { AIHandler, envKeySource } from '@jxburros/ai-nugget';
```

```js
const { AIHandler, envKeySource } = require('@jxburros/ai-nugget');
```

### Bundler compatibility for the vendored `nugget/` path

`nugget/src/*.ts` uses NodeNext-style relative imports with explicit `.js`
extensions (e.g. `export * from './types.js'`), which `tsc` needs to resolve
`.ts` files under `moduleResolution: bundler`/`nodenext`. Not every bundler's
runtime module graph treats `.ts`/`.js` as interchangeable the way `tsc` does —
confirmed with Next.js 16's Turbopack: aliasing straight at `nugget/src/index.ts`
type-checks but fails to resolve at build/dev time (`Module not found: Can't
resolve './types.js'`), and aliasing at the compiled `dist/index.d.ts` builds but
silently resolves some named exports to `undefined` at runtime. If your bundler
hits this, vendor `dist/` (real `.js` + `.d.ts` pairs) instead of `nugget/`, and
point path aliases at its `.js` entry points (e.g. `dist/index.js`,
`dist/agent/index.js`) — TypeScript picks up the sibling `.d.ts` automatically.
