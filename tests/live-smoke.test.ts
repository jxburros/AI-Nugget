import { describe, expect, it } from 'vitest';
import {
  AIHandler,
  chainKeySources,
  envKeySource,
  extractJson,
  literalKeySource,
  type ChatRequest,
  type Connection,
  type StreamEvent,
} from '../src/index.js';
import { defineTool, runAgent } from '../src/agent/index.js';

/**
 * Optional, env-gated live smoke tests. They are SKIPPED unless
 * `AI_HANDLER_LIVE=1`, so they never run in the deterministic suite or in CI by
 * default (design §10 / development-plan Phase 2). They exercise the real wire
 * path against a live provider — local Ollama by default.
 *
 * Configure via environment:
 *   AI_HANDLER_LIVE=1                 enable this suite
 *   AI_HANDLER_LIVE_PROVIDER=ollama   profile key (default: ollama)
 *   AI_HANDLER_LIVE_MODEL=llama3.2    model id     (default: llama3.2)
 *   AI_HANDLER_LIVE_BASE_URL=...      override the profile default base URL
 *   AI_HANDLER_LIVE_KEY=sk-...        literal API key (cloud providers)
 *   AI_HANDLER_LIVE_KEY_ENV=OPENAI_API_KEY   OR resolve the key from this env var
 *   AI_HANDLER_LIVE_JSON=1            also run the JSON-mode check (capable model)
 *   AI_HANDLER_LIVE_TOOLS=1           also run the agent tool-loop check (tool-capable model)
 *
 * Examples:
 *   AI_HANDLER_LIVE=1 npm run test:live
 *   AI_HANDLER_LIVE=1 AI_HANDLER_LIVE_PROVIDER=openai \
 *     AI_HANDLER_LIVE_MODEL=gpt-4o-mini AI_HANDLER_LIVE_KEY_ENV=OPENAI_API_KEY npm run test:live
 */

const env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {};
const LIVE = env.AI_HANDLER_LIVE === '1';
const PROVIDER = env.AI_HANDLER_LIVE_PROVIDER ?? 'ollama';
const MODEL = env.AI_HANDLER_LIVE_MODEL ?? 'llama3.2';
const BASE_URL = env.AI_HANDLER_LIVE_BASE_URL;
const LITERAL_KEY = env.AI_HANDLER_LIVE_KEY;
const KEY_ENV = env.AI_HANDLER_LIVE_KEY_ENV;
const RUN_JSON = env.AI_HANDLER_LIVE_JSON === '1';
const RUN_TOOLS = env.AI_HANDLER_LIVE_TOOLS === '1';
const TIMEOUT = 120_000;

function handler(): AIHandler {
  const keySource = LITERAL_KEY ? chainKeySources(literalKeySource(), envKeySource()) : envKeySource();
  return new AIHandler({ keySource, retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 4000 } });
}

function connection(): Connection {
  const conn: Connection = { id: 'live', provider: PROVIDER };
  if (BASE_URL) conn.baseUrl = BASE_URL;
  if (LITERAL_KEY) conn.keyRef = { kind: 'literal', value: LITERAL_KEY };
  else if (KEY_ENV) conn.keyRef = { kind: 'env', name: KEY_ENV };
  else conn.keyRef = { kind: 'none' };
  return conn;
}

function userReq(prompt: string, over: Partial<ChatRequest> = {}): ChatRequest {
  return { model: MODEL, messages: [{ role: 'user', content: prompt }], maxTokens: 256, ...over };
}

describe.runIf(LIVE)(`live smoke: ${PROVIDER}/${MODEL}`, () => {
  it('reports a healthy connection', async () => {
    const result = await handler().testConnection(connection());
    expect(result.ok, result.message).toBe(true);
  }, TIMEOUT);

  it('lists models with source provenance', async () => {
    const models = await handler().listModels(connection());
    expect(Array.isArray(models)).toBe(true);
    for (const model of models) {
      expect(model.source.provider).toBe(PROVIDER);
      expect(model.source.connectionId).toBe('live');
    }
  }, TIMEOUT);

  it('streams a chat completion with deltas, usage, and timing', async () => {
    const events: StreamEvent[] = [];
    for await (const event of handler().stream(connection(), userReq('Reply with a short greeting.'))) {
      events.push(event);
    }
    expect(events[0]?.type).toBe('start');
    expect(events.some((e) => e.type === 'delta' && e.text.length > 0)).toBe(true);
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.result.text.trim().length).toBeGreaterThan(0);
      expect(done.result.finishReason).toBe('stop');
      expect(done.result.timing.totalMs).toBeGreaterThanOrEqual(0);
      expect(done.result.usage).toBeDefined();
      expect(done.result.source.provider).toBe(PROVIDER);
    }
  }, TIMEOUT);

  it('completes a buffered chat() call', async () => {
    const result = await handler().chat(connection(), userReq('Name one primary color in one word.'));
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, TIMEOUT);

  it.runIf(RUN_JSON)('returns parseable JSON in json response mode', async () => {
    const result = await handler().chat(connection(), userReq(
      'Return a JSON object with keys "color" (a string) and "count" (a number).',
      { responseFormat: { type: 'json', schema: { type: 'object', properties: { color: { type: 'string' }, count: { type: 'number' } } } } },
    ));
    const parsed = extractJson(result.text);
    expect(parsed, `model output was not JSON: ${result.text}`).not.toBeNull();
    expect(typeof parsed).toBe('object');
  }, TIMEOUT);

  it.runIf(RUN_TOOLS)('drives a two-step agent tool loop end to end', async () => {
    const calls: unknown[] = [];
    const add = defineTool<{ a: number; b: number }, { sum: number }>({
      name: 'add',
      description: 'Add two numbers and return their sum.',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      execute: (args) => { calls.push(args); return { sum: args.a + args.b }; },
    });
    const agent = runAgent({
      handler: handler(),
      connection: connection(),
      model: MODEL,
      tools: [add],
      messages: [{ role: 'user', content: 'Use the add tool to compute 21 + 21, then tell me the result.' }],
      budget: { maxSteps: 4 },
    });
    for await (const _event of agent) void _event;
    const result = await agent.result;
    // Honest assertion: the loop must terminate cleanly (not error/cancel).
    expect(['finished', 'max_steps']).toContain(result.stopReason);
    // If the model used the tool at all, it must have been invoked with validated args.
    if (calls.length > 0) expect(calls[0]).toMatchObject({ a: expect.any(Number), b: expect.any(Number) });
  }, TIMEOUT);
});
