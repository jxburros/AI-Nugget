import type { ToolCall, ToolSchema } from '../types.js';
export interface ToolSpec<A = unknown, R = unknown> extends ToolSchema {
    sideEffects?: boolean;
    execute(args: A, ctx: ToolContext): Promise<R> | R;
}
export interface ToolContext {
    signal: AbortSignal;
    callId: string;
    step: number;
    metadata?: Record<string, unknown>;
}
export declare function defineTool<A, R>(spec: ToolSpec<A, R>): ToolSpec<A, R>;
export declare function validateToolArgs(tool: ToolSpec, call: ToolCall): {
    ok: true;
    args: unknown;
} | {
    ok: false;
    message: string;
};
//# sourceMappingURL=tools.d.ts.map