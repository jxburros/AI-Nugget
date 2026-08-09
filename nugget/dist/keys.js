import { globalEnv } from './util.js';
export function parseKeyRef(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return { kind: 'none' };
    const braced = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
    if (braced?.[1])
        return { kind: 'env', name: braced[1] };
    const dollar = /^\$([A-Z0-9_]+)$/.exec(trimmed);
    if (dollar?.[1])
        return { kind: 'env', name: dollar[1] };
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(trimmed))
        return { kind: 'env', name: trimmed };
    if (trimmed.startsWith('secret://'))
        return { kind: 'brokered', ref: trimmed };
    if (trimmed.startsWith('stored://'))
        return { kind: 'stored', ref: trimmed.slice('stored://'.length) };
    return { kind: 'literal', value: trimmed };
}
export function envKeySource(env = globalEnv()) {
    return {
        async resolve(ref) {
            if (ref.kind === 'none')
                return { ok: true, apiKey: null };
            if (ref.kind !== 'env')
                return { ok: false, reason: 'denied' };
            const apiKey = env[ref.name]?.trim();
            return apiKey ? { ok: true, apiKey } : { ok: false, reason: 'missing' };
        },
    };
}
export function literalKeySource() {
    return {
        async resolve(ref) {
            if (ref.kind === 'none')
                return { ok: true, apiKey: null };
            if (ref.kind === 'literal')
                return { ok: true, apiKey: ref.value };
            return { ok: false, reason: 'denied' };
        },
    };
}
export function memoryKeySource(values) {
    return {
        async resolve(ref) {
            if (ref.kind === 'none')
                return { ok: true, apiKey: null };
            if (ref.kind === 'literal')
                return { ok: true, apiKey: ref.value };
            const key = ref.kind === 'env' ? ref.name : ref.ref;
            const value = values[key]?.trim();
            return value ? { ok: true, apiKey: value } : { ok: false, reason: 'missing' };
        },
    };
}
export function chainKeySources(...sources) {
    return {
        async resolve(ref) {
            let missing = false;
            for (const source of sources) {
                const result = await source.resolve(ref);
                if (result.ok)
                    return result;
                if (result.reason === 'locked')
                    return result;
                if (result.reason === 'missing') {
                    missing = true;
                    continue;
                }
            }
            return missing ? { ok: false, reason: 'missing' } : { ok: false, reason: 'denied' };
        },
    };
}
//# sourceMappingURL=keys.js.map