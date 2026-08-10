import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, allowAllPolicy, classify, memoryKeySource, resetPolicyWarningForTests } from '../src/index.js';
import { AnthropicAdapter } from '../src/adapters/engines/anthropic.js';
import { GoogleAdapter } from '../src/adapters/engines/google.js';
import { OllamaAdapter } from '../src/adapters/engines/ollama.js';
import { OpenAIChatAdapter } from '../src/adapters/engines/openaiChat.js';
import { profileFor } from '../src/adapters/profiles.js';
import type { StreamEvent } from '../src/index.js';
import { chatReq, mockFetch, ndjsonResponse, resolved, sseResponse } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const anomalies = (events: StreamEvent[]) => events.filter((e) => e.type === 'context' && e.kind === 'stream_anomaly');

describe('classify: 4xx fallthrough', () => {
  it('distinguishes a missing endpoint from a malformed request', () => {
    expect(classify(404, 'not found').kind).toBe('not_found');
    expect(classify(410, 'gone').kind).toBe('not_found');
    expect(classify(400, 'bad body').kind).toBe('invalid_request');
    // Genuine client-state problems keep the honest invalid_request label.
    expect(classify(409, 'conflict').kind).toBe('invalid_request');
    expect(classify(415, 'unsupported media type').kind).toBe('invalid_request');
  });

  it('leaves not_found non-retryable so a wrong model name is not re-sent three times', () => {
    expect(classify(404, 'no such model').retryable).toBe(false);
  });
});

describe('ollama: tool-call arguments', () => {
  it('parses JSON-string arguments from a llama.cpp-style backend', async () => {
    mockFetch(ndjsonResponse([
      { message: { role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: '{"city":"Oslo"}' } }] } },
      { done: true, done_reason: 'stop' },
    ]));
    const events = await collect(new OllamaAdapter('ollama').stream(resolved('ollama', { baseUrl: 'http://localhost:11434' }), chatReq()));
    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.type).toBe('tool_call');
    if (call?.type === 'tool_call') expect(call.call.arguments).toEqual({ city: 'Oslo' });
  });

  it('passes a native object through untouched', async () => {
    mockFetch(ndjsonResponse([
      { message: { role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: { city: 'Oslo' } } }] } },
      { done: true, done_reason: 'stop' },
    ]));
    const events = await collect(new OllamaAdapter('ollama').stream(resolved('ollama', { baseUrl: 'http://localhost:11434' }), chatReq()));
    const call = events.find((e) => e.type === 'tool_call');
    if (call?.type === 'tool_call') expect(call.call.arguments).toEqual({ city: 'Oslo' });
  });

  it('degrades malformed argument JSON to {} instead of crashing the stream', async () => {
    mockFetch(ndjsonResponse([
      { message: { role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: '{"city":' } }] } },
      { done: true, done_reason: 'stop' },
    ]));
    const events = await collect(new OllamaAdapter('ollama').stream(resolved('ollama', { baseUrl: 'http://localhost:11434' }), chatReq()));
    const call = events.find((e) => e.type === 'tool_call');
    if (call?.type === 'tool_call') expect(call.call.arguments).toEqual({});
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});

describe('stream-anomaly parity across engines', () => {
  it('openai flags a stream with no finish_reason', async () => {
    mockFetch(sseResponse([{ choices: [{ delta: { content: 'hi' } }] }]));
    const adapter = new OpenAIChatAdapter('openai', profileFor('openai'));
    expect(anomalies(await collect(adapter.stream(resolved('openai'), chatReq())))).toHaveLength(1);
  });

  it('anthropic flags a stream with no stop_reason or message_stop', async () => {
    mockFetch(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    ]));
    const events = await collect(new AnthropicAdapter('anthropic').stream(resolved('anthropic', { baseUrl: 'https://api.anthropic.com' }), chatReq()));
    expect(anomalies(events)).toHaveLength(1);
  });

  it('anthropic stays quiet when message_delta carries a stop_reason', async () => {
    mockFetch(sseResponse([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]));
    const events = await collect(new AnthropicAdapter('anthropic').stream(resolved('anthropic', { baseUrl: 'https://api.anthropic.com' }), chatReq()));
    expect(anomalies(events)).toHaveLength(0);
  });

  it('google flags a stream with no finishReason', async () => {
    mockFetch(sseResponse([{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }]));
    const events = await collect(new GoogleAdapter('google').stream(resolved('google', { baseUrl: 'https://generativelanguage.googleapis.com' }), chatReq()));
    expect(anomalies(events)).toHaveLength(1);
  });

  it('google stays quiet when a finishReason arrives', async () => {
    mockFetch(sseResponse([{ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }]));
    const events = await collect(new GoogleAdapter('google').stream(resolved('google', { baseUrl: 'https://generativelanguage.googleapis.com' }), chatReq()));
    expect(anomalies(events)).toHaveLength(0);
  });

  it('ollama flags an NDJSON stream that never sent a done record', async () => {
    mockFetch(ndjsonResponse([{ message: { content: 'hi' } }]));
    const events = await collect(new OllamaAdapter('ollama').stream(resolved('ollama', { baseUrl: 'http://localhost:11434' }), chatReq()));
    expect(anomalies(events)).toHaveLength(1);
  });

  it('ollama stays quiet on a well-formed stream', async () => {
    mockFetch(ndjsonResponse([{ message: { content: 'hi' } }, { done: true, done_reason: 'stop' }]));
    const events = await collect(new OllamaAdapter('ollama').stream(resolved('ollama', { baseUrl: 'http://localhost:11434' }), chatReq()));
    expect(anomalies(events)).toHaveLength(0);
  });
});

describe('json-mode downgrade is surfaced, not silent', () => {
  const downgrades = (events: StreamEvent[]) => events.filter((e) => e.type === 'context' && e.kind === 'json_mode_downgraded');

  it('google signals when JSON mode is dropped because tools are present', async () => {
    mockFetch(sseResponse([{ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }]));
    const req = chatReq({
      responseFormat: { type: 'json' },
      tools: [{ name: 'lookup', description: 'x', parameters: { type: 'object', properties: {} } }],
    });
    const events = await collect(new GoogleAdapter('google').stream(resolved('google', { baseUrl: 'https://generativelanguage.googleapis.com' }), req));
    expect(downgrades(events)).toHaveLength(1);
  });

  it('google stays quiet when JSON mode is requested without tools', async () => {
    mockFetch(sseResponse([{ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }]));
    const req = chatReq({ responseFormat: { type: 'json' } });
    const events = await collect(new GoogleAdapter('google').stream(resolved('google', { baseUrl: 'https://generativelanguage.googleapis.com' }), req));
    expect(downgrades(events)).toHaveLength(0);
  });

  it('anthropic signals the same downgrade for its forced-tool JSON mode', async () => {
    mockFetch(sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]));
    const req = chatReq({
      responseFormat: { type: 'json' },
      tools: [{ name: 'lookup', description: 'x', parameters: { type: 'object', properties: {} } }],
    });
    const events = await collect(new AnthropicAdapter('anthropic').stream(resolved('anthropic', { baseUrl: 'https://api.anthropic.com' }), req));
    expect(downgrades(events)).toHaveLength(1);
  });
});

describe('handler: governance visibility and idempotency', () => {
  it('warns when no GovernancePolicy is configured, once per process', () => {
    resetPolicyWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new AIHandler({ keySource: memoryKeySource({}) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('No GovernancePolicy configured');
    // It is a startup notice, not a per-instance one — an app building a handler
    // per request must not flood its logs.
    new AIHandler({ keySource: memoryKeySource({}) });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent when a policy is passed explicitly, including allowAllPolicy()', () => {
    resetPolicyWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new AIHandler({ keySource: memoryKeySource({}), policy: allowAllPolicy() });
    new AIHandler({ keySource: memoryKeySource({}), silencePolicyWarning: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends one stable Idempotency-Key across every retry of a logical call', async () => {
    const { calls } = mockFetch(
      new Response('boom', { status: 503 }),
      sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );
    const handler = new AIHandler({
      keySource: memoryKeySource({ OPENAI_API_KEY: 'sk-test-key-abcdefghijklmno' }),
      policy: allowAllPolicy(),
      retry: { maxAttempts: 2, baseDelayMs: 0 },
    });
    await handler.chat(
      { id: 'c1', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(calls).toHaveLength(2);
    const keys = calls.map((c) => c.headers['idempotency-key']);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('omits the header for providers that do not document it', async () => {
    const { calls } = mockFetch(ndjsonResponse([{ message: { content: 'ok' } }, { done: true, done_reason: 'stop' }]));
    const handler = new AIHandler({ keySource: memoryKeySource({}), policy: allowAllPolicy() });
    await handler.chat(
      { id: 'c1', provider: 'ollama' },
      { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(calls[0]?.headers['idempotency-key']).toBeUndefined();
  });
});
