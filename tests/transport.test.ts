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

  it('fires an idle timeout when no bump() arrives, even though the total deadline is far off (F3)', async () => {
    const timeout = withTimeout(10_000, undefined, 10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(timeout.timedOut()).toBe(true);
    expect(timeout.signal.aborted).toBe(true);
    timeout.done();
  });

  it('bump() re-arms the idle timeout so periodic chunks keep a stream alive (F3)', async () => {
    const timeout = withTimeout(10_000, undefined, 25);
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      timeout.bump();
    }
    expect(timeout.timedOut()).toBe(false);
    expect(timeout.signal.aborted).toBe(false);
    timeout.done();
  });

  it('sseLines calls onChunk for every read from the wire (F3)', async () => {
    const res = new Response('data: {"a":1}\n\ndata: [DONE]\n');
    let chunks = 0;
    await collectAsync(sseLines(res, () => { chunks += 1; }));
    expect(chunks).toBeGreaterThan(0);
  });
});
