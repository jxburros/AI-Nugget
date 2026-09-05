import type { ChatRequest, ChatResult, EmbedRequest, EmbedResult, ProviderAdapter, ResolvedConnection, StreamEvent } from '../../types.js';
import type { ProviderProfile } from '../profiles.js';
export declare class OpenAIChatAdapter implements ProviderAdapter {
    private profile;
    readonly provider: string;
    constructor(provider: string, profile: ProviderProfile);
    chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
    stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
    listModels(conn: ResolvedConnection): Promise<import("../../types.js").ModelInfo[]>;
    health(conn: ResolvedConnection): Promise<{
        ok: boolean;
        detail?: string;
    }>;
    embed(conn: ResolvedConnection, req: EmbedRequest): Promise<EmbedResult>;
}
/**
 * True when a `/chat/completions` 400 is the "function tools with reasoning_effort
 * are not supported" refusal AND the request actually carried tools AND the caller
 * did not already pin `reasoning_effort` (in which case the choice is theirs).
 */
export declare function shouldRetryWithoutReasoningEffort(error: unknown, req: ChatRequest): boolean;
//# sourceMappingURL=openaiChat.d.ts.map