export function stableHash(input: string): string {
  // FNV-1a 32-bit, small and deterministic across runtimes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

export function makeId(prefix: string, seed: string): string {
  return `${prefix}_${stableHash(seed)}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Deliberately approximate. Context Nugget should not require tokenizer deps.
  return Math.ceil(text.length / 4);
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function metadataMatches(metadata: Record<string, unknown> | undefined, filters?: Record<string, unknown>): boolean {
  if (!filters) return true;
  for (const [key, expected] of Object.entries(filters)) {
    const actual = metadata?.[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
      continue;
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const expectedRecord = expected as { in?: unknown[]; exists?: boolean };
      if (expectedRecord.in && !expectedRecord.in.includes(actual)) return false;
      if (typeof expectedRecord.exists === 'boolean') {
        const exists = actual !== undefined && actual !== null;
        if (exists !== expectedRecord.exists) return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function daysSince(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 86_400_000);
}

export function recencyBoost(iso?: string, halfLifeDays = 30): number {
  const days = daysSince(iso);
  if (days === null) return 0;
  return Math.exp(-days / halfLifeDays);
}
