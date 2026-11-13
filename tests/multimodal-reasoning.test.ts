import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, AIError, profileFor, type ChatResult, type StreamEvent } from '../src/index.js';
import { chatReq, jsonResponse, mockFetch, resolved, sseResponse } from './helpers.js';

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function done(events: StreamEvent[]): ChatResult {
  const last = events.at(-1);
  if (last?.type !== 'done') throw new Error('no done event');
  return last.result;
}

const openAiStop = () => sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
const googleStop = () => sseResponse([{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]);
const audio = { type: 'audio' as const, dataBase64: 'QUFB', mimeType: 'audio/mpeg' };
const pdf = { type: 'file' as const, dataBase64: 'JVBERg==', mimeType: 'application/pdf', filename: 'report.pdf' };
const video = { type: 'video' as const, dataBase64: 'AAAA', mimeType: 'video/mp4' };

describe('new provider profiles', () => {
  afterEach(() => vi.restoreAllMocks());

  it('meta targets the Meta Model API with max_completion_tokens and json_schema', async () => {
    const profile = profileFor('meta');
    expect(profile.defaultBaseUrl).toBe('https://api.meta.ai/v1');
    expect(profile.capabilities.nativeTools).toBe(true);
    const { calls } = mockFetch(openAiStop());
    await collect(adapterFor('meta').stream(resolved('meta', { baseUrl: 'https://api.meta.ai/v1' }), chatReq({
      model: 'muse-spark-1.3', maxTokens: 64, reasoningEffort: 'xhigh', responseFormat: { type: 'json', schema: { type: 'object' } },
    })));
    const body = calls[0]!.body as Record<string, unknown>;
    expect(calls[0]!.url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(body.max_completion_tokens).toBe(64);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'response', schema: { type: 'object' } } });
  });

  it('moonshot replays reasoning_content on tool-loop assistant turns', async () => {
    expect(profileFor('moonshot').quirks).toMatchObject({ supportsUsageInStream: true, maxTokensParam: 'max_completion_tokens', supportsJsonSchema: true, preserveAssistantState: true });
    const conn = resolved('moonshot', { baseUrl: 'https://api.moonshot.ai/v1' });
    mockFetch(sseResponse([
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    ]));
    const first = done(await collect(adapterFor('moonshot').stream(conn, chatReq({ model: 'kimi-k3' }))));
    vi.restoreAllMocks();
    const { calls } = mockFetch(openAiStop());
    await collect(adapterFor('moonshot').stream(conn, chatReq({ model: 'kimi-k3', messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: first.toolCalls, providerState: first.providerState },
      { role: 'tool', toolCallId: 'c1', content: '{}' },
    ] })));
    const messages = (calls[0]!.body as { messages: Record<string, unknown>[] }).messages;
    expect(messages[1]).toMatchObject({ role: 'assistant', reasoning_content: 'think' });
  });

  it('echoes reasoning under the key it streamed in', async () => {
    mockFetch(sseResponse([
      { choices: [{ delta: { reasoning: 'r' } }] },
      { choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] },
    ]));
    const result = done(await collect(adapterFor('together').stream(resolved('together'), chatReq())));
    expect(result.providerState?.content[0]).toMatchObject({ reasoning: 'r' });
    expect(result.providerState?.content[0]).not.toHaveProperty('reasoning_content');
  });

  it('vercel gateway profile exists with the documented base URL', () => {
    expect(profileFor('vercel').defaultBaseUrl).toBe('https://ai-gateway.vercel.sh/v1');
    expect(profileFor('together').defaultBaseUrl).toBe('https://api.together.ai/v1');
  });
});

describe('reasoning effort tiers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps Gemini 3 effort to thinkingLevel and 2.x to thinkingBudget', async () => {
    const conn = resolved('google', { baseUrl: 'https://g.test' });
    const { calls } = mockFetch(googleStop(), googleStop());
    await collect(adapterFor('google').stream(conn, chatReq({ model: 'gemini-3.1-pro-preview', reasoningEffort: 'max' })));
    await collect(adapterFor('google').stream(conn, chatReq({ model: 'gemini-2.5-pro', reasoningEffort: 'max' })));
    expect((calls[0]!.body as any).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    expect((calls[1]!.body as any).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 32768 });
  });

  it('sends xhigh/max as Claude adaptive effort', async () => {
    const { calls } = mockFetch(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]));
    await collect(adapterFor('anthropic').stream(resolved('anthropic'), chatReq({ model: 'claude-opus-5-5', maxTokens: 100, reasoningEffort: 'max' })));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config.effort).toBe('max');
  });

  it('fits legacy Claude budgets for xhigh', async () => {
    const { calls } = mockFetch(sseResponse([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]));
    await collect(adapterFor('anthropic').stream(resolved('anthropic'), chatReq({ model: 'claude-sonnet-4-5', maxTokens: 100, reasoningEffort: 'xhigh' })));
    const body = calls[0]!.body as Record<string, any>;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 24576 });
    expect(body.max_tokens).toBeGreaterThan(24576);
  });
});

describe('Gemini thought signatures', () => {
  afterEach(() => vi.restoreAllMocks());
  const conn = () => resolved('google', { baseUrl: 'https://g.test' });
  const tools = [{ name: 'f', description: 'f', parameters: { type: 'object' } }];

  it('keeps thoughtSignature on the model turn and replays it verbatim', async () => {
    mockFetch(sseResponse([
      { candidates: [{ content: { parts: [{ text: 'Let me ' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'check.' }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'SIG' }] }, finishReason: 'STOP' }] },
    ]));
    const first = done(await collect(adapterFor('google').stream(conn(), chatReq({ model: 'gemini-3-flash-preview', tools }))));
    expect(first.providerState?.content[0]).toEqual({ role: 'model', parts: [{ text: 'Let me check.' }, { functionCall: { name: 'f', args: {} }, thoughtSignature: 'SIG' }] });
    vi.restoreAllMocks();
    const { calls } = mockFetch(googleStop());
    await collect(adapterFor('google').stream(conn(), chatReq({ model: 'gemini-3-flash-preview', tools, messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls, providerState: first.providerState },
      { role: 'tool', name: 'f', toolCallId: first.toolCalls![0]!.id, content: '{}' },
    ] })));
    const contents = (calls[0]!.body as any).contents;
    expect(contents[1].parts[1].thoughtSignature).toBe('SIG');
  });

  it('marks a rebuilt Gemini 3 function-call turn with the documented skip sentinel', async () => {
    const { calls } = mockFetch(googleStop());
    await collect(adapterFor('google').stream(conn(), chatReq({ model: 'gemini-3-pro-preview', tools, messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'f', arguments: {} }, { id: 'b', name: 'f', arguments: {} }] },
      { role: 'tool', name: 'f', toolCallId: 'a', content: '{}' },
      { role: 'tool', name: 'f', toolCallId: 'b', content: '{}' },
    ] })));
    const parts = (calls[0]!.body as any).contents[1].parts;
    expect(parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(parts[1].thoughtSignature).toBeUndefined();
  });
});

describe('multimodal inputs', () => {
  afterEach(() => vi.restoreAllMocks());
  const user = (part: object) => [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, part as never] }];

  it('openaiChat maps audio, file and video parts', async () => {
    const { calls } = mockFetch(openAiStop());
    await collect(adapterFor('openai').stream(resolved('openai'), chatReq({ messages: [{ role: 'user', content: [audio, pdf, video] }] })));
    const content = (calls[0]!.body as any).messages[0].content;
    expect(content[0]).toEqual({ type: 'input_audio', input_audio: { data: 'QUFB', format: 'mp3' } });
    expect(content[1]).toEqual({ type: 'file', file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } });
    expect(content[2]).toEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } });
  });

  it('openaiChat passes image URLs through and refuses audio by URL', async () => {
    const { calls } = mockFetch(openAiStop());
    await collect(adapterFor('openai').stream(resolved('openai'), chatReq({ messages: user({ type: 'image', url: 'https://x.test/a.png' }) })));
    expect((calls[0]!.body as any).messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://x.test/a.png' } });
    await expect(collect(adapterFor('openai').stream(resolved('openai'), chatReq({ messages: user({ type: 'audio', url: 'https://x.test/a.mp3' }) }))))
      .rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('google sends media as inlineData, or fileData for a URI', async () => {
    const { calls } = mockFetch(googleStop());
    await collect(adapterFor('google').stream(resolved('google', { baseUrl: 'https://g.test' }), chatReq({ messages: [{ role: 'user', content: [audio, pdf, { type: 'video', url: 'gs://b/v.mp4', mimeType: 'video/mp4' }] }] })));
    const parts = (calls[0]!.body as any).contents[0].parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'audio/mpeg', data: 'QUFB' } });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'JVBERg==' } });
    expect(parts[2]).toEqual({ fileData: { mimeType: 'video/mp4', fileUri: 'gs://b/v.mp4' } });
  });

  it('anthropic sends PDFs as document blocks and refuses audio', async () => {
    const { calls } = mockFetch(sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]));
    await collect(adapterFor('anthropic').stream(resolved('anthropic'), chatReq({ maxTokens: 10, messages: user(pdf) })));
    expect((calls[0]!.body as any).messages[0].content[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' }, title: 'report.pdf' });
    await expect(collect(adapterFor('anthropic').stream(resolved('anthropic'), chatReq({ maxTokens: 10, messages: user(audio) }))))
      .rejects.toBeInstanceOf(AIError);
  });

  it('ollama refuses non-image media instead of dropping it', async () => {
    await expect(collect(adapterFor('ollama').stream(resolved('ollama', { baseUrl: 'http://localhost:11434' }), chatReq({ messages: user(pdf) }))))
      .rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('responses maps files to input_file and refuses audio', async () => {
    const completed = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } };
    const { calls } = mockFetch(sseResponse([completed]));
    await collect(adapterFor('openai', undefined, 'responses').stream(resolved('openai'), chatReq({ messages: user(pdf) })));
    expect((calls[0]!.body as any).input[0].content[1]).toEqual({ type: 'input_file', filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERg==' });
    await expect(collect(adapterFor('openai', undefined, 'responses').stream(resolved('openai'), chatReq({ messages: user(audio) }))))
      .rejects.toMatchObject({ kind: 'invalid_request' });
  });
});

describe('media outputs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('collects Gemini inline image output on result.media and as context events', async () => {
    mockFetch(sseResponse([
      { candidates: [{ content: { parts: [{ text: 'Here:' }, { inlineData: { mimeType: 'image/png', data: 'UE5H' } }] }, finishReason: 'STOP' }] },
    ]));
    const events = await collect(adapterFor('google').stream(resolved('google', { baseUrl: 'https://g.test' }), chatReq()));
    expect(done(events).media).toEqual([{ type: 'image', mimeType: 'image/png', dataBase64: 'UE5H' }]);
    expect(events.some((e) => e.type === 'context' && e.kind === 'media')).toBe(true);
    expect(done(events).text).toBe('Here:');
  });

  it('collects OpenRouter-style images and chat audio', async () => {
    mockFetch(sseResponse([
      { choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,V0VC' } }] } }] },
      { choices: [{ delta: { audio: { data: 'AB', transcript: 'he' } } }] },
      { choices: [{ delta: { audio: { data: 'CD', transcript: 'llo' } }, finish_reason: 'stop' }] },
    ]));
    const result = done(await collect(adapterFor('openrouter').stream(resolved('openrouter'), chatReq({ providerOptions: { audio: { format: 'mp3' } } }))));
    expect(result.media).toEqual([
      { type: 'image', mimeType: 'image/webp', dataBase64: 'V0VC' },
      { type: 'audio', mimeType: 'audio/mpeg', dataBase64: 'ABCD', transcript: 'hello' },
    ]);
  });

  it('collects Responses image_generation_call output', async () => {
    mockFetch(jsonResponse({ status: 'completed', output: [{ type: 'image_generation_call', result: 'SU1H', output_format: 'jpeg' }] }));
    const result = done(await collect(adapterFor('openai', undefined, 'responses').stream(resolved('openai'), chatReq())));
    expect(result.media).toEqual([{ type: 'image', mimeType: 'image/jpeg', dataBase64: 'SU1H' }]);
  });
});
