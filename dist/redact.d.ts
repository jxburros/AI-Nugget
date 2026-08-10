import type { Redactor } from './types.js';
/**
 * Prefixed secret formats. Each pattern is anchored on a vendor prefix that is
 * distinctive enough that a match is a secret, not a coincidence.
 */
export declare const SECRET_PATTERNS: RegExp[];
/**
 * Unprefixed/opaque secrets — Azure OpenAI `api-key` values, AWS *secret*
 * access keys, generic bearer/session tokens — carry no distinctive prefix, so
 * matching them on shape alone would redact commit SHAs, content hashes, and
 * base64 payloads. These patterns instead anchor on the *label* that precedes
 * the value (`api-key: …`, `"aws_secret_access_key": "…"`, `password=…`) and
 * redact only the value, keeping the label readable in logs.
 *
 * Exact-match registration (`SessionRedactor.addSecret`, which the handler does
 * for every resolved key) remains the only guaranteed catch for a bare,
 * unlabeled, unprefixed secret.
 */
export declare const LABELED_SECRET_PATTERNS: RegExp[];
export declare function createDefaultRedactor(extraSecrets?: Iterable<string>): Redactor;
export declare class SessionRedactor implements Redactor {
    private secrets;
    addSecret(value: string | null | undefined): void;
    redact(text: string): string;
}
//# sourceMappingURL=redact.d.ts.map