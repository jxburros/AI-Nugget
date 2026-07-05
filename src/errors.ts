import type { AIErrorKind } from './types.js';

export class AIError extends Error {
  kind: AIErrorKind;
  status?: number;
  retryable: boolean;
  provider?: string;
  raw?: string;
  retryAfterMs?: number;

  constructor(message: string, opts: {
    kind: AIErrorKind;
    status?: number;
    retryable?: boolean;
    provider?: string;
    raw?: string;
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
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export function defaultRetryable(kind: AIErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'timeout' || kind === 'network' || kind === 'server' || kind === 'invalid_response';
}

export function classify(status: number, body = '', provider?: string, headers?: Headers): AIError {
  const excerpt = body.slice(0, 200);
  const lower = body.toLowerCase();
  let kind: AIErrorKind = 'server';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 408) kind = 'timeout';
  else if (status === 429) kind = 'rate_limit';
  else if (status === 400 || status === 422) {
    kind = lower.includes('context') || lower.includes('maximum context') || lower.includes('token limit')
      ? 'context_length'
      : 'invalid_request';
  } else if (status >= 500) kind = 'server';
  else kind = 'invalid_request';

  return new AIError(`HTTP ${status}: ${excerpt}`, {
    kind,
    status,
    provider,
    raw: excerpt,
    retryAfterMs: parseRetryAfter(headers?.get('retry-after') ?? null),
  });
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
