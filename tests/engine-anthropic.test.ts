import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, type StreamEvent } from '../src/index.js';
import { chatReq, jsonResponse, mockFetch, resolved, sseResponse, textResponse } from './helpers.js';

const anthropic = () => adapterFor('anthropic');
const conn = () => resolved('anthropic', { baseUrl: 'https://api.anthropic.com' });

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('anthropic engine contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses the full SSE event sequence and maps stop_reason', async () => {
    mockFetch(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]));
    const events = await collect(anthropic().stream(conn(), chatReq()));
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.result.text).toBe('Hello');
      expect(done.result.finishReason).toBe('stop');
      expect(done.result.usage).toEqual({ inputTokens: 12, outputTokens: 4, estimated: false });
    }
  });

  it('accumulates a streamed tool_use block via input_json_delta', async () => {
    mockFetch(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"NYC"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]));
    const events = await collect(anthropic().stream(conn(), chatReq({ tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] })));
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    const call = (toolEvents[0] as { call: { name: string; arguments: unknown } }).call;
    expect(call.name).toBe('get_weather');
    expect(call.arguments).toEqual({ city: 'NYC' });
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.finishReason).toBe('tool');
  });

  it('forced-tool JSON mode injects json_output and returns JSON as text', async () => {
    const { calls } = mockFetch(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_j', name: 'json_output', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"answer":42}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]));
    const events = await collect(anthropic().stream(conn(), chatReq({ responseFormat: { type: 'json', schema: { type: 'object', properties: { answer: { type: 'number' } } } } })));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.tools[0].name).toBe('json_output');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'json_output' });
    expect(body.tools[0].input_schema).toEqual({ type: 'object', properties: { answer: { type: 'number' } } });
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('{"answer":42}');
    // JSON mode is not surfaced as a tool call to the caller.
    expect(done?.type === 'done' && done.result.toolCalls).toBeUndefined();
    expect(done?.type === 'done' && done.result.finishReason).toBe('stop');
  });

  it('injects the maxTokens default and anthropic-version header', async () => {
    const { calls } = mockFetch(sseResponse([{ type: 'message_stop' }]));
    await collect(anthropic().stream(conn(), chatReq()));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.max_tokens).toBe(4096);
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-test');
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('maps a tool-result message to a tool_result content block', async () => {
    const { calls } = mockFetch(sseResponse([{ type: 'message_stop' }]));
    await collect(anthropic().stream(conn(), chatReq({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'get_weather', arguments: { city: 'NYC' } }] },
        { role: 'tool', toolCallId: 'toolu_1', name: 'get_weather', content: '{"temp":70}' },
      ],
    })));
    const body = calls[0]!.body as Record<string, any>;
    const assistant = body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content[0]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } });
    const toolTurn = body.messages.find((m: any) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
    expect(toolTurn.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":70}' });
  });

  it('groups parallel tool-result messages into one user turn', async () => {
    const { calls } = mockFetch(sseResponse([{ type: 'message_stop' }]));
    await collect(anthropic().stream(conn(), chatReq({
      messages: [
        { role: 'user', content: 'weather and time?' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'toolu_1', name: 'get_weather', arguments: { city: 'NYC' } },
          { id: 'toolu_2', name: 'get_time', arguments: { city: 'NYC' } },
        ] },
        { role: 'tool', toolCallId: 'toolu_1', name: 'get_weather', content: '{"temp":70}' },
        { role: 'tool', toolCallId: 'toolu_2', name: 'get_time', content: '{"time":"noon"}' },
      ],
    })));
    const body = calls[0]!.body as Record<string, any>;
    const toolTurns = body.messages.filter((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'tool_result'));
    expect(toolTurns).toHaveLength(1);
    expect(toolTurns[0].content.map((p: any) => p.tool_use_id)).toEqual(['toolu_1', 'toolu_2']);
  });

  it('handles a buffered (non-SSE) response body', async () => {
    mockFetch(jsonResponse({ content: [{ type: 'text', text: 'buffered' }], usage: { input_tokens: 2, output_tokens: 1 }, stop_reason: 'end_turn' }));
    const events = await collect(anthropic().stream(conn(), chatReq()));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('buffered');
  });

  it('classifies auth failures', async () => {
    mockFetch(textResponse('bad key', 401));
    await expect(anthropic().chat(conn(), chatReq())).rejects.toMatchObject({ kind: 'auth', status: 401, retryable: false });
  });
});
