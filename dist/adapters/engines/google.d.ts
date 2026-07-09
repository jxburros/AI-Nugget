import type { ChatRequest, ChatResult, ProviderAdapter, ResolvedConnection, StreamEvent } from '../../types.js';
export declare class GoogleAdapter implements ProviderAdapter {
    readonly provider: string;
    constructor(provider: string);
    chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
    stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
    /**
     * `GoogleAdapter` has no `listModels`, so without a `health` probe
     * `AIHandler.testConnection` would report `ok: true` without ever making a
     * network call. `/v1beta/models` is a lightweight, key-authenticated GET
     * that gives an honest connectivity/auth check.
     */
    health(conn: ResolvedConnection): Promise<{
        ok: boolean;
        detail?: string;
    }>;
}
//# sourceMappingURL=google.d.ts.map