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
/**
 * Light validation only: object-ness, `required` presence, and top-level
 * `properties[key].type` against JS typeof/Array.isArray/Number.isInteger.
 * It does not implement full JSON Schema — no `enum`, nested `properties`,
 * `oneOf`/`anyOf`, numeric bounds, string `pattern`, array `items` schemas, or
 * `additionalProperties`. That's intentional for a zero-dependency nugget; a
 * caller that needs stricter guarantees should validate `args` again inside
 * `tool.execute` with its own schema library.
 */
export declare function validateToolArgs(tool: ToolSpec, call: ToolCall): {
    ok: true;
    args: unknown;
} | {
    ok: false;
    message: string;
};
//# sourceMappingURL=tools.d.ts.map