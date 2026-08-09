export function defineTool(spec) {
    return spec;
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
export function validateToolArgs(tool, call) {
    const schema = tool.parameters;
    if (schema.type && schema.type !== 'object')
        return { ok: false, message: `Tool ${tool.name} parameters must be an object schema` };
    if (typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)) {
        return { ok: false, message: `Tool ${tool.name} expected object arguments` };
    }
    const args = call.arguments;
    const required = Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === 'string') : [];
    for (const key of required) {
        if (!(key in args))
            return { ok: false, message: `Tool ${tool.name} missing required argument: ${key}` };
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, spec] of Object.entries(properties)) {
        if (!(key in args) || spec.type === undefined)
            continue;
        const value = args[key];
        const ok = matchesType(value, spec.type);
        if (!ok)
            return { ok: false, message: `Tool ${tool.name} argument ${key} must be ${spec.type}` };
    }
    return { ok: true, args };
}
function matchesType(value, type) {
    if (type === 'array')
        return Array.isArray(value);
    if (type === 'integer')
        return typeof value === 'number' && Number.isInteger(value);
    if (type === 'null')
        return value === null;
    if (type === 'object')
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    return typeof value === type;
}
//# sourceMappingURL=tools.js.map