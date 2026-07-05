import type { CallInfo, CallRecord, ChatRequest, ChatResult, Connection, GovernancePolicy, KeySource, ModelInfo, Redactor, StreamEvent, TelemetrySink } from './types.js';
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
    private resolveConnection;
    private acquire;
    private release;
    private retryDelay;
    private recordSuccess;
    private recordFailure;
    private record;
    private redact;
}
//# sourceMappingURL=handler.d.ts.map