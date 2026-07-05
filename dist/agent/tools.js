export function defineTool(spec) {
    return spec;
}
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
    return typeof value === type;
}
//# sourceMappingURL=tools.js.map