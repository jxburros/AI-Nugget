import type { CallInfo, CallRecord, ChatRequest, ChatResult, Connection, EmbedRequest, EmbedResult, GovernancePolicy, KeySource, ModelInfo, ParsedResult, Redactor, StandardSchemaV1, StreamEvent, TelemetrySink, Usage } from './types.js';
export interface HandlerOptions {
    keySource: KeySource;
    policy?: GovernancePolicy;
    redactor?: Redactor;
    telemetry?: TelemetrySink;
    hooks?: {
        beforeCall?(info: CallInfo): Promise<void | 'deny'>;
        afterCall?(record: CallRecord): Promise<void>;
    };
    retry?: {
        maxAttempts?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
    };
    limits?: {
        maxConcurrent?: number;
        minIntervalMs?: number;
    };
    /**
     * Optional cost estimator. Called once per successful call/embedding with the
     * final usage; its return value (USD) is stored on the telemetry record's
     * `costUsd`. Return undefined to leave a call uncosted. Pricing tables live in
     * the app, not the library — this is only the seam to attach one.
     */
    pricing?(info: {
        provider: string;
        model: string;
        usage: Usage;
    }): number | undefined;
}
export declare class AIHandler {
    private opts;
    private active;
    private queue;
    private lastStarted;
    private sessionRedactor;
    private policy;
    constructor(opts: HandlerOptions);
    chat(conn: Connection, req: ChatRequest): Promise<ChatResult>;
    stream(conn: Connection, req: ChatRequest): AsyncIterable<StreamEvent>;
    listModels(conn: Connection): Promise<ModelInfo[]>;
    testConnection(conn: Connection): Promise<{
        ok: boolean;
        message: string;
    }>;
    /**
     * Warm a connection so the first real call doesn't pay cold DNS/TLS and
     * (for a local daemon) process spin-up on the hot path. Runs a lightweight
     * health probe and never throws — call it once at boot. Combined with a CJS
     * `require` path it removes the cold-start "offline" false negative.
     */
    prewarm(conn: Connection): Promise<void>;
    /**
     * Chat that returns typed, validated output. Requests JSON mode, extracts the
     * JSON from the reply, and validates it against any Standard Schema validator
     * (Zod / Valibot / ArkType). On a validation miss it performs exactly one
     * corrective retry that shows the model its error, then throws
     * `invalid_response` if still invalid. No schema library is bundled — the
     * caller supplies the schema.
     */
    chatParsed<T>(conn: Connection, req: ChatRequest, schema: StandardSchemaV1<T>): Promise<ParsedResult<T>>;
    /**
     * Produce embeddings through the same governed pipeline as chat: policy check,
     * key resolution, `beforeCall` hook, concurrency, and exactly one redacted
     * telemetry record. Throws a typed `invalid_request` error for providers whose
     * adapter has no `embed` (Anthropic, Google) rather than failing silently.
     */
    embed(conn: Connection, req: EmbedRequest): Promise<EmbedResult>;
    private recordEmbed;
    private runProbe;
    private resolveConnection;
    private acquire;
    private release;
    private retryDelay;
    private recordSuccess;
    private recordFailure;
    private record;
    private redact;
    private redactedError;
    private redactedCause;
}
//# sourceMappingURL=handler.d.ts.map