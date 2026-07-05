import { AIError } from '../../errors.js';
import { fetchJson } from '../../transport.js';
import { asRecord, asString } from '../../util.js';
export async function listOpenModels(conn, profile) {
    if (!profile.listModelsPath)
        return [];
    const { data } = await fetchJson(`${conn.baseUrl}${profile.listModelsPath}`, {
        method: 'GET',
        headers: conn.headers,
        timeoutMs: conn.timeoutMs ?? 120_000,
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
        models.push({
            id,
            source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
        });
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
            timeoutMs: Math.min(conn.timeoutMs ?? 120_000, 10_000),
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
//# sourceMappingURL=base.js.map