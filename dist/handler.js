import { adapterFor } from './adapters/index.js';
import { applyAuth, profileFor } from './adapters/profiles.js';
import { AIError, fromUnknown } from './errors.js';
import { extractJson } from './json.js';
import { allowAllPolicy } from './policy.js';
import { SessionRedactor } from './redact.js';
import { promptChars, sleep } from './util.js';
/**
 * A *startup* notice, so it fires once per process rather than once per handler
 * — an app that builds a handler per request would otherwise flood its logs
 * with a message that says the same thing every time.
 */
let warnedNoPolicy = false;
/** Test seam: reset the once-per-process startup notice. */
export function resetPolicyWarningForTests() {
    warnedNoPolicy = false;
}
export class AIHandler {
    opts;
    active = 0;
    queue = [];
    lastStarted = 0;
    sessionRedactor = new SessionRedactor();
    policy;
    constructor(opts) {
        this.opts = opts;
        this.policy = opts.policy ?? allowAllPolicy();
        // `allowAllPolicy()` stays the default — a library must not decide an app's
        // governance — but "no policy configured" should be visible at runtime, not
        // only in a README paragraph. Passing an explicit policy (including
        // `allowAllPolicy()`) is the opt-out.
        if (!opts.policy && !opts.silencePolicyWarning && !warnedNoPolicy) {
            warnedNoPolicy = true;
            globalThis.console?.warn?.('[ai-nugget] No GovernancePolicy configured — every provider/model is allowed. ' +
                'Pass `policy` (e.g. allowlistPolicy(...)), or `policy: allowAllPolicy()` / `silencePolicyWarning: true` to accept this deliberately.');
        }
    }
    async chat(conn, req) {
        let result;
        for await (const event of this.stream(conn, req)) {
            if (event.type === 'done')
                result = event.result;
            if (event.type === 'error')
                throw event.error;
        }
        if (!result)
            throw new AIError('Call ended without a result', { kind: 'invalid_response', provider: conn.provider });
        return result;
    }
    async *stream(conn, req) {
        const callId = createCallId();
        const startedAt = Date.now();
        const adapter = adapterFor(conn.provider, conn.baseUrl);
        const preflight = await this.preflight(callId, conn, req.model, req.metadata);
        if (!preflight.ok)
            return yield* this.failStream(callId, conn, req, startedAt, 1, preflight.error);
        // One idempotency key per logical call, reused across every retry attempt,
        // so a provider that supports it collapses a re-sent generation instead of
        // billing it twice (see `supportsIdempotencyKey` in the profile table).
        const resolved = withIdempotencyKey(preflight.resolved, callId);
        let acquired = false;
        let recorded = false;
        let attempt = 0;
        try {
            await this.acquire(req.signal);
            acquired = true;
            const maxAttempts = this.opts.retry?.maxAttempts ?? 3;
            let emittedStart = false;
            let emittedOutput = false;
            for (;;) {
                attempt += 1;
                try {
                    for await (const event of adapter.stream(resolved, req)) {
                        if (event.type === 'start') {
                            if (!emittedStart) {
                                emittedStart = true;
                                yield { ...event, callId };
                            }
                            continue;
                        }
                        if (event.type === 'delta' || event.type === 'tool_call')
                            emittedOutput = true;
                        if (event.type === 'done') {
                            await this.recordSuccess(callId, conn, req, startedAt, attempt, event.result);
                            recorded = true;
                            yield event;
                            return;
                        }
                        yield event;
                    }
                    throw new AIError('Provider did not emit a done event', { kind: 'invalid_response', provider: conn.provider });
                }
                catch (errorValue) {
                    const error = fromUnknown(errorValue, conn.provider);
                    // `emittedOutput` stops retries once any byte has reached the caller:
                    // never silently re-run a partially delivered answer.
                    if (!error.retryable || attempt >= maxAttempts || req.signal?.aborted || emittedOutput) {
                        recorded = true;
                        return yield* this.failStream(callId, conn, req, startedAt, attempt, error);
                    }
                    const delayMs = this.retryDelay(error, attempt);
                    yield { type: 'retry', attempt, reason: error.kind, delayMs };
                    try {
                        await sleep(delayMs, req.signal);
                    }
                    catch (sleepError) {
                        recorded = true;
                        return yield* this.failStream(callId, conn, req, startedAt, attempt, fromUnknown(sleepError, conn.provider));
                    }
                }
            }
        }
        catch (errorValue) {
            recorded = true;
            return yield* this.failStream(callId, conn, req, startedAt, Math.max(1, attempt), fromUnknown(errorValue, conn.provider));
        }
        finally {
            if (acquired)
                this.release();
            if (acquired && !recorded) {
                await this.recordFailure(callId, conn, req, startedAt, Math.max(1, attempt), new AIError('Call canceled before completion', { kind: 'canceled', retryable: false, provider: conn.provider }));
            }
        }
    }
    /**
     * The shared pre-call preamble: policy check → key resolution → `beforeCall`
     * hook. Every entry point (`stream`, `embed`, `listModels`/`testConnection`)
     * runs exactly this sequence, so it lives once. Failures are *returned*, not
     * recorded — each caller owns its own telemetry shape (`recordFailure` for
     * chat/probe, `recordEmbed` for embeddings) and records the returned error.
     */
    async preflight(callId, conn, model, metadata) {
        const policyResult = this.policy.checkModel(conn.provider, model);
        if (!policyResult.allowed) {
            return { ok: false, error: new AIError(policyResult.reason, { kind: 'policy_blocked', retryable: false, provider: conn.provider }) };
        }
        let resolved;
        try {
            resolved = await this.resolveConnection(conn);
        }
        catch (errorValue) {
            // Key resolution failures (missing/locked/denied) are a recorded outcome,
            // not an uncaught throw — the traceability contract covers them too.
            return { ok: false, error: fromUnknown(errorValue, conn.provider) };
        }
        try {
            const info = {
                callId,
                connection: safeConnection(conn),
                provider: conn.provider,
                model,
                metadata,
                resolved: safeResolved(resolved),
            };
            if (await this.opts.hooks?.beforeCall?.(info) === 'deny') {
                return { ok: false, error: new AIError('Call denied by beforeCall hook', { kind: 'policy_blocked', retryable: false, provider: conn.provider }) };
            }
        }
        catch (errorValue) {
            // A throwing beforeCall hook is a recorded, redacted outcome too — not
            // an uncaught throw that skips telemetry and the redaction guarantee.
            return { ok: false, error: fromUnknown(errorValue, conn.provider) };
        }
        return { ok: true, resolved };
    }
    /** Record a failed call and emit the single redacted `error` event for it. */
    async *failStream(callId, conn, req, startedAt, attempts, error) {
        await this.recordFailure(callId, conn, req, startedAt, attempts, error);
        yield { type: 'error', error: this.redactedError(error) };
    }
    async listModels(conn) {
        return this.runProbe(conn, '__listModels__', async (resolved) => {
            const adapter = adapterFor(conn.provider, conn.baseUrl);
            return adapter.listModels?.(resolved) ?? [];
        });
    }
    async testConnection(conn) {
        try {
            return await this.runProbe(conn, '__testConnection__', async (resolved) => {
                const adapter = adapterFor(conn.provider, conn.baseUrl);
                const health = await adapter.health?.(resolved);
                if (health) {
                    if (!health.ok)
                        throw new AIError(health.detail ?? 'Connection failed', { kind: 'network', retryable: false, provider: conn.provider });
                    return { ok: true, message: health.detail ?? 'Connection healthy' };
                }
                await adapter.listModels?.(resolved);
                return { ok: true, message: 'Connection healthy' };
            });
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? this.redact(error.message) : 'Connection failed' };
        }
    }
    /**
     * Warm a connection so the first real call doesn't pay cold DNS/TLS and
     * (for a local daemon) process spin-up on the hot path. Runs a lightweight
     * health probe and never throws — call it once at boot. Combined with a CJS
     * `require` path it removes the cold-start "offline" false negative.
     */
    async prewarm(conn) {
        try {
            await this.testConnection(conn);
        }
        catch {
            // Warm-up only: a failure here just means the first real call pays the cost.
        }
    }
    /**
     * Chat that returns typed, validated output. Requests JSON mode, extracts the
     * JSON from the reply, and validates it against any Standard Schema validator
     * (Zod / Valibot / ArkType). On a validation miss it performs exactly one
     * corrective retry that shows the model its error, then throws
     * `invalid_response` if still invalid. No schema library is bundled — the
     * caller supplies the schema.
     */
    async chatParsed(conn, req, schema) {
        const base = { ...req, responseFormat: req.responseFormat ?? { type: 'json' } };
        let result = await this.chat(conn, base);
        let validated = await validateWithSchema(schema, result.text);
        if (validated.ok)
            return { data: validated.value, result };
        const retry = {
            ...base,
            messages: [
                ...base.messages,
                { role: 'assistant', content: result.text },
                { role: 'user', content: `That response did not match the required schema (${validated.message}). Reply again with ONLY a valid JSON value that matches it.` },
            ],
        };
        result = await this.chat(conn, retry);
        validated = await validateWithSchema(schema, result.text);
        if (validated.ok)
            return { data: validated.value, result };
        throw new AIError(`Model output failed schema validation: ${validated.message}`, { kind: 'invalid_response', provider: conn.provider });
    }
    /**
     * Produce embeddings through the same governed pipeline as chat: policy check,
     * key resolution, `beforeCall` hook, concurrency, and exactly one redacted
     * telemetry record. Throws a typed `invalid_request` error for providers whose
     * adapter has no `embed` (Anthropic, Google) rather than failing silently.
     */
    async embed(conn, req) {
        const callId = createCallId();
        const startedAt = Date.now();
        const inputChars = (Array.isArray(req.input) ? req.input : [req.input]).reduce((sum, text) => sum + text.length, 0);
        const fail = async (error) => {
            await this.recordEmbed(callId, conn, req, startedAt, { estimated: true }, inputChars, error);
            throw this.redactedError(error);
        };
        const preflight = await this.preflight(callId, conn, req.model, req.metadata);
        if (!preflight.ok)
            return fail(preflight.error);
        const resolved = preflight.resolved;
        const adapter = adapterFor(conn.provider, conn.baseUrl);
        if (!adapter.embed) {
            return fail(new AIError(`Provider ${conn.provider} does not support embeddings`, { kind: 'invalid_request', retryable: false, provider: conn.provider }));
        }
        await this.acquire(req.signal);
        try {
            const result = await adapter.embed(resolved, req);
            await this.recordEmbed(callId, conn, req, startedAt, result.usage, inputChars);
            return result;
        }
        catch (errorValue) {
            return fail(fromUnknown(errorValue, conn.provider));
        }
        finally {
            this.release();
        }
    }
    async recordEmbed(callId, conn, req, startedAt, usage, inputChars, error) {
        const costUsd = error ? undefined : this.opts.pricing?.({ provider: conn.provider, model: req.model, usage });
        await this.record({
            callId,
            connectionId: conn.id,
            provider: conn.provider,
            model: req.model,
            startedAt,
            timing: { firstTokenMs: null, totalMs: Date.now() - startedAt },
            usage,
            finishReason: error ? (error.kind === 'canceled' ? 'canceled' : 'error') : 'stop',
            ...(error ? { error: { kind: error.kind, status: error.status, message: error.message } } : {}),
            attempts: 1,
            metadata: { ...req.metadata, operation: '__embed__' },
            promptChars: inputChars,
            responseChars: 0,
            ...(costUsd !== undefined ? { costUsd } : {}),
        });
    }
    async runProbe(conn, operation, action) {
        const callId = createCallId();
        const startedAt = Date.now();
        const req = { model: operation, messages: [], metadata: { operation } };
        try {
            const preflight = await this.preflight(callId, conn, operation, req.metadata);
            if (!preflight.ok)
                throw preflight.error;
            const resolved = preflight.resolved;
            await this.acquire(undefined);
            try {
                const value = await action(resolved);
                await this.recordSuccess(callId, conn, req, startedAt, 1, {
                    text: '',
                    finishReason: 'stop',
                    usage: { estimated: true },
                    timing: { firstTokenMs: null, totalMs: Date.now() - startedAt },
                    model: operation,
                    source: { provider: conn.provider, connectionId: conn.id, baseUrl: resolved.baseUrl },
                });
                return value;
            }
            finally {
                this.release();
            }
        }
        catch (errorValue) {
            const error = fromUnknown(errorValue, conn.provider);
            await this.recordFailure(callId, conn, req, startedAt, 1, error);
            throw this.redactedError(error);
        }
    }
    async resolveConnection(conn) {
        const profile = profileFor(conn.provider, conn.baseUrl);
        const baseUrl = conn.baseUrl ?? profile.defaultBaseUrl;
        if (!baseUrl)
            throw new AIError(`Provider ${conn.provider} requires baseUrl`, { kind: 'invalid_request', retryable: false, provider: conn.provider });
        const keyRef = conn.keyRef ?? { kind: 'none' };
        const key = await this.opts.keySource.resolve(keyRef);
        if (!key.ok) {
            throw new AIError(`API key unavailable: ${key.reason}`, { kind: 'key_unavailable', retryable: false, provider: conn.provider });
        }
        this.sessionRedactor.addSecret(key.apiKey);
        return {
            ...conn,
            baseUrl: trimSlash(baseUrl),
            apiKey: key.apiKey,
            headers: applyAuth(profile, key.apiKey, conn.headers ?? {}),
        };
    }
    async acquire(signal) {
        const max = this.opts.limits?.maxConcurrent ?? Number.POSITIVE_INFINITY;
        while (this.active >= max) {
            await new Promise((resolve, reject) => {
                let waiter;
                const onAbort = () => {
                    const index = this.queue.indexOf(waiter);
                    if (index >= 0)
                        this.queue.splice(index, 1);
                    reject(new AIError('Call canceled while waiting for concurrency slot', { kind: 'canceled', retryable: false }));
                };
                if (signal?.aborted) {
                    reject(new AIError('Call canceled while waiting for concurrency slot', { kind: 'canceled', retryable: false }));
                    return;
                }
                signal?.addEventListener('abort', onAbort, { once: true });
                waiter = { resolve, reject, signal, onAbort };
                this.queue.push(waiter);
            });
        }
        this.active += 1;
        const minInterval = this.opts.limits?.minIntervalMs ?? 0;
        const previousLastStarted = this.lastStarted;
        const wait = Math.max(0, previousLastStarted + minInterval - Date.now());
        const reserved = Date.now() + wait;
        this.lastStarted = reserved;
        try {
            if (wait)
                await sleep(wait, signal);
        }
        catch (error) {
            this.release();
            // Only undo our own reservation — a later caller may have already
            // paced itself off `reserved` and must keep that spacing.
            if (this.lastStarted === reserved)
                this.lastStarted = previousLastStarted;
            throw error;
        }
    }
    release() {
        this.active = Math.max(0, this.active - 1);
        while (this.queue.length) {
            const waiter = this.queue.shift();
            waiter.signal?.removeEventListener('abort', waiter.onAbort);
            if (waiter.signal?.aborted)
                continue;
            waiter.resolve();
            break;
        }
    }
    retryDelay(error, attempt) {
        const base = this.opts.retry?.baseDelayMs ?? 250;
        const max = this.opts.retry?.maxDelayMs ?? 30_000;
        if (error.retryAfterMs !== undefined)
            return Math.min(error.retryAfterMs, max);
        const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
        return Math.round(exponential * (0.75 + Math.random() * 0.5));
    }
    async recordSuccess(callId, conn, req, startedAt, attempts, result) {
        const costUsd = this.opts.pricing?.({ provider: conn.provider, model: req.model, usage: result.usage });
        await this.record({
            callId,
            connectionId: conn.id,
            provider: conn.provider,
            model: req.model,
            startedAt,
            timing: result.timing,
            usage: result.usage,
            finishReason: result.finishReason,
            attempts,
            metadata: req.metadata,
            promptChars: promptChars(req.messages),
            responseChars: result.text.length,
            ...(costUsd !== undefined ? { costUsd } : {}),
        });
    }
    async recordFailure(callId, conn, req, startedAt, attempts, error) {
        await this.record({
            callId,
            connectionId: conn.id,
            provider: conn.provider,
            model: req.model,
            startedAt,
            timing: { firstTokenMs: null, totalMs: Date.now() - startedAt },
            usage: { estimated: true },
            finishReason: error.kind === 'canceled' ? 'canceled' : 'error',
            error: { kind: error.kind, status: error.status, message: error.message },
            attempts,
            metadata: req.metadata,
            promptChars: promptChars(req.messages),
            responseChars: 0,
        });
    }
    async record(record) {
        const redacted = redactRecord(record, (text) => this.redact(text));
        try {
            await this.opts.telemetry?.record(redacted);
            await this.opts.hooks?.afterCall?.(redacted);
        }
        catch {
            // Telemetry and afterCall hooks must not re-drive provider calls or turn
            // an already-completed model response into a retry.
        }
    }
    redact(text) {
        return (this.opts.redactor ?? this.sessionRedactor).redact(this.sessionRedactor.redact(text));
    }
    redactedError(error) {
        return new AIError(this.redact(error.message), {
            kind: error.kind,
            status: error.status,
            retryable: error.retryable,
            provider: error.provider,
            raw: error.raw === undefined ? undefined : this.redact(error.raw),
            retryAfterMs: error.retryAfterMs,
            cause: this.redactedCause(error.cause),
        });
    }
    redactedCause(cause) {
        if (cause instanceof Error) {
            const redacted = new Error(this.redact(cause.message));
            redacted.name = cause.name;
            redacted.stack = undefined;
            return redacted;
        }
        return cause;
    }
}
function redactRecord(record, redact) {
    return {
        ...record,
        error: record.error ? { ...record.error, message: redact(record.error.message) } : undefined,
        metadata: redactMetadata(record.metadata, redact),
    };
}
/**
 * Redacts metadata by round-tripping through JSON. Metadata is an app-supplied
 * passthrough and may contain values JSON cannot represent (BigInt, circular
 * references, functions); redaction must never throw, so a non-serializable
 * payload is replaced with a sentinel rather than crashing the telemetry path.
 */
function redactMetadata(metadata, redact) {
    if (!metadata)
        return undefined;
    try {
        return JSON.parse(redact(JSON.stringify(metadata)));
    }
    catch {
        return { redacted: true, note: 'metadata was not JSON-serializable' };
    }
}
function trimSlash(value) {
    return value.replace(/\/+$/, '');
}
/**
 * Drops the resolved API key *and* neutralizes the auth headers built from it,
 * so a `beforeCall` hook can inspect the endpoint but never the secret.
 * `keyRef` is scrubbed too — a `{ kind: 'literal' }` ref carries the plaintext
 * key, and hooks routinely log the whole object.
 */
function safeResolved(resolved) {
    const { apiKey: _apiKey, headers, ...rest } = resolved;
    return { ...rest, ...safeKeyRef(resolved), headers: maskAuthHeaders(headers) };
}
/**
 * The caller's own `Connection`, with any plaintext `keyRef` masked. Hooks get
 * the connection so they can key off `id`/`provider`/`baseUrl`; they must never
 * be handed the secret, since logging `info.connection` for audit is the
 * obvious thing to do and would otherwise ship the key in clear text.
 */
function safeConnection(conn) {
    return { ...conn, ...safeKeyRef(conn) };
}
function safeKeyRef(conn) {
    if (conn.keyRef?.kind !== 'literal')
        return conn.keyRef === undefined ? {} : { keyRef: conn.keyRef };
    return { keyRef: { kind: 'literal', value: REDACTED } };
}
const REDACTED = '[REDACTED]';
/** Header names whose value is derived from the API key by {@link applyAuth}. */
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key']);
function maskAuthHeaders(headers) {
    const masked = {};
    for (const [name, value] of Object.entries(headers)) {
        masked[name] = AUTH_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
    }
    return masked;
}
/**
 * Attach a per-call `Idempotency-Key` for providers that honor one, so a retry
 * after a dropped connection can't be billed as a second generation. Only set
 * where the profile declares support, and never overrides a caller-supplied
 * header.
 */
function withIdempotencyKey(resolved, callId) {
    const profile = profileFor(resolved.provider, resolved.baseUrl);
    if (!profile.quirks?.supportsIdempotencyKey)
        return resolved;
    if (Object.keys(resolved.headers).some((name) => name.toLowerCase() === 'idempotency-key'))
        return resolved;
    return { ...resolved, headers: { ...resolved.headers, 'idempotency-key': callId } };
}
async function validateWithSchema(schema, text) {
    const value = extractJson(text);
    if (value === null)
        return { ok: false, message: 'no JSON found in model output' };
    const result = await schema['~standard'].validate(value);
    if (result.issues) {
        const message = result.issues.map((issue) => issue.message).join('; ');
        return { ok: false, message: message || 'validation failed' };
    }
    return { ok: true, value: result.value };
}
function createCallId() {
    return globalThis.crypto?.randomUUID?.() ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
//# sourceMappingURL=handler.js.map