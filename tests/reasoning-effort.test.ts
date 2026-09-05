import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, type StreamEvent } from '../src/index.js';
import { chatReq, jsonResponse, mockFetch, ndjsonResponse, resolved, sseResponse } from './helpers.js';

async function drain(events: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of events) { /* consume */ }
}

const body = (calls: { body: unknown }[]) => calls[0]!.body as Record<string, unknown>;

describe('ChatRequest.reasoningEffort maps onto each provider knob', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is never sent unless asked for', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]));
    await drain(adapterFor('openai').stream(resolved('openai'), chatReq()));
    expect('reasoning_effort' in body(calls)).toBe(false);
  });

  it('openai: reasoning_effort, with providerOptions winning on collision', async () => {
    const { calls } = mockFetch(
      sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]),
      sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]),
    );
    await drain(adapterFor('openai').stream(resolved('openai'), chatReq({ reasoningEffort: 'low' })));
    expect(body(calls).reasoning_effort).toBe('low');
    await drain(adapterFor('openai').stream(resolved('openai'), chatReq({ reasoningEffort: 'low', providerOptions: { reasoning_effort: 'high' } })));
    expect((calls[1]!.body as Record<string, unknown>).reasoning_effort).toBe('high');
  });

  it('anthropic: thinking budget tiers, samplers dropped, max_tokens raised to fit', async () => {
    const { calls } = mockFetch(
      sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]),
      sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]),
    );
    await drain(adapterFor('anthropic').stream(resolved('anthropic'), chatReq({ reasoningEffort: 'high', temperature: 0.2, maxTokens: 1000 })));
    const high = body(calls);
    expect(high.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(high.max_tokens).toBe(16384 + 1024);
    expect('temperature' in high).toBe(false);
    await drain(adapterFor('anthropic').stream(resolved('anthropic'), chatReq({ reasoningEffort: 'none', temperature: 0.2 })));
    const none = calls[1]!.body as Record<string, unknown>;
    expect(none.thinking).toEqual({ type: 'disabled' });
    expect(none.temperature).toBe(0.2);
  });

  it('google: generationConfig.thinkingConfig.thinkingBudget', async () => {
    const { calls } = mockFetch(sseResponse([{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }]));
    await drain(adapterFor('google').stream(resolved('google'), chatReq({ reasoningEffort: 'none' })));
    const cfg = body(calls).generationConfig as Record<string, unknown>;
    expect(cfg.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('ollama: think flag', async () => {
    const { calls } = mockFetch(
      ndjsonResponse([{ message: { content: 'x' }, done: true }]),
      ndjsonResponse([{ message: { content: 'x' }, done: true }]),
    );
    await drain(adapterFor('ollama').stream(resolved('ollama', { baseUrl: 'http://localhost:11434' }), chatReq({ reasoningEffort: 'medium' })));
    expect(body(calls).think).toBe(true);
    await drain(adapterFor('ollama').stream(resolved('ollama', { baseUrl: 'http://localhost:11434' }), chatReq({ reasoningEffort: 'none' })));
    expect((calls[1]!.body as Record<string, unknown>).think).toBe(false);
  });

  it('openai: a requested effort that the provider refuses alongside tools is retried as none and disclosed', async () => {
    const refusal = { error: { message: "Function tools with reasoning_effort are not supported. Please use /v1/responses or set reasoning_effort to 'none'." } };
    const { calls } = mockFetch(
      jsonResponse(refusal, 400),
      sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    );
    const events: StreamEvent[] = [];
    for await (const e of adapterFor('openai').stream(resolved('openai'), chatReq({ reasoningEffort: 'high', tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] }))) events.push(e);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as Record<string, unknown>).reasoning_effort).toBe('none');
    const ctx = events.find((e) => e.type === 'context' && e.kind === 'reasoning_effort_disabled_for_tools');
    expect(ctx && (ctx as { data: { requested: string } }).data.requested).toBe('high');
  });
});
