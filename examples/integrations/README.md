# Integration starters

Minimal, copy-pasteable hosts for the four places this nugget actually gets
deployed, plus a packaging check. Each is a real package that installs the
nugget through its published `exports` map (`file:../../..`), and each has a
`verify` script that CI runs — so these are proof, not prose.

| Starter | Host | `verify` proves |
|---|---|---|
| `express/` | Node + Express | The package resolves in a Node server, SSE streaming works end to end, and an unknown `connectionId` is refused rather than used as an endpoint |
| `nextjs/` | Next.js App Router (`app/api/chat/route.ts`) | `next build` succeeds — the bundler resolves the package and the route type-checks |
| `workers/` | Cloudflare Workers / edge | `wrangler deploy --dry-run` bundles for workerd, which fails on any Node built-in — the real isomorphism test |
| `ollama-desktop/` | Local Ollama, no key | Health probe, live model discovery, prewarm, and NDJSON streaming on the zero-key local path |
| `module-resolution/` | Packaging | Every entry point (root and `/agent`) resolves under both `import` and `require` |

Run one locally:

```bash
npm run build                       # from the repo root, first
cd examples/integrations/express
npm install
npm run verify                      # hermetic: no API key, no network
npm start                           # or run it for real
```

`express/`, `ollama-desktop/`, and `module-resolution/` verify against
`mock-provider.mjs`, a local stand-in speaking both the OpenAI-compatible and
Ollama protocols — no key, no network. `nextjs/` and `workers/` run their real
host toolchains.

CI runs all five on every push and PR (`.github/workflows/integrations.yml`),
which is what catches packaging and runtime friction that the unit suite —
running inside this repo, against mocked `fetch` — structurally cannot see.

## What each starter is actually demonstrating

Beyond "it runs", each one carries the host-specific decisions worth copying:

- **express** — server-owned connection allowlist (never take `provider`/
  `baseUrl` from a client), `StreamEvent` → SSE bridge, client-disconnect abort
  so an abandoned tab stops costing tokens, and one `AIError.kind` → HTTP status
  mapper.
- **nextjs** — module-scoped handler so `limits` actually apply per process
  rather than per request, `request.signal` threaded through, and a note on the
  `nodejs` vs `edge` runtime choice.
- **workers** — no `process.env` at the edge: the `KeySource` is built per
  request from the `env` binding. Telemetry goes through `ctx.waitUntil` so a
  write outlives the response. Limits are per-isolate, i.e. effectively per
  request — don't rely on them for a global ceiling.
- **ollama-desktop** — the failure modes a local runtime has and a hosted one
  doesn't: daemon not running (answered by `testConnection()` without throwing),
  no models pulled, cold model load (`prewarm()`), and truncation detected via
  the `stream_anomaly` context event.

For the surrounding concepts, see [`docs/security.md`](../../docs/security.md)
(connection allowlists, SSRF) and [`docs/reliability.md`](../../docs/reliability.md)
(timeouts, retries, per-instance limits).
