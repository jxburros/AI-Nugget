import { describe, expect, it } from 'vitest';
import { ndjsonLines, sseLines, withTimeout } from '../src/index.js';

describe('transport primitives', () => {
  it('merges external aborts and cleans up', () => {
    const external = new AbortController();
    const timeout = withTimeout(10_000, external.signal);
    external.abort();
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timedOut()).toBe(false);
    timeout.done();
  });

  it('reads SSE data lines', async () => {
    const res = new Response('event: message\ndata: {"a":1}\n\ndata: [DONE]\n');
    await expect(Array.fromAsync(sseLines(res))).resolves.toEqual(['{"a":1}']);
  });

  it('reads buffered NDJSON lines', async () => {
    const res = new Response('{"a":1}\n{"b":2}\n');
    await expect(Array.fromAsync(ndjsonLines(res))).resolves.toEqual([{ a: 1 }, { b: 2 }]);
  });
});
