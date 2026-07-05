import type { ChatRequest, ChatResult, ModelInfo, ProviderAdapter, ResolvedConnection, StreamEvent } from '../../types.js';
export declare class OllamaAdapter implements ProviderAdapter {
    readonly provider: string;
    constructor(provider: string);
    chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
    stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
    listModels(conn: ResolvedConnection): Promise<ModelInfo[]>;
}
//# sourceMappingURL=ollama.d.ts.map