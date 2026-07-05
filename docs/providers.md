# Provider guide

`ai-handler` reaches every provider through one of four **protocol engines**
(`openaiChat`, `anthropic`, `google`, `ollama`) plus a data-driven **profile**
that supplies base URL, auth, static capabilities, and quirks. This page documents
the providers that behave differently enough to warrant their own notes — the
three local / self-hosted paths in particular. See the matrix in `README.md` for
the full shipped set and `design.md` §6 for the engine/profile architecture.

Model identity is always `(source, model)`; use `modelRef(source, model)` for the
canonical `provider/model` key. The same weights served by Ollama, llama.cpp, and
a cloud host are **distinct entries** and must not be merged by bare model id.

## Static capabilities

Each profile declares what its provider can do at the protocol level, readable via
`providerCapabilities(provider, baseUrl)`:

| Field | Meaning | Consumed by |
|---|---|---|
| `nativeTools` | Provider/engine exposes real function-calling | agent `toolMode: 'auto'` (native vs promptJson) |
| `jsonMode` | Provider/engine has a structured-JSON output mode | OpenAI engine gates `response_format` on it |

`nativeTools` is `true` for the cloud OpenAI-family providers, `anthropic`, and
`google`; it is **`false`** for `ollama`, `llamacpp`, `lmstudio`, `vllm`, and the
`openai-compat` escape hatch — the small local models these usually serve rarely
honor a native tool schema, so `toolMode: 'auto'` chooses the promptJson floor
there (§7). Override per run with `toolMode: 'native'` when your local model does
support tools.

---

## Ollama (`provider: 'ollama'`)

Native `/api/chat` NDJSON engine — kept as its own engine (not routed through
`openai-compat`) so it can carry Ollama-specific fields.

- **Base URL:** `http://localhost:11434` (default). No API key (`keyOptional`).
- **Streaming:** NDJSON, one JSON object per line.
- **Images:** passed through the native `images[]` array on messages.
- **JSON mode:** `format: 'json'` (and a JSON schema when supplied).
- **Tools:** the native `tools` array exists, but support is **model-dependent**;
  `providerCapabilities('ollama').nativeTools` is `false`, so `auto` uses
  promptJson. Force native with `toolMode: 'native'` on a tool-capable model.
- **Model discovery:** `listModels` calls `/api/tags` and then probes `/api/show`
  per model for context window and capabilities (best-effort, degrades if the
  endpoint is unavailable).
- **OpenAI-compat alternative:** Ollama also serves an OpenAI-compatible `/v1`
  endpoint. Point the `openai-compat` profile at `http://localhost:11434/v1` if you
  specifically want the OpenAI wire shape instead of the native path.

```ts
const conn = { id: 'local', provider: 'ollama', keyRef: { kind: 'none' } };
await handler.chat(conn, { model: 'llama3.2', messages: [{ role: 'user', content: 'Hi' }] });
```

---

## llama.cpp (`provider: 'llamacpp'`)

Targets `llama-server`'s OpenAI-compatible layer (the `openaiChat` engine), with
two quirks that change request generation:

- **Base URL:** `http://localhost:8080/v1` (default). No API key (`keyOptional`).
- **`modelOptional`:** a llama-server instance hosts exactly one model. When you
  pass an empty `model`, the engine **omits the `model` field entirely** so the
  server does not reject an unexpected value. Pass a model string and it is sent
  as-is.
- **Health:** a real `/health` endpoint is used by `testConnection`, not just a
  model-list probe.
- **`supportsUsageInStream`:** not set — the engine does **not** send
  `stream_options.include_usage`, which older llama-server builds reject. Usage is
  estimated (`usage.estimated === true`) unless the server reports it in the body.
- **Tools:** `nativeTools` is `false`; `auto` uses promptJson.

```ts
const conn = { id: 'llama', provider: 'llamacpp', keyRef: { kind: 'none' } };
await handler.chat(conn, { model: '', messages: [{ role: 'user', content: 'Hi' }] }); // model omitted on the wire
```

---

## openai-compat (`provider: 'openai-compat'`) — the escape hatch

Any OpenAI-compatible endpoint that does not have (or need) its own profile. This
is **your configuration, not a supported profile** — including any provider the
support policy declines to ship (see `design.md` §1). No fixtures, no guarantees.

- **Base URL:** **required** — there is no default; the handler throws
  `invalid_request` if `baseUrl` is missing.
- **Auth:** `bearer` by default; set `keyRef: { kind: 'none' }` for keyless local
  servers.
- **Capabilities:** conservative — `nativeTools: false`, `jsonMode: true`. So
  `auto` uses promptJson, and `response_format` is sent when you request JSON.
  If your endpoint genuinely supports native tools, opt in with `toolMode: 'native'`.
- **`stream_options`:** not sent (no `supportsUsageInStream` quirk), since unknown
  fields are the most common cause of compat-server 400s.
- **Unknown provider keys:** any `provider` string not in the table resolves to
  this profile **as long as a `baseUrl` is supplied**, so
  `{ provider: 'my-gateway', baseUrl: '…' }` just works.

```ts
const conn = {
  id: 'gw', provider: 'openai-compat',
  baseUrl: 'https://my-gateway.example/v1',
  keyRef: { kind: 'env', name: 'GATEWAY_KEY' },
};
await handler.chat(conn, { model: 'whatever-it-serves', messages: [{ role: 'user', content: 'Hi' }] });
```

---

## Adding a new provider

If the endpoint speaks OpenAI-compatible chat, a new provider is a **profile table
row**, not a new engine — add it to `PROVIDER_PROFILES` in
`src/adapters/profiles.ts` with `engine: 'openaiChat'`, its base URL, auth mode,
`capabilities`, and any `quirks`, then add a light profile test (URL/auth/header
construction). The support-policy bar in `design.md` §1 governs what earns a
shipped profile.
