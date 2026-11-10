/**
 * Normalizes provider rate-limit response headers into {@link RateLimitInfo}:
 * the IETF `RateLimit` / `RateLimit-Policy` structured fields
 * (draft-ietf-httpapi-ratelimit-headers), OpenAI/Groq/Together-style
 * `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`, and Anthropic's
 * `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`. Returns
 * undefined when the response carries none of them. Never throws.
 */
export function parseRateLimitHeaders(headers) {
    if (!headers)
        return undefined;
    const info = {};
    const resets = [];
    const exhaustedResets = [];
    const policies = parseIetf(headers.get('ratelimit'), headers.get('ratelimit-policy'));
    if (policies.length) {
        info.policies = policies;
        for (const policy of policies) {
            if (policy.resetSeconds === undefined)
                continue;
            resets.push(policy.resetSeconds * 1000);
            if (policy.remaining === 0)
                exhaustedResets.push(policy.resetSeconds * 1000);
        }
    }
    for (const [kind, field] of [['requests', 'Requests'], ['tokens', 'Tokens']]) {
        const limit = num(headers.get(`x-ratelimit-limit-${kind}`)) ?? num(headers.get(`anthropic-ratelimit-${kind}-limit`));
        const remaining = num(headers.get(`x-ratelimit-remaining-${kind}`)) ?? num(headers.get(`anthropic-ratelimit-${kind}-remaining`));
        const reset = duration(headers.get(`x-ratelimit-reset-${kind}`)) ?? timestamp(headers.get(`anthropic-ratelimit-${kind}-reset`));
        if (limit !== undefined)
            info[`limit${field}`] = limit;
        if (remaining !== undefined)
            info[`remaining${field}`] = remaining;
        if (reset !== undefined) {
            resets.push(reset);
            if (remaining === 0)
                exhaustedResets.push(reset);
        }
    }
    const candidates = exhaustedResets.length ? exhaustedResets : resets;
    if (candidates.length)
        info.resetMs = Math.max(0, exhaustedResets.length ? Math.max(...candidates) : Math.min(...candidates));
    return Object.keys(info).length ? info : undefined;
}
/**
 * Delay before retrying a throttled request: `retry-after-ms`, then
 * `Retry-After` (seconds or HTTP date), then — for a 429 only — the reset of
 * an exhausted rate-limit window.
 */
export function retryDelayFromHeaders(headers, status, rateLimit) {
    const ms = num(headers?.get('retry-after-ms') ?? null);
    if (ms !== undefined)
        return Math.max(0, ms);
    const retryAfter = headers?.get('retry-after');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds))
            return Math.max(0, seconds * 1000);
        const time = Date.parse(retryAfter);
        if (!Number.isNaN(time))
            return Math.max(0, time - Date.now());
    }
    if (status === 429 && rateLimit?.resetMs !== undefined)
        return rateLimit.resetMs;
    return undefined;
}
/** Minimal RFC 9651 list parsing for `"name";r=1;t=2, "other";…` items. */
function parseIetf(limits, policyHeader) {
    if (!limits)
        return [];
    const quotas = new Map();
    for (const item of listItems(policyHeader)) {
        quotas.set(item.name, { quota: num(item.params.q), windowSeconds: num(item.params.w), unit: item.params.qu });
    }
    const out = [];
    for (const item of listItems(limits)) {
        const remaining = num(item.params.r);
        if (remaining === undefined)
            continue;
        const policy = { name: item.name, remaining };
        const reset = num(item.params.t);
        if (reset !== undefined)
            policy.resetSeconds = reset;
        const quota = quotas.get(item.name);
        if (quota?.quota !== undefined)
            policy.quota = quota.quota;
        if (quota?.windowSeconds !== undefined)
            policy.windowSeconds = quota.windowSeconds;
        if (quota?.unit !== undefined)
            policy.unit = quota.unit;
        out.push(policy);
    }
    return out;
}
function listItems(value) {
    if (!value)
        return [];
    const items = [];
    for (const raw of value.split(',')) {
        const [head, ...rest] = raw.split(';').map((part) => part.trim());
        if (!head)
            continue;
        const params = {};
        for (const param of rest) {
            const eq = param.indexOf('=');
            if (eq > 0)
                params[param.slice(0, eq).trim()] = param.slice(eq + 1).trim().replace(/^"|"$/g, '');
        }
        items.push({ name: head.replace(/^"|"$/g, ''), params });
    }
    return items;
}
function num(value) {
    if (value === null || value === undefined || value.trim() === '')
        return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
/** OpenAI-style reset durations: `1s`, `6m0s`, `20ms`, `1h2m3.5s`, or bare seconds. */
function duration(value) {
    if (!value)
        return undefined;
    const bare = num(value);
    if (bare !== undefined)
        return bare * 1000;
    let total = 0;
    let matched = false;
    for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
        matched = true;
        const n = Number(amount);
        total += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
    }
    return matched ? Math.round(total) : undefined;
}
/** Anthropic-style RFC 3339 reset timestamps. */
function timestamp(value) {
    if (!value)
        return undefined;
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : Math.max(0, time - Date.now());
}
//# sourceMappingURL=ratelimit.js.map