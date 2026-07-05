import { adapterFor } from './adapters/index.js';
import { applyAuth, profileFor } from './adapters/profiles.js';
import { AIError, fromUnknown } from './errors.js';
import { allowAllPolicy } from './policy.js';
import { SessionRedactor } from './redact.js';
import { promptChars, sleep } from './util.js';
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
        const policyResult = this.policy.checkModel(conn.provider, req.model);
        if (!policyResult.allowed) {
            const error = new AIError(policyResult.reason, { kind: 'policy_blocked', retryable: false, provider: conn.provider });
            await this.recordFailure(callId, conn, req, startedAt, 1, error);
            yield { type: 'error', error };
            return;
        }
        let resolved;
        try {
            resolved = await this.resolveConnection(conn);
        }
        catch (errorValue) {
            // Key resolution failures (missing/locked/denied) are a recorded outcome,
            // not an uncaught throw — the traceability contract covers them too.
            const error = fromUnknown(errorValue, conn.provider);
            await this.recordFailure(callId, conn, req, startedAt, 1, error);
            yield { type: 'error', error };
            return;
        }
        const info = { callId, connection: conn, provider: conn.provider, model: req.model, metadata: req.metadata };
        if (await this.opts.hooks?.beforeCall?.(info) === 'deny') {
            const error = new AIError('Call denied by beforeCall hook', { kind: 'policy_blocked', retryable: false, provider: conn.provider });
            await this.recordFailure(callId, conn, req, startedAt, 1, error);
            yield { type: 'error', error };
            return;
        }
        await this.acquire(req.signal);
        try {
            const maxAttempts = this.opts.retry?.maxAttempts ?? 3;
            let attempt = 0;
            for (;;) {
                attempt += 1;
                try {
                    let final;
                    for await (const event of adapter.stream(resolved, req)) {
                        if (event.type === 'start')
                            yield { ...event, callId };
                        else {
                            if (event.type === 'done')
                                final = event.result;
                            yield event;
                        }
                    }
                    if (!final)
                        throw new AIError('Provider did not emit a done event', { kind: 'invalid_response', provider: conn.provider });
                    await this.recordSuccess(callId, conn, req, startedAt, attempt, final);
                    return;
                }
                catch (errorValue) {
                    const error = fromUnknown(errorValue, conn.provider);
                    if (!error.retryable || attempt >= maxAttempts || req.signal?.aborted) {
                        await this.recordFailure(callId, conn, req, startedAt, attempt, error);
                        yield { type: 'error', error };
                        return;
                    }
                    const delayMs = this.retryDelay(error, attempt);
                    yield { type: 'retry', attempt, reason: error.kind, delayMs };
                    await sleep(delayMs, req.signal);
                }
            }
        }
        finally {
            this.release();
        }
    }
    async listModels(conn) {
        const resolved = await this.resolveConnection(conn);
        const adapter = adapterFor(conn.provider, conn.baseUrl);
        return adapter.listModels?.(resolved) ?? [];
    }
    async testConnection(conn) {
        try {
            const resolved = await this.resolveConnection(conn);
            const adapter = adapterFor(conn.provider, conn.baseUrl);
            const health = await adapter.health?.(resolved);
            if (health)
                return { ok: health.ok, message: health.detail ?? (health.ok ? 'Connection healthy' : 'Connection failed') };
            await adapter.listModels?.(resolved);
            return { ok: true, message: 'Connection healthy' };
        }
        catch (error) {
            return { ok: false, message: error instanceof Error ? this.redact(error.message) : 'Connection failed' };
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
                const onAbort = () => {
                    reject(new AIError('Call canceled while waiting for concurrency slot', { kind: 'canceled', retryable: false }));
                };
                if (signal?.aborted)
                    return onAbort();
                signal?.addEventListener('abort', onAbort, { once: true });
                this.queue.push(() => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                });
            });
        }
        const minInterval = this.opts.limits?.minIntervalMs ?? 0;
        const wait = Math.max(0, this.lastStarted + minInterval - Date.now());
        if (wait)
            await sleep(wait, signal);
        this.active += 1;
        this.lastStarted = Date.now();
    }
    release() {
        this.active = Math.max(0, this.active - 1);
        this.queue.shift()?.();
    }
    retryDelay(error, attempt) {
        if (error.retryAfterMs !== undefined)
            return error.retryAfterMs;
        const base = this.opts.retry?.baseDelayMs ?? 250;
        const max = this.opts.retry?.maxDelayMs ?? 30_000;
        const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
        return Math.round(exponential * (0.75 + Math.random() * 0.5));
    }
    async recordSuccess(callId, conn, req, startedAt, attempts, result) {
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
        await this.opts.telemetry?.record(redacted);
        await this.opts.hooks?.afterCall?.(redacted);
    }
    redact(text) {
        return (this.opts.redactor ?? this.sessionRedactor).redact(this.sessionRedactor.redact(text));
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
function createCallId() {
    return globalThis.crypto?.randomUUID?.() ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
//# sourceMappingURL=handler.js.map