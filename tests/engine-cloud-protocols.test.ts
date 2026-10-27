import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, allowAllPolicy, literalKeySource, type CallRecord, type Connection } from '../src/index.js';
import { chatReq, jsonResponse, mockFetch, sseResponse, streamingResponse } from './helpers.js';
import { crc32 } from '../src/adapters/engines/awsEventStream.js';

afterEach(() => vi.restoreAllMocks());
const h = () => new AIHandler({ keySource: literalKeySource(), policy: allowAllPolicy(), retry: { maxAttempts: 1 } });
const c = (provider: string, protocol: Connection['protocol'], extra: Partial<Connection> = {}): Connection => ({ id: 'test', provider, protocol, baseUrl: 'https://provider.test/v1', keyRef: { kind: 'literal', value: 'fake-provider-key' }, ...extra });
const response = (output: unknown[]) => ({ id: 'resp1', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } });
const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] };

describe('Responses through the handler', () => {
  it.each(['sambanova', 'nvidia', 'bedrock', 'azure-openai-v1'])('%s maps buffered output, usage, schemas and function inputs', async provider => {
    const { calls } = mockFetch(jsonResponse(response([answer])));
    const result = await h().chat(c(provider, 'responses'), chatReq({ responseFormat: { type: 'json', schema: { type: 'object' } }, maxTokens: 42, tools: [{ name: 'lookup', description: 'look', parameters: { type: 'object' } }] }));
    expect(calls[0]?.url).toBe('https://provider.test/v1/responses');
    expect(calls[0]?.body).toMatchObject({ max_output_tokens: 42, store: false, tools: [{ type: 'function', name: 'lookup' }], text: { format: { type: 'json_schema', strict: true } } });
    expect(result.text).toBe('answer'); expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, estimated: false });
  });

  it('replays opaque reasoning and tool items without duplicating assistant messages', async () => {
    const output = [{ type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] }, { type: 'function_call', id: 'f1', call_id: 'call1', name: 'lookup', arguments: '{"x":1}' }];
    const { calls } = mockFetch(sseResponse([{ type: 'response.completed', response: response(output) }]), jsonResponse(response([answer])));
    const handler = h(); const conn = c('sambanova', 'responses');
    const first = await handler.chat(conn, chatReq());
    expect(first.toolCalls?.[0]).toMatchObject({ id: 'call1', arguments: { x: 1 } });
    await handler.chat(conn, chatReq({ messages: [{ role: 'assistant', content: first.text, providerState: first.providerState, toolCalls: first.toolCalls }, { role: 'tool', toolCallId: 'call1', content: 'found' }] }));
    expect((calls[1]?.body as { input: unknown[] }).input).toEqual([...output, { type: 'function_call_output', call_id: 'call1', output: 'found' }]);
  });

  it('emits text once while retaining terminal content', async () => {
    mockFetch(sseResponse([{ type: 'response.output_text.delta', delta: 'answer' }, { type: 'response.completed', response: response([answer]) }]));
    const deltas: string[] = [];
    for await (const event of h().stream(c('sambanova', 'responses'), chatReq())) if (event.type === 'delta') deltas.push(event.text);
    expect(deltas).toEqual(['answer']);
  });

  it('forces buffered mode for Cloudflare Responses', async () => {
    const { calls } = mockFetch(jsonResponse(response([answer])));
    await h().chat(c('cloudflare', 'responses'), chatReq({ providerOptions: { stream: true } }));
    expect(calls[0]?.body).toMatchObject({ stream: false });
  });

  it.each([
    sseResponse([{ type: 'response.output_text.delta', delta: 'partial' }]),
    sseResponse([{ type: 'response.failed', response: { error: { message: 'failed' } } }]),
    jsonResponse({ status: 'completed' }),
    jsonResponse(response([{ type: 'function_call', call_id: 'x', name: 'tool', arguments: '{broken' }])),
  ])('rejects incomplete or malformed wire results honestly', async res => {
    mockFetch(res);
    await expect(h().chat(c('sambanova', 'responses'), chatReq())).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('marks provider token exhaustion as length rather than success', async () => {
    mockFetch(jsonResponse({ ...response([answer]), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    expect((await h().chat(c('sambanova', 'responses'), chatReq())).finishReason).toBe('length');
  });

  it('bounds a hung Responses stream and records one failure', async () => {
    mockFetch(call => streamingResponse([], { signal: call.signal, hangUntilAbort: true }));
    const records: CallRecord[] = [];
    const handler = new AIHandler({ keySource: literalKeySource(), policy: allowAllPolicy(), retry: { maxAttempts: 1 }, telemetry: { record(r) { records.push(r); } } });
    await expect(handler.chat(c('sambanova', 'responses', { timeoutMs: 25 }), chatReq())).rejects.toMatchObject({ kind: 'timeout' });
    expect(records).toHaveLength(1);
  });
});

/** Test fixture writer independent of the decoder; split frames across chunks. */
function awsResponse(events: Array<[string, unknown]>, corrupt = false): Response {
  const encoder = new TextEncoder();
  const frames = events.map(([type, data]) => {
    const key = encoder.encode(':event-type'); const value = encoder.encode(type);
    const headers = new Uint8Array(1 + key.length + 3 + value.length);
    headers[0] = key.length; headers.set(key, 1); headers[1 + key.length] = 7;
    new DataView(headers.buffer).setUint16(key.length + 2, value.length); headers.set(value, key.length + 4);
    const payload = encoder.encode(JSON.stringify(data));
    const frame = new Uint8Array(16 + headers.length + payload.length); const view = new DataView(frame.buffer);
    view.setUint32(0, frame.length); view.setUint32(4, headers.length); view.setUint32(8, crc32(frame.subarray(0, 8)));
    frame.set(headers, 12); frame.set(payload, 12 + headers.length); view.setUint32(frame.length - 4, crc32(frame.subarray(0, -4)));
    return frame;
  });
  if (corrupt && frames[0]) frames[0][frames[0].length - 1]! ^= 1;
  return new Response(new ReadableStream({ start(controller) {
    for (const frame of frames) { controller.enqueue(frame.slice(0, 7)); controller.enqueue(frame.slice(7)); }
    controller.close();
  } }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
}

describe('Bedrock Converse through the handler', () => {
  it('uses the standard CRC32 polynomial', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('decodes split EventStream frames, reasoning signatures, text and usage', async () => {
    const { calls } = mockFetch(awsResponse([
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'thinking', signature: 'signature' } } }],
      ['contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'answer' } }],
      ['messageStop', { stopReason: 'end_turn' }],
      ['metadata', { usage: { inputTokens: 2, outputTokens: 3 } }],
    ]));
    const result = await h().chat(c('bedrock', 'converse', { baseUrl: undefined, cloud: { region: 'us-east-1' } }), chatReq({ model: 'arn:aws:bedrock:us-east-1:123:inference-profile/test' }));
    expect(calls[0]?.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A123%3Ainference-profile%2Ftest/converse-stream');
    expect(result.text).toBe('answer');
    expect(result.providerState?.content[0]).toEqual({ reasoningContent: { reasoningText: { text: 'thinking', signature: 'signature' } } });
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3, estimated: false });
  });

  it('round-trips native tool calls and groups parallel tool results', async () => {
    const { calls } = mockFetch(awsResponse([
      ['contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tool1', name: 'lookup' } } }],
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"q":' } } }],
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '"test"}' } } }],
      ['messageStop', { stopReason: 'tool_use' }],
    ]), jsonResponse({ output: { message: { role: 'assistant', content: [{ text: 'done' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }));
    const handler = h(); const conn = c('bedrock', 'converse');
    const first = await handler.chat(conn, chatReq({ tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object' } }] }));
    expect(first.toolCalls?.[0]?.arguments).toEqual({ q: 'test' });
    await handler.chat(conn, chatReq({ providerOptions: { stream: false }, messages: [
      { role: 'system', content: 'system' }, { role: 'assistant', content: '', providerState: first.providerState },
      { role: 'tool', toolCallId: 'tool1', content: 'found' }, { role: 'tool', toolCallId: 'tool2', content: 'also found' },
    ] }));
    expect(calls[0]?.body).toMatchObject({ toolConfig: { tools: [{ toolSpec: { name: 'lookup', inputSchema: { json: { type: 'object' } } } }] } });
    expect(calls[1]?.url).toContain('/converse');
    const body = calls[1]?.body as { messages: Array<{ content: unknown[] }>; system: unknown[]; stream?: unknown };
    expect(body.system).toEqual([{ text: 'system' }]); expect(body.messages).toHaveLength(2);
    expect(body.messages[1]?.content).toHaveLength(2); expect(body.stream).toBeUndefined();
  });

  it('rejects corrupt checksums', async () => {
    mockFetch(awsResponse([['messageStop', { stopReason: 'end_turn' }]], true));
    await expect(h().chat(c('bedrock', 'converse'), chatReq())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('rejects truncated streams', async () => {
    mockFetch(awsResponse([['contentBlockDelta', { delta: { text: 'partial' } }]]));
    await expect(h().chat(c('bedrock', 'converse'), chatReq())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('propagates provider exceptions', async () => {
    mockFetch(awsResponse([['throttlingException', { message: 'slow down' }]]));
    await expect(h().chat(c('bedrock', 'converse'), chatReq())).rejects.toMatchObject({ kind: 'rate_limit' });
  });
  it('requires explicit model-native reasoning options instead of ignoring the knob', async () => {
    const { calls } = mockFetch();
    await expect(h().chat(c('bedrock', 'converse'), chatReq({ reasoningEffort: 'high' }))).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });
  it('does not claim discovery or health on the runtime endpoint', async () => {
    const { calls } = mockFetch(); const handler = h(); const conn = c('bedrock', 'converse');
    expect(await handler.listModels(conn)).toEqual([]);
    expect((await handler.testConnection(conn)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
