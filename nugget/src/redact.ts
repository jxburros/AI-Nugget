import type { Redactor } from './types.js';

const SECRET_PATTERNS: RegExp[] = [
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

export function createDefaultRedactor(extraSecrets: Iterable<string> = []): Redactor {
  const secrets = new Set([...extraSecrets].filter((value) => value.length >= 6));
  return {
    redact(text: string): string {
      let output = text;
      for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]');
      for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
      return output;
    },
  };
}

export class SessionRedactor implements Redactor {
  private secrets = new Set<string>();

  addSecret(value: string | null | undefined): void {
    if (value && value.length >= 6) this.secrets.add(value);
  }

  redact(text: string): string {
    return createDefaultRedactor(this.secrets).redact(text);
  }
}
