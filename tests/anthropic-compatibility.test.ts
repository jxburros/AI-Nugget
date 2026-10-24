import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, memoryKeySource, type CallRecord, type StreamEvent } from '../src/index.js';
import { defineTool, runAgent } from '../src/agent/index.js';
import { chatReq, jsonResponse, mockFetch, sseResponse } from './helpers.js';

const connection = { id: 'claude', provider: 'anthropic', keyRef: { kind: 'none' as const } };
function handler(records: CallRecord[] = []) {
  return new AIHandler({ keySource: memoryKeySource({}), retry: { maxAttempts: 1 }, telemetry: { record: r => { records.push(r); } } });
}
const end = () => sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
const model = 'claude-opus-5-5';
const tool = defineTool({ name: 'read', description: 'read', parameters: { type: 'object', properties: {} }, execute: () => 'ok' });

describe('Anthropic compatibility through the handler pipeline', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-7'])('omits samplers and maps effort for %s', async model => {
    const { calls } = mockFetch(end());
    await handler().chat(connection, chatReq({ model, temperature: 0.2, topP: 0.9, reasoningEffort: 'high' }));
    expect(calls[0]!.body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(calls[0]!.body).not.toHaveProperty('temperature');
    expect(calls[0]!.body).not.toHaveProperty('top_p');
  });

  it('uses native JSON schema output alongside caller tools', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const { calls } = mockFetch(jsonResponse({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }));
    const result = await handler().chat(connection, chatReq({ model, tools: [tool], responseFormat: { type: 'json', schema } }));
    expect(calls[0]!.body).toMatchObject({ output_config: { format: { type: 'json_schema', schema } }, tools: [{ name: 'read' }] });
    expect(calls[0]!.body).not.toHaveProperty('tool_choice');
    expect(JSON.parse(result.text)).toEqual({ ok: true });
  });

  it('rejects unsupported explicit forced-tool and thinking-off requests before fetch', async () => {
    const { calls } = mockFetch();
    await expect(handler().chat(connection, chatReq({ model, tools: [tool], toolChoice: { name: 'read' } }))).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(handler().chat(connection, chatReq({ model, reasoningEffort: 'none' }))).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])('fails honestly on an SSE overload after output=%s', async partial => {
    const records: CallRecord[] = [];
    mockFetch(sseResponse([
      ...(partial ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }] : []),
      { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } },
    ]));
    const events: StreamEvent[] = [];
    for await (const event of handler(records).stream(connection, chatReq({ model }))) events.push(event);
    expect(events.some(e => e.type === 'done')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'server', status: 529 } });
    expect(records).toHaveLength(1);
    expect(records[0]!.error?.kind).toBe('server');
  });

  it.each([false, true])('replays complete thinking and tool blocks on the second agent step (buffered=%s)', async buffered => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'signed-opaque-block' },
      { type: 'redacted_thinking', data: 'opaque-redacted-block' },
      { type: 'tool_use', id: 't1', name: 'read', input: {} },
    ];
    const first = buffered ? jsonResponse({ content, stop_reason: 'tool_use' }) : sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-opaque-block' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: content[1] },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: content[2] },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
    ]);
    const { calls } = mockFetch(first, end());
    const agent = runAgent({ handler: handler(), connection, model, tools: [tool], messages: [{ role: 'user', content: 'read' }] });
    for await (const _ of agent) { /* drain */ }
    expect((await agent.result).stopReason).toBe('finished');
    expect(calls).toHaveLength(2);
    const request = calls[1]!.body as { messages: { role: string; content: unknown }[] };
    expect(request.messages.find(m => m.role === 'assistant')?.content).toEqual(content);
  });

it('discloses schema-less JSON fallback instead of forcing an unsupported tool', async () => {
  const { calls } = mockFetch(end());
  const events: StreamEvent[] = [];
  for await (const event of handler().stream(connection, chatReq({ model, responseFormat: { type: 'json' } }))) events.push(event);
  expect(events.some(e => e.type === 'context' && e.kind === 'json_mode_downgraded')).toBe(true);
  expect(calls[0]!.body).not.toHaveProperty('tool_choice');
  expect(calls[0]!.body).not.toHaveProperty('output_config');
});

  it('does not retry an overload after visible reasoning has reached the caller', async () => {
    const { calls } = mockFetch(sseResponse([
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'progress' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
    ]));
    const h = new AIHandler({ keySource: memoryKeySource({}), retry: { maxAttempts: 3, baseDelayMs: 0 } });
    const events: StreamEvent[] = [];
    for await (const event of h.stream(connection, chatReq({ model }))) events.push(event);
    expect(calls).toHaveLength(1);
    expect(events.filter(e => e.type === 'retry')).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('error');
  });

});
