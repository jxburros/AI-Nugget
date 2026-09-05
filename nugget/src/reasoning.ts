/**
 * Inline reasoning stripper — keeps a reasoning model's chain of thought out of `delta` events
 * and `ChatResult.text`, routing it to the `reasoning` stream event instead.
 *
 * Reasoning models (deepseek-r1, phi4-reasoning, qwq, …) emit their thinking either in the
 * provider's dedicated field — which every engine already maps to `{ type: 'reasoning' }` — or
 * INLINE in the answer as `<think>…</think>`-style blocks. Inline reasoning routinely quotes the
 * system prompt and tool instructions back verbatim, so an app that streams `delta` straight to
 * a screen, a database or a JSON parser leaks it. Every consumer would otherwise write this
 * state machine, and most would get the split-tag and template-opened cases wrong; the handler
 * runs it once, on every engine, unless `HandlerOptions.stripInlineReasoning` is `false`.
 *
 * Ported from AI Server Studio's `services/reasoningFilter.ts` (2026-09-05), which had to exist
 * because the nugget did not do this.
 *
 * Two subtleties the tests pin:
 *   - Tags may be split across chunks, so a trailing partial `<thi` is held back until the next
 *     chunk decides whether it opens a tag. An unterminated block is reasoning to the end.
 *   - The **orphan close**: a closing tag with no opening one at the head of the stream, because
 *     the runtime's chat template emitted `<think>` itself. Handled once per stream, only before
 *     any visible text has gone out, and only when the closing tag starts its own line — a
 *     `</think>` quoted mid-sentence in a real answer is left alone.
 */

const TAG_PAIRS: { open: string; close: string }[] = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
  { open: '<reasoning>', close: '</reasoning>' },
  { open: '<|begin_of_thought|>', close: '<|end_of_thought|>' },
];

const LONGEST_TAG = Math.max(...TAG_PAIRS.flatMap((p) => [p.open.length, p.close.length]));

export interface ReasoningStripResult {
  /** Text safe to show from this chunk (may be empty). */
  visible: string;
  /** Reasoning text removed from this chunk (may be empty). */
  reasoning: string;
}

export interface ReasoningStripper {
  /** Feed the next raw delta; returns what may be shown and what was reasoning. */
  push(chunk: string): ReasoningStripResult;
  /** End of stream: flushes any held-back prefix that never became a tag. */
  end(): ReasoningStripResult;
  /** True while inside an unterminated reasoning block. */
  readonly inReasoning: boolean;
}

function partialTagSuffixLength(text: string): number {
  const lower = text.toLowerCase();
  const maxLen = Math.min(LONGEST_TAG - 1, lower.length);
  for (let len = maxLen; len >= 1; len -= 1) {
    const tail = lower.slice(lower.length - len);
    if (tail[0] !== '<') continue;
    for (const pair of TAG_PAIRS) {
      if (pair.open.startsWith(tail) || pair.close.startsWith(tail)) return len;
    }
  }
  return 0;
}

function closesOwnLine(text: string, idx: number): boolean {
  let i = idx - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i -= 1;
  return i < 0 || text[i] === '\n';
}

export function createReasoningStripper(): ReasoningStripper {
  let pending = '';
  let inReasoning = false;
  let closeTag = '';
  let emittedVisible = false;
  let orphanConsumed = false;

  function process(input: string, flushAll: boolean): ReasoningStripResult {
    let text = pending + input;
    pending = '';
    let visible = '';
    let reasoning = '';

    while (text.length > 0) {
      const lower = text.toLowerCase();
      if (inReasoning) {
        const idx = lower.indexOf(closeTag);
        if (idx === -1) {
          const hold = flushAll ? 0 : partialTagSuffixLength(text);
          const consumed = text.length - hold;
          reasoning += text.slice(0, consumed);
          pending = text.slice(consumed);
          text = '';
          if (flushAll) {
            reasoning += pending;
            pending = '';
          }
          break;
        }
        reasoning += text.slice(0, idx);
        text = text.slice(idx + closeTag.length);
        inReasoning = false;
        closeTag = '';
        if (text.startsWith('\n')) text = text.slice(1);
        continue;
      }
      let openIdx = -1;
      let pair: { open: string; close: string } | null = null;
      for (const p of TAG_PAIRS) {
        const i = lower.indexOf(p.open);
        if (i !== -1 && (openIdx === -1 || i < openIdx)) {
          openIdx = i;
          pair = p;
        }
      }
      let orphanCloseIdx = -1;
      let orphanCloseLen = 0;
      if (!emittedVisible && !orphanConsumed) {
        for (const p of TAG_PAIRS) {
          const i = lower.indexOf(p.close);
          if (i !== -1 && (orphanCloseIdx === -1 || i < orphanCloseIdx) && closesOwnLine(text, i)) {
            orphanCloseIdx = i;
            orphanCloseLen = p.close.length;
          }
        }
      }
      if (orphanCloseIdx !== -1 && (openIdx === -1 || orphanCloseIdx < openIdx)) {
        orphanConsumed = true;
        reasoning += text.slice(0, orphanCloseIdx);
        text = text.slice(orphanCloseIdx + orphanCloseLen).replace(/^\n+/, '');
        continue;
      }
      if (openIdx === -1 || !pair) {
        const hold = flushAll ? 0 : partialTagSuffixLength(text);
        visible += text.slice(0, text.length - hold);
        pending = text.slice(text.length - hold);
        text = '';
        break;
      }
      visible += text.slice(0, openIdx);
      text = text.slice(openIdx + pair.open.length);
      inReasoning = true;
      closeTag = pair.close;
    }
    if (visible.trim().length > 0) emittedVisible = true;
    return { visible, reasoning };
  }

  return {
    push: (chunk) => process(chunk, false),
    end: () => process('', true),
    get inReasoning() {
      return inReasoning;
    },
  };
}

/** Whole-string form: `{ visible, reasoning }` for already-buffered text. */
export function stripReasoningBlocksDetailed(text: string): ReasoningStripResult {
  if (!text) return { visible: '', reasoning: '' };
  const stripper = createReasoningStripper();
  const a = stripper.push(text);
  const b = stripper.end();
  return { visible: (a.visible + b.visible).trim(), reasoning: a.reasoning + b.reasoning };
}

/** Whole-string form returning only the visible text. */
export function stripReasoningBlocks(text: string): string {
  return stripReasoningBlocksDetailed(text).visible;
}

/** Cheap pre-check: does `text` carry any inline reasoning tag (open or close)? */
export function containsReasoningBlock(text: string): boolean {
  const lower = text.toLowerCase();
  return TAG_PAIRS.some((p) => lower.includes(p.open) || lower.includes(p.close));
}
