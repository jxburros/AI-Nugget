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
    name?: string;
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
    /**
     * Provider-native request fields the nugget does not model as first-class
     * options — an escape hatch so a caller can reach a capability without waiting
     * for a library release. Merged into the outgoing provider request body:
     * shallow at the top level, and one level deep into the provider's own nested
     * option container (Ollama `options`, Google `generationConfig`). Examples:
     * `{ options: { num_ctx: 8192 }, keep_alive: '30m' }` (Ollama),
     * `{ reasoning_effort: 'high' }` (OpenAI), `{ thinking: { type: 'enabled' } }`
     * (Anthropic), `{ safetySettings: [...] }` (Google). Values here win over the
     * nugget's own fields on a key collision, so use with care.
     */
    providerOptions?: Record<string, unknown>;
}
export interface Connection {
    id: string;
    provider: string;
    baseUrl?: string;
    keyRef?: KeyRef;
    timeoutMs?: number;
    headers?: Record<string, string>;
    /**
     * Idle timeout for streaming calls: aborts the stream only if no bytes arrive
     * for this many milliseconds, resetting on every chunk. Distinct from
     * `timeoutMs`, which bounds the total call lifetime. Set this (and a generous
     * `timeoutMs`) for long local generations that stream slowly but healthily.
     */
    idleTimeoutMs?: number;
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
export interface EmbedRequest {
    model: string;
    /** One string, or a batch of strings embedded in a single call. */
    input: string | string[];
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    /** Provider-native passthrough, same contract as {@link ChatRequest.providerOptions}. */
    providerOptions?: Record<string, unknown>;
}
export interface EmbedResult {
    /** One vector per input, in input order. */
    embeddings: number[][];
    model: string;
    usage: Usage;
    source: ModelSource;
    raw?: unknown;
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
    type: 'reasoning';
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
    embed?(conn: ResolvedConnection, req: EmbedRequest): Promise<EmbedResult>;
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
    /**
     * The fully resolved connection for this call — base URL defaulted from the
     * provider profile and auth headers applied. Present whenever `beforeCall`
     * runs after resolution (chat/stream and probes), letting a hook validate the
     * *effective* endpoint (e.g. a request-time SSRF/DNS-rebinding re-check on the
     * resolved `baseUrl`) without duplicating profile logic. The resolved
     * `apiKey` is intentionally not exposed here.
     */
    resolved?: Omit<ResolvedConnection, 'apiKey'>;
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
    /**
     * Estimated cost of this call in USD, computed by the optional `pricing` hook
     * passed to the handler. Undefined when no pricing hook is configured or the
     * hook returns nothing for this provider/model.
     */
    costUsd?: number;
}
/**
 * Minimal [Standard Schema](https://standardschema.dev) validator surface. Any
 * Zod / Valibot / ArkType schema (v1+) satisfies this via its `~standard`
 * property, so `chatParsed` can validate model output against a schema the app
 * already owns — with zero dependency added to this library.
 */
export interface StandardSchemaV1<Output = unknown> {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    };
}
export type StandardSchemaResult<Output> = {
    readonly value: Output;
    readonly issues?: undefined;
} | {
    readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | {
            readonly key: PropertyKey;
        }>;
    }>;
};
/** Output of {@link AIHandler.chatParsed}: the validated value plus the raw chat result. */
export interface ParsedResult<T> {
    data: T;
    result: ChatResult;
}
//# sourceMappingURL=types.d.ts.map