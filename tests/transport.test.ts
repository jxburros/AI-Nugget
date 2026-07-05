import { describe, expect, it } from 'vitest';
import { ndjsonLines, sseLines, withTimeout } from '../src/index.js';

async function collectAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) result.push(item);
  return result;
}

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
    await expect(collectAsync(sseLines(res))).resolves.toEqual(['{"a":1}']);
  });

  it('reads buffered NDJSON lines', async () => {
    const res = new Response('{"a":1}\n{"b":2}\n');
    await expect(collectAsync(ndjsonLines(res))).resolves.toEqual([{ a: 1 }, { b: 2 }]);
  });
});
