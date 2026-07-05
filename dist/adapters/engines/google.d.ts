import type { ChatRequest, ChatResult, ProviderAdapter, ResolvedConnection, StreamEvent } from '../../types.js';
export declare class GoogleAdapter implements ProviderAdapter {
    readonly provider: string;
    constructor(provider: string);
    chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
    stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
}
//# sourceMappingURL=google.d.ts.map