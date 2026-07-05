import { AIError, fromUnknown } from '../../errors.js';
import { fetchJson, withTimeout } from '../../transport.js';
import { asRecord, asString } from '../../util.js';
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
/** Create a timeout/abort scope covering the full stream lifetime. */
export function streamTimeout(conn, signal) {
    return withTimeout(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);
}
export async function listOpenModels(conn, profile) {
    if (!profile.listModelsPath)
        return [];
    const { data } = await fetchJson(`${conn.baseUrl}${profile.listModelsPath}`, {
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
        await fetchJson(`${conn.baseUrl}${path}`, {
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
export function requireResponse(condition, message) {
    if (!condition)
        throw new AIError(message, { kind: 'invalid_response' });
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
    const value = row['capabilities'] ?? asRecord(row['architecture'])?.['modality'];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
        return value;
    if (typeof value === 'string')
        return [value];
    return undefined;
}
//# sourceMappingURL=base.js.map