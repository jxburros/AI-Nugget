import type { RateLimitInfo } from './types.js';
/**
 * Normalizes provider rate-limit response headers into {@link RateLimitInfo}:
 * the IETF `RateLimit` / `RateLimit-Policy` structured fields
 * (draft-ietf-httpapi-ratelimit-headers), OpenAI/Groq/Together-style
 * `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`, and Anthropic's
 * `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`. Returns
 * undefined when the response carries none of them. Never throws.
 */
export declare function parseRateLimitHeaders(headers: Headers | undefined): RateLimitInfo | undefined;
/**
 * Delay before retrying a throttled request: `retry-after-ms`, then
 * `Retry-After` (seconds or HTTP date), then — for a 429 only — the reset of
 * an exhausted rate-limit window.
 */
export declare function retryDelayFromHeaders(headers: Headers | undefined, status: number, rateLimit?: RateLimitInfo): number | undefined;
//# sourceMappingURL=ratelimit.d.ts.map