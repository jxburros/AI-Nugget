import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, AIError, type StreamEvent } from '../src/index.js';
import { chatReq, jsonResponse, mockFetch, resolved, sseResponse, streamingResponse, textResponse } from './helpers.js';

const openai = () => adapterFor('openai');

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('openaiChat engine contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('streams deltas, reports usage, and finishes with stop', async () => {
    mockFetch(sseResponse([
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 5, completion_tokens: 2 }, choices: [] },
    ]));
    const events = await collect(openai().stream(resolved('openai'), chatReq()));
    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('Hello');
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.result.text).toBe('Hello');
      expect(done.result.finishReason).toBe('stop');
      expect(done.result.usage).toEqual({ inputTokens: 5, outputTokens: 2, estimated: false });
      expect(done.result.timing.firstTokenMs).not.toBeNull();
      expect(done.result.source).toEqual({ provider: 'openai', connectionId: 'conn-1', baseUrl: 'https://api.test/v1' });
    }
  });

  it('maps finish_reason length', async () => {
    mockFetch(sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }]));
    const events = await collect(openai().stream(resolved('openai'), chatReq()));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.finishReason).toBe('length');
  });

  it('recovers a buffered (non-SSE) body when the server ignores stream:true', async () => {
    mockFetch(jsonResponse({
      choices: [{ message: { content: 'buffered' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }));
    const events = await collect(openai().stream(resolved('openai'), chatReq()));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('buffered');
    expect(done?.type === 'done' && done.result.usage.estimated).toBe(false);
  });

  it('accumulates streamed tool_call deltas into one completed call', async () => {
    mockFetch(sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"NYC"}' } }] }, finish_reason: 'tool_calls' }] },
    ]));
    const events = await collect(openai().stream(resolved('openai'), chatReq({ tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] })));
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    const call = (toolEvents[0] as { call: { name: string; arguments: unknown } }).call;
    expect(call.name).toBe('get_weather');
    expect(call.arguments).toEqual({ city: 'NYC' });
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.finishReason).toBe('tool');
  });

  it('sends tools and json response_format in the request body', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]));
    await collect(openai().stream(resolved('openai'), chatReq({
      responseFormat: { type: 'json' },
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      maxTokens: 128,
    })));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.tools[0].function.name).toBe('t');
    expect(body.max_completion_tokens).toBe(128);
    expect(body.max_tokens).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(calls[0]!.url).toBe('https://api.test/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
  });

  it('uses json_schema response_format when an OpenAI profile receives a schema', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]));
    await collect(openai().stream(resolved('openai'), chatReq({
      responseFormat: { type: 'json', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    })));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    });
  });

  it('keeps max_tokens for local OpenAI-compatible profiles', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('llamacpp').stream(resolved('llamacpp', { baseUrl: 'http://localhost:8080/v1' }), chatReq({ maxTokens: 64 })));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.max_tokens).toBe(64);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('omits stream_options.include_usage for providers whose quirk profile does not confirm support', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('llamacpp').stream(resolved('llamacpp', { baseUrl: 'http://localhost:8080/v1' }), chatReq()));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.stream_options).toBeUndefined();
  });

  it('builds the azure deployment URL with the profile default api-version (F7)', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('azure-openai').stream(resolved('azure-openai', { baseUrl: 'https://my-resource.openai.azure.com' }), chatReq({ model: 'gpt-4o' })));
    expect(calls[0]!.url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21');
  });

  it('overrides the azure api-version per connection (F7)', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('azure-openai').stream(
      resolved('azure-openai', { baseUrl: 'https://my-resource.openai.azure.com', apiVersion: '2025-01-01-preview' }),
      chatReq({ model: 'gpt-4o' }),
    ));
    expect(calls[0]!.url).toBe('https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview');
  });

  it('classifies 401 / 429 / 500 with retryability', async () => {
    for (const [status, kind, retryable] of [[401, 'auth', false], [429, 'rate_limit', true], [500, 'server', true]] as const) {
      mockFetch(textResponse('boom', status));
      await expect(openai().chat(resolved('openai'), chatReq())).rejects.toMatchObject({ kind, status, retryable });
      vi.restoreAllMocks();
    }
  });

  it('honors Retry-After on 429', async () => {
    mockFetch(textResponse('slow down', 429, { 'retry-after': '2' }));
    await expect(openai().chat(resolved('openai'), chatReq())).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 2000 });
  });

  it('surfaces malformed SSE frames without crashing and still finishes', async () => {
    mockFetch(sseResponse(['not json', { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    const events = await collect(openai().stream(resolved('openai'), chatReq()));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('ok');
  });

  it('emits a stream_anomaly context event when no finish_reason arrives', async () => {
    mockFetch(sseResponse([{ choices: [{ delta: { content: 'partial' } }] }]));
    const events = await collect(openai().stream(resolved('openai'), chatReq()));
    expect(events.some((e) => e.type === 'context' && e.kind === 'stream_anomaly')).toBe(true);
  });

  it('cancels mid-stream when the request signal aborts', async () => {
    const ac = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init: RequestInit = {}) =>
      streamingResponse(['data: {"choices":[{"delta":{"content":"par"}}]}\n\n'], { signal: init.signal ?? undefined, hangUntilAbort: true }));
    const iterator = openai().stream(resolved('openai'), chatReq({ signal: ac.signal }))[Symbol.asyncIterator]();
    await iterator.next(); // start
    await iterator.next(); // first delta
    const pending = iterator.next();
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AIError);
  });
});
