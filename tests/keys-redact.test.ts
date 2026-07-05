import { describe, expect, it } from 'vitest';
import { createDefaultRedactor, memoryKeySource, parseKeyRef } from '../src/index.js';

describe('keys and redaction', () => {
  it('parses env, brokered, stored, none, and literal refs', () => {
    expect(parseKeyRef('${OPENAI_API_KEY}')).toEqual({ kind: 'env', name: 'OPENAI_API_KEY' });
    expect(parseKeyRef('$ANTHROPIC_API_KEY')).toEqual({ kind: 'env', name: 'ANTHROPIC_API_KEY' });
    expect(parseKeyRef('secret://provider/name')).toEqual({ kind: 'brokered', ref: 'secret://provider/name' });
    expect(parseKeyRef('stored://abc')).toEqual({ kind: 'stored', ref: 'abc' });
    expect(parseKeyRef('')).toEqual({ kind: 'none' });
    expect(parseKeyRef('sk-testliteral1234567890')).toEqual({ kind: 'literal', value: 'sk-testliteral1234567890' });
  });

  it('resolves memory keys and redacts known secret strings', async () => {
    const source = memoryKeySource({ OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz' });
    await expect(source.resolve({ kind: 'env', name: 'OPENAI_API_KEY' })).resolves.toEqual({ ok: true, apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' });
    expect(createDefaultRedactor(['plain-secret']).redact('token sk-abcdefghijklmnopqrstuvwxyz and plain-secret')).toBe('token [REDACTED] and [REDACTED]');
  });
});
