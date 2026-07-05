export function allowAllPolicy() {
    return { checkModel: () => ({ allowed: true }) };
}
export function blocklistPolicy(patterns) {
    return {
        checkModel(provider, model) {
            const target = `${provider}/${model}`;
            const blocked = patterns.find((pattern) => pattern.test(target));
            return blocked ? { allowed: false, reason: `Model blocked by policy: ${blocked}` } : { allowed: true };
        },
    };
}
export function allowlistPolicy(prefixesByProvider) {
    return {
        checkModel(provider, model) {
            const prefixes = prefixesByProvider[provider];
            if (!prefixes || prefixes.length === 0)
                return { allowed: true };
            return prefixes.some((prefix) => model.startsWith(prefix))
                ? { allowed: true }
                : { allowed: false, reason: `Model is not allowed for provider ${provider}` };
        },
    };
}
export function composePolicies(...policies) {
    return {
        checkModel(provider, model) {
            for (const policy of policies) {
                const result = policy.checkModel(provider, model);
                if (!result.allowed)
                    return result;
            }
            return { allowed: true };
        },
    };
}
//# sourceMappingURL=policy.js.map