const SECRET_PATTERNS = [
    /sk-[A-Za-z0-9_-]{20,}/g,
    /sk-ant-[A-Za-z0-9_-]{20,}/g,
    /AIza[0-9A-Za-z_-]{20,}/g,
    /ghp_[0-9A-Za-z_]{20,}/g,
    /github_pat_[0-9A-Za-z_]{20,}/g,
    /glpat-[0-9A-Za-z_-]{20,}/g,
    /xox[baprs]-[0-9A-Za-z-]{10,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /ASIA[0-9A-Z]{16}/g,
    /SG\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g,
    /rk_live_[0-9A-Za-z]{20,}/g,
    /pk_live_[0-9A-Za-z]{20,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
export function createDefaultRedactor(extraSecrets = []) {
    const secrets = new Set([...extraSecrets].filter((value) => value.length >= 6));
    return {
        redact(text) {
            let output = text;
            for (const pattern of SECRET_PATTERNS)
                output = output.replace(pattern, '[REDACTED]');
            for (const secret of secrets)
                output = output.split(secret).join('[REDACTED]');
            return output;
        },
    };
}
export class SessionRedactor {
    secrets = new Set();
    addSecret(value) {
        if (value && value.length >= 6)
            this.secrets.add(value);
    }
    redact(text) {
        return createDefaultRedactor(this.secrets).redact(text);
    }
}
//# sourceMappingURL=redact.js.map