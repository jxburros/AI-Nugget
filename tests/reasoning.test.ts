import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIHandler, memoryKeySource, createReasoningStripper, stripReasoningBlocks, containsReasoningBlock, type StreamEvent } from '../src/index.js';

/** Inline reasoning stripping (ported from AI Server Studio, 2026-09-05). */

describe('createReasoningStripper', () => {
  it('passes plain text through, including a lone "<"', () => {
    const s = createReasoningStripper();
    expect(s.push('a < b')).toEqual({ visible: 'a < b', reasoning: '' });
    expect(s.end()).toEqual({ visible: '', reasoning: '' });
  });

  it('removes a complete block and routes it to reasoning', () => {
    const s = createReasoningStripper();
    expect(s.push('<think>plan it</think>\nanswer')).toEqual({ visible: 'answer', reasoning: 'plan it' });
  });

  it('handles tags split across chunks', () => {
    const s = createReasoningStripper();
    const a = s.push('<thi');
    const b = s.push('nk>hidden</th');
    const c = s.push('ink>shown');
    const d = s.end();
    expect(a.visible + b.visible + c.visible + d.visible).toBe('shown');
    expect(a.reasoning + b.reasoning + c.reasoning + d.reasoning).toBe('hidden');
  });

  it('treats an unterminated block as reasoning to the end', () => {
    const s = createReasoningStripper();
    const a = s.push('<think>never closed');
    const b = s.end();
    expect(a.visible + b.visible).toBe('');
    expect(a.reasoning + b.reasoning).toBe('never closed');
  });

  it('consumes a template-opened block that only has a closing tag (orphan close)', () => {
    const s = createReasoningStripper();
    const a = s.push('thinking without an opening tag\n</think>\nreal answer');
    expect(a.visible).toBe('real answer');
    expect(a.reasoning).toBe('thinking without an opening tag\n');
  });

  it('leaves a closing tag quoted mid-sentence alone once visible text has gone out', () => {
    const s = createReasoningStripper();
    expect(s.push('The tag looks like </think> in text').visible).toBe('The tag looks like </think> in text');
  });

  it('whole-string helpers', () => {
    expect(stripReasoningBlocks('<reasoning>x</reasoning>y')).toBe('y');
    expect(containsReasoningBlock('a </think> b')).toBe(true);
    expect(containsReasoningBlock('plain')).toBe(false);
  });
});

describe('AIHandler strips inline reasoning on every engine by default', () => {
  afterEach(() => vi.restoreAllMocks());

  const sse = (frames: unknown[]) =>
    new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

  async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  }

  it('routes <think> blocks to reasoning events and cleans result.text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sse([
      { choices: [{ delta: { content: '<think>secret ' } }] },
      { choices: [{ delta: { content: 'plan</think>The ' } }] },
      { choices: [{ delta: { content: 'answer.' }, finish_reason: 'stop' }] },
    ]));
    const handler = new AIHandler({ keySource: memoryKeySource({ K: 'sk-abcdefghijklmnopqrstuvwxyz' }), silencePolicyWarning: true });
    const events = await collect(handler.stream(
      { id: 'c', provider: 'openai', keyRef: { kind: 'env', name: 'K' } },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    ));
    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => (e as { text: string }).text).join('');
    expect(deltas).toBe('The answer.');
    expect(reasoning).toBe('secret plan');
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('The answer.');
  });

  it('stripInlineReasoning: false leaves the raw text alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sse([
      { choices: [{ delta: { content: '<think>x</think>y' }, finish_reason: 'stop' }] },
    ]));
    const handler = new AIHandler({ keySource: memoryKeySource({ K: 'sk-abcdefghijklmnopqrstuvwxyz' }), silencePolicyWarning: true, stripInlineReasoning: false });
    const events = await collect(handler.stream(
      { id: 'c', provider: 'openai', keyRef: { kind: 'env', name: 'K' } },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    ));
    const done = events.at(-1);
    expect(done?.type === 'done' && done.result.text).toBe('<think>x</think>y');
  });
});
