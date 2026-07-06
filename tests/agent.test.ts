import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, memoryKeySource, type CallRecord, type Connection } from '../src/index.js';
import { defineTool, runAgent, type AgentEvent, type ApprovalGate } from '../src/agent/index.js';
import { mockFetch, sseResponse, streamingResponse } from './helpers.js';

const connection: Connection = { id: 'c1', provider: 'openai', keyRef: { kind: 'none' } };

function handlerWith(records: CallRecord[] = []): AIHandler {
  return new AIHandler({
    keySource: memoryKeySource({}),
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    telemetry: { record: (r) => records.push(r) },
  });
}

/** One OpenAI SSE step that returns a native tool call. */
function toolStep(name: string, args: unknown): Response {
  return sseResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] },
    { usage: { prompt_tokens: 2, completion_tokens: 2 }, choices: [] },
  ]);
}

/** One OpenAI SSE step that returns final assistant text. */
function textStep(text: string, tokens = 2): Response {
  return sseResponse([
    { choices: [{ delta: { content: text }, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: tokens, completion_tokens: tokens }, choices: [] },
  ]);
}

const echo = defineTool<{ msg: string }, { echoed: string }>({
  name: 'echo',
  description: 'Echo a message back',
  parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  execute: (args) => ({ echoed: args.msg }),
});

const add = defineTool<{ count: number }, { count: number }>({
  name: 'add',
  description: 'Add one',
  parameters: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
  execute: (args) => ({ count: args.count + 1 }),
});

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('agent loop', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs a native tool roundtrip and returns final text', async () => {
    const records: CallRecord[] = [];
    mockFetch(toolStep('echo', { msg: 'hi' }), textStep('done: hi'));
    const agent = runAgent({ handler: handlerWith(records), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'say hi' }] });
    const events = await drain(agent);
    const result = await agent.result;
    expect(result.stopReason).toBe('finished');
    expect(result.finalText).toBe('done: hi');
    expect(events.some((e) => e.type === 'tool_result' && !e.isError && (e.result as any).echoed === 'hi')).toBe(true);
    // every model call passed through the handler pipeline (one record per step, tagged with agentStep)
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.metadata?.agentStep)).toEqual([1, 2]);
  });

  it('self-corrects invalid tool args by feeding a tool_error back to the model', async () => {
    mockFetch(toolStep('echo', {}), toolStep('echo', { msg: 'fixed' }), textStep('ok'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }] });
    const events = await drain(agent);
    const result = await agent.result;
    expect(events.some((e) => e.type === 'tool_result' && e.isError && /missing required argument/i.test(String((e.result as any).error)))).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && !e.isError && (e.result as any).echoed === 'fixed')).toBe(true);
    expect(result.stopReason).toBe('finished');
  });

  it('continues after an approval denial (deny is data, not an exception)', async () => {
    const writeFile = defineTool({
      name: 'write_file', description: 'write', sideEffects: true,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: () => ({ written: true }),
    });
    const deny: ApprovalGate = async () => 'deny';
    mockFetch(toolStep('write_file', { path: '/etc/x' }), textStep('understood, skipped'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [writeFile], messages: [{ role: 'user', content: 'write' }], approval: deny });
    const events = await drain(agent);
    const result = await agent.result;
    expect(events.some((e) => e.type === 'tool_denied')).toBe(true);
    expect(result.stopReason).toBe('finished');
    expect(result.finalText).toBe('understood, skipped');
  });

  it('applies modifiedArguments from the approval gate', async () => {
    const captured: unknown[] = [];
    const writeFile = defineTool({
      name: 'write_file', description: 'write', sideEffects: true,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: (args) => { captured.push(args); return { written: true }; },
    });
    const modify: ApprovalGate = async () => ({ modifiedArguments: { path: '/safe/x' } });
    mockFetch(toolStep('write_file', { path: '/etc/x' }), textStep('done'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [writeFile], messages: [{ role: 'user', content: 'write' }], approval: modify });
    await drain(agent);
    expect(captured).toEqual([{ path: '/safe/x' }]);
  });

  it('validates modifiedArguments from the approval gate before executing', async () => {
    const captured: unknown[] = [];
    const writeFile = defineTool({
      name: 'write_file', description: 'write', sideEffects: true,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: (args) => { captured.push(args); return { written: true }; },
    });
    const modify: ApprovalGate = async () => ({ modifiedArguments: { path: 123 } });
    mockFetch(toolStep('write_file', { path: '/etc/x' }), textStep('fixed'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [writeFile], messages: [{ role: 'user', content: 'write' }], approval: modify });
    const events = await drain(agent);
    expect(captured).toEqual([]);
    expect(events.some((e) => e.type === 'tool_result' && e.isError && /must be string/i.test(String((e.result as any).error)))).toBe(true);
  });

  it('accepts integer JSON schema tool arguments', async () => {
    mockFetch(toolStep('add', { count: 2 }), textStep('3'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [add], messages: [{ role: 'user', content: 'add' }] });
    const events = await drain(agent);
    expect(events.some((e) => e.type === 'tool_result' && !e.isError && (e.result as any).count === 3)).toBe(true);
  });

  it('stops with max_steps when the model keeps calling tools', async () => {
    mockFetch(toolStep('echo', { msg: 'a' }));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], budget: { maxSteps: 1 } });
    await drain(agent);
    const result = await agent.result;
    expect(result.stopReason).toBe('max_steps');
  });

  it('stops with budget when accumulated tokens exceed maxTokens', async () => {
    mockFetch(toolStep('echo', { msg: 'a' }));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], budget: { maxTokens: 1, maxSteps: 5 } });
    await drain(agent);
    const result = await agent.result;
    expect(result.stopReason).toBe('budget');
  });

  it('stops with deadline when the wall-clock budget elapses', async () => {
    const slow = defineTool({
      name: 'slow', description: 'slow tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true }; },
    });
    mockFetch(toolStep('slow', {}), textStep('never reached'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [slow], messages: [{ role: 'user', content: 'go' }], budget: { deadlineMs: 10, maxSteps: 5 } });
    await drain(agent);
    const result = await agent.result;
    expect(result.stopReason).toBe('deadline');
  });

  it('uses deadlineMs to abort an in-flight model call', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init: RequestInit = {}) =>
      streamingResponse([], { signal: init.signal ?? undefined, hangUntilAbort: true }));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], budget: { deadlineMs: 5, maxSteps: 5 } });
    await drain(agent);
    const result = await agent.result;
    expect(result.stopReason).toBe('deadline');
  });

  it('stops with canceled when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], signal: ac.signal });
    await drain(agent);
    const result = await agent.result;
    expect(result.stopReason).toBe('canceled');
  });

  it('reaches the same tool result in promptJson mode as in native mode', async () => {
    // native
    mockFetch(toolStep('echo', { msg: 'parity' }), textStep('native done'));
    const nativeAgent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'native' });
    const nativeEvents = await drain(nativeAgent);
    vi.restoreAllMocks();
    // promptJson: model answers with a JSON tool directive as plain text
    mockFetch(textStep(JSON.stringify({ tool: 'echo', input: { msg: 'parity' } })), textStep('prompt done'));
    const promptAgent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'promptJson' });
    const promptEvents = await drain(promptAgent);

    const nativeResult = nativeEvents.find((e) => e.type === 'tool_result') as any;
    const promptResult = promptEvents.find((e) => e.type === 'tool_result') as any;
    expect(nativeResult.result).toEqual({ echoed: 'parity' });
    expect(promptResult.result).toEqual({ echoed: 'parity' });
  });

  it('runs several tools from one promptJson turn via the {"tools":[...]} form', async () => {
    // Model answers with a batched directive: two echo calls in a single turn.
    mockFetch(
      textStep(JSON.stringify({ tools: [{ tool: 'echo', input: { msg: 'one' } }, { tool: 'echo', input: { msg: 'two' } }] })),
      textStep('both done'),
    );
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'promptJson' });
    const events = await drain(agent);
    const result = await agent.result;
    const echoed = events.filter((e) => e.type === 'tool_result' && !e.isError).map((e) => (e.result as any).echoed);
    expect(echoed).toEqual(['one', 'two']);
    // Both calls belong to the same step, matching native multi-tool behavior.
    expect(events.filter((e) => e.type === 'tool_start').every((e) => (e as any).step === 1)).toBe(true);
    expect(result.stopReason).toBe('finished');
  });

  it('injects the tool directory into the prompt in promptJson mode', async () => {
    const { calls } = mockFetch(textStep('all done'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'promptJson' });
    await drain(agent);
    const body = calls[0]!.body as Record<string, any>;
    const system = body.messages.find((m: any) => m.role === 'system');
    expect(system.content).toContain('echo');
    // promptJson mode must NOT send native tools
    expect(body.tools).toBeUndefined();
  });

  it('serializes promptJson history as plain text instead of native tool wire format', async () => {
    const { calls } = mockFetch(textStep(JSON.stringify({ tool: 'echo', input: { msg: 'plain' } })), textStep('done'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'promptJson' });
    await drain(agent);
    const secondBody = calls[1]!.body as Record<string, any>;
    expect(JSON.stringify(secondBody.messages)).not.toContain('tool_calls');
    expect(JSON.stringify(secondBody.messages)).not.toContain('tool_call_id');
    expect(secondBody.messages.some((m: any) => m.role === 'user' && /Tool echo returned/.test(m.content))).toBe(true);
  });

  it('auto mode sends native tools for a hosted provider with reliable tool-calling', async () => {
    const { calls } = mockFetch(toolStep('echo', { msg: 'hi' }), textStep('done'));
    const agent = runAgent({ handler: handlerWith(), connection, model: 'gpt-x', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'auto' });
    await drain(agent);
    const body = calls[0]!.body as Record<string, any>;
    expect(body.tools).toBeDefined();
    expect(body.messages.some((m: any) => m.role === 'system')).toBe(false);
  });

  it('auto mode falls back to promptJson for a local-runtime connection (no toolMode specified either)', async () => {
    const local: Connection = { id: 'c2', provider: 'llamacpp', keyRef: { kind: 'none' } };
    const { calls } = mockFetch(textStep(JSON.stringify({ tool: 'echo', input: { msg: 'local' } })), textStep('done'));
    const agent = runAgent({ handler: handlerWith(), connection: local, model: 'llama3.2', tools: [echo], messages: [{ role: 'user', content: 'go' }] });
    const events = await drain(agent);
    const body = calls[0]!.body as Record<string, any>;
    expect(body.tools).toBeUndefined();
    expect(body.messages.some((m: any) => m.role === 'system' && /echo/.test(m.content))).toBe(true);
    const toolResult = events.find((e) => e.type === 'tool_result') as any;
    expect(toolResult.result).toEqual({ echoed: 'local' });
  });

  it('an explicit toolMode overrides the auto/capability default', async () => {
    const local: Connection = { id: 'c2', provider: 'llamacpp', keyRef: { kind: 'none' } };
    const { calls } = mockFetch(toolStep('echo', { msg: 'forced-native' }), textStep('done'));
    const agent = runAgent({ handler: handlerWith(), connection: local, model: 'llama3.2', tools: [echo], messages: [{ role: 'user', content: 'go' }], toolMode: 'native' });
    await drain(agent);
    const body = calls[0]!.body as Record<string, any>;
    expect(body.tools).toBeDefined();
  });
});
