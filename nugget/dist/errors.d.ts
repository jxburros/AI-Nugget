import type { AIErrorKind, RateLimitInfo } from './types.js';
export declare class AIError extends Error {
    kind: AIErrorKind;
    status?: number;
    retryable: boolean;
    provider?: string;
    raw?: string;
    retryAfterMs?: number;
    /** Rate-limit headers the provider sent with this failure, normalized. */
    rateLimit?: RateLimitInfo;
    constructor(message: string, opts: {
        kind: AIErrorKind;
        status?: number;
        retryable?: boolean;
        provider?: string;
        raw?: string;
        retryAfterMs?: number;
        rateLimit?: RateLimitInfo;
        cause?: unknown;
    });
}
export declare function defaultRetryable(kind: AIErrorKind): boolean;
export declare function classify(status: number, body?: string, provider?: string, headers?: Headers): AIError;
export declare function fromUnknown(error: unknown, provider?: string): AIError;
//# sourceMappingURL=errors.d.ts.map