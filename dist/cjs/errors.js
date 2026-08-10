"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIError = void 0;
exports.defaultRetryable = defaultRetryable;
exports.classify = classify;
exports.fromUnknown = fromUnknown;
const redact_js_1 = require("./redact.js");
/**
 * Pattern-based redaction applied at the wire boundary, before an error object
 * exists. `AIHandler` redacts again on the way out (adding session-registered
 * exact secrets), but doing it here means a provider body that echoes a
 * recognizable secret can never be carried by an `AIError` in the first place —
 * including on code paths that never reach the handler's own catch blocks.
 */
const wireRedactor = (0, redact_js_1.createDefaultRedactor)();
class AIError extends Error {
    kind;
    status;
    retryable;
    provider;
    raw;
    retryAfterMs;
    constructor(message, opts) {
        super(message);
        this.name = 'AIError';
        this.kind = opts.kind;
        this.retryable = opts.retryable ?? defaultRetryable(opts.kind);
        if (opts.status !== undefined)
            this.status = opts.status;
        if (opts.provider !== undefined)
            this.provider = opts.provider;
        if (opts.raw !== undefined)
            this.raw = opts.raw;
        if (opts.retryAfterMs !== undefined)
            this.retryAfterMs = opts.retryAfterMs;
        if (opts.cause !== undefined)
            this.cause = opts.cause;
    }
}
exports.AIError = AIError;
function defaultRetryable(kind) {
    return kind === 'rate_limit' || kind === 'timeout' || kind === 'network' || kind === 'server' || kind === 'invalid_response';
}
function classify(status, body = '', provider, headers) {
    const excerpt = wireRedactor.redact(body.slice(0, 200));
    const lower = body.toLowerCase();
    let kind = 'server';
    // 403 is classified as `auth` (non-retryable) deliberately: a forbidden
    // response almost always means a bad/insufficient credential or a blocked
    // region/model, none of which a retry fixes. Callers that know a specific
    // provider returns a retryable 403 can reclassify in a `beforeCall`/adapter.
    if (status === 401 || status === 403)
        kind = 'auth';
    else if (status === 408)
        kind = 'timeout';
    else if (status === 429)
        kind = 'rate_limit';
    else if (status === 400 || status === 422) {
        kind = lower.includes('context') || lower.includes('maximum context') || lower.includes('token limit')
            ? 'context_length'
            : 'invalid_request';
    }
    else if (status === 404 || status === 410) {
        // A missing route/deployment is not a malformed request: it is usually a
        // wrong baseUrl or model name, and sometimes a temporarily misrouted load
        // balancer. `not_found` keeps it distinguishable from `invalid_request` so
        // apps don't tell a user "your request was invalid" for an infra problem.
        // Non-retryable by default — a caller that knows its 404s are transient can
        // retry on `kind === 'not_found'` itself.
        kind = 'not_found';
    }
    else if (status >= 500)
        kind = 'server';
    // Everything else in 4xx (409 conflict, 405, 415, 451, …) is a genuine
    // client-side request problem, so `invalid_request` is honest for it.
    else
        kind = 'invalid_request';
    return new AIError(`HTTP ${status}: ${excerpt}`, {
        kind,
        status,
        provider,
        raw: excerpt,
        retryAfterMs: parseRetryAfter(headers?.get('retry-after') ?? null),
    });
}
function fromUnknown(error, provider) {
    if (error instanceof AIError)
        return error;
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
function parseRetryAfter(value) {
    if (!value)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds))
        return Math.max(0, seconds * 1000);
    const time = Date.parse(value);
    if (!Number.isNaN(time))
        return Math.max(0, time - Date.now());
    return undefined;
}
