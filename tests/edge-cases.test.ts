import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, memoryKeySource, type CallRecord, type Connection, type KeyRef, type KeySource } from '../src/index.js';
import { defineTool, runAgent, type AgentEvent } from '../src/agent/index.js';
import { mockFetch, sseResponse, textResponse } from './helpers.js';

function handlerWith(records: CallRecord[] = [], keySource: KeySource = memoryKeySource({})): AIHandler {
  return new AIHandler({ keySource, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, telemetry: { record: (r) => records.push(r) } });
}

const echo = defineTool<{ msg: string }, { echoed: string }>({
  name: 'echo',
  description: 'Echo a message back',
  parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  execute: (args) => ({ echoed: args.msg }),
});

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** One OpenAI SSE step returning a native tool call. */
function toolStep(name: string, args: unknown) {
  return sseResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] },
    { usage: { prompt_tokens: 2, completion_tokens: 2 }, choices: [] },
  ]);
}
function textStep(text: string) {
  return sseResponse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }, { usage: { prompt_tokens: 2, completion_tokens: 2 }, choices: [] }]);
}

describe('agent auto tool mode (end to end)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('takes the native path for a native-capable provider under auto', async () => {
    const { calls } = mockFetch(toolStep('echo', { msg: 'hi' }), textStep('done'));
    const conn: Connection = { id: 'c1', provider: 'openai', keyRef: { kind: 'none' } };
    const agent = runAgent({ handler: handlerWith(), connection: conn, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'auto' });
    await drain(agent);
    const body = calls[0]!.body as Record<string, any>;
    // native path: real `tools` sent, no promptJson system directive injected
    expect(body.tools?.[0]?.function?.name).toBe('echo');
    expect(body.messages.some((m: any) => m.role === 'system' && /respond only with JSON/i.test(m.content))).toBe(false);
  });

  it('takes the promptJson path for a local provider under auto', async () => {
    // Ollama NDJSON step: model answers with a JSON tool directive as plain text.
    const directive = JSON.stringify({ tool: 'echo', input: { msg: 'hi' } });
    const ndjson = (obj: unknown) => new Response(JSON.stringify(obj) + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    const { calls } = mockFetch(
      ndjson({ message: { content: directive }, done: true, done_reason: 'stop', prompt_eval_count: 2, eval_count: 2 }),
      ndjson({ message: { content: 'done' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }),
    );
    const conn: Connection = { id: 'c1', provider: 'ollama', keyRef: { kind: 'none' } };
    const agent = runAgent({ handler: handlerWith(), connection: conn, model: 'llama3.2', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'auto' });
    const events = await drain(agent);
    const body = calls[0]!.body as Record<string, any>;
    // promptJson path: NO native tools, system directive injected, tool still runs
    expect(body.tools).toBeUndefined();
    expect(body.messages.some((m: any) => m.role === 'system' && /respond only with JSON/i.test(m.content))).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && !e.isError && (e.result as any).echoed === 'hi')).toBe(true);
  });
});

describe('edge cases: key, approval, and stream errors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('denies a side-effecting tool when no approval gate is configured', async () => {
    const writeFile = defineTool({
      name: 'write_file', description: 'write', sideEffects: true,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: () => ({ written: true }),
    });
    mockFetch(toolStep('write_file', { path: '/etc/x' }), textStep('skipped'));
    const conn: Connection = { id: 'c1', provider: 'openai', keyRef: { kind: 'none' } };
    const agent = runAgent({ handler: handlerWith(), connection: conn, model: 'gpt-x', tools: [writeFile], messages: [{ role: 'user', content: 'go' }] });
    const events = await drain(agent);
    const denied = events.find((e) => e.type === 'tool_denied') as any;
    expect(denied?.reason).toMatch(/no approval gate/i);
    expect((await agent.result).stopReason).toBe('finished');
  });

  it('stops the agent loop with stopReason "error" when the handler surfaces auth failure', async () => {
    const locking: KeySource = { resolve: async (ref: KeyRef) => ref.kind === 'none' ? { ok: false, reason: 'locked' } : { ok: false, reason: 'locked' } };
    const conn: Connection = { id: 'c1', provider: 'openai', keyRef: { kind: 'brokered', ref: 'secret://x' } };
    const agent = runAgent({ handler: handlerWith([], locking), connection: conn, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }] });
    await drain(agent);
    expect((await agent.result).stopReason).toBe('error');
  });

  it('records a locked-key failure as one telemetry row and an error event', async () => {
    const records: CallRecord[] = [];
    const locking: KeySource = { resolve: async () => ({ ok: false, reason: 'locked' }) };
    const handler = new AIHandler({ keySource: locking, telemetry: { record: (r) => records.push(r) } });
    const conn: Connection = { id: 'c1', provider: 'openai', keyRef: { kind: 'brokered', ref: 'secret://x' } };
    const out: AgentEvent[] = [];
    for await (const e of handler.stream(conn, { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })) out.push(e as AgentEvent);
    expect(out.at(-1)?.type).toBe('error');
    expect(records).toHaveLength(1);
    expect(records[0]?.error?.kind).toBe('key_unavailable');
  });

  it('surfaces a 500 as a retryable error event after exhausting attempts, still recording it', async () => {
    const records: CallRecord[] = [];
    mockFetch(textResponse('boom', 500), textResponse('boom', 500));
    const handler = new AIHandler({ keySource: memoryKeySource({}), retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, telemetry: { record: (r) => records.push(r) } });
    const conn: Connection = { id: 'c1', provider: 'openai', keyRef: { kind: 'none' } };
    const out: AgentEvent[] = [];
    for await (const e of handler.stream(conn, { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] })) out.push(e as AgentEvent);
    expect(out.at(-1)?.type).toBe('error');
    expect((out.at(-1) as any).error.kind).toBe('server');
    expect(records).toHaveLength(1);
    expect(records[0]?.attempts).toBe(2);
  });
});
