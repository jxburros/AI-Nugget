import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, type ModelInfo, type StreamEvent } from '../src/index.js';
import { chatReq, jsonResponse, mockFetch, ndjsonResponse, resolved, textResponse } from './helpers.js';

const ollama = () => adapterFor('ollama');
const conn = () => resolved('ollama', { baseUrl: 'http://localhost:11434' });

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('ollama engine contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('streams NDJSON deltas and reports eval counts as usage', async () => {
    mockFetch(ndjsonResponse([
      { message: { role: 'assistant', content: 'Hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 2 },
    ]));
    const events = await collect(ollama().stream(conn(), chatReq()));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('Hello');
    expect(done?.type === 'done' && done.result.usage).toEqual({ inputTokens: 7, outputTokens: 2, estimated: false });
    expect(done?.type === 'done' && done.result.finishReason).toBe('stop');
  });

  it('emits native tool calls and maps the tools body to function shape', async () => {
    const { calls } = mockFetch(ndjsonResponse([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'NYC' } } }] }, done: true, done_reason: 'stop' },
    ]));
    const events = await collect(ollama().stream(conn(), chatReq({ tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] })));
    const toolEvents = events.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);
    expect((toolEvents[0] as { call: { arguments: unknown } }).call.arguments).toEqual({ city: 'NYC' });
    const body = calls[0]!.body as Record<string, any>;
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } });
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.finishReason).toBe('tool');
  });

  it('sends images and a json format flag', async () => {
    const { calls } = mockFetch(ndjsonResponse([{ message: { content: '{}' }, done: true, done_reason: 'stop' }]));
    await collect(ollama().stream(conn(), chatReq({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', imageBase64: 'AAAA', mimeType: 'image/png' }] }],
      responseFormat: { type: 'json' },
    })));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.messages[0].images).toEqual(['AAAA']);
    expect(body.format).toBe('json');
    expect(body.stream).toBe(true);
  });

  it('lists models and probes /api/show for context window + capabilities', async () => {
    mockFetch(
      jsonResponse({ models: [{ name: 'llama3.1:8b' }] }),
      jsonResponse({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 8192 } }),
    );
    const models: ModelInfo[] = await ollama().listModels!(conn());
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe('llama3.1:8b');
    expect(models[0]!.contextWindow).toBe(8192);
    expect(models[0]!.capabilities).toEqual(['completion', 'tools']);
  });

  it('degrades gracefully when /api/show fails', async () => {
    mockFetch(
      jsonResponse({ models: [{ name: 'llama3.1:8b' }] }),
      textResponse('nope', 500),
    );
    const models: ModelInfo[] = await ollama().listModels!(conn());
    expect(models[0]!.id).toBe('llama3.1:8b');
    expect(models[0]!.contextWindow).toBeUndefined();
  });

  it('classifies malformed NDJSON as invalid_response', async () => {
    mockFetch(new Response('not json\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    await expect(ollama().chat(conn(), chatReq())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
