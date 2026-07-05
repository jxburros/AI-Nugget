export declare function withTimeout(ms: number, external?: AbortSignal): {
    signal: AbortSignal;
    done(): void;
    timedOut(): boolean;
};
export declare function fetchJson(url: string, init: RequestInit & {
    timeoutMs: number;
    provider?: string;
}): Promise<{
    data: unknown;
    status: number;
    totalMs: number;
}>;
export declare function sseLines(res: Response): AsyncIterable<string>;
export declare function ndjsonLines(res: Response): AsyncIterable<unknown>;
export declare function textLines(res: Response): AsyncIterable<string>;
export declare function postJsonResponse(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number, signal: AbortSignal | undefined, provider: string): Promise<Response>;
//# sourceMappingURL=transport.d.ts.map