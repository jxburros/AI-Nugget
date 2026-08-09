import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AIHandler,
  memoryKeySource,
  profileFor,
  type CallInfo,
  type CallRecord,
  type Connection,
  type StandardSchemaV1,
  type StreamEvent,
} from '../src/index.js';
import { defineTool, runAgent, type AgentEvent } from '../src/agent/index.js';
import { jsonResponse, mockFetch, ndjsonResponse, sseResponse } from './helpers.js';

const key = memoryKeySource({ OPENAI_API_KEY: 'sk-test-value' });

function handler(over: Partial<ConstructorParameters<typeof AIHandler>[0]> = {}): AIHandler {
  return new AIHandler({ keySource: key, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, ...over });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const openaiText = (text: string) => sseResponse([
  { choices: [{ delta: { content: text }, finish_reason: 'stop' }] },
  { usage: { prompt_tokens: 2, completion_tokens: 3 }, choices: [] },
]);

describe('[4] providerOptions passthrough', () => {
  afterEach(() => vi.restoreAllMocks());

  it('merges Ollama options one level deep and forwards top-level keys', async () => {
    const { calls } = mockFetch(ndjsonResponse([{ message: { content: 'hi' } }, { prompt_eval_count: 1, eval_count: 1, done_reason: 'stop' }]));
    await handler().chat(
      { id: 'o', provider: 'ollama', keyRef: { kind: 'none' } },
      { model: 'llama', messages: [{ role: 'user', content: 'x' }], temperature: 0.2, providerOptions: { options: { num_ctx: 8192 }, keep_alive: '30m' } },
    );
    const body = calls[0]!.body as { options: Record<string, unknown>; keep_alive: string };
    expect(body.options.num_ctx).toBe(8192);
    expect(body.options.temperature).toBe(0.2); // nested merge keeps the nugget's samplers
    expect(body.keep_alive).toBe('30m');
  });

  it('forwards OpenAI-native fields at the top level', async () => {
    const { calls } = mockFetch(openaiText('ok'));
    await handler().chat(
      { id: 'c', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
      { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }], providerOptions: { reasoning_effort: 'high' } },
    );
    expect((calls[0]!.body as { reasoning_effort: string }).reasoning_effort).toBe('high');
  });
});

describe('[17] reasoning stream events', () => {
  afterEach(() => vi.restoreAllMocks());

  it('surfaces OpenAI reasoning_content on its own channel, not in the answer text', async () => {
    mockFetch(sseResponse([
      { choices: [{ delta: { reasoning_content: 'thinking' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [] },
    ]));
    const events = await collect(handler().stream(
      { id: 'c', provider: 'openai', keyRef: { kind: 'none' } },
      { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }] },
    ));
    expect(events.some((e) => e.type === 'reasoning' && e.text === 'thinking')).toBe(true);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.text).toBe('answer');
  });
});

describe('[20] new profiles + Azure api-version override', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers cerebras/moonshot/cohere/perplexity as hosted openaiChat providers', () => {
    for (const provider of ['cerebras', 'moonshot', 'cohere', 'perplexity']) {
      const profile = profileFor(provider);
      expect(profile.engine).toBe('openaiChat');
      expect(profile.capabilities.nativeTools).toBe(true);
      expect(profile.defaultBaseUrl).toBeTruthy();
    }
  });

  it('defaults Azure api-version but lets providerOptions override it', async () => {
    const conn: Connection = { id: 'az', provider: 'azure-openai', baseUrl: 'https://x.openai.azure.com', keyRef: { kind: 'none' } };
    const first = mockFetch(openaiText('a'));
    await handler().chat(conn, { model: 'dep', messages: [{ role: 'user', content: 'x' }] });
    expect(first.calls[0]!.url).toContain('api-version=2024-10-21');
    vi.restoreAllMocks();
    const second = mockFetch(openaiText('a'));
    await handler().chat(conn, { model: 'dep', messages: [{ role: 'user', content: 'x' }], providerOptions: { apiVersion: '2025-01-01-preview' } });
    expect(second.calls[0]!.url).toContain('api-version=2025-01-01-preview');
  });
});

describe('[23] embeddings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('embeds through Ollama /api/embed with one record', async () => {
    const records: CallRecord[] = [];
    const { calls } = mockFetch(jsonResponse({ embeddings: [[1, 2], [3, 4]], prompt_eval_count: 5 }));
    const result = await handler({ telemetry: { record: (r) => records.push(r) } }).embed(
      { id: 'o', provider: 'ollama', keyRef: { kind: 'none' } },
      { model: 'nomic', input: ['a', 'b'] },
    );
    expect(result.embeddings).toEqual([[1, 2], [3, 4]]);
    expect(result.usage.inputTokens).toBe(5);
    expect(calls[0]!.url).toMatch(/\/api\/embed$/);
    expect((calls[0]!.body as { input: string[] }).input).toEqual(['a', 'b']);
    expect(records).toHaveLength(1);
    expect(records[0]?.metadata?.operation).toBe('__embed__');
  });

  it('orders OpenAI embeddings by their reported index', async () => {
    mockFetch(jsonResponse({ data: [{ index: 1, embedding: [9] }, { index: 0, embedding: [8] }], usage: { prompt_tokens: 3 } }));
    const result = await handler().embed(
      { id: 'c', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
      { model: 'text-embedding-3-small', input: ['x', 'y'] },
    );
    expect(result.embeddings).toEqual([[8], [9]]);
  });

  it('fails honestly for a provider with no embeddings support', async () => {
    const records: CallRecord[] = [];
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(
      handler({ telemetry: { record: (r) => records.push(r) } }).embed(
        { id: 'a', provider: 'anthropic', keyRef: { kind: 'none' } },
        { model: 'claude', input: 'x' },
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(spy).not.toHaveBeenCalled();
    expect(records[0]?.error?.kind).toBe('invalid_request');
  });
});

describe('[15] chatParsed typed output', () => {
  afterEach(() => vi.restoreAllMocks());

  const numberSchema: StandardSchemaV1<{ n: number }> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => {
        const record = value as { n?: unknown };
        return typeof record?.n === 'number' ? { value: { n: record.n } } : { issues: [{ message: 'n must be a number' }] };
      },
    },
  };
  const conn: Connection = { id: 'c', provider: 'openai', keyRef: { kind: 'none' } };

  it('validates JSON output against a Standard Schema', async () => {
    mockFetch(openaiText('{"n": 5}'));
    const { data } = await handler().chatParsed(conn, { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }] }, numberSchema);
    expect(data).toEqual({ n: 5 });
  });

  it('performs exactly one corrective retry on a validation miss', async () => {
    const { calls } = mockFetch(openaiText('{"n": "nope"}'), openaiText('{"n": 7}'));
    const { data } = await handler().chatParsed(conn, { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }] }, numberSchema);
    expect(data).toEqual({ n: 7 });
    expect(calls).toHaveLength(2);
  });
});

describe('[24]/[22] pricing hook and resolved beforeCall', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records costUsd from the pricing hook', async () => {
    const records: CallRecord[] = [];
    mockFetch(openaiText('ok'));
    await handler({
      telemetry: { record: (r) => records.push(r) },
      pricing: ({ usage }) => (usage.outputTokens ?? 0) * 0.01,
    }).chat({ id: 'c', provider: 'openai', keyRef: { kind: 'none' } }, { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }] });
    expect(records[0]?.costUsd).toBeCloseTo(0.03);
  });

  it('passes the resolved connection (without the key) to beforeCall', async () => {
    let seen: CallInfo | undefined;
    mockFetch(openaiText('ok'));
    await handler({ hooks: { beforeCall: async (info) => { seen = info; } } }).chat(
      { id: 'c', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
      { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(seen?.resolved?.baseUrl).toContain('api.openai.com');
    expect(seen?.resolved && 'apiKey' in seen.resolved).toBe(false);
  });
});

describe('agent loop 0.5 behavior', () => {
  afterEach(() => vi.restoreAllMocks());

  const ollamaConn: Connection = { id: 'o', provider: 'ollama', keyRef: { kind: 'none' } };
  const openaiConn: Connection = { id: 'c', provider: 'openai', keyRef: { kind: 'none' } };
  const noop = defineTool<Record<string, never>, undefined>({
    name: 'noop', description: 'returns nothing',
    parameters: { type: 'object', properties: {} },
    execute: () => undefined,
  });
  const echo = defineTool<{ msg: string }, { echoed: string }>({
    name: 'echo', description: 'echo', parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    execute: (a) => ({ echoed: a.msg }),
  });
  const openaiToolStep = (name: string, args: unknown) => sseResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [] },
  ]);

  it('[9] does not crash when a tool returns undefined', async () => {
    mockFetch(openaiToolStep('noop', {}), openaiText('done'));
    const agent = runAgent({ handler: handler(), connection: openaiConn, model: 'gpt-x', tools: [noop], messages: [{ role: 'user', content: 'go' }] });
    const events = await drain(agent);
    const result = await agent.result;
    expect(result.stopReason).toBe('finished');
    expect(result.finalText).toBe('done');
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('null');
    expect(events.some((e) => e.type === 'tool_result' && !e.isError)).toBe(true);
  });

  it('[10] populates AgentResult.error when a run ends in error', async () => {
    mockFetch(jsonResponse({ error: 'nope' }, 401));
    const agent = runAgent({ handler: handler(), connection: openaiConn, model: 'gpt-x', tools: [], messages: [{ role: 'user', content: 'go' }] });
    await drain(agent);
    const result = await agent.result;
    expect(result.stopReason).toBe('error');
    expect(result.error?.kind).toBe('auth');
  });

  it('[7] emits tool_mode and does not leak a promptJson directive into deltas', async () => {
    mockFetch(
      ndjsonResponse([{ message: { content: '{"tool":"echo","input":{"msg":"hi"}}' } }, { prompt_eval_count: 1, eval_count: 1 }]),
      ndjsonResponse([{ message: { content: 'ok' } }, { prompt_eval_count: 1, eval_count: 1 }]),
    );
    const agent = runAgent({ handler: handler(), connection: ollamaConn, model: 'llama', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'promptJson' });
    const events = await drain(agent);
    expect(events.some((e) => e.type === 'tool_mode' && e.mode === 'promptJson')).toBe(true);
    const deltas = events.filter((e): e is Extract<AgentEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.text);
    expect(deltas).toEqual(['ok']); // the directive JSON was withheld; only the answer streamed
    expect(events.some((e) => e.type === 'tool_result' && (e.result as { echoed?: string }).echoed === 'hi')).toBe(true);
  });

  it('[6] modelCapabilities upgrades a local model to native tool-calling', async () => {
    mockFetch(ndjsonResponse([{ message: { content: 'hi' } }, { prompt_eval_count: 1, eval_count: 1 }]));
    const agent = runAgent({ handler: handler(), connection: ollamaConn, model: 'llama', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'auto', modelCapabilities: ['tools'] });
    const events = await drain(agent);
    expect(events.some((e) => e.type === 'tool_mode' && e.mode === 'native')).toBe(true);
  });

  it('[14] approvalMode:all makes tool_denied reachable for a plain tool', async () => {
    mockFetch(openaiToolStep('echo', { msg: 'x' }), openaiText('done'));
    const agent = runAgent({
      handler: handler(), connection: openaiConn, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }],
      approvalMode: 'all', approval: async () => 'deny',
    });
    const events = await drain(agent);
    expect(events.some((e) => e.type === 'tool_denied' && e.reason === 'Denied by approval gate')).toBe(true);
  });

  it('[12] caps and frames oversized tool results', async () => {
    const big = defineTool<Record<string, never>, { data: string }>({
      name: 'big', description: 'big', parameters: { type: 'object', properties: {} },
      execute: () => ({ data: 'x'.repeat(200) }),
    });
    mockFetch(openaiToolStep('big', {}), openaiText('done'));
    const agent = runAgent({
      handler: handler(), connection: openaiConn, model: 'gpt-x', tools: [big], messages: [{ role: 'user', content: 'go' }],
      toolResult: { maxChars: 20, wrapUntrusted: true },
    });
    await drain(agent);
    const toolMsg = (await agent.result).messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('truncated');
    expect(String(toolMsg?.content)).toContain('<untrusted_tool_output>');
  });
});

describe('[16] idle timeout does not break a healthy call', () => {
  afterEach(() => vi.restoreAllMocks());

  it('completes normally when idleTimeoutMs is set', async () => {
    mockFetch(openaiText('ok'));
    const result = await handler().chat(
      { id: 'c', provider: 'openai', keyRef: { kind: 'none' }, idleTimeoutMs: 5_000 },
      { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }] },
    );
    expect(result.text).toBe('ok');
  });
});
