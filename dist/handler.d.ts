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
    /**
     * Concurrency and pacing limits, enforced by an **in-memory queue on this
     * handler instance only**. There is no shared/external coordination, so N
     * instances behind a load balancer allow N × `maxConcurrent` in flight against
     * the provider. Size these per instance, or put a shared limiter in front if a
     * global ceiling matters.
     */
    limits?: {
        maxConcurrent?: number;
        minIntervalMs?: number;
    };
    /**
     * Silence the one-time startup notice logged when no `policy` is supplied.
     * Set this only when running unrestricted is a deliberate choice — passing an
     * explicit `policy: allowAllPolicy()` says the same thing and is clearer.
     */
    silencePolicyWarning?: boolean;
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
/** Test seam: reset the once-per-process startup notice. */
export declare function resetPolicyWarningForTests(): void;
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
    /**
     * The shared pre-call preamble: policy check → key resolution → `beforeCall`
     * hook. Every entry point (`stream`, `embed`, `listModels`/`testConnection`)
     * runs exactly this sequence, so it lives once. Failures are *returned*, not
     * recorded — each caller owns its own telemetry shape (`recordFailure` for
     * chat/probe, `recordEmbed` for embeddings) and records the returned error.
     */
    private preflight;
    /** Record a failed call and emit the single redacted `error` event for it. */
    private failStream;
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