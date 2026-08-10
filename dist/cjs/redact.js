"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionRedactor = exports.LABELED_SECRET_PATTERNS = exports.SECRET_PATTERNS = void 0;
exports.createDefaultRedactor = createDefaultRedactor;
/**
 * Prefixed secret formats. Each pattern is anchored on a vendor prefix that is
 * distinctive enough that a match is a secret, not a coincidence.
 */
exports.SECRET_PATTERNS = [
    /sk-[A-Za-z0-9_-]{20,}/g,
    /sk-proj-[A-Za-z0-9_-]{20,}/g,
    /sk-ant-[A-Za-z0-9_-]{20,}/g,
    /AIza[0-9A-Za-z_-]{20,}/g,
    /gsk_[0-9A-Za-z_-]{20,}/g,
    /xai-[0-9A-Za-z_-]{20,}/g,
    /hf_[0-9A-Za-z]{20,}/g,
    /nvapi-[0-9A-Za-z_-]{20,}/g,
    /ghp_[0-9A-Za-z_]{20,}/g,
    /github_pat_[0-9A-Za-z_]{20,}/g,
    /glpat-[0-9A-Za-z_-]{20,}/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
    /xox[baprs]-[0-9A-Za-z-]{10,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /ASIA[0-9A-Z]{16}/g,
    /SG\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g,
    /rk_live_[0-9A-Za-z]{20,}/g,
    /pk_live_[0-9A-Za-z]{20,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
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
exports.LABELED_SECRET_PATTERNS = [
    new RegExp(
    // Lookbehind rather than `\b` so an underscore-joined prefix still matches
    // the label (`aws_secret_access_key`, `azure_api_key`).
    String.raw `(?<![A-Za-z0-9])(api[_-]?key|apikey|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|session[_-]?token|client[_-]?secret|refresh[_-]?token|private[_-]?key|password|passwd)` +
        // Optional closing quote handles JSON keys (`"api_key": "…"`).
        String.raw `(["']?\s*[:=]\s*|\s+)` +
        String.raw `(["']?)([A-Za-z0-9/+_.~-]{16,}={0,2})\3`, 'gi'),
];
function createDefaultRedactor(extraSecrets = []) {
    const secrets = new Set([...extraSecrets].filter((value) => value.length >= 6));
    return {
        redact(text) {
            let output = text;
            for (const pattern of exports.SECRET_PATTERNS)
                output = output.replace(pattern, '[REDACTED]');
            for (const pattern of exports.LABELED_SECRET_PATTERNS) {
                output = output.replace(pattern, (_match, label, separator, quote) => `${label}${separator}${quote}[REDACTED]${quote}`);
            }
            for (const secret of secrets)
                output = output.split(secret).join('[REDACTED]');
            return output;
        },
    };
}
class SessionRedactor {
    secrets = new Set();
    addSecret(value) {
        if (value && value.length >= 6)
            this.secrets.add(value);
    }
    redact(text) {
        return createDefaultRedactor(this.secrets).redact(text);
    }
}
exports.SessionRedactor = SessionRedactor;
