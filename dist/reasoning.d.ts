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
export declare function createReasoningStripper(): ReasoningStripper;
/** Whole-string form: `{ visible, reasoning }` for already-buffered text. */
export declare function stripReasoningBlocksDetailed(text: string): ReasoningStripResult;
/** Whole-string form returning only the visible text. */
export declare function stripReasoningBlocks(text: string): string;
/** Cheap pre-check: does `text` carry any inline reasoning tag (open or close)? */
export declare function containsReasoningBlock(text: string): boolean;
//# sourceMappingURL=reasoning.d.ts.map