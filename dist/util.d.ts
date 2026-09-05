import type { ChatMessage } from './types.js';
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function asString(value: unknown): string | undefined;
export declare function asNumber(value: unknown): number | undefined;
export declare function promptChars(messages: ChatMessage[]): number;
export declare function textFromMessages(messages: ChatMessage[]): string;
export declare function globalEnv(): Record<string, string | undefined>;
/**
 * Merges app-supplied {@link ChatRequest.providerOptions} into a provider
 * request body: shallow at the top level, and one level deep for each key in
 * `nestedKeys` where both sides are plain objects (Ollama `options`, Google
 * `generationConfig`). Values in `providerOptions` win on collision.
 */
export declare function applyProviderOptions(body: Record<string, unknown>, providerOptions: Record<string, unknown> | undefined, nestedKeys?: readonly string[]): Record<string, unknown>;
/** Joins a base URL and path without producing a double slash, even if `base` ends with `/`. */
export declare function joinUrl(base: string, path: string): string;
/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the returned array. Used to probe many local models
 * concurrently without opening an unbounded number of sockets.
 */
export declare function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
/**
 * Token budgets behind the {@link ReasoningEffort} tiers for providers that
 * express effort as a thinking-token budget (Anthropic `budget_tokens`, Google
 * `thinkingBudget`). `'none'` is 0. Deliberately conservative: they are floors
 * a model may stop under, not ceilings it fills.
 */
export declare const REASONING_BUDGET_TOKENS: Record<'none' | 'minimal' | 'low' | 'medium' | 'high', number>;
//# sourceMappingURL=util.d.ts.map