import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, type StreamEvent } from '../src/index.js';
import { chatReq, mockFetch, resolved, sseResponse, textResponse } from './helpers.js';

const google = () => adapterFor('google');
const conn = () => resolved('google', { baseUrl: 'https://generativelanguage.googleapis.com' });

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('google engine contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('streams candidate text and normalizes usage metadata', async () => {
    mockFetch(sseResponse([
      { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 } },
    ]));
    const events = await collect(google().stream(conn(), chatReq()));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('Hello');
    expect(done?.type === 'done' && done.result.usage).toEqual({ inputTokens: 6, outputTokens: 2, estimated: false });
    expect(done?.type === 'done' && done.result.finishReason).toBe('stop');
  });

  it('parses a functionCall part into a tool_call and maps finishReason to tool', async () => {
    mockFetch(sseResponse([
      { candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }] }, finishReason: 'STOP' }] },
    ]));
    const events = await collect(google().stream(conn(), chatReq({ tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] })));
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    const call = (toolEvents[0] as { call: { name: string; arguments: unknown } }).call;
    expect(call.name).toBe('get_weather');
    expect(call.arguments).toEqual({ city: 'NYC' });
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.finishReason).toBe('tool');
  });

  it('builds contents, systemInstruction, tools, and json config in the request', async () => {
    const { calls } = mockFetch(sseResponse([{ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }]));
    await collect(google().stream(conn(), chatReq({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'NYC' } }] },
        { role: 'tool', toolCallId: 'c1', name: 'get_weather', content: '{"temp":70}' },
      ],
      responseFormat: { type: 'json' },
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }],
    })));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.systemInstruction.parts[0].text).toBe('be terse');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.tools[0].functionDeclarations[0].name).toBe('get_weather');
    const modelTurn = body.contents.find((c: any) => c.role === 'model');
    expect(modelTurn.parts[0]).toEqual({ functionCall: { name: 'get_weather', args: { city: 'NYC' } } });
    const fnResponse = body.contents.find((c: any) => c.parts[0]?.functionResponse);
    expect(fnResponse.parts[0].functionResponse.name).toBe('get_weather');
    expect(calls[0]!.url).toContain(':streamGenerateContent?alt=sse');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('sk-test');
  });

  it('maps SAFETY finishReason to content_filter', async () => {
    mockFetch(sseResponse([{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] }]));
    const events = await collect(google().stream(conn(), chatReq()));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.finishReason).toBe('content_filter');
  });

  it('handles a non-SSE JSON array body', async () => {
    mockFetch(new Response(JSON.stringify([
      { candidates: [{ content: { parts: [{ text: 'a' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const events = await collect(google().stream(conn(), chatReq()));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('ab');
  });

  it('classifies server errors as retryable', async () => {
    mockFetch(textResponse('upstream boom', 503));
    await expect(google().chat(conn(), chatReq())).rejects.toMatchObject({ kind: 'server', status: 503, retryable: true });
  });
});
