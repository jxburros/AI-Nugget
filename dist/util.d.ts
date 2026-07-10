import type { ChatMessage } from './types.js';
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function asString(value: unknown): string | undefined;
export declare function asNumber(value: unknown): number | undefined;
/**
 * Character-count proxy for telemetry, not a token estimate. Intentionally
 * includes base64 image payload length alongside text — a request with
 * images is genuinely more expensive to send, so the inflated count is a
 * feature for cost-shaped telemetry, not a bug to weight away.
 */
export declare function promptChars(messages: ChatMessage[]): number;
export declare function textFromMessages(messages: ChatMessage[]): string;
export declare function globalEnv(): Record<string, string | undefined>;
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=util.d.ts.map