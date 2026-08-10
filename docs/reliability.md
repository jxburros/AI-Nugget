# Retries, timeouts, and limits

## Timeouts: `timeoutMs` vs `idleTimeoutMs`

Both live on `Connection`, and they answer different questions:

| Field | Bounds | Use it for |
|---|---|---|
| `timeoutMs` | The **total** lifetime of the call, from request to the last byte of the stream. Default `120_000`. | An absolute ceiling so nothing hangs forever. |
| `idleTimeoutMs` | The gap **between chunks**. Rearmed on every chunk received; unset by default (no idle bound). | Long but healthy generations — a slow local model that streams steadily should not be killed by a total ceiling sized for its slowest case. |

The combination that usually works for a local model is a generous total and a
tight idle bound: a stream that is producing tokens stays alive indefinitely up
to `timeoutMs`, while one that stalls dies in seconds.

```ts
const conn = {
  id: 'local',
  provider: 'ollama',
  timeoutMs: 600_000,     // 10 min ceiling for a long generation
  idleTimeoutMs: 20_000,  // but bail if it goes 20s without a token
};
```

Both fire as a typed `AIError` with `kind: 'timeout'` (retryable).

### Timeout enforcement is a per-adapter contract

`AIHandler` does **not** impose a timeout of its own. It forwards `req.signal`
and nothing else; the actual deadline is created inside each adapter, by
`streamTimeout(conn, req.signal)` / the `timeoutMs` argument to `fetchJson`.

Every in-tree adapter does this — `streamTimeout()` applies
`conn.timeoutMs ?? DEFAULT_TIMEOUT_MS` plus `conn.idleTimeoutMs`, and every
`fetchJson` call passes a `timeoutMs`. But **the handler cannot verify it**. An
adapter that skipped it would hand `postResponse` only the caller's signal, and
a provider that opens a connection and never writes would hang with no upper
bound anywhere.

If you write or vendor a custom `ProviderAdapter`:

- Wrap the whole call — including body consumption — in `streamTimeout(conn, req.signal)`
  and pass `timeout.signal` to `postResponse`.
- Call `timeout.bump()` on every received chunk so `idleTimeoutMs` rearms.
- Call `timeout.done()` in a `finally`, after the stream is fully consumed.
- Pass `timeoutMs` on every `fetchJson`.

The `add-provider` skill (`.claude/skills/add-provider/`) covers this as part of
the adapter checklist.

## Retries

Defaults: 3 attempts, 250 ms base delay, 30 s cap, exponential with jitter,
honoring a `Retry-After` header when the provider sends one. Configure via
`new AIHandler({ retry: { maxAttempts, baseDelayMs, maxDelayMs } })`.

Only `retryable` error kinds are retried: `rate_limit`, `timeout`, `network`,
`server`, `invalid_response`. Each retry emits a
`{ type: 'retry', attempt, reason, delayMs }` stream event.

### Retries stop once any output has been emitted

This is the rule most worth knowing. The moment a `delta` or `tool_call` event
has reached the caller, the handler stops retrying, even for an otherwise
retryable failure — it records the failure and emits `error` instead.

The reasoning: a partially delivered answer has already been shown to a user (or
written to a database, or streamed to a browser). Silently re-running the
generation would produce a second, different answer appended to the first. A
truncated answer plus an honest error is recoverable; a spliced double answer is
not.

Practically: retries protect the *connection-establishment* phase. Once tokens
flow, recovery is the app's decision.

### Retries and double-billing

There is a narrow window where a retry costs money twice: the provider fully
generates and bills a response, then the connection drops before any byte
reaches the client. `emittedOutput` is still `false`, so the handler retries and
the same prompt is generated (and billed) again.

Where the provider supports it, the handler mitigates this with an idempotency
key. Profiles carrying the `supportsIdempotencyKey` quirk (currently `openai`)
get an `Idempotency-Key` header holding the **`callId`**, generated once per
logical call and reused across every retry attempt, so the provider can
recognize and dedupe the resubmission. A caller-supplied `idempotency-key` in
`Connection.headers` is never overwritten.

For providers without documented idempotency support, the risk remains. If your
workload is cost-sensitive:

- set `retry: { maxAttempts: 1 }` and handle retries yourself at a layer that
  knows what a duplicate would cost, or
- supply your own `idempotency-key` (or provider-equivalent) via
  `Connection.headers` if the provider honors one that isn't in the table yet —
  and please open an issue so the profile can be updated.

## Concurrency and rate limits are per-instance

`limits: { maxConcurrent, minIntervalMs }` is enforced by an **in-memory queue
belonging to a single `AIHandler` instance**. There is no shared state, no
external coordinator, and no cross-process awareness — that's deliberate for a
zero-dependency library, but it changes how you size a scaled-out deployment:

- Four pods each with `maxConcurrent: 10` allow **40** concurrent calls at the
  provider, not 10.
- `minIntervalMs` paces one instance's calls; N instances each pace
  independently, so the aggregate rate is N × the configured rate.

Size the limits per instance against `provider_quota / instance_count`, or put a
shared limiter (a Redis token bucket, a gateway, your provider's own
project-level rate limits) in front if a global ceiling actually matters.

Both limits also apply to `listModels()`/`testConnection()` probes, which run
through the same queue.

## Error kinds and retryability

| `kind` | Retryable by default | Typical cause |
|---|---|---|
| `rate_limit` | yes | 429 |
| `timeout` | yes | 408, or a fired `timeoutMs`/`idleTimeoutMs` |
| `network` | yes | transport failure before a response |
| `server` | yes | 5xx |
| `invalid_response` | yes | malformed SSE/NDJSON, no `done` event |
| `auth` | no | 401/403 — a retry does not fix a bad credential |
| `invalid_request` | no | 400/422 and other 4xx |
| `not_found` | no | 404/410 — wrong `baseUrl`, model, or deployment |
| `context_length` | no | 400/422 whose body mentions a context/token limit |
| `canceled` | no | caller aborted |
| `policy_blocked` | no | `GovernancePolicy` or a `beforeCall` deny |
| `key_unavailable` | no | `KeySource` returned missing/locked/denied |
| `tool_error` / `budget_exceeded` | no | agent layer |

`not_found` exists so a misrouted edge or a soft-deleted deployment is
distinguishable from a genuinely malformed request body — telling a user "that
request was invalid" for an infra problem is actively misleading. It is
non-retryable by default because most 404s are a wrong URL or model name; an app
that knows its 404s are transient can retry on `error.kind === 'not_found'`
itself.

See [recipes.md](./recipes.md#error-handling-matrix) for mapping these onto HTTP
responses.
