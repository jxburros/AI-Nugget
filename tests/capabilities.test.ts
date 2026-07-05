import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterFor, providerCapabilities, PROVIDER_PROFILES, type Connection, type StreamEvent } from '../src/index.js';
import { resolveToolMode } from '../src/agent/loop.js';
import { chatReq, mockFetch, resolved, sseResponse } from './helpers.js';

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('provider capabilities', () => {
  it('reports static capabilities per provider', () => {
    expect(providerCapabilities('openai')).toEqual({ nativeTools: true, jsonMode: true });
    expect(providerCapabilities('anthropic')).toEqual({ nativeTools: true, jsonMode: true });
    expect(providerCapabilities('google')).toEqual({ nativeTools: true, jsonMode: true });
    // Local/model-dependent servers do not advertise reliable native tools.
    expect(providerCapabilities('ollama').nativeTools).toBe(false);
    expect(providerCapabilities('llamacpp').nativeTools).toBe(false);
    expect(providerCapabilities('vllm').nativeTools).toBe(false);
    expect(providerCapabilities('lmstudio').nativeTools).toBe(false);
  });

  it('falls unknown providers back to the conservative openai-compat defaults', () => {
    expect(providerCapabilities('some-new-provider', 'https://x.test/v1')).toEqual({ nativeTools: false, jsonMode: true });
  });

  it('declares capabilities on every shipped profile', () => {
    for (const [key, profile] of Object.entries(PROVIDER_PROFILES)) {
      expect(profile.capabilities, key).toBeDefined();
      expect(typeof profile.capabilities?.nativeTools, key).toBe('boolean');
      expect(typeof profile.capabilities?.jsonMode, key).toBe('boolean');
    }
  });
});

describe('toolMode: auto resolution', () => {
  const conn = (provider: string, over: Partial<Connection> = {}): Connection => ({ id: 'c1', provider, keyRef: { kind: 'none' }, ...over });

  it('honors explicit native / promptJson unchanged', () => {
    expect(resolveToolMode('native', conn('ollama'))).toBe('native');
    expect(resolveToolMode('promptJson', conn('openai'))).toBe('promptJson');
  });

  it('auto picks native for providers with native tool-calling', () => {
    expect(resolveToolMode('auto', conn('openai'))).toBe('native');
    expect(resolveToolMode('auto', conn('anthropic'))).toBe('native');
  });

  it('auto falls back to promptJson where native tools are unreliable', () => {
    expect(resolveToolMode('auto', conn('ollama'))).toBe('promptJson');
    expect(resolveToolMode('auto', conn('llamacpp'))).toBe('promptJson');
    expect(resolveToolMode('auto', conn('openai-compat', { baseUrl: 'http://local/v1' }))).toBe('promptJson');
  });

  it('defaults an unset toolMode to auto', () => {
    expect(resolveToolMode(undefined, conn('openai'))).toBe('native');
    expect(resolveToolMode(undefined, conn('ollama'))).toBe('promptJson');
  });
});

describe('quirks and capabilities shape the request body', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds stream_options.include_usage only where the provider supports it', async () => {
    // openai advertises supportsUsageInStream → include_usage present
    const first = mockFetch(sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('openai').stream(resolved('openai'), chatReq()));
    expect((first.calls[0]!.body as any).stream_options).toEqual({ include_usage: true });
    vi.restoreAllMocks();
    // openai-compat has no such quirk → the field is omitted (compat servers reject unknown keys)
    const second = mockFetch(sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('openai-compat', 'http://local/v1').stream(resolved('openai-compat', { baseUrl: 'http://local/v1' }), chatReq()));
    expect((second.calls[0]!.body as any).stream_options).toBeUndefined();
  });

  it('omits the model field for model-optional single-model servers when unset', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('llamacpp').stream(resolved('llamacpp', { baseUrl: 'http://localhost:8080/v1' }), chatReq({ model: '' })));
    const body = calls[0]!.body as Record<string, unknown>;
    expect('model' in body).toBe(false);
  });

  it('keeps the model field for model-optional servers when a model is given', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('llamacpp').stream(resolved('llamacpp', { baseUrl: 'http://localhost:8080/v1' }), chatReq({ model: 'my-gguf' })));
    expect((calls[0]!.body as any).model).toBe('my-gguf');
  });

  it('requests response_format only where the provider has a JSON mode', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('openai').stream(resolved('openai'), chatReq({ responseFormat: { type: 'json' } })));
    expect((calls[0]!.body as any).response_format).toEqual({ type: 'json_object' });
  });

  it('marks the azure deployment URL via the urlTemplate quirk', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]));
    await collect(adapterFor('azure-openai').stream(
      resolved('azure-openai', { baseUrl: 'https://my.openai.azure.com' }),
      chatReq({ model: 'gpt-4o' }),
    ));
    expect(calls[0]!.url).toBe('https://my.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21');
  });
});
