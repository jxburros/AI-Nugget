import { describe, expect, it } from 'vitest';
import { extractJson, extractJsonWithSchema, requireString } from '../src/index.js';

describe('extractJson', () => {
  it('parses direct objects, fenced objects, and array slices', () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true });
    expect(extractJson('Here:\n```json\n{"name":"Bob"}\n```')).toEqual({ name: 'Bob' });
    expect(extractJson('prefix [1,2,3] suffix')).toEqual([1, 2, 3]);
  });

  it('validates with schema helpers', () => {
    const value = extractJsonWithSchema('{"name":"Ada"}', (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected object');
      return requireString(raw as Record<string, unknown>, 'name');
    });
    expect(value).toBe('Ada');
  });
});
