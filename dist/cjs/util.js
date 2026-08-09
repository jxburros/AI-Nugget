"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asRecord = asRecord;
exports.asString = asString;
exports.asNumber = asNumber;
exports.promptChars = promptChars;
exports.textFromMessages = textFromMessages;
exports.globalEnv = globalEnv;
exports.applyProviderOptions = applyProviderOptions;
exports.joinUrl = joinUrl;
exports.mapWithConcurrency = mapWithConcurrency;
exports.sleep = sleep;
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function promptChars(messages) {
    return messages.reduce((sum, message) => {
        if (typeof message.content === 'string')
            return sum + message.content.length;
        return sum + message.content.reduce((partSum, part) => partSum + (part.text?.length ?? 0) + (part.imageBase64?.length ?? 0), 0);
    }, 0);
}
function textFromMessages(messages) {
    return messages.map((message) => {
        if (typeof message.content === 'string')
            return message.content;
        return message.content.map((part) => part.text ?? '').join('');
    }).join('\n');
}
function globalEnv() {
    const maybeProcess = globalThis;
    return maybeProcess.process?.env ?? {};
}
/**
 * Merges app-supplied {@link ChatRequest.providerOptions} into a provider
 * request body: shallow at the top level, and one level deep for each key in
 * `nestedKeys` where both sides are plain objects (Ollama `options`, Google
 * `generationConfig`). Values in `providerOptions` win on collision.
 */
function applyProviderOptions(body, providerOptions, nestedKeys = []) {
    if (!providerOptions)
        return body;
    const merged = { ...body };
    for (const [key, value] of Object.entries(providerOptions)) {
        const base = asRecord(merged[key]);
        if (nestedKeys.includes(key) && base && asRecord(value)) {
            merged[key] = { ...base, ...value };
        }
        else {
            merged[key] = value;
        }
    }
    return merged;
}
/** Joins a base URL and path without producing a double slash, even if `base` ends with `/`. */
function joinUrl(base, path) {
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the returned array. Used to probe many local models
 * concurrently without opening an unbounded number of sockets.
 */
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const worker = async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length)
                return;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}
function sleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const timer = setTimeout(() => {
            settled = true;
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new DOMException('Sleep aborted', 'AbortError'));
        };
        if (signal) {
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}
