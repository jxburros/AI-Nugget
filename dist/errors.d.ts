import type { AIErrorKind } from './types.js';
export declare class AIError extends Error {
    kind: AIErrorKind;
    status?: number;
    retryable: boolean;
    provider?: string;
    raw?: string;
    /** Machine-readable error code from a structured `{ error: { code, ... } }` body (e.g. OpenAI/JX Runtime `error.code`), when the body parses as JSON and carries one. */
    code?: string;
    /** The provider's `error.details` value, when present — e.g. JX Runtime's `RATE_LIMITED` `retryAfterSeconds` or its guided-repair `{ summary, actions }` plan. Already redacted, but still provider-shaped: treat it as a hint, not a stable contract. */
    details?: unknown;
    retryAfterMs?: number;
    constructor(message: string, opts: {
        kind: AIErrorKind;
        status?: number;
        retryable?: boolean;
        provider?: string;
        raw?: string;
        code?: string;
        details?: unknown;
        retryAfterMs?: number;
        cause?: unknown;
    });
}
export declare function defaultRetryable(kind: AIErrorKind): boolean;
export declare function classify(status: number, body?: string, provider?: string, headers?: Headers): AIError;
export declare function fromUnknown(error: unknown, provider?: string): AIError;
//# sourceMappingURL=errors.d.ts.map