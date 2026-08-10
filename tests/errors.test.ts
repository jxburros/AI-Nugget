import { describe, expect, it } from 'vitest';
import { AIError, classify, fromUnknown } from '../src/index.js';

describe('classify(status, body)', () => {
  it('maps HTTP statuses to typed kinds with correct retryability', () => {
    expect(classify(401, 'bad key')).toMatchObject({ kind: 'auth', status: 401, retryable: false });
    expect(classify(403, 'forbidden')).toMatchObject({ kind: 'auth', retryable: false });
    expect(classify(408, 'timeout')).toMatchObject({ kind: 'timeout', retryable: true });
    expect(classify(429, 'slow down')).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(classify(500, 'oops')).toMatchObject({ kind: 'server', retryable: true });
    expect(classify(503, 'unavailable')).toMatchObject({ kind: 'server', retryable: true });
  });

  it('distinguishes context-length from generic invalid_request on 400/422', () => {
    expect(classify(400, 'maximum context length exceeded')).toMatchObject({ kind: 'context_length', retryable: false });
    expect(classify(400, 'missing field model')).toMatchObject({ kind: 'invalid_request', retryable: false });
    expect(classify(422, 'unprocessable')).toMatchObject({ kind: 'invalid_request' });
  });

  it('parses Retry-After seconds and truncates the raw body to 2000 chars', () => {
    const headers = new Headers({ 'retry-after': '3' });
    const error = classify(429, 'x'.repeat(3000), 'openai', headers);
    expect(error.retryAfterMs).toBe(3000);
    expect(error.raw?.length).toBe(2000);
    expect(error.provider).toBe('openai');
  });

  it('extracts code and details from a structured { error: { code, details } } body', () => {
    const body = JSON.stringify({
      error: {
        code: 'MODEL_NOT_FOUND',
        message: "No model with id 'x' is registered.",
        details: { repair: { summary: 'No usable inference engine.', actions: [{ id: 'install-backend', method: 'POST', path: '/runtime/backend/install' }] } },
      },
    });
    const error = classify(404, body, 'openai-compat');
    expect(error.code).toBe('MODEL_NOT_FOUND');
    expect(error.details).toEqual({ repair: { summary: 'No usable inference engine.', actions: [{ id: 'install-backend', method: 'POST', path: '/runtime/backend/install' }] } });
  });

  it('leaves code and details undefined for a plain-text or codeless body', () => {
    expect(classify(500, 'internal server error').code).toBeUndefined();
    expect(classify(500, 'internal server error').details).toBeUndefined();
    expect(classify(400, JSON.stringify({ error: { message: 'bad request' } })).code).toBeUndefined();
  });

  it('does not attempt to parse an oversized body for code/details', () => {
    const error = classify(500, JSON.stringify({ error: { code: 'X', details: 'y'.repeat(25_000) } }));
    expect(error.code).toBeUndefined();
    expect(error.details).toBeUndefined();
  });
});

describe('fromUnknown()', () => {
  it('passes an existing AIError through untouched', () => {
    const original = new AIError('boom', { kind: 'server', retryable: true });
    expect(fromUnknown(original)).toBe(original);
  });

  it('maps AbortError to canceled (non-retryable)', () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    expect(fromUnknown(abort)).toMatchObject({ kind: 'canceled', retryable: false });
  });

  it('maps timeout-worded and generic network errors', () => {
    expect(fromUnknown(new Error('request timed out'))).toMatchObject({ kind: 'timeout', retryable: true });
    expect(fromUnknown(new Error('ECONNRESET'))).toMatchObject({ kind: 'network', retryable: true });
    expect(fromUnknown('weird')).toMatchObject({ kind: 'network' });
  });
});
