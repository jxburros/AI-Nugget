# Security notes

This library's job is to make provider calls **safe to route and observe**: keys
enter through one seam, every call is policy-checked, and everything recorded is
redacted. It deliberately does *not* decide your policy. The consequence is that
several protections are **seams you configure**, not defaults you inherit — this
page is the honest list of which.

## Keys never appear in telemetry, errors, or hooks

- Keys enter only through `KeySource`. A resolved key is registered with the
  session redactor, so any later appearance in an error message, a metadata
  blob, or a `CallRecord` is scrubbed by exact match.
- `classify()` redacts the provider's response excerpt **at construction**, at
  the wire boundary, before an `AIError` object exists. That means a provider
  that echoes a credential back in an auth-failure body cannot leak it through
  any code path, including ones that never reach the handler's own catch blocks.
- `beforeCall(info)` receives a **scrubbed** connection. `info.connection.keyRef`
  is masked when it is a `{ kind: 'literal' }` ref, and `info.resolved` has both
  the `apiKey` field removed and the derived auth headers (`authorization`,
  `x-api-key`, `x-goog-api-key`, `api-key`) replaced with `[REDACTED]`. Logging
  the whole `info` object for audit — the natural thing to do — is safe.

### What pattern-based redaction does and does not cover

`createDefaultRedactor()` has two families of pattern:

1. **Prefixed formats** — `sk-`, `sk-ant-`, `AIza`, `gsk_`, `ghp_`,
   `github_pat_`, `glpat-`, `xox[baprs]-`, `AKIA`/`ASIA`, `SG.`, `pk_live_`,
   `rk_live_`, `hf_`, `nvapi-`, `xai-`, PEM private-key blocks, JWTs, and a
   generic `Bearer <token>`. A match here is unambiguous.
2. **Labeled unprefixed values** — an Azure OpenAI `api-key`, an AWS *secret*
   access key, a `client_secret`, a bare session token: these have no
   distinctive prefix, so they are matched by the **label** that precedes them
   (`api-key: …`, `"aws_secret_access_key": "…"`, `password=…`) and only the
   value is replaced. The label stays readable so logs remain diagnosable.

**A bare, unlabeled, unprefixed secret is not caught by patterns.** Matching one
on shape alone would redact commit SHAs, content hashes, and base64 payloads.
The guaranteed catch is exact-match registration:

```ts
const redactor = new SessionRedactor();
redactor.addSecret(process.env.SOME_OPAQUE_TOKEN);   // now scrubbed everywhere
new AIHandler({ keySource, redactor });
```

The handler already does this automatically for every key it resolves. Register
anything *else* secret that could reach a prompt, a tool result, or an error.

## SSRF: caller-controlled `baseUrl`

`resolveConnection()` applies **no scheme or host allowlist** to
`Connection.baseUrl`, and `applyAuth()` attaches the resolved API key as a
header to whatever URL results. If end-user input can reach `baseUrl` — a
"custom OpenAI-compatible endpoint" field in a settings UI is the classic case —
you have built server-side request forgery **with a real credential attached**:
an attacker points it at an internal service or their own collector and receives
your key.

This is out of library scope by design (`AGENTS.md`: apps configure policy at
the seam), and there is no warning or log when an unexpected scheme appears.

**Rule: never take `provider` or `baseUrl` from client input.** Define the
available connections server-side and let the client choose a `connectionId`:

```ts
const CONNECTIONS = {
  cloud: { id: 'cloud', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
  local: { id: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
} as const;

const conn = CONNECTIONS[req.body.connectionId as keyof typeof CONNECTIONS];
if (!conn) return res.status(400).json({ error: 'unknown connection' });
```

If an app genuinely must accept a user-supplied endpoint, do the check yourself
in `beforeCall` — `info.resolved.baseUrl` is the *effective* URL after profile
defaults, which is what you want to validate:

```ts
hooks: {
  async beforeCall(info) {
    const url = new URL(info.resolved!.baseUrl);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) return 'deny';
  },
}
```

Note that a hostname allowlist alone does not stop DNS rebinding; pin to
addresses or route through an egress proxy if the threat model warrants it.

## Prompt and tool injection: opt-in, fail-open

Tool results are fed back into the model's context. A tool that reads
attacker-influenced content (a web page, an inbox, a ticket body) can therefore
steer the *next* model turn — including which tool it asks for next. In
`promptJson` mode the tool name and arguments come straight out of model output,
so a successful injection chooses the next tool call.

Two mitigations exist, and **neither is on by default**:

| Mitigation | Default | Turn it on with |
|---|---|---|
| Fencing untrusted tool output so the model treats it as data, not instructions | **off** | `toolResult: { wrapUntrusted: true }` |
| Human/programmatic approval before a tool runs | **off** (no gate configured ⇒ side-effecting tools are *denied*, not auto-approved) | `approval: gate`, plus `sideEffects: true` on the tool, or `approvalMode: 'all'` |

```ts
runAgent({
  handler, connection, model, messages, tools,
  toolResult: { wrapUntrusted: true, maxChars: 8_000 },
  approvalMode: 'all',
  approval: async ({ call, tool }) => (await askHuman(call, tool)) ? 'allow' : 'deny',
});
```

Turning both on is the right default for any agent whose tools touch untrusted
input or cause side effects.

## Tool-argument validation is a filter, not a boundary

`validateToolArgs` checks **object-ness, `required` presence, and top-level
`properties[key].type`**. It is not a JSON Schema implementation: no `enum`, no
nested object schemas, no array `items`, no numeric bounds, no `pattern`, no
`oneOf`/`anyOf`, no `additionalProperties`. That's deliberate for a
zero-dependency nugget — but it means passing validation proves almost nothing
about the *values*.

**Validate again inside every `execute()`.** The pattern:

```ts
import { defineTool } from '@jxburros/ai-nugget/agent';

const readFile = defineTool({
  name: 'read_project_file',
  description: 'Read a file from the project directory',
  parameters: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string' } },   // top-level type: all the schema buys you
  },
  async execute(args) {
    const { path } = args as { path: string };

    // 1. Re-validate shape with whatever you actually trust.
    if (typeof path !== 'string' || path.length > 200) throw new Error('invalid path');

    // 2. Enforce the real constraint the schema cannot express.
    const resolved = nodePath.resolve(PROJECT_ROOT, path);
    if (!resolved.startsWith(PROJECT_ROOT + nodePath.sep)) throw new Error('path escapes project root');
    if (!ALLOWED_EXTENSIONS.has(nodePath.extname(resolved))) throw new Error('unsupported file type');

    // 3. Only now do the work.
    return { content: await fs.readFile(resolved, 'utf8') };
  },
});
```

The three steps generalize: re-check the shape, enforce the constraint the
schema can't express (path containment, id ownership, amount ceilings, allowed
enum values), then act. A thrown error is fed back to the model as a recoverable
`tool_error` — it does not crash the run — so failing loudly inside `execute` is
the cheap, correct move.

Anything with a side effect (writes, sends, payments, deletes) should *also*
carry `sideEffects: true` so the approval gate covers it.

## Governance is neutral by default

With no `policy` configured, `allowAllPolicy()` is used — every provider and
model is permitted. Since 0.6 the handler logs a one-line notice at construction
when that happens, so an unrestricted deployment is visible at runtime rather
than only in a doc. Silence it by passing a real policy, by passing
`policy: allowAllPolicy()` explicitly, or with `silencePolicyWarning: true`.

`allowlistPolicy` fails closed for providers omitted from the map. Remember that
`listModels()`/`testConnection()` are policy-checked too, under the operation IDs
`__listModels__` and `__testConnection__` — use `'*'` in a provider's prefix list
to allow them.
