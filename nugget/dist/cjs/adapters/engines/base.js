"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TIMEOUT_MS = void 0;
exports.streamError = streamError;
exports.streamTimeout = streamTimeout;
exports.listOpenModels = listOpenModels;
exports.health = health;
exports.parseArgs = parseArgs;
exports.safeParse = safeParse;
exports.randomId = randomId;
exports.streamAnomaly = streamAnomaly;
exports.partBase64 = partBase64;
exports.partMime = partMime;
exports.partUrl = partUrl;
exports.partHasBytes = partHasBytes;
exports.unsupportedPart = unsupportedPart;
exports.mediaFromUrl = mediaFromUrl;
exports.promptCacheUnsupported = promptCacheUnsupported;
exports.mcpUnsupported = mcpUnsupported;
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
        fetch: conn.fetch,
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
    if (!path && profile.quirks?.unsupportedProbe)
        return { ok: false, detail: 'This endpoint has no lightweight health probe; validate with an explicit model call.' };
    if (!path)
        return { ok: true };
    try {
        await (0, transport_js_1.fetchJson)((0, util_js_1.joinUrl)(conn.baseUrl, path), {
            method: 'GET',
            headers: conn.headers,
            timeoutMs: Math.min(conn.timeoutMs ?? exports.DEFAULT_TIMEOUT_MS, 10_000),
            provider: conn.provider,
            fetch: conn.fetch,
        });
        return { ok: true };
    }
    catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : 'Health check failed' };
    }
}
/**
 * Coerce a provider's tool-call `arguments` into an object. Providers disagree
 * on the shape: OpenAI/Anthropic stream a JSON *string*, Google and Ollama send
 * a native object — but Ollama-compatible backends (llama.cpp and friends)
 * sometimes send a string too. Malformed JSON degrades to `{}` so a single bad
 * tool call surfaces as an argument-validation error rather than a stream crash.
 */
function parseArgs(raw) {
    if (raw === undefined || raw === null)
        return {};
    if (typeof raw !== 'string')
        return raw;
    if (!raw.trim())
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
/** JSON.parse that returns undefined instead of throwing — for per-line stream frames. */
function safeParse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
/** Stable-enough id for a tool call a provider didn't give one for. */
function randomId() {
    return globalThis.crypto?.randomUUID?.() ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
/**
 * A stream that ended without the provider's terminal marker (an OpenAI
 * `finish_reason`, an Anthropic `message_delta.stop_reason`, a Google
 * `finishReason`, an Ollama `done`) was almost certainly truncated. Every
 * engine yields this so a dropped connection is diagnosable identically
 * regardless of provider.
 */
function streamAnomaly(reason = 'stream ended without a terminal finish reason') {
    return { type: 'context', kind: 'stream_anomaly', data: { reason } };
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
/** Base64 payload of a non-text part (`dataBase64`, or the legacy `imageBase64`). */
function partBase64(part) {
    return part.dataBase64 ?? part.imageBase64 ?? dataUrlPayload(part.url);
}
/** Default MIME type per part kind when the caller did not set one. */
function partMime(part) {
    if (part.mimeType)
        return part.mimeType;
    const fromUrl = part.url?.match(/^data:([^;,]+)[;,]/)?.[1];
    if (fromUrl)
        return fromUrl;
    return part.type === 'image' ? 'image/png' : part.type === 'audio' ? 'audio/wav' : part.type === 'video' ? 'video/mp4' : part.type === 'file' ? 'application/pdf' : 'text/plain';
}
/** A `data:` URL for the part, or its caller-supplied URL. */
function partUrl(part) {
    if (part.url)
        return part.url;
    return `data:${partMime(part)};base64,${partBase64(part) ?? ''}`;
}
/** True when the part carries inline bytes rather than only a remote URL. */
function partHasBytes(part) {
    return (part.dataBase64 ?? part.imageBase64) !== undefined || (part.url?.startsWith('data:') ?? false);
}
/** Typed, non-retryable failure for a content part this protocol cannot carry. */
function unsupportedPart(provider, part, detail = '') {
    return new errors_js_1.AIError(`${provider} cannot accept ${part.type} input${detail ? ` ${detail}` : ''} on this protocol`, { kind: 'invalid_request', retryable: false, provider });
}
/** Builds a {@link MediaOutput} from a `data:` URL or a remote URL. */
function mediaFromUrl(type, url, fallbackMime) {
    const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
    return match ? { type, mimeType: match[1], dataBase64: match[2] } : { type, mimeType: fallbackMime, url };
}
function dataUrlPayload(url) {
    return url?.match(/^data:[^,]*;base64,(.*)$/s)?.[1];
}
/** Context event for a provider with no request-level prompt-cache control. */
function promptCacheUnsupported(provider) {
    return { type: 'context', kind: 'prompt_cache_unsupported', data: { provider, reason: 'This provider has no request-level prompt-cache control here; any caching it does is implicit.' } };
}
/** Typed failure when a protocol cannot hand MCP servers to the provider. */
function mcpUnsupported(provider, protocol) {
    return new errors_js_1.AIError(`${provider} ${protocol} cannot connect provider-hosted MCP servers; use protocol: 'responses' or the anthropic engine`, { kind: 'invalid_request', retryable: false, provider });
}
