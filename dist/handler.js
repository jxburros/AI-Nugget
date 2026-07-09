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
            yield { type: 'error', error: this.redactedError(error) };
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
            yield { type: 'error', error: this.redactedError(error) };
            return;
        }
        const info = { callId, connection: conn, provider: conn.provider, model: req.model, metadata: req.metadata };
        try {
            if (await this.opts.hooks?.beforeCall?.(info) === 'deny') {
                const error = new AIError('Call denied by beforeCall hook', { kind: 'policy_blocked', retryable: false, provider: conn.provider });
                await this.recordFailure(callId, conn, req, startedAt, 1, error);
                yield { type: 'error', error: this.redactedError(error) };
                return;
            }
        }
        catch (errorValue) {
            // A throwing beforeCall hook is a recorded, redacted outcome too — not
            // an uncaught throw that skips telemetry and the redaction guarantee.
            const error = fromUnknown(errorValue, conn.provider);
            await this.recordFailure(callId, conn, req, startedAt, 1, error);
            yield { type: 'error', error: this.redactedError(error) };
            return;
        }
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
                    if (!error.retryable || attempt >= maxAttempts || req.signal?.aborted || emittedOutput) {
                        await this.recordFailure(callId, conn, req, startedAt, attempt, error);
                        recorded = true;
                        yield { type: 'error', error: this.redactedError(error) };
                        return;
                    }
                    const delayMs = this.retryDelay(error, attempt);
                    yield { type: 'retry', attempt, reason: error.kind, delayMs };
                    try {
                        await sleep(delayMs, req.signal);
                    }
                    catch (sleepError) {
                        const canceled = fromUnknown(sleepError, conn.provider);
                        await this.recordFailure(callId, conn, req, startedAt, attempt, canceled);
                        recorded = true;
                        yield { type: 'error', error: this.redactedError(canceled) };
                        return;
                    }
                }
            }
        }
        catch (errorValue) {
            const error = fromUnknown(errorValue, conn.provider);
            await this.recordFailure(callId, conn, req, startedAt, Math.max(1, attempt), error);
            recorded = true;
            yield { type: 'error', error: this.redactedError(error) };
            return;
        }
        finally {
            if (acquired)
                this.release();
            if (acquired && !recorded) {
                await this.recordFailure(callId, conn, req, startedAt, Math.max(1, attempt), new AIError('Call canceled before completion', { kind: 'canceled', retryable: false, provider: conn.provider }));
            }
        }
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
    async runProbe(conn, operation, action) {
        const callId = createCallId();
        const startedAt = Date.now();
        const req = { model: operation, messages: [], metadata: { operation } };
        const policyResult = this.policy.checkModel(conn.provider, operation);
        if (!policyResult.allowed) {
            const error = new AIError(policyResult.reason, { kind: 'policy_blocked', retryable: false, provider: conn.provider });
            await this.recordFailure(callId, conn, req, startedAt, 1, error);
            throw this.redactedError(error);
        }
        let resolved;
        try {
            resolved = await this.resolveConnection(conn);
            const info = { callId, connection: conn, provider: conn.provider, model: operation, metadata: req.metadata };
            if (await this.opts.hooks?.beforeCall?.(info) === 'deny') {
                throw new AIError('Call denied by beforeCall hook', { kind: 'policy_blocked', retryable: false, provider: conn.provider });
            }
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
function createCallId() {
    return globalThis.crypto?.randomUUID?.() ?? `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
//# sourceMappingURL=handler.js.map