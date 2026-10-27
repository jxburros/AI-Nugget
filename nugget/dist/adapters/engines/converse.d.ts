import type { ChatRequest, ChatResult, ProviderAdapter, ResolvedConnection, StreamEvent } from '../../types.js';
/** Bedrock native Converse/ConverseStream, distinct from its compatible APIs. */
export declare class ConverseAdapter implements ProviderAdapter {
    readonly provider: string;
    constructor(provider: string);
    chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
    health(): Promise<{
        ok: boolean;
        detail: string;
    }>;
    stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
}
//# sourceMappingURL=converse.d.ts.map