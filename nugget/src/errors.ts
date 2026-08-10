import { createDefaultRedactor } from './redact.js';
import type { AIErrorKind } from './types.js';

/**
 * Pattern-based redaction applied at the wire boundary, before an error object
 * exists. `AIHandler` redacts again on the way out (adding session-registered
 * exact secrets), but doing it here means a provider body that echoes a
 * recognizable secret can never be carried by an `AIError` in the first place —
 * including on code paths that never reach the handler's own catch blocks.
 */
const wireRedactor = createDefaultRedactor();

/** `raw` is a bounded excerpt, not the full body — large enough to carry a small
 * structured error payload (a provider's `details` object) without letting a
 * pathological response body bloat every error, log line, and telemetry record. */
const RAW_EXCERPT_MAX_CHARS = 2_000;

/** Bodies larger than this are never JSON-parsed for `code`/`details` — a
 * malformed or oversized response degrades to the plain `raw` excerpt instead
 * of paying parse cost (or holding a huge object on the error) for no benefit. */
const MAX_PARSEABLE_BODY_CHARS = 20_000;

export class AIError extends Error {
  kind: AIErrorKind;
  status?: number;
  retryable: boolean;
  provider?: string;
  raw?: string;
  /** Machine-readable error code from a structured `{ error: { code, ... } }` body (e.g. OpenAI/JX Runtime `error.code`), when the body parses as JSON and carries one. */
  code?: string;
  /** The provider's `error.details` value, when present — e.g. JX Runtime's `RATE_LIMITED` `retryAfterSeconds` or its guided-repair `{ summary, actions }` plan. Already redacted, but still provider-shaped: treat it as a hint, not a stable contract. */
  details?: unknown;
  retryAfterMs?: number;

  constructor(message: string, opts: {
    kind: AIErrorKind;
    status?: number;
    retryable?: boolean;
    provider?: string;
    raw?: string;
    code?: string;
    details?: unknown;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(message);
    this.name = 'AIError';
    this.kind = opts.kind;
    this.retryable = opts.retryable ?? defaultRetryable(opts.kind);
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.provider !== undefined) this.provider = opts.provider;
    if (opts.raw !== undefined) this.raw = opts.raw;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export function defaultRetryable(kind: AIErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'timeout' || kind === 'network' || kind === 'server' || kind === 'invalid_response';
}

export function classify(status: number, body = '', provider?: string, headers?: Headers): AIError {
  // Redact the *full* body before truncating anything derived from it — a
  // secret past the excerpt's cutoff must never survive into `raw`, `code`,
  // or `details` just because it was outside the old 200-char window.
  const redactedBody = wireRedactor.redact(body);
  const excerpt = redactedBody.slice(0, RAW_EXCERPT_MAX_CHARS);
  const structured = extractStructuredError(redactedBody);
  const lower = body.toLowerCase();
  let kind: AIErrorKind = 'server';
  // 403 is classified as `auth` (non-retryable) deliberately: a forbidden
  // response almost always means a bad/insufficient credential or a blocked
  // region/model, none of which a retry fixes. Callers that know a specific
  // provider returns a retryable 403 can reclassify in a `beforeCall`/adapter.
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 408) kind = 'timeout';
  else if (status === 429) kind = 'rate_limit';
  else if (status === 400 || status === 422) {
    kind = lower.includes('context') || lower.includes('maximum context') || lower.includes('token limit')
      ? 'context_length'
      : 'invalid_request';
  } else if (status === 404 || status === 410) {
    // A missing route/deployment is not a malformed request: it is usually a
    // wrong baseUrl or model name, and sometimes a temporarily misrouted load
    // balancer. `not_found` keeps it distinguishable from `invalid_request` so
    // apps don't tell a user "your request was invalid" for an infra problem.
    // Non-retryable by default — a caller that knows its 404s are transient can
    // retry on `kind === 'not_found'` itself.
    kind = 'not_found';
  } else if (status >= 500) kind = 'server';
  // Everything else in 4xx (409 conflict, 405, 415, 451, …) is a genuine
  // client-side request problem, so `invalid_request` is honest for it.
  else kind = 'invalid_request';

  return new AIError(`HTTP ${status}: ${redactedBody.slice(0, 200)}`, {
    kind,
    status,
    provider,
    raw: excerpt,
    code: structured?.code,
    details: structured?.details,
    retryAfterMs: parseRetryAfter(headers?.get('retry-after') ?? null),
  });
}

/**
 * Pulls a machine-readable `code`/`details` pair out of a JSON error body,
 * checking `{ error: { code, details } }` (OpenAI, Anthropic, JX Runtime)
 * before falling back to top-level `{ code, details }`. Returns undefined for
 * anything that isn't small, parseable JSON carrying at least one of the two —
 * most provider bodies are plain text or don't have this shape, and that's fine,
 * `raw` still carries the excerpt either way.
 */
function extractStructuredError(redactedBody: string): { code?: string; details?: unknown } | undefined {
  if (!redactedBody || redactedBody.length > MAX_PARSEABLE_BODY_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(redactedBody);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const root = parsed as Record<string, unknown>;
  const errorObj = typeof root.error === 'object' && root.error !== null ? (root.error as Record<string, unknown>) : root;
  const code = typeof errorObj.code === 'string' ? errorObj.code : undefined;
  const details = 'details' in errorObj ? errorObj.details : undefined;
  if (code === undefined && details === undefined) return undefined;
  return { code, details };
}

export function fromUnknown(error: unknown, provider?: string): AIError {
  if (error instanceof AIError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AIError('Request was canceled', { kind: 'canceled', retryable: false, provider, cause: error });
  }
  if (error instanceof Error && /timeout|timed out/i.test(error.message)) {
    return new AIError(error.message, { kind: 'timeout', provider, cause: error });
  }
  if (error instanceof Error) {
    return new AIError(error.message, { kind: 'network', provider, cause: error });
  }
  return new AIError('Unknown AI provider error', { kind: 'network', provider, cause: error });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const time = Date.parse(value);
  if (!Number.isNaN(time)) return Math.max(0, time - Date.now());
  return undefined;
}
