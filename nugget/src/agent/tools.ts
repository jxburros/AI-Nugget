import { AIError } from '../errors.js';
import { standardJsonSchema } from '../json.js';
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
export type ToolDefinition<A = unknown, R = unknown> = Omit<ToolSpec<A, R>, 'parameters'> & { parameters?: object };

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
export function defineTool<A, R>(spec: ToolDefinition<A, R>): ToolSpec<A, R> {
  if (spec.parameters) return spec as ToolSpec<A, R>;
  const parameters = standardJsonSchema(spec.input, 'input');
  if (!parameters) {
    throw new AIError(`Tool ${spec.name} needs \`parameters\`, or an \`input\` schema that implements Standard JSON Schema`, { kind: 'invalid_request', retryable: false });
  }
  return { ...spec, parameters } as ToolSpec<A, R>;
}

/** Validate arguments with the tool's Standard Schema `input`, or the light built-in check. */
export async function validateToolInput(tool: ToolSpec, call: ToolCall): Promise<{ ok: true; args: unknown } | { ok: false; message: string }> {
  if (!tool.input) return validateToolArgs(tool, call);
  const result = await tool.input['~standard'].validate(call.arguments);
  if (result.issues) {
    const message = result.issues.map((issue) => issue.message).join('; ') || 'validation failed';
    return { ok: false, message: `Tool ${tool.name} arguments invalid: ${message}` };
  }
  return { ok: true, args: result.value };
}

/**
 * Light validation only: object-ness, `required` presence, and top-level
 * `properties[key].type` against JS typeof/Array.isArray/Number.isInteger.
 * It does not implement full JSON Schema — no `enum`, nested `properties`,
 * `oneOf`/`anyOf`, numeric bounds, string `pattern`, array `items` schemas, or
 * `additionalProperties`. That's intentional for a zero-dependency nugget; a
 * caller that needs stricter guarantees should validate `args` again inside
 * `tool.execute` with its own schema library.
 */
export function validateToolArgs(tool: ToolSpec, call: ToolCall): { ok: true; args: unknown } | { ok: false; message: string } {
  const schema = tool.parameters as { required?: unknown; properties?: unknown; type?: unknown };
  if (schema.type && schema.type !== 'object') return { ok: false, message: `Tool ${tool.name} parameters must be an object schema` };
  if (typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)) {
    return { ok: false, message: `Tool ${tool.name} expected object arguments` };
  }
  const args = call.arguments as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  for (const key of required) {
    if (!(key in args)) return { ok: false, message: `Tool ${tool.name} missing required argument: ${key}` };
  }
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, { type?: string }> : {};
  for (const [key, spec] of Object.entries(properties)) {
    if (!(key in args) || spec.type === undefined) continue;
    const value = args[key];
    const ok = matchesType(value, spec.type);
    if (!ok) return { ok: false, message: `Tool ${tool.name} argument ${key} must be ${spec.type}` };
  }
  return { ok: true, args };
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'null') return value === null;
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === type;
}
