import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, memoryKeySource, type CallRecord, type ChatRequest, type Connection, type StreamEvent } from '../src/index.js';
import { jsonResponse, mockFetch, sseResponse, textResponse } from './helpers.js';

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

  it('reports a healthy connection via listModels through testConnection', async () => {
    mockFetch(jsonResponse({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }));
    const handler = new AIHandler({ keySource: memoryKeySource({}) });
    const result = await handler.testConnection(openaiConn());
    expect(result.ok).toBe(true);
  });

  it('lists models with source provenance', async () => {
    mockFetch(jsonResponse({ data: [{ id: 'gpt-x' }] }));
    const handler = new AIHandler({ keySource: memoryKeySource({}) });
    const models = await handler.listModels(openaiConn());
    expect(models[0]).toEqual({ id: 'gpt-x', source: { provider: 'openai', connectionId: 'c1', baseUrl: 'https://api.openai.com/v1' } });
  });
});
