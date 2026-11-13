import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adapterFor, AIHandler, allowAllPolicy, composePolicies, mcpServerAllowlistPolicy, memoryKeySource, parseRateLimitHeaders,
  profileFor, standardJsonSchema, type CallRecord, type StandardSchemaV1, type StreamEvent,
} from '../src/index.js';
import { defineTool, runAgent } from '../src/agent/index.js';
import { chatReq, mockFetch, resolved, sseResponse } from './helpers.js';

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const openAiStop = (usage?: object) => sseResponse([
  { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
  ...(usage ? [{ choices: [], usage }] : []),
]);
const anthropicStop = (usage: object = { input_tokens: 1 }) => sseResponse([
  { type: 'message_start', message: { usage } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]);
const responsesDone = (extra: object = {}) => sseResponse([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], ...extra } }]);

function handler(keys: Record<string, string> = {}, telemetry?: CallRecord[]) {
  return new AIHandler({
    keySource: memoryKeySource(keys),
    policy: allowAllPolicy(),
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
    ...(telemetry ? { telemetry: { record: async (r: CallRecord) => { telemetry.push(r); } } } : {}),
  });
}

describe('perplexity orchestrator default', () => {
  afterEach(() => vi.restoreAllMocks());

  it('targets the Orchestrator Chat Completions endpoint with its documented fields', async () => {
    expect(profileFor('perplexity').defaultBaseUrl).toBe('https://api.perplexity.ai/orchestrator/v1');
    const { calls } = mockFetch(openAiStop());
    await handler({ PPLX: 'pplx-key' }).chat({ id: 'p', provider: 'perplexity', keyRef: { kind: 'env', name: 'PPLX' } }, chatReq({ model: 'perplexity/sonar', maxTokens: 20 }));
    expect(calls[0]!.url).toBe('https://api.perplexity.ai/orchestrator/v1/chat/completions');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(20);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('keeps the pre-0.8 endpoint reachable through an explicit baseUrl', async () => {
    const { calls } = mockFetch(openAiStop());
    await handler({ PPLX: 'k' }).chat({ id: 'p', provider: 'perplexity', baseUrl: 'https://api.perplexity.ai', keyRef: { kind: 'env', name: 'PPLX' } }, chatReq({ model: 'sonar' }));
    expect(calls[0]!.url).toBe('https://api.perplexity.ai/chat/completions');
  });
});

describe('prompt caching', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends OpenAI cache key/retention and reports cached tokens', async () => {
    const { calls } = mockFetch(openAiStop({ prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 80 } }));
    const events = await collect(adapterFor('openai').stream(resolved('openai'), chatReq({ promptCache: { key: 'tenant-1', retention: 'extended' } })));
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe('tenant-1');
    expect(body.prompt_cache_retention).toBe('24h');
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.usage).toEqual({ inputTokens: 100, outputTokens: 2, cachedInputTokens: 80, estimated: false });
  });

  it('uses prompt_cache_options for GPT-5.6+ on Responses', async () => {
    const { calls } = mockFetch(responsesDone({ usage: { input_tokens: 50, output_tokens: 1, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 30 } } }));
    const events = await collect(adapterFor('openai', undefined, 'responses').stream(resolved('openai'), chatReq({ model: 'gpt-5.6', promptCache: { retention: 'extended' } })));
    expect((calls[0]!.body as Record<string, unknown>).prompt_cache_options).toEqual({ ttl: '12h' });
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.usage).toMatchObject({ inputTokens: 50, cachedInputTokens: 10, cacheWriteTokens: 30 });
  });

  it('turns on Anthropic automatic caching and reports total input tokens', async () => {
    const { calls } = mockFetch(anthropicStop({ input_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }));
    const events = await collect(adapterFor('anthropic').stream(resolved('anthropic'), chatReq({ maxTokens: 10, promptCache: { retention: 'extended' } })));
    expect((calls[0]!.body as Record<string, unknown>).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.usage).toEqual({ inputTokens: 1250, outputTokens: 2, cachedInputTokens: 1000, cacheWriteTokens: 200, estimated: false });
  });

  it('says so instead of silently ignoring caching where there is no control', async () => {
    const { calls } = mockFetch(openAiStop());
    const events = await collect(adapterFor('groq').stream(resolved('groq'), chatReq({ promptCache: { key: 'k' } })));
    expect(events.some((e) => e.type === 'context' && e.kind === 'prompt_cache_unsupported')).toBe(true);
    expect(calls[0]!.body).not.toHaveProperty('prompt_cache_key');
  });
});

describe('rate-limit headers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses IETF RateLimit / RateLimit-Policy fields', () => {
    const info = parseRateLimitHeaders(new Headers({ RateLimit: '"burst";r=0;t=7, "daily";r=900;t=3600', 'RateLimit-Policy': '"burst";q=100;w=60, "daily";q=1000;w=86400' }));
    expect(info?.policies).toEqual([
      { name: 'burst', remaining: 0, resetSeconds: 7, quota: 100, windowSeconds: 60 },
      { name: 'daily', remaining: 900, resetSeconds: 3600, quota: 1000, windowSeconds: 86400 },
    ]);
    expect(info?.resetMs).toBe(7000);
  });

  it('parses OpenAI- and Anthropic-style vendor headers', () => {
    const openai = parseRateLimitHeaders(new Headers({ 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '499', 'x-ratelimit-reset-requests': '120ms', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '6m0s' }));
    expect(openai).toMatchObject({ limitRequests: 500, remainingRequests: 499, remainingTokens: 0, resetMs: 360_000 });
    const reset = new Date(Date.now() + 30_000).toISOString();
    const anthropic = parseRateLimitHeaders(new Headers({ 'anthropic-ratelimit-requests-remaining': '3', 'anthropic-ratelimit-requests-reset': reset }));
    expect(anthropic?.remainingRequests).toBe(3);
    expect(anthropic?.resetMs).toBeGreaterThan(25_000);
    expect(parseRateLimitHeaders(new Headers({ 'content-type': 'text/plain' }))).toBeUndefined();
  });

  it('backs off on a 429 by the exhausted window, and records rate limits', async () => {
    const records: CallRecord[] = [];
    mockFetch(
      new Response('slow down', { status: 429, headers: { RateLimit: '"default";r=0;t=0' } }),
      new Response(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]).body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-ratelimit-remaining-requests': '41' } }),
    );
    const events = await collect(handler({ K: 'k' }, records).stream({ id: 'o', provider: 'openai', keyRef: { kind: 'env', name: 'K' } }, chatReq()));
    const retry = events.find((e) => e.type === 'retry');
    expect(retry?.type === 'retry' && retry.delayMs).toBe(0);
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.rateLimit?.remainingRequests).toBe(41);
    expect(records[0]?.rateLimit?.remainingRequests).toBe(41);
  });

  it('attaches rate-limit info to the typed error', async () => {
    mockFetch(new Response('no', { status: 429, headers: { 'retry-after-ms': '2', 'x-ratelimit-remaining-requests': '0' } }));
    const h = new AIHandler({ keySource: memoryKeySource({ K: 'k' }), policy: allowAllPolicy(), retry: { maxAttempts: 1 } });
    await expect(h.chat({ id: 'o', provider: 'openai', keyRef: { kind: 'env', name: 'K' } }, chatReq()))
      .rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 2, rateLimit: { remainingRequests: 0 } });
  });
});

/** A minimal Standard Schema + Standard JSON Schema validator, as Zod 4.2+ exposes. */
function fakeSchema<T>(json: Record<string, unknown>, check: (v: unknown) => v is T): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake',
      validate: (value) => check(value) ? { value } : { issues: [{ message: 'bad value' }] },
      jsonSchema: {
        input: ({ target }) => ({ $schema: target, ...json }),
        output: ({ target }) => ({ $schema: target, ...json }),
      },
    },
  };
}
const citySchema = fakeSchema<{ city: string }>({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  (v): v is { city: string } => typeof (v as { city?: unknown })?.city === 'string');

describe('Standard JSON Schema', () => {
  afterEach(() => vi.restoreAllMocks());

  it('derives JSON Schema and strips the dialect marker', () => {
    expect(standardJsonSchema(citySchema)).toEqual({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] });
    expect(standardJsonSchema({ '~standard': { version: 1, vendor: 'x', validate: () => ({ value: 1 }) } })).toBeUndefined();
  });

  it('chatParsed sends the derived schema for constrained decoding', async () => {
    const { calls } = mockFetch(sseResponse([{ choices: [{ delta: { content: '{"city":"Oslo"}' }, finish_reason: 'stop' }] }]));
    const parsed = await handler({ K: 'k' }).chatParsed({ id: 'o', provider: 'openai', keyRef: { kind: 'env', name: 'K' } }, chatReq(), citySchema);
    expect(parsed.data).toEqual({ city: 'Oslo' });
    expect((calls[0]!.body as Record<string, any>).response_format.json_schema.schema).toEqual({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] });
  });

  it('defineTool takes an input schema, sends only name/description/parameters, and validates with it', async () => {
    const executed: unknown[] = [];
    const tool = defineTool({ name: 'weather', description: 'w', input: citySchema, execute: (args) => { executed.push(args); return 'sunny'; } });
    expect(tool.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] });
    const { calls } = mockFetch(
      sseResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'weather', arguments: '{"city":1}' } }] }, finish_reason: 'tool_calls' }] }]),
      sseResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'weather', arguments: '{"city":"Oslo"}' } }] }, finish_reason: 'tool_calls' }] }]),
      sseResponse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    );
    for await (const _ of runAgent({ handler: handler({ K: 'k' }), connection: { id: 'o', provider: 'openai', keyRef: { kind: 'env', name: 'K' } }, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool] })) { /* drain */ }
    expect(executed).toEqual([{ city: 'Oslo' }]);
    expect((calls[0]!.body as any).tools[0]).toEqual({ type: 'function', function: { name: 'weather', description: 'w', parameters: tool.parameters } });
    const toolReply = (calls[1]!.body as any).messages.find((m: any) => m.role === 'tool');
    expect(toolReply.content).toContain('bad value');
  });

  it('defineTool without parameters or a convertible schema fails clearly', () => {
    expect(() => defineTool({ name: 't', description: 'd', execute: () => 1 })).toThrow(/parameters/);
  });
});

describe('Open Responses', () => {
  afterEach(() => vi.restoreAllMocks());

  it('open-responses profile speaks the Responses protocol by default', async () => {
    const { calls } = mockFetch(responsesDone());
    const result = await handler().chat({ id: 'local', provider: 'open-responses', baseUrl: 'http://localhost:11434/v1' }, chatReq());
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/responses');
    expect(result.text).toBe('ok');
  });

  it('maps response.failed error types onto typed, retryable kinds', async () => {
    mockFetch(sseResponse([{ type: 'response.failed', response: { status: 'failed', error: { type: 'too_many_requests', message: 'busy' } } }]));
    await expect(collect(adapterFor('open-responses', 'http://x/v1').stream(resolved('open-responses', { baseUrl: 'http://x/v1' }), chatReq())))
      .rejects.toMatchObject({ kind: 'rate_limit', retryable: true });
  });

  it('surfaces slug-prefixed extension events and reasoning_text deltas', async () => {
    mockFetch(sseResponse([
      { type: 'acme:trace_event', sequence_number: 1, data: 'x' },
      { type: 'response.reasoning_text.delta', delta: 'thinking' },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ], false));
    const events = await collect(adapterFor('open-responses', 'http://x/v1').stream(resolved('open-responses', { baseUrl: 'http://x/v1' }), chatReq()));
    expect(events.some((e) => e.type === 'context' && e.kind === 'provider_event')).toBe(true);
    expect(events.some((e) => e.type === 'reasoning' && e.text === 'thinking')).toBe(true);
  });
});

describe('hosted MCP connectors', () => {
  afterEach(() => vi.restoreAllMocks());
  const server = { name: 'docs', url: 'https://mcp.example.com/mcp', authorization: { kind: 'env' as const, name: 'MCP_TOKEN' }, allowedTools: ['search'] };

  it('sends Anthropic mcp_servers + mcp_toolset with the beta header, token from the KeySource', async () => {
    const records: CallRecord[] = [];
    const { calls } = mockFetch(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'mcp_tool_use', id: 'm1', name: 'search', server_name: 'docs', input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]));
    const events = await collect(handler({ ANTHROPIC: 'sk-ant', MCP_TOKEN: 'mcp-secret-token-123' }, records).stream(
      { id: 'a', provider: 'anthropic', keyRef: { kind: 'env', name: 'ANTHROPIC' }, headers: { 'anthropic-beta': 'other-beta' } },
      chatReq({ maxTokens: 10, mcpServers: [server] }),
    ));
    const body = calls[0]!.body as Record<string, any>;
    expect(calls[0]!.headers['anthropic-beta']).toBe('other-beta,mcp-client-2025-11-20');
    expect(body.mcp_servers).toEqual([{ type: 'url', url: server.url, name: 'docs', authorization_token: 'mcp-secret-token-123' }]);
    expect(body.tools).toEqual([{ type: 'mcp_toolset', mcp_server_name: 'docs', default_config: { enabled: false }, configs: { search: { enabled: true } } }]);
    expect(events.some((e) => e.type === 'context' && e.kind === 'mcp_tool_use')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('mcp-secret-token-123');
  });

  it('sends Responses mcp tools', async () => {
    const { calls } = mockFetch(responsesDone());
    await handler({ K: 'k', MCP_TOKEN: 'tok' }).chat({ id: 'o', provider: 'openai', protocol: 'responses', keyRef: { kind: 'env', name: 'K' } }, chatReq({ mcpServers: [{ ...server, requireApproval: 'never' }] }));
    expect((calls[0]!.body as any).tools).toEqual([{ type: 'mcp', server_label: 'docs', server_url: server.url, authorization: 'tok', allowed_tools: ['search'], require_approval: 'never' }]);
  });

  it('is governed by checkMcpServer, requires https, and fails honestly elsewhere', async () => {
    const policy = composePolicies(allowAllPolicy(), mcpServerAllowlistPolicy(['https://trusted.example/']));
    const h = new AIHandler({ keySource: memoryKeySource({ K: 'k', MCP_TOKEN: 't' }), policy });
    const conn = { id: 'o', provider: 'openai', protocol: 'responses' as const, keyRef: { kind: 'env' as const, name: 'K' } };
    await expect(h.chat(conn, chatReq({ mcpServers: [server] }))).rejects.toMatchObject({ kind: 'policy_blocked' });
    await expect(handler({ K: 'k' }).chat(conn, chatReq({ mcpServers: [{ name: 'x', url: 'http://insecure.example' }] }))).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(handler({ K: 'k' }).chat(conn, chatReq({ mcpServers: [server] }))).rejects.toMatchObject({ kind: 'key_unavailable' });
    mockFetch();
    await expect(handler({ K: 'k' }).chat({ id: 'c', provider: 'openai', keyRef: { kind: 'env', name: 'K' } }, chatReq({ mcpServers: [{ name: 'x', url: 'https://ok.example' }] })))
      .rejects.toMatchObject({ kind: 'invalid_request' });
  });
});
