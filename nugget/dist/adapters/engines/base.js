import { AIError, fromUnknown } from '../../errors.js';
import { fetchJson, withTimeout } from '../../transport.js';
import { asRecord, asString, joinUrl } from '../../util.js';
export const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Maps a raw streaming failure onto a typed {@link AIError}. A fired timeout is
 * reported as `timeout` regardless of how the underlying `fetch` surfaced the
 * abort; anything else is normalized through {@link fromUnknown} (which passes
 * an existing {@link AIError} through untouched, preserving retryability).
 */
export function streamError(error, timeout, provider) {
    if (timeout.timedOut())
        return new AIError('Request timed out', { kind: 'timeout', provider });
    return fromUnknown(error, provider);
}
/**
 * Create a timeout/abort scope covering the full stream lifetime, plus an
 * optional idle timeout (`conn.idleTimeoutMs`) that the engine rearms via
 * `bump()` on each received chunk.
 */
export function streamTimeout(conn, signal) {
    return withTimeout(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal, conn.idleTimeoutMs);
}
export async function listOpenModels(conn, profile) {
    if (!profile.listModelsPath)
        return [];
    const { data } = await fetchJson(joinUrl(conn.baseUrl, profile.listModelsPath), {
        method: 'GET',
        headers: conn.headers,
        timeoutMs: conn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        provider: conn.provider,
    });
    const record = asRecord(data);
    const items = Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
    const models = [];
    for (const item of items) {
        const row = asRecord(item);
        const id = asString(row?.id) ?? asString(row?.name);
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
export async function health(conn, profile) {
    const path = profile.healthPath ?? profile.listModelsPath;
    if (!path)
        return { ok: true };
    try {
        await fetchJson(joinUrl(conn.baseUrl, path), {
            method: 'GET',
            headers: conn.headers,
            timeoutMs: Math.min(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000),
            provider: conn.provider,
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
export function parseArgs(raw) {
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
export function safeParse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
/** Stable-enough id for a tool call a provider didn't give one for. */
export function randomId() {
    return globalThis.crypto?.randomUUID?.() ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
/**
 * A stream that ended without the provider's terminal marker (an OpenAI
 * `finish_reason`, an Anthropic `message_delta.stop_reason`, a Google
 * `finishReason`, an Ollama `done`) was almost certainly truncated. Every
 * engine yields this so a dropped connection is diagnosable identically
 * regardless of provider.
 */
export function streamAnomaly(reason = 'stream ended without a terminal finish reason') {
    return { type: 'context', kind: 'stream_anomaly', data: { reason } };
}
/**
 * Pulls a context-window figure out of the many shapes providers use for it
 * (OpenRouter `context_length`, OpenAI-style `context_window`, Ollama
 * `/api/show` `model_info` entries surfaced as `contextWindow`, JX Runtime's
 * `capabilities.max_context`).
 */
function asContextWindow(row) {
    if (!row)
        return undefined;
    const direct = row['context_length'] ?? row['context_window'] ?? row['contextWindow'];
    if (typeof direct === 'number' && Number.isFinite(direct))
        return direct;
    const nested = asRecord(row['capabilities'])?.['max_context'];
    return typeof nested === 'number' && Number.isFinite(nested) ? nested : undefined;
}
/**
 * `capabilities` on a listed model comes in two shapes across providers: an
 * array/single string of capability names, or — JX Runtime's `GET /v1/models`
 * (`{ chat: true, tools: false, max_context: 8192, ... }`) — an object of
 * capability flags. The object form is flattened to the names whose flag is
 * `true`; non-boolean fields (`max_context`) are read separately by
 * {@link asContextWindow} and dropped here rather than surfacing as a bogus
 * capability name.
 */
function asCapabilities(row) {
    if (!row)
        return undefined;
    const value = row['capabilities'] ?? asRecord(row['architecture'])?.['modality'];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
        return value;
    if (typeof value === 'string')
        return [value];
    const record = asRecord(value);
    if (record) {
        const flags = Object.entries(record).filter(([, flag]) => flag === true).map(([name]) => name);
        return flags.length ? flags : undefined;
    }
    return undefined;
}
//# sourceMappingURL=base.js.map