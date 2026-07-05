export type Role = 'system' | 'user' | 'assistant' | 'tool';
export interface ContentPart {
    type: 'text' | 'image';
    text?: string;
    imageBase64?: string;
    mimeType?: string;
}
export interface ChatMessage {
    role: Role;
    content: string | ContentPart[];
    toolCalls?: ToolCall[];
    toolCallId?: string;
}
export interface ToolCall {
    id: string;
    name: string;
    arguments: unknown;
    raw?: string;
}
export interface ToolSchema {
    name: string;
    description: string;
    parameters: object;
}
export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    responseFormat?: {
        type: 'text';
    } | {
        type: 'json';
        schema?: object;
    };
    tools?: ToolSchema[];
    toolChoice?: 'auto' | 'none' | {
        name: string;
    };
    stopSequences?: string[];
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
}
export interface Connection {
    id: string;
    provider: string;
    baseUrl?: string;
    keyRef?: KeyRef;
    timeoutMs?: number;
    headers?: Record<string, string>;
}
export type KeyRef = {
    kind: 'none';
} | {
    kind: 'env';
    name: string;
} | {
    kind: 'literal';
    value: string;
} | {
    kind: 'stored';
    ref: string;
} | {
    kind: 'brokered';
    ref: string;
};
export interface KeySource {
    resolve(ref: KeyRef): Promise<{
        ok: true;
        apiKey: string | null;
    } | {
        ok: false;
        reason: 'missing' | 'locked' | 'denied';
    }>;
}
export interface ResolvedConnection extends Connection {
    baseUrl: string;
    apiKey: string | null;
    headers: Record<string, string>;
}
export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    estimated: boolean;
}
export interface ChatResult {
    text: string;
    toolCalls?: ToolCall[];
    finishReason: 'stop' | 'length' | 'tool' | 'content_filter' | 'error' | 'canceled';
    usage: Usage;
    timing: {
        firstTokenMs: number | null;
        totalMs: number;
    };
    model: string;
    source: ModelSource;
    raw?: unknown;
}
export interface ModelSource {
    provider: string;
    connectionId: string;
    baseUrl?: string;
}
export declare function modelRef(source: ModelSource, model: string): string;
export type AIErrorKind = 'auth' | 'rate_limit' | 'timeout' | 'network' | 'server' | 'invalid_request' | 'invalid_response' | 'context_length' | 'canceled' | 'policy_blocked' | 'key_unavailable' | 'tool_error' | 'budget_exceeded';
export type StreamEvent = {
    type: 'start';
    callId: string;
    provider: string;
    model: string;
} | {
    type: 'delta';
    text: string;
} | {
    type: 'tool_call';
    call: ToolCall;
} | {
    type: 'context';
    kind: string;
    data: unknown;
} | {
    type: 'retry';
    attempt: number;
    reason: AIErrorKind;
    delayMs: number;
} | {
    type: 'done';
    result: ChatResult;
} | {
    type: 'error';
    error: import('./errors.js').AIError;
};
export interface ProviderAdapter {
    readonly provider: string;
    chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult>;
    stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent>;
    listModels?(conn: ResolvedConnection): Promise<ModelInfo[]>;
    health?(conn: ResolvedConnection): Promise<{
        ok: boolean;
        detail?: string;
    }>;
}
export interface ModelInfo {
    id: string;
    source: ModelSource;
    contextWindow?: number;
    capabilities?: string[];
}
export interface GovernancePolicy {
    checkModel(provider: string, model: string): {
        allowed: true;
    } | {
        allowed: false;
        reason: string;
    };
}
export interface Redactor {
    redact(text: string): string;
}
export interface TelemetrySink {
    record(r: CallRecord): void | Promise<void>;
}
export interface CallInfo {
    callId: string;
    connection: Connection;
    provider: string;
    model: string;
    metadata?: Record<string, unknown>;
}
export interface CallRecord {
    callId: string;
    connectionId: string;
    provider: string;
    model: string;
    startedAt: number;
    timing: ChatResult['timing'];
    usage: Usage;
    finishReason: ChatResult['finishReason'];
    error?: {
        kind: AIErrorKind;
        status?: number;
        message: string;
    };
    attempts: number;
    metadata?: Record<string, unknown>;
    promptChars: number;
    responseChars: number;
}
//# sourceMappingURL=types.d.ts.map