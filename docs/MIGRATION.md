# Migration & adoption guide

How an app takes on `ai-handler` and replaces its hand-rolled provider code. For
the per-repo end states (AI-model-test, AI-Server-Studio, Blobsmith, locus-os,
ai-agent-skills) see `design.md` §9; this guide is the concrete how-to.

## 1. Choose a distribution model

Two supported ways to consume the code; pick one per repo (see `README.md` →
Distribution for the decision rationale):

| Model | Use when | Import specifier |
|---|---|---|
| **Package** (`@jxburros/ai-handler`) | The repo can depend on a private package | `@jxburros/ai-handler`, `@jxburros/ai-handler/agent` |
| **Vendored** (`nugget/`) | The repo cannot take a dependency (air-gapped builds, single-file deploys) | `../vendor/ai-handler/src/index.js` (your copied path) |

Vendoring: copy the generated `nugget/` folder into the app, keep its
`VERSION.txt` (version + content hash), and re-run the ai-agent-skills drift check
to detect when the vendored copy falls behind. Both models expose the identical
API — vendoring only changes the import path.

## 2. Wire the four seams

Every adoption fills the same four seams; none ship with app-specific behavior:

- **`KeySource`** — where keys come from. Built-ins: `envKeySource()`,
  `literalKeySource()`, `memoryKeySource()`, `chainKeySources()`. Vault-backed
  sources (locus-os `secret://`, an AES-GCM table) implement the one-method
  interface. A missing/locked/denied key becomes a typed `key_unavailable`
  failure with a telemetry row — never a silent success.
- **`GovernancePolicy`** — which models an app refuses. Ships **neutral**. Use
  `allowlistPolicy(prefixesByProvider)` / `blocklistPolicy(patterns)` /
  `composePolicies(...)`. Your old block/allow list becomes one line of config.
- **`Redactor`** — `createDefaultRedactor()` covers the built-in secret patterns
  plus any literal keys resolved this session; swap in your own choke point.
- **`TelemetrySink`** — receives one `CallRecord` per call, success or failure.
  Records carry **sizes, not content**; persist bodies app-side from the
  `ChatResult` you already hold.

## 3. Replace provider dispatch

Delete local `adapterFor`/`httpAdapters` copies and per-file provider `switch`
statements. All provider selection now lives behind `handler.chat` /
`handler.stream`; `adapterFor` exists once in the library. A former
`generate(model, prompt)` shim becomes:

```ts
handler.chat(conn, { model, messages: [{ role: 'user', content: prompt }] });
```

Migrate to real `messages[]` afterward to gain system prompts, images, and tools.

## 4. Adopt streaming and the agent loop

- Non-streaming providers are normalized into the same event stream (buffered
  result → one `delta` → `done`), so a route handler transcribes `StreamEvent`s
  into its existing SSE frames (see `examples/streaming-sse-route.ts`). Cloud
  paths become streaming for free.
- Replace bespoke ReAct loops with `runAgent()` — `defineTool` specs, schema-
  validated args, budgets, and `ApprovalGate` for side effects (see
  `examples/agent-tools.ts`). `toolMode: 'auto'` picks native vs promptJson from
  provider capabilities, so the same agent code runs on cloud and local models.

## 5. Delete the old copy in the same PR

Adopt in dependency order and remove the local implementation in the **same** PR —
no transition period with both paths live (the drift that motivated this nugget
came from long-lived parallel copies). Port any local tests worth keeping
(`extractJsonObject` cases, adapter/timeout behaviors) into the app or confirm the
library's contract suite already covers them.

## Behavioral notes when migrating

- **Model identity is `(source, model)`.** Stored results should key on
  `modelRef(source, model)`; do not collapse the same weights served by different
  hosts into one id.
- **Anthropic `maxTokens`** is required by the provider; the library injects a
  `4096` default (always overridable) so you can stop triplicating `1024/2048/4096`.
- **Anthropic JSON mode** is implemented via a forced tool — request
  `responseFormat: { type: 'json' }` and it works like every other engine.
- **`usage.estimated`** is explicit: `true` when the library estimated
  (`ceil(len/4)`), `false` when the provider reported counts. Stop guessing which
  stored rows were estimates.
- **Local providers** (`ollama`, `llamacpp`, `lmstudio`, `vllm`) are keyless and
  `toolMode: 'auto'` uses promptJson there — override with `'native'` on a
  tool-capable local model. See `docs/providers.md`.

## Versioning during migration

The public surface follows the stability policy in `README.md` → API stability.
Pin an exact version (package) or a `VERSION.txt` hash (vendored) so a provider
API change lands as one intentional bump, not a surprise across every repo at once.
