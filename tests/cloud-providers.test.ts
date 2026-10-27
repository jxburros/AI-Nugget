import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, allowAllPolicy, literalKeySource, profileFor, type CallInfo, type CallRecord, type Connection, type StreamEvent } from '../src/index.js';
import { chatReq, jsonResponse, mockFetch, sseResponse } from './helpers.js';

afterEach(() => vi.restoreAllMocks());
const conn = (provider: string, extra: Partial<Connection> = {}): Connection => ({ id: 'cloud', provider, keyRef: { kind: 'literal', value: 'test-credential-only' }, ...extra });
const handler = () => new AIHandler({ keySource: literalKeySource(), policy: allowAllPolicy(), retry: { maxAttempts: 1 } });
const completion = () => jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } });

describe('new provider contracts through AIHandler', () => {
  it.each([
    ['minimax', 'https://api.minimax.io/v1'],
    ['zai', 'https://api.z.ai/api/paas/v4'],
    ['dashscope', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
    ['huggingface', 'https://router.huggingface.co/v1'],
    ['deepinfra', 'https://api.deepinfra.com/v1/openai'],
    ['sambanova', 'https://api.sambanova.ai/v1'],
    ['nvidia', 'https://nim.example/v1'],
    ['cloudflare', 'https://api.cloudflare.com/client/v4/accounts/account123/ai/v1'],
    ['bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1'],
    ['vertex', 'https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/endpoints/openapi'],
    ['azure-openai-v1', 'https://deployment.openai.azure.com/openai/v1'],
  ])('%s constructs documented URL/auth and preserves model identity', async (provider, base) => {
    const { calls } = mockFetch(completion());
    const records: CallRecord[] = [];
    const h = new AIHandler({ keySource: literalKeySource(), policy: allowAllPolicy(), telemetry: { record(r) { records.push(r); } } });
    const c = conn(provider, { cloud: { accountId: 'account123', region: 'us-east-1', project: 'my-project', location: 'us-central1' }, ...(['nvidia', 'azure-openai-v1'].includes(provider) ? { baseUrl: base } : {}) });
    const result = await h.chat(c, chatReq({ model: 'org/model:provider-suffix' }));
    expect(calls[0]?.url).toBe(`${base}/chat/completions`);
    expect(calls[0]?.headers.authorization).toBe('Bearer test-credential-only');
    expect(calls[0]?.body).toMatchObject({ model: 'org/model:provider-suffix' });
    expect(result.source.provider).toBe(provider);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('test-credential-only');
  });

  it.each(['minimax', 'zai', 'dashscope', 'cloudflare', 'vertex'])('%s does not fake a successful health check', async provider => {
    const { calls } = mockFetch();
    const result = await handler().testConnection(conn(provider, { baseUrl: 'https://example.test/v1' }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no lightweight health probe');
    expect(calls).toHaveLength(0);
  });

  it.each(['cloudflare', 'bedrock', 'vertex', 'nvidia', 'azure-openai-v1'])('%s requires explicit endpoint coordinates', async provider => {
    const { calls } = mockFetch();
    await expect(handler().chat(conn(provider), chatReq())).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  it('keeps region-specific and coding-plan overrides explicit', async () => {
    const { calls } = mockFetch(completion(), completion());
    await handler().chat(conn('dashscope', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }), chatReq());
    await handler().chat(conn('zai', { baseUrl: 'https://api.z.ai/api/coding/paas/v4' }), chatReq());
    expect(calls.map(c => c.url)).toEqual(['https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'https://api.z.ai/api/coding/paas/v4/chat/completions']);
  });

  it('uses the unprefixed global Vertex host', async () => {
    const { calls } = mockFetch(completion());
    await handler().chat(conn('vertex', { cloud: { project: 'project', location: 'global' } }), chatReq());
    expect(calls[0]?.url).toContain('https://aiplatform.googleapis.com/v1/projects/project/locations/global/');
  });

  it('supports explicit Bedrock Mantle and Alibaba workspace endpoints', async () => {
    const { calls } = mockFetch(completion(), completion());
    await handler().chat(conn('bedrock', { cloud: { region: 'us-east-1', bedrockEndpoint: 'mantle' } }), chatReq());
    await handler().chat(conn('dashscope', { cloud: { workspace: 'ws123', region: 'ap-southeast-1' } }), chatReq());
    expect(calls[0]?.url).toBe('https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions');
    expect(calls[1]?.url).toBe('https://ws123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  });

  it('does not probe a nonexistent Bedrock runtime models API', async () => {
    const { calls } = mockFetch();
    const c = conn('bedrock', { cloud: { region: 'us-east-1' } });
    expect(await handler().listModels(c)).toEqual([]);
    expect((await handler().testConnection(c)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refreshes token credentials per call and scrubs beforeCall hooks', async () => {
    let n = 0;
    const infos: CallInfo[] = [];
    const { calls } = mockFetch(completion(), completion());
    const h = new AIHandler({ keySource: { async resolve() { return { ok: true, apiKey: `oauth-token-${++n}` }; } }, policy: allowAllPolicy(), hooks: { async beforeCall(info) { infos.push(info); } } });
    const c = conn('azure-openai', { baseUrl: 'https://azure.example', auth: 'bearer', keyRef: { kind: 'brokered', ref: 'entra' } });
    await h.chat(c, chatReq()); await h.chat(c, chatReq());
    expect(calls.map(c => c.headers.authorization)).toEqual(['Bearer oauth-token-1', 'Bearer oauth-token-2']);
    expect(calls[0]?.headers['api-key']).toBeUndefined();
    expect(JSON.stringify(infos)).not.toContain('oauth-token-');
  });

  it('signs the final HTTP request on every retry without exposing signer to hooks', async () => {
    const infos: CallInfo[] = [];
    const signed: string[] = [];
    const { calls } = mockFetch(jsonResponse({ error: 'busy' }, 503), completion());
    const h = new AIHandler({
      keySource: { async resolve() { return { ok: true, apiKey: null, async authorize(request) {
        signed.push(await request.clone().text()); request.headers.set('authorization', 'AWS4-HMAC-SHA256 fake-test-signature'); return request;
      } }; } }, policy: allowAllPolicy(), retry: { baseDelayMs: 0, maxAttempts: 2 }, hooks: { async beforeCall(info) { infos.push(info); } },
    });
    await h.chat(conn('bedrock', { cloud: { region: 'us-west-2' }, keyRef: { kind: 'brokered', ref: 'aws' } }), chatReq());
    expect(signed).toHaveLength(2);
    expect(signed[0]).toBe(signed[1]);
    expect(calls[0]?.headers.authorization).toContain('AWS4-HMAC');
    expect(infos[0]?.resolved?.fetch).toBeUndefined();
  });

  it('sanitizes SDK signing failures before returning or recording them', async () => {
    const records: CallRecord[] = [];
    const h = new AIHandler({ keySource: { async resolve() { return { ok: true, apiKey: null, async authorize() { throw new Error('secret-access-key'); } }; } }, policy: allowAllPolicy(), telemetry: { record(r) { records.push(r); } } });
    await expect(h.chat(conn('bedrock', { cloud: { region: 'us-west-2' } }), chatReq())).rejects.toMatchObject({ kind: 'auth', message: 'Request authorization failed' });
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('secret-access-key');
  });

  it('bounds a signer that never resolves', async () => {
    const h = new AIHandler({ keySource: { async resolve() { return { ok: true, apiKey: null, authorize: () => new Promise<Request>(() => undefined) }; } }, policy: allowAllPolicy(), retry: { maxAttempts: 1 } });
    await expect(h.chat(conn('bedrock', { cloud: { region: 'us-east-1' }, timeoutMs: 20 }), chatReq())).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('preserves MiniMax thinking and tool state while hiding inline thinking from the answer', async () => {
    const first = { role: 'assistant', content: '<think>private thought</think>', reasoning_content: 'opaque reasoning', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }] };
    const { calls } = mockFetch(jsonResponse({ choices: [{ message: first, finish_reason: 'tool_calls' }] }), completion());
    const h = handler(); const c = conn('minimax');
    const result = await h.chat(c, chatReq());
    expect(result.text).toBe('');
    await h.chat(c, chatReq({ messages: [{ role: 'assistant', content: result.text, providerState: result.providerState }, { role: 'tool', toolCallId: 'call-1', content: 'found' }] }));
    expect((calls[1]?.body as { messages: unknown[] }).messages[0]).toEqual(first);
  });

  it('preserves streamed MiniMax reasoning state', async () => {
    mockFetch(sseResponse([{ choices: [{ delta: { reasoning_content: 'think' } }] }, { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }]));
    const result = await handler().chat(conn('minimax'), chatReq());
    expect(result.providerState?.content[0]).toMatchObject({ content: 'answer', reasoning_content: 'think' });
  });

  it('supports Cloudflare embeddings through the configured account endpoint', async () => {
    const { calls } = mockFetch(jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2 } }));
    const result = await handler().embed(conn('cloudflare', { cloud: { accountId: 'acct' } }), { model: '@cf/embedding-model', input: 'hi' });
    expect(calls[0]?.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/embeddings');
    expect(result.embeddings).toEqual([[0.1, 0.2]]);
  });

  it('does not assume every chat router exposes embeddings', async () => {
    const { calls } = mockFetch();
    await expect(handler().embed(conn('huggingface'), { model: 'model', input: 'x' })).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  it('retains conservative tool defaults for self-hosted NIM', () => {
    expect(profileFor('nvidia').capabilities).toMatchObject({ local: true, nativeTools: false, embeddable: false });
  });

  it('denies new providers through the same policy before any request', async () => {
    const { calls } = mockFetch();
    const h = new AIHandler({ keySource: literalKeySource(), policy: { checkModel: () => ({ allowed: false, reason: 'blocked' }) } });
    const events: StreamEvent[] = [];
    for await (const event of h.stream(conn('minimax'), chatReq())) events.push(event);
    expect(events[0]?.type).toBe('error'); expect(calls).toHaveLength(0);
  });
});
