"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withTimeout = withTimeout;
exports.fetchJson = fetchJson;
exports.postResponse = postResponse;
exports.sseLines = sseLines;
exports.ndjsonLines = ndjsonLines;
exports.textLines = textLines;
const errors_js_1 = require("./errors.js");
function withTimeout(ms, external, idleMs) {
    const controller = new AbortController();
    let didTimeOut = false;
    const timer = setTimeout(() => {
        didTimeOut = true;
        controller.abort(new errors_js_1.AIError(`Request timed out after ${ms}ms`, { kind: 'timeout' }));
    }, ms);
    // Optional idle timeout: aborts only when no chunk has arrived for `idleMs`,
    // rearmed on every `bump()`. Keeps a long but healthy stream alive while the
    // total `ms` ceiling still bounds a truly stuck call.
    let idleTimer;
    const armIdle = () => {
        if (idleMs === undefined)
            return;
        if (idleTimer)
            clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            didTimeOut = true;
            controller.abort(new errors_js_1.AIError(`Request idle for ${idleMs}ms`, { kind: 'timeout' }));
        }, idleMs);
    };
    const onAbort = () => controller.abort(external?.reason);
    if (external) {
        if (external.aborted)
            onAbort();
        else
            external.addEventListener('abort', onAbort, { once: true });
    }
    armIdle();
    return {
        signal: controller.signal,
        done() {
            clearTimeout(timer);
            if (idleTimer)
                clearTimeout(idleTimer);
            external?.removeEventListener('abort', onAbort);
        },
        timedOut() {
            return didTimeOut;
        },
        bump() {
            armIdle();
        },
    };
}
async function fetchJson(url, init) {
    const timeout = withTimeout(init.timeoutMs, init.signal ?? undefined);
    const started = Date.now();
    try {
        const res = await fetch(url, { ...init, signal: timeout.signal });
        const raw = await res.text().catch(() => '');
        if (!res.ok)
            throw (0, errors_js_1.classify)(res.status, raw, init.provider, res.headers);
        return { data: raw.trim() ? tolerantJson(raw) : null, status: res.status, totalMs: Date.now() - started };
    }
    catch (error) {
        if (timeout.timedOut())
            throw new errors_js_1.AIError(`Request timed out after ${init.timeoutMs}ms`, { kind: 'timeout', provider: init.provider });
        throw (0, errors_js_1.fromUnknown)(error, init.provider);
    }
    finally {
        timeout.done();
    }
}
/**
 * POST a JSON body and return the raw {@link Response} for streaming.
 *
 * The caller owns the abort/timeout `signal` and is responsible for keeping it
 * alive until the response body has been fully consumed — passing a
 * `withTimeout()` signal here and cleaning it up only after the stream ends is
 * what lets external cancellation and the timeout apply for the *whole* stream,
 * not merely the connection handshake. Non-2xx responses are classified and
 * thrown before the body is handed back.
 */
async function postResponse(url, body, headers, signal, provider) {
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal,
        });
    }
    catch (error) {
        throw (0, errors_js_1.fromUnknown)(error, provider);
    }
    if (!res.ok) {
        const raw = await res.text().catch(() => '');
        throw (0, errors_js_1.classify)(res.status, raw, provider, res.headers);
    }
    return res;
}
async function* sseLines(res) {
    for await (const line of textLines(res)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':'))
            continue;
        if (!trimmed.startsWith('data:'))
            continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]')
            continue;
        yield data;
    }
}
async function* ndjsonLines(res) {
    for await (const line of textLines(res)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            yield JSON.parse(trimmed);
        }
        catch {
            throw new errors_js_1.AIError('Provider returned malformed NDJSON', { kind: 'invalid_response' });
        }
    }
}
async function* textLines(res) {
    if (!res.body) {
        const raw = await res.text().catch(() => '');
        for (const line of raw.split(/\r?\n/))
            yield line;
        return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                completed = true;
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                yield line;
            }
        }
        buffer += decoder.decode();
        if (buffer.trim())
            yield buffer;
    }
    finally {
        if (!completed)
            await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
function tolerantJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return { text: raw };
    }
}
