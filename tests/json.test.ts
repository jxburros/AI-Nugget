import { describe, expect, it } from 'vitest';
import { extractJson, extractJsonWithSchema, requireString } from '../src/index.js';

describe('extractJson', () => {
  it('parses direct objects, fenced objects, and array slices', () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true });
    expect(extractJson('Here:\n```json\n{"name":"Bob"}\n```')).toEqual({ name: 'Bob' });
    expect(extractJson('prefix [1,2,3] suffix')).toEqual([1, 2, 3]);
  });

  it('handles Blobsmith edge cases: bare fences, prose-embedded objects, and no-match', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('The answer is {"score": 5, "note": "ok"} — done.')).toEqual({ score: 5, note: 'ok' });
    expect(extractJson('no json here at all')).toBeNull();
    expect(extractJson('')).toBeNull();
    // prefers a valid direct parse over slicing
    expect(extractJson('[{"x":1}]')).toEqual([{ x: 1 }]);
  });

  it('is nesting-aware: does not splice across unrelated braces or braces inside strings', () => {
    // A stray closing brace in trailing prose must not extend the span past the real object.
    expect(extractJson('{"tool":"echo","input":{"msg":"hi"}} (note: see {this} for context)')).toEqual({ tool: 'echo', input: { msg: 'hi' } });
    // Two separate JSON objects: the first balanced, parseable span wins.
    expect(extractJson('noise {"a":1} more noise {"b":2} trailing')).toEqual({ a: 1 });
    // A brace embedded inside a string literal must not be treated as structural.
    expect(extractJson('prefix {"text":"a { b } c"} suffix')).toEqual({ text: 'a { b } c' });
  });

  it('validates with schema helpers', () => {
    const value = extractJsonWithSchema('{"name":"Ada"}', (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected object');
      return requireString(raw as Record<string, unknown>, 'name');
    });
    expect(value).toBe('Ada');
  });
});
