import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIError, fetchJson, ndjsonLines, postResponse, sseLines, textLines, withTimeout } from '../src/index.js';
import { jsonResponse, mockFetch, textResponse } from './helpers.js';

async function collectAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) result.push(item);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('merges external aborts and cleans up', () => {
    const external = new AbortController();
    const timeout = withTimeout(10_000, external.signal);
    external.abort();
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timedOut()).toBe(false);
    timeout.done();
  });

  it('aborts with a timeout reason when the total deadline fires', async () => {
    vi.useFakeTimers();
    const timeout = withTimeout(1_000);
    expect(timeout.timedOut()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(timeout.timedOut()).toBe(true);
    expect(timeout.signal.aborted).toBe(true);
    expect((timeout.signal.reason as AIError).kind).toBe('timeout');
    timeout.done();
  });

  it('fires the idle timeout when no chunk arrives', async () => {
    vi.useFakeTimers();
    const timeout = withTimeout(60_000, undefined, 500);
    await vi.advanceTimersByTimeAsync(501);
    expect(timeout.timedOut()).toBe(true);
    expect((timeout.signal.reason as AIError).message).toContain('idle');
    timeout.done();
  });

  it('rearms the idle timer on every bump, so a slow but healthy stream survives', async () => {
    vi.useFakeTimers();
    const timeout = withTimeout(60_000, undefined, 500);
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(400);
      expect(timeout.timedOut()).toBe(false);
      timeout.bump();
    }
    // Total elapsed is 2s — well past `idleMs` — but no single gap exceeded it.
    await vi.advanceTimersByTimeAsync(400);
    expect(timeout.timedOut()).toBe(false);
    // Now stop bumping and let the gap run past the idle ceiling.
    await vi.advanceTimersByTimeAsync(200);
    expect(timeout.timedOut()).toBe(true);
    timeout.done();
  });

  it('stops both timers after done(), so a completed call cannot abort later', async () => {
    vi.useFakeTimers();
    const timeout = withTimeout(1_000, undefined, 500);
    timeout.done();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(timeout.timedOut()).toBe(false);
    expect(timeout.signal.aborted).toBe(false);
  });
});

describe('fetchJson', () => {
  it('classifies a non-2xx body into a typed AIError', async () => {
    mockFetch(jsonResponse({ error: { message: 'nope' } }, 429, { 'retry-after': '2' }));
    const error = await fetchJson('https://api.test/v1/models', { timeoutMs: 1_000, provider: 'openai' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).kind).toBe('rate_limit');
    expect((error as AIError).status).toBe(429);
    expect((error as AIError).retryAfterMs).toBe(2_000);
  });

  it('maps 404 to not_found rather than invalid_request', async () => {
    mockFetch(textResponse('no such deployment', 404));
    const error = await fetchJson('https://api.test/v1/models', { timeoutMs: 1_000, provider: 'openai' }).catch((e: unknown) => e);
    expect((error as AIError).kind).toBe('not_found');
  });

  it('falls back to a { text } wrapper for a non-JSON 2xx body', async () => {
    mockFetch(textResponse('plain text, not json', 200));
    const { data, status } = await fetchJson('https://api.test/v1/models', { timeoutMs: 1_000 });
    expect(status).toBe(200);
    expect(data).toEqual({ text: 'plain text, not json' });
  });

  it('returns null data for an empty body', async () => {
    mockFetch(textResponse('', 200));
    await expect(fetchJson('https://api.test/v1/models', { timeoutMs: 1_000 })).resolves.toMatchObject({ data: null });
  });

  it('reports a hung request as a timeout error, not a generic abort', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init: RequestInit = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const error = await fetchJson('https://api.test/v1/models', { timeoutMs: 20, provider: 'openai' }).catch((e: unknown) => e);
    expect((error as AIError).kind).toBe('timeout');
    expect((error as AIError).message).toContain('20ms');
  });

  it('redacts a secret echoed back in the provider error body', async () => {
    mockFetch(textResponse('bad key sk-abcdefghijklmnopqrstuvwxyz0123', 401));
    const error = await fetchJson('https://api.test/v1/models', { timeoutMs: 1_000, provider: 'openai' }).catch((e: unknown) => e);
    expect((error as AIError).message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect((error as AIError).raw).toContain('[REDACTED]');
  });
});

describe('postResponse', () => {
  it('classifies a non-2xx response before handing back a body', async () => {
    mockFetch(jsonResponse({ error: 'server exploded' }, 503));
    const controller = new AbortController();
    const error = await postResponse('https://api.test/v1/chat/completions', { a: 1 }, {}, controller.signal, 'openai').catch((e: unknown) => e);
    expect((error as AIError).kind).toBe('server');
    expect((error as AIError).retryable).toBe(true);
  });

  it('normalizes a transport-level failure through fromUnknown', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const controller = new AbortController();
    const error = await postResponse('https://api.test/v1/chat/completions', {}, {}, controller.signal, 'openai').catch((e: unknown) => e);
    expect((error as AIError).kind).toBe('network');
    expect((error as AIError).provider).toBe('openai');
  });

  it('returns the raw response for a 2xx so the caller can stream it', async () => {
    mockFetch(textResponse('data: {"a":1}\n\n', 200, { 'content-type': 'text/event-stream' }));
    const controller = new AbortController();
    const res = await postResponse('https://api.test/v1/chat/completions', {}, {}, controller.signal, 'openai');
    expect(res.ok).toBe(true);
    await expect(collectAsync(sseLines(res))).resolves.toEqual(['{"a":1}']);
  });
});

describe('line readers', () => {
  it('reads SSE data lines', async () => {
    const res = new Response('event: message\ndata: {"a":1}\n\ndata: [DONE]\n');
    await expect(collectAsync(sseLines(res))).resolves.toEqual(['{"a":1}']);
  });

  it('reads buffered NDJSON lines', async () => {
    const res = new Response('{"a":1}\n{"b":2}\n');
    await expect(collectAsync(ndjsonLines(res))).resolves.toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('throws invalid_response on malformed NDJSON', async () => {
    const res = new Response('{"a":1}\nnot json at all\n');
    const error = await collectAsync(ndjsonLines(res)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).kind).toBe('invalid_response');
    expect((error as AIError).retryable).toBe(true);
  });

  it('falls back to buffered text when a response has no body stream', async () => {
    // A Response whose `body` getter is null — some runtimes/proxies do this for
    // fully-buffered replies; textLines must still yield the lines.
    const res = new Response('line one\nline two\n');
    Object.defineProperty(res, 'body', { get: () => null });
    await expect(collectAsync(textLines(res))).resolves.toEqual(['line one', 'line two', '']);
  });

  it('yields a trailing line that has no newline terminator', async () => {
    const res = new Response('first\nsecond-without-newline');
    await expect(collectAsync(textLines(res))).resolves.toEqual(['first', 'second-without-newline']);
  });
});
