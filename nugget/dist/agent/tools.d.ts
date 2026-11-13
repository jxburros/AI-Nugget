import type { StandardSchemaV1, ToolCall, ToolSchema } from '../types.js';
export interface ToolSpec<A = unknown, R = unknown> extends ToolSchema {
    sideEffects?: boolean;
    /**
     * Optional Standard Schema validator (Zod / Valibot / ArkType) for the
     * arguments. When set, arguments are validated with it — fully, not the
     * light built-in check — and `execute` receives its parsed output. With the
     * Standard JSON Schema extension it also supplies `parameters`.
     */
    input?: StandardSchemaV1<A>;
    execute(args: A, ctx: ToolContext): Promise<R> | R;
}
/** {@link defineTool} input: `parameters` may be omitted when `input` can produce it. */
export type ToolDefinition<A = unknown, R = unknown> = Omit<ToolSpec<A, R>, 'parameters'> & {
    parameters?: object;
};
export interface ToolContext {
    signal: AbortSignal;
    callId: string;
    step: number;
    metadata?: Record<string, unknown>;
}
/**
 * Define a tool. Pass a JSON Schema `parameters`, or a Standard Schema `input`
 * that implements Standard JSON Schema (Zod 4.2+, Valibot) and the parameters
 * schema is derived from it — one schema for the provider and the validator.
 */
export declare function defineTool<A, R>(spec: ToolDefinition<A, R>): ToolSpec<A, R>;
/** Validate arguments with the tool's Standard Schema `input`, or the light built-in check. */
export declare function validateToolInput(tool: ToolSpec, call: ToolCall): Promise<{
    ok: true;
    args: unknown;
} | {
    ok: false;
    message: string;
}>;
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