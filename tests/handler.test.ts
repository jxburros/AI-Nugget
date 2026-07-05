import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, blocklistPolicy, memoryKeySource, type CallRecord, type ChatRequest } from '../src/index.js';

describe('AIHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records policy-denied calls without invoking adapters', async () => {
    const records: CallRecord[] = [];
    const handler = new AIHandler({
      keySource: memoryKeySource({}),
      policy: blocklistPolicy([/blocked/]),
      telemetry: { record: (record) => records.push(record) },
    });
    const events = await Array.fromAsync(handler.stream({ id: 'c1', provider: 'openai' }, req('blocked-model')));
    expect(events.at(-1)?.type).toBe('error');
    expect(records[0]?.error?.kind).toBe('policy_blocked');
  });

  it('retries retryable errors and redacts telemetry metadata', async () => {
    const records: CallRecord[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response('temporary sk-abcdefghijklmnopqrstuvwxyz', { status: 500 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":1},"choices":[]}\n\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
    const handler = new AIHandler({
      keySource: memoryKeySource({ OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz' }),
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      telemetry: { record: (record) => records.push(record) },
    });
    const events = await Array.fromAsync(handler.stream({ id: 'c1', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } }, {
      ...req('gpt-test'),
      metadata: { secret: 'sk-abcdefghijklmnopqrstuvwxyz' },
    }));
    expect(events.some((event) => event.type === 'retry')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});

function req(model: string): ChatRequest {
  return { model, messages: [{ role: 'user', content: 'hello' }] };
}
