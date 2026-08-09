import type { ChatRequest, ChatResult, ModelInfo, ProviderAdapter, ResolvedConnection, StreamEvent } from '../../types.js';
export declare class AnthropicAdapter implements ProviderAdapter {
    readonly provider: string;
    constructor(provider: string);
    chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
    stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
    /**
     * Lists models from Anthropic's `/v1/models` endpoint (auth + version headers
     * already applied to `conn.headers`). The endpoint does not report a context
     * window, so `contextWindow` is left undefined rather than guessed.
     */
    listModels(conn: ResolvedConnection): Promise<ModelInfo[]>;
}
//# sourceMappingURL=anthropic.d.ts.map