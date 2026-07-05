import { AIError } from './errors.js';

export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed.ok) return parsed.value;
  }

  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const parsed = tryParse(text.slice(start, end + 1));
      if (parsed.ok) return parsed.value;
    }
  }
  return null;
}

export function extractJsonWithSchema<T>(text: string, parse: (value: unknown) => T): T {
  const value = extractJson(text);
  if (value === null) throw new AIError('No JSON object or array found in model output', { kind: 'invalid_response' });
  try {
    return parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'JSON did not match expected schema';
    throw new AIError(message, { kind: 'invalid_response', cause: error });
  }
}

export function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`);
  return value;
}

export function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected ${key} to be a number`);
  return value;
}

export function requireStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Expected ${key} to be a string array`);
  }
  return value;
}

export function requireOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string when present`);
  return value;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
