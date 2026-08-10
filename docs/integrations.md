# Integration matrix

Package-level tests run inside this repo against mocked `fetch`. They prove
*behavior*. They structurally cannot prove *packaging*: a broken `exports` map,
a bundler that won't resolve the package, a Node built-in that crept into the
import graph, or a route handler that type-checks but won't build.

`examples/integrations/` closes that gap. Each starter is a real installable
package that consumes the nugget through its published entry points, and each
has a `verify` script CI runs on every push and PR
(`.github/workflows/integrations.yml`).

| Starter | Host toolchain | What a failure here would mean |
|---|---|---|
| `module-resolution` | Node ESM + CJS | The `exports` map is broken, or a named export resolves to `undefined` under `require()` (the classic dual-package hazard) |
| `express` | Node + Express | The package doesn't resolve in a plain Node server, or the `StreamEvent` → SSE bridge is broken |
| `ollama-desktop` | Local runtime, no key | The zero-key local path regressed — health probe, model discovery, or NDJSON streaming |
| `workers` | `wrangler deploy --dry-run` (workerd/esbuild) | Something in the import graph reaches for a Node built-in — the isomorphism invariant broke |
| `nextjs` | `next build` | A bundler can't resolve the package or the typed route handler no longer compiles |

Three of the five (`module-resolution`, `express`, `ollama-desktop`) run against
`examples/integrations/mock-provider.mjs`, a local server speaking both the
OpenAI-compatible and Ollama protocols — hermetic, no API key, no network. The
other two run their host's real build.

## Running one locally

```bash
npm run build                    # from the repo root
cd examples/integrations/express
npm install
npm run verify
```

## What this matrix deliberately does not cover

- **Live provider behavior.** Upstream APIs drift independently of this
  library; that's `live-matrix.yml`'s job (weekly/manual, key-gated). See
  [providers.md](./providers.md#verification-status) for which providers are
  live-verified and which are only mock-verified.
- **Browser bundlers other than the ones above.** The headless-Chromium contract
  suite in `ci.yml` proves the *core* runs in a browser; a specific bundler's
  resolution quirks are covered only for Turbopack (via the Next.js build) and
  esbuild (via wrangler). Known Turbopack caveats for the vendored `nugget/`
  path are in [distribution.md](./distribution.md#bundler-compatibility-for-the-vendored-nugget-path).
- **Deployment.** Nothing here deploys anywhere; `wrangler` runs `--dry-run` and
  `next build` produces no server.

## Adding a host

If you hit friction in a host that isn't listed, that host belongs here. Add a
directory under `examples/integrations/` with a `package.json` depending on
`"@jxburros/ai-nugget": "file:../../.."`, a `verify` script that exits non-zero
on failure, and a matrix entry in `.github/workflows/integrations.yml`. Keep the
verify hermetic (use `mock-provider.mjs`) unless the point of the starter is the
host's own build.
