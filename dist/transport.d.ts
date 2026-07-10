/**
 * `ms` is a total deadline for the whole call. `idleMs`, when given, is a
 * second, independently-armed deadline that `bump()` re-arms on every chunk
 * of data received — it catches a stalled provider in `idleMs`, while a
 * healthy stream that simply runs long is only bounded by `ms`.
 */
export declare function withTimeout(ms: number, external?: AbortSignal, idleMs?: number): {
    signal: AbortSignal;
    done(): void;
    timedOut(): boolean;
    bump(): void;
};
export declare function fetchJson(url: string, init: RequestInit & {
    timeoutMs: number;
    provider?: string;
}): Promise<{
    data: unknown;
    status: number;
    totalMs: number;
}>;
/**
 * POST a JSON body and return the raw {@link Response} for streaming.
 *
 * The caller owns the abort/timeout `signal` and is responsible for keeping it
 * alive until the response body has been fully consumed — passing a
 * `withTimeout()` signal here and cleaning it up only after the stream ends is
 * what lets external cancellation and the timeout apply for the *whole* stream,
 * not merely the connection handshake. Non-2xx responses are classified and
 * thrown before the body is handed back.
 */
export declare function postResponse(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal, provider: string): Promise<Response>;
export declare function sseLines(res: Response, onChunk?: () => void): AsyncIterable<string>;
export declare function ndjsonLines(res: Response, onChunk?: () => void): AsyncIterable<unknown>;
/** `onChunk`, when given, fires after every chunk of bytes read from the wire — used to bump an idle timeout. */
export declare function textLines(res: Response, onChunk?: () => void): AsyncIterable<string>;
//# sourceMappingURL=transport.d.ts.map