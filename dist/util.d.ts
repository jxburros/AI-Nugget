import type { ChatMessage } from './types.js';
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function asString(value: unknown): string | undefined;
export declare function asNumber(value: unknown): number | undefined;
export declare function promptChars(messages: ChatMessage[]): number;
export declare function textFromMessages(messages: ChatMessage[]): string;
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=util.d.ts.map