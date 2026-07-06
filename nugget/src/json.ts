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
    for (const span of balancedSpans(text, open, close)) {
      const parsed = tryParse(span);
      if (parsed.ok) return parsed.value;
    }
  }
  return null;
}

/**
 * Yields each top-level `open`/`close` balanced substring of `text`, tracking
 * nesting depth and skipping over string-literal content (including escapes)
 * so a stray brace inside a string or trailing prose can't prematurely close
 * or extend a span. Used instead of first-`indexOf`/last-`lastIndexOf` so
 * multiple JSON regions (or JSON followed by unrelated braces) don't get
 * spliced into one bogus span.
 */
function* balancedSpans(text: string, open: string, close: string): Generator<string> {
  let depth = 0;
  let spanStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      if (depth === 0) spanStart = i;
      depth += 1;
      continue;
    }
    if (ch === close && depth > 0) {
      depth -= 1;
      if (depth === 0 && spanStart >= 0) {
        yield text.slice(spanStart, i + 1);
        spanStart = -1;
      }
    }
  }
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
