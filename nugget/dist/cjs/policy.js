"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.allowAllPolicy = allowAllPolicy;
exports.blocklistPolicy = blocklistPolicy;
exports.allowlistPolicy = allowlistPolicy;
exports.mcpServerAllowlistPolicy = mcpServerAllowlistPolicy;
exports.composePolicies = composePolicies;
function allowAllPolicy() {
    return { checkModel: () => ({ allowed: true }) };
}
function blocklistPolicy(patterns) {
    return {
        checkModel(provider, model) {
            const target = `${provider}/${model}`;
            const blocked = patterns.find((pattern) => pattern.test(target));
            return blocked ? { allowed: false, reason: `Model blocked by policy: ${blocked}` } : { allowed: true };
        },
    };
}
function allowlistPolicy(prefixesByProvider) {
    return {
        checkModel(provider, model) {
            const prefixes = prefixesByProvider[provider];
            if (!prefixes || prefixes.length === 0)
                return { allowed: false, reason: `No models are allowed for provider ${provider}` };
            return prefixes.some((prefix) => prefix === '*' || model.startsWith(prefix))
                ? { allowed: true }
                : { allowed: false, reason: `Model is not allowed for provider ${provider}` };
        },
    };
}
/**
 * Allow provider-hosted MCP servers only when their URL starts with one of the
 * given prefixes (e.g. `https://mcp.example.com/`). Every model stays allowed;
 * compose with a model policy via {@link composePolicies}.
 */
function mcpServerAllowlistPolicy(urlPrefixes) {
    return {
        checkModel: () => ({ allowed: true }),
        checkMcpServer(_provider, server) {
            return urlPrefixes.some((prefix) => server.url.startsWith(prefix))
                ? { allowed: true }
                : { allowed: false, reason: `MCP server not allowed by policy: ${server.name}` };
        },
    };
}
function composePolicies(...policies) {
    return {
        checkModel(provider, model) {
            for (const policy of policies) {
                const result = policy.checkModel(provider, model);
                if (!result.allowed)
                    return result;
            }
            return { allowed: true };
        },
        checkMcpServer(provider, server) {
            for (const policy of policies) {
                const result = policy.checkMcpServer?.(provider, server);
                if (result && !result.allowed)
                    return result;
            }
            return { allowed: true };
        },
    };
}
