import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, memoryKeySource, type CallRecord, type ChatRequest, type Connection, type StreamEvent } from '../src/index.js';
import { jsonResponse, mockFetch, sseResponse, streamingResponse, textResponse } from './helpers.js';

const req: ChatRequest = { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] };
const openaiConn = (over: Partial<Connection> = {}): Connection => ({ id: 'c1', provider: 'openai', keyRef: { kind: 'none' }, ...over });

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('AIHandler pipeline', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records a key-unavailable failure without calling the adapter', async () => {
    const records: CallRecord[] = [];
    const spy = vi.spyOn(globalThis, 'fetch');
    const handler = new AIHandler({ keySource: memoryKeySource({}), telemetry: { record: (r) => records.push(r) } });
    const events = await collect(handler.stream(openaiConn({ keyRef: { kind: 'env', name: 'MISSING_KEY' } }), req));
    expect(events.at(-1)?.type).toBe('error');
    expect((events.at(-1) as any).error.kind).toBe('key_unavailable');
    expect(records).toHaveLength(1);
    expect(records[0]?.error?.kind).toBe('key_unavailable');
    expect(spy).not.toHaveBeenCalled();
  });

  it('short-circuits when a beforeCall hook denies the call', async () => {
    const records: CallRecord[] = [];
    const handler = new AIHandler({
      keySource: memoryKeySource({}),
      hooks: { beforeCall: async () => 'deny' },
      telemetry: { record: (r) => records.push(r) },
    });
    const events = await collect(handler.stream(openaiConn(), req));
    expect((events.at(-1) as any).error.kind).toBe('policy_blocked');
    expect(records).toHaveLength(1);
    expect(records[0]?.error?.kind).toBe('policy_blocked');
  });

  it('honors Retry-After over the exponential backoff base', async () => {
    mockFetch(
      textResponse('rate limited', 429, { 'retry-after': '0' }),
      sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );
    const handler = new AIHandler({ keySource: memoryKeySource({}), retry: { maxAttempts: 2, baseDelayMs: 5000, maxDelayMs: 5000 } });
    const events = await collect(handler.stream(openaiConn(), req));
    const retry = events.find((e) => e.type === 'retry');
    expect(retry).toBeDefined();
    expect((retry as any).reason).toBe('rate_limit');
    expect((retry as any).delayMs).toBe(0); // Retry-After: 0 beats the 5000ms base
    expect(events.at(-1)?.type).toBe('done');
  });

  it('emits exactly one CallRecord per call, success included', async () => {
    const records: CallRecord[] = [];
    mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, { usage: { prompt_tokens: 3, completion_tokens: 1 }, choices: [] }]));
    const handler = new AIHandler({ keySource: memoryKeySource({}), telemetry: { record: (r) => records.push(r) } });
    await handler.chat(openaiConn(), req);
    expect(records).toHaveLength(1);
    expect(records[0]?.finishReason).toBe('stop');
    expect(records[0]?.promptChars).toBeGreaterThan(0);
    expect(records[0]?.responseChars).toBe(2);
    expect(records[0]?.usage).toEqual({ inputTokens: 3, outputTokens: 1, estimated: false });
  });

  it('does not re-execute a successful provider call when telemetry or afterCall throws', async () => {
    const records: CallRecord[] = [];
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    const handler = new AIHandler({
      keySource: memoryKeySource({}),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      telemetry: { record: (r) => { records.push(r); throw new Error('telemetry sink down'); } },
      hooks: { afterCall: async () => { throw new Error('audit hook down'); } },
    });
    await expect(handler.chat(openaiConn(), req)).resolves.toMatchObject({ text: 'ok' });
    expect(calls).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  it('records success before yielding done so consumers can break at the terminal event', async () => {
    const records: CallRecord[] = [];
    mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    const handler = new AIHandler({ keySource: memoryKeySource({}), telemetry: { record: (r) => records.push(r) } });
    const iterator = handler.stream(openaiConn(), req)[Symbol.asyncIterator]();
    await iterator.next(); // start
    await iterator.next(); // delta
    const done = await iterator.next();
    expect(done.value?.type).toBe('done');
    expect(records).toHaveLength(1);
    await iterator.return?.();
  });

  it('does not retry after user-visible stream output has been emitted', async () => {
    const records: CallRecord[] = [];
    let sent = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          return;
        }
        controller.error(new Error('connection reset'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const handler = new AIHandler({
      keySource: memoryKeySource({}),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      telemetry: { record: (r) => records.push(r) },
    });
    const events = await collect(handler.stream(openaiConn(), req));
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('error');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.finishReason).toBe('error');
  });

  it('removes aborted queued waiters so later calls are not stranded', async () => {
    const first = new AbortController();
    const second = new AbortController();
    let fetches = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init: RequestInit = {}) => {
      fetches += 1;
      if (fetches === 1) {
        return streamingResponse(['data: {"choices":[{"delta":{"content":"held"}}]}\n\n'], { signal: init.signal ?? undefined, hangUntilAbort: true });
      }
      return sseResponse([{ choices: [{ delta: { content: 'third' }, finish_reason: 'stop' }] }]);
    });
    const handler = new AIHandler({ keySource: memoryKeySource({}), limits: { maxConcurrent: 1 } });
    const firstRun = collect(handler.stream(openaiConn(), { ...req, signal: first.signal }));
    await waitFor(() => fetches === 1);
    const secondRun = collect(handler.stream(openaiConn(), { ...req, signal: second.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.abort();
    const thirdRun = handler.chat(openaiConn(), req);
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.abort();
    await expect(firstRun).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error' })]));
    await expect(secondRun).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error' })]));
    await expect(thirdRun).resolves.toMatchObject({ text: 'third' });
    expect(fetches).toBe(2);
  });

  it('never lets non-serializable metadata crash the telemetry path', async () => {
    const records: CallRecord[] = [];
    mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    const handler = new AIHandler({ keySource: memoryKeySource({}), telemetry: { record: (r) => records.push(r) } });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await handler.chat(openaiConn(), { ...req, metadata: circular });
    expect(records).toHaveLength(1);
    expect(records[0]?.metadata).toEqual({ redacted: true, note: 'metadata was not JSON-serializable' });
  });

  it('enforces maxConcurrent so calls do not overlap', async () => {
    let inflight = 0;
    let maxInflight = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    });
    const handler = new AIHandler({ keySource: memoryKeySource({}), limits: { maxConcurrent: 1 } });
    await Promise.all([
      handler.chat(openaiConn(), req),
      handler.chat(openaiConn(), req),
      handler.chat(openaiConn(), req),
    ]);
    expect(maxInflight).toBe(1);
  });

  it('paces concurrent callers without exceeding maxConcurrent during minInterval waits', async () => {
    let inflight = 0;
    let maxInflight = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight -= 1;
      return sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    });
    const handler = new AIHandler({ keySource: memoryKeySource({}), limits: { maxConcurrent: 1, minIntervalMs: 5 } });
    await Promise.all([handler.chat(openaiConn(), req), handler.chat(openaiConn(), req)]);
    expect(maxInflight).toBe(1);
  });

  it('reports a healthy connection via listModels through testConnection', async () => {
    const records: CallRecord[] = [];
    mockFetch(jsonResponse({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }));
    const handler = new AIHandler({ keySource: memoryKeySource({}), telemetry: { record: (r) => records.push(r) } });
    const result = await handler.testConnection(openaiConn());
    expect(result.ok).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]?.model).toBe('__testConnection__');
  });

  it('lists models with source provenance', async () => {
    const records: CallRecord[] = [];
    mockFetch(jsonResponse({ data: [{ id: 'gpt-x' }] }));
    const handler = new AIHandler({ keySource: memoryKeySource({}), telemetry: { record: (r) => records.push(r) } });
    const models = await handler.listModels(openaiConn());
    expect(models[0]).toEqual({ id: 'gpt-x', source: { provider: 'openai', connectionId: 'c1', baseUrl: 'https://api.openai.com/v1' } });
    expect(records).toHaveLength(1);
    expect(records[0]?.model).toBe('__listModels__');
  });

  it('applies policy and beforeCall hooks to model probes', async () => {
    const records: CallRecord[] = [];
    const handler = new AIHandler({
      keySource: memoryKeySource({}),
      policy: { checkModel: () => ({ allowed: false, reason: 'no probes' }) },
      telemetry: { record: (r) => records.push(r) },
    });
    await expect(handler.listModels(openaiConn())).rejects.toMatchObject({ kind: 'policy_blocked' });
    expect(records).toHaveLength(1);
    expect(records[0]?.error?.kind).toBe('policy_blocked');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for predicate');
}
