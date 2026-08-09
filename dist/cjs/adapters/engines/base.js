"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TIMEOUT_MS = void 0;
exports.streamError = streamError;
exports.streamTimeout = streamTimeout;
exports.listOpenModels = listOpenModels;
exports.health = health;
exports.requireResponse = requireResponse;
const errors_js_1 = require("../../errors.js");
const transport_js_1 = require("../../transport.js");
const util_js_1 = require("../../util.js");
exports.DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Maps a raw streaming failure onto a typed {@link AIError}. A fired timeout is
 * reported as `timeout` regardless of how the underlying `fetch` surfaced the
 * abort; anything else is normalized through {@link fromUnknown} (which passes
 * an existing {@link AIError} through untouched, preserving retryability).
 */
function streamError(error, timeout, provider) {
    if (timeout.timedOut())
        return new errors_js_1.AIError('Request timed out', { kind: 'timeout', provider });
    return (0, errors_js_1.fromUnknown)(error, provider);
}
/**
 * Create a timeout/abort scope covering the full stream lifetime, plus an
 * optional idle timeout (`conn.idleTimeoutMs`) that the engine rearms via
 * `bump()` on each received chunk.
 */
function streamTimeout(conn, signal) {
    return (0, transport_js_1.withTimeout)(conn.timeoutMs ?? exports.DEFAULT_TIMEOUT_MS, signal, conn.idleTimeoutMs);
}
async function listOpenModels(conn, profile) {
    if (!profile.listModelsPath)
        return [];
    const { data } = await (0, transport_js_1.fetchJson)((0, util_js_1.joinUrl)(conn.baseUrl, profile.listModelsPath), {
        method: 'GET',
        headers: conn.headers,
        timeoutMs: conn.timeoutMs ?? exports.DEFAULT_TIMEOUT_MS,
        provider: conn.provider,
    });
    const record = (0, util_js_1.asRecord)(data);
    const items = Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
    const models = [];
    for (const item of items) {
        const row = (0, util_js_1.asRecord)(item);
        const id = (0, util_js_1.asString)(row?.id) ?? (0, util_js_1.asString)(row?.name);
        if (!id)
            continue;
        const contextWindow = asContextWindow(row);
        const capabilities = asCapabilities(row);
        const model = {
            id,
            source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
        };
        if (contextWindow !== undefined)
            model.contextWindow = contextWindow;
        if (capabilities)
            model.capabilities = capabilities;
        models.push(model);
    }
    return models;
}
async function health(conn, profile) {
    const path = profile.healthPath ?? profile.listModelsPath;
    if (!path)
        return { ok: true };
    try {
        await (0, transport_js_1.fetchJson)((0, util_js_1.joinUrl)(conn.baseUrl, path), {
            method: 'GET',
            headers: conn.headers,
            timeoutMs: Math.min(conn.timeoutMs ?? exports.DEFAULT_TIMEOUT_MS, 10_000),
            provider: conn.provider,
        });
        return { ok: true };
    }
    catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : 'Health check failed' };
    }
}
function requireResponse(condition, message) {
    if (!condition)
        throw new errors_js_1.AIError(message, { kind: 'invalid_response' });
}
/**
 * Pulls a context-window figure out of the many shapes providers use for it
 * (OpenRouter `context_length`, OpenAI-style `context_window`, Ollama
 * `/api/show` `model_info` entries surfaced as `contextWindow`).
 */
function asContextWindow(row) {
    if (!row)
        return undefined;
    const direct = row['context_length'] ?? row['context_window'] ?? row['contextWindow'];
    return typeof direct === 'number' && Number.isFinite(direct) ? direct : undefined;
}
function asCapabilities(row) {
    if (!row)
        return undefined;
    const value = row['capabilities'] ?? (0, util_js_1.asRecord)(row['architecture'])?.['modality'];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
        return value;
    if (typeof value === 'string')
        return [value];
    return undefined;
}
