# Recipes

Small server apps built directly on `AIHandler` (see `examples/npm-mini-apps/`)
tend to hit the same three points of friction: resolving connection config,
turning a JSON-mode reply into a validated app object, and mapping a failure
into an HTTP response. None of this is policy — it's the boilerplate every
consumer re-derives — so here's the canonical shape for each.

For host-specific wiring (Express, Next.js, Cloudflare Workers, local Ollama),
see `examples/integrations/`.

## Env-based connection setup

`envConnection()` resolves a `Connection` plus a default `model` from app-owned
env vars (`AI_PROVIDER`, `AI_MODEL`, `AI_KEY_ENV`, `AI_BASE_URL` by default):

```ts
import { AIHandler, envConnection, envKeySource } from '@jxburros/ai-nugget';

const handler = new AIHandler({ keySource: envKeySource() });
const { connection, model } = envConnection({ id: 'my-app', defaultProvider: 'openai', defaultModel: 'gpt-4o-mini' });

const result = await handler.chat(connection, { model, messages: [{ role: 'user', content: 'Hello!' }] });
```

It only reads the server's own environment — `provider`/`baseUrl` never come
from client input this way either, same as the manual pattern it replaces. Pass
`env`, `providerVar`/`modelVar`/`keyEnvVar`/`baseUrlVar`, or
`defaultProvider`/`defaultModel`/`defaultKeyEnv` to override the var names or
fallbacks an app already uses.

## JSON output + validation

Two paths, depending on whether you already own a schema library.

**With a Standard Schema validator (Zod / Valibot / ArkType):** `chatParsed`
requests JSON mode, extracts the JSON, validates, and performs exactly one
corrective retry that shows the model its own error before throwing
`invalid_response`. No schema library is bundled — you supply the schema.

```ts
const { data, result } = await handler.chatParsed(conn, req, MySchema);
```

**Without one:** ask for JSON in the prompt (and set
`responseFormat: { type: 'json' }` for providers with `capabilities.jsonMode`),
then run the raw text through `extractJsonWithSchema` with a small parse
function built from the `require*` guards in `json.ts`. Don't hand-roll a
`/\{[\s\S]*\}/` regex plus `JSON.parse`, which silently accepts the first
brace-looking substring and gives no useful error on a malformed reply:

```ts
import { extractJsonWithSchema, requireNumber, requireString } from '@jxburros/ai-nugget';

function parseSprint(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a JSON object');
  const record = raw as Record<string, unknown>;
  return { headline: requireString(record, 'headline'), minutes: requireNumber(record, 'minutes') };
}

const sprint = extractJsonWithSchema(result.text, parseSprint);
```

`extractJsonWithSchema` recovers JSON from fenced code blocks or prose the model
wrapped around it, and throws a typed `AIError` with
`kind: 'invalid_response'` on anything that doesn't parse or doesn't match the
schema. That error flows into the same `AIError`-kind switch as any other
provider failure, so JSON validation doesn't need its own error path. `require*`
covers scalars and string arrays only — validate array length, numeric ranges,
or nested shapes yourself.

**Requesting JSON mode together with tools** is dropped by Gemini and Anthropic;
both emit a `json_mode_downgraded` context event rather than failing silently.
See [providers.md](./providers.md#json-mode-combined-with-tools).

## Error handling matrix

Every failure that reaches your `catch` around `handler.chat()`/`stream()` —
including a JSON-validation failure from `extractJsonWithSchema` — is (or is
normalized to) an `AIError` with a `kind`. Map `kind` to an HTTP status and a
user-facing message once, log the raw `error.message` server-side, and never
forward it to the client:

| `kind` | Suggested status | Example user-facing message |
|---|---|---|
| `invalid_request` | 400 | "That request was invalid." |
| `not_found` | 502 | "The AI service is not configured correctly." |
| `context_length` | 413 | "Your input is too long. Please shorten it and try again." |
| `auth` | 502 | "The AI service is not configured correctly." |
| `key_unavailable` | 500 | "The AI service is not configured correctly." |
| `policy_blocked` | 403 | "This request was blocked by policy." |
| `rate_limit` | 429 | "The AI service is busy. Please try again shortly." |
| `timeout` | 504 | "The request took too long. Please try again." |
| `canceled` | 499 | "The request was canceled." |
| `invalid_response` | 502 | "The AI response wasn't in the expected format. Please try again." |
| `network` / `server` | 502 | "The AI service is temporarily unavailable." |
| `tool_error` | 500 | "Something went wrong running a tool." |
| `budget_exceeded` | 429 | "This request used too many steps/tokens. Please try again." |

`auth`, `key_unavailable`, and `not_found` map to 5xx, not 4xx, because it's the
*server's* credential or endpoint configuration that's wrong, not the caller's —
the distinction matters for who should act on the error.
`examples/npm-mini-apps/*/ai-error-map.mjs` is a copyable implementation.

### `error.code` and `error.details`

When a provider's response body is JSON shaped like `{ error: { code, details } }`
(OpenAI, Anthropic, and self-hosted runtimes like [JX Runtime](https://github.com/jxburros/JX-Runtime)
all do this), `classify()` lifts `code` and `details` onto the `AIError` —
`error.code` is a stable machine-readable string, `error.details` is whatever
provider-shaped object came with it. Both are `undefined` for a plain-text body
or one with no `error.code`/`error.details`. This is what lets an app act on
JX Runtime's guided-repair plan (`error.details.repair.actions`, one already
filled in as a request an "Install" button can fire) instead of re-parsing
`error.raw` itself:

```ts
try {
  await handler.chat(conn, req);
} catch (e) {
  const error = e as AIError;
  const repair = (error.details as { repair?: { summary: string; actions: unknown[] } } | undefined)?.repair;
  if (repair) offerRepairUi(repair); // e.g. a button per repair.actions[i]
}
```

Both fields are redacted the same way `raw` is (wire-boundary pattern redaction,
then the handler's own session-secret pass on the way out) — but they're still
provider-shaped, not part of this library's stable contract, so treat unknown
keys as optional and validate before acting on them.

## Telemetry

Every call — success, failure, or a stream the consumer abandoned — produces
exactly one redacted `CallRecord` on the `TelemetrySink`. Attach a `pricing` hook
to stamp `costUsd`; pricing tables live in the app, not the library.

```ts
new AIHandler({
  keySource,
  telemetry: { record: (r) => metrics.write(r) },
  pricing: ({ provider, model, usage }) => PRICES[`${provider}/${model}`]?.(usage),
});
```

See `examples/telemetry.mjs`.
