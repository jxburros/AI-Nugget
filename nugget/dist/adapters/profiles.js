const HOSTED_CLOUD = { nativeTools: true, jsonMode: true, local: false, embeddable: false };
const LOCAL_RUNTIME = { nativeTools: false, jsonMode: false, local: true, embeddable: true };
export const PROVIDER_PROFILES = {
    openai: {
        engine: 'openaiChat',
        defaultBaseUrl: 'https://api.openai.com/v1',
        auth: 'bearer',
        listModelsPath: '/models',
        capabilities: HOSTED_CLOUD,
        quirks: { supportsUsageInStream: true, maxTokensParam: 'max_completion_tokens', supportsJsonSchema: true, supportsIdempotencyKey: true },
    },
    'azure-openai': {
        engine: 'openaiChat',
        auth: 'api-key-header',
        capabilities: HOSTED_CLOUD,
        quirks: { urlTemplate: '{baseUrl}/openai/deployments/{model}/chat/completions?api-version={apiVersion}', apiVersion: '2024-10-21', maxTokensParam: 'max_completion_tokens', supportsJsonSchema: true },
    },
    openrouter: {
        engine: 'openaiChat',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        auth: 'bearer',
        defaultHeaders: { 'HTTP-Referer': 'https://github.com/jxburros/AI-Nugget', 'X-Title': 'ai-nugget' },
        listModelsPath: '/models',
        capabilities: HOSTED_CLOUD,
        quirks: { supportsUsageInStream: true },
    },
    groq: { engine: 'openaiChat', defaultBaseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    deepseek: { engine: 'openaiChat', defaultBaseUrl: 'https://api.deepseek.com/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    mistral: { engine: 'openaiChat', defaultBaseUrl: 'https://api.mistral.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    together: { engine: 'openaiChat', defaultBaseUrl: 'https://api.together.xyz/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    fireworks: { engine: 'openaiChat', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    cerebras: { engine: 'openaiChat', defaultBaseUrl: 'https://api.cerebras.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    moonshot: { engine: 'openaiChat', defaultBaseUrl: 'https://api.moonshot.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    // Cohere's OpenAI-compatible surface lives under /compatibility/v1.
    cohere: { engine: 'openaiChat', defaultBaseUrl: 'https://api.cohere.ai/compatibility/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    // Perplexity has no public model-listing endpoint, so listModels resolves empty.
    perplexity: { engine: 'openaiChat', defaultBaseUrl: 'https://api.perplexity.ai', auth: 'bearer', capabilities: HOSTED_CLOUD },
    lmstudio: {
        engine: 'openaiChat',
        defaultBaseUrl: 'http://localhost:1234/v1',
        auth: 'none',
        listModelsPath: '/models',
        capabilities: LOCAL_RUNTIME,
        quirks: { keyOptional: true },
    },
    llamacpp: {
        engine: 'openaiChat',
        defaultBaseUrl: 'http://localhost:8080/v1',
        auth: 'none',
        listModelsPath: '/models',
        healthPath: '/health',
        capabilities: LOCAL_RUNTIME,
        quirks: { keyOptional: true, modelOptional: true },
    },
    vllm: {
        engine: 'openaiChat',
        defaultBaseUrl: 'http://localhost:8000/v1',
        auth: 'none',
        listModelsPath: '/models',
        capabilities: LOCAL_RUNTIME,
        quirks: { keyOptional: true },
    },
    ollama: {
        engine: 'ollama',
        defaultBaseUrl: 'http://localhost:11434',
        auth: 'none',
        listModelsPath: '/api/tags',
        // Ollama's `format: 'json'` is engine-enforced (reliable regardless of
        // model); its `tools` field is honored only by models trained for tool
        // use, so nativeTools stays conservative like the other local runtimes.
        capabilities: { ...LOCAL_RUNTIME, jsonMode: true },
        quirks: { keyOptional: true },
    },
    anthropic: {
        engine: 'anthropic',
        defaultBaseUrl: 'https://api.anthropic.com',
        auth: 'x-api-key',
        defaultHeaders: { 'anthropic-version': '2023-06-01' },
        capabilities: HOSTED_CLOUD,
        quirks: { maxTokensRequired: true },
    },
    google: {
        engine: 'google',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com',
        auth: 'x-goog-api-key',
        capabilities: HOSTED_CLOUD,
    },
    'openai-compat': {
        engine: 'openaiChat',
        auth: 'bearer',
        listModelsPath: '/models',
        // Unknown endpoint — usually pointed at a local/self-hosted server, so
        // assume the conservative local-runtime defaults rather than the hosted-cloud ones.
        capabilities: LOCAL_RUNTIME,
        // Most servers reached through this escape hatch (JX Runtime and other
        // local OpenAI-compatible runtimes) don't require a key at all; keep
        // `auth: 'bearer'` for the ones that do (a key is only sent if provided).
        quirks: { keyOptional: true },
    },
};
export function profileFor(provider, baseUrl) {
    return PROVIDER_PROFILES[provider] ?? {
        ...PROVIDER_PROFILES['openai-compat'],
        defaultBaseUrl: baseUrl,
    };
}
export function applyAuth(profile, apiKey, headers) {
    const next = { ...profile.defaultHeaders, ...headers };
    if (!apiKey)
        return next;
    if (profile.auth === 'bearer')
        next.authorization = `Bearer ${apiKey}`;
    else if (profile.auth === 'x-api-key')
        next['x-api-key'] = apiKey;
    else if (profile.auth === 'x-goog-api-key')
        next['x-goog-api-key'] = apiKey;
    else if (profile.auth === 'api-key-header')
        next['api-key'] = apiKey;
    return next;
}
//# sourceMappingURL=profiles.js.map