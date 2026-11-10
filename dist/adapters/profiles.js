const HOSTED_CLOUD = { nativeTools: true, jsonMode: true, local: false, embeddable: false };
const LOCAL_RUNTIME = { nativeTools: false, jsonMode: false, local: true, embeddable: true };
export const PROVIDER_PROFILES = {
    // MiniMax's legacy `max_tokens` counts thinking tokens; `max_completion_tokens` caps the answer.
    minimax: { engine: 'openaiChat', defaultBaseUrl: 'https://api.minimax.io/v1', auth: 'bearer', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true, embeddings: false, unsupportedProbe: true, maxTokensParam: 'max_completion_tokens', supportsUsageInStream: true } },
    zai: { engine: 'openaiChat', defaultBaseUrl: 'https://api.z.ai/api/paas/v4', auth: 'bearer', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true, embeddings: false, unsupportedProbe: true } },
    dashscope: { engine: 'openaiChat', defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', auth: 'bearer', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true, unsupportedProbe: true } },
    huggingface: { engine: 'openaiChat', defaultBaseUrl: 'https://router.huggingface.co/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true, embeddings: false } },
    deepinfra: { engine: 'openaiChat', defaultBaseUrl: 'https://api.deepinfra.com/v1/openai', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true, embeddings: true } },
    sambanova: { engine: 'openaiChat', defaultBaseUrl: 'https://api.sambanova.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true, embeddings: false } },
    nvidia: { engine: 'openaiChat', auth: 'bearer', listModelsPath: '/models', capabilities: { ...LOCAL_RUNTIME, embeddable: false }, quirks: { keyOptional: true, preserveAssistantState: true } },
    cloudflare: { engine: 'openaiChat', auth: 'bearer', capabilities: HOSTED_CLOUD, quirks: { responsesStreaming: false, embeddings: true, preserveAssistantState: true, unsupportedProbe: true } },
    bedrock: { engine: 'openaiChat', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true, embeddings: false } },
    vertex: { engine: 'openaiChat', auth: 'bearer', capabilities: HOSTED_CLOUD, quirks: { embeddings: false, unsupportedProbe: true } },
    'azure-openai-v1': { engine: 'openaiChat', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { supportsUsageInStream: true, maxTokensParam: 'max_completion_tokens', supportsJsonSchema: true, embeddings: true, promptCache: true } },
    openai: {
        engine: 'openaiChat',
        defaultBaseUrl: 'https://api.openai.com/v1',
        auth: 'bearer',
        listModelsPath: '/models',
        capabilities: HOSTED_CLOUD,
        quirks: { supportsUsageInStream: true, maxTokensParam: 'max_completion_tokens', supportsJsonSchema: true, supportsIdempotencyKey: true, promptCache: true },
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
    // Vercel AI Gateway: one key for many upstream providers, OpenAI-compatible.
    vercel: { engine: 'openaiChat', defaultBaseUrl: 'https://ai-gateway.vercel.sh/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { supportsJsonSchema: true } },
    // Groq deprecated `max_tokens`; its json_schema mode refuses streaming, so it stays off.
    groq: { engine: 'openaiChat', defaultBaseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { maxTokensParam: 'max_completion_tokens' } },
    // DeepSeek thinking mode returns 400 on a tool-using history that omits the
    // earlier `reasoning_content`, so assistant turns replay it verbatim.
    deepseek: { engine: 'openaiChat', defaultBaseUrl: 'https://api.deepseek.com/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true } },
    mistral: { engine: 'openaiChat', defaultBaseUrl: 'https://api.mistral.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    // Together moved its documented host to api.together.ai (US-only: us-api.together.ai).
    together: { engine: 'openaiChat', defaultBaseUrl: 'https://api.together.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true } },
    fireworks: { engine: 'openaiChat', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD, quirks: { preserveAssistantState: true } },
    cerebras: { engine: 'openaiChat', defaultBaseUrl: 'https://api.cerebras.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    // Kimi (platform.kimi.ai). Thinking models stream `reasoning_content` and
    // require it echoed back on assistant turns in tool loops, hence
    // preserveAssistantState. Mainland-China keys use https://api.moonshot.cn/v1.
    moonshot: {
        engine: 'openaiChat',
        defaultBaseUrl: 'https://api.moonshot.ai/v1',
        auth: 'bearer',
        listModelsPath: '/models',
        capabilities: HOSTED_CLOUD,
        quirks: { supportsUsageInStream: true, maxTokensParam: 'max_completion_tokens', supportsJsonSchema: true, preserveAssistantState: true },
    },
    // Meta Model API (Muse Spark / Muse Wonder) at dev.meta.ai — OpenAI-compatible
    // Chat Completions and Responses (`protocol: 'responses'`). Muse models always
    // reason: `reasoningEffort: 'none'` is a 400 there.
    meta: {
        engine: 'openaiChat',
        defaultBaseUrl: 'https://api.meta.ai/v1',
        auth: 'bearer',
        listModelsPath: '/models',
        capabilities: HOSTED_CLOUD,
        quirks: { maxTokensParam: 'max_completion_tokens', supportsJsonSchema: true, embeddings: false, promptCache: true },
    },
    // Cohere's OpenAI-compatible surface lives under /compatibility/v1.
    cohere: { engine: 'openaiChat', defaultBaseUrl: 'https://api.cohere.ai/compatibility/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
    // Perplexity ended Sonar Chat Completions support on 2026-09-27. Since 0.8.0
    // the default is the Orchestrator Chat Completions endpoint, which takes
    // catalog model IDs (`creator/model`). Pre-0.8 behavior: baseUrl
    // `https://api.perplexity.ai`. Agent API: `protocol: 'responses'` with baseUrl
    // `https://api.perplexity.ai/v1`. No documented Orchestrator model listing.
    perplexity: {
        engine: 'openaiChat',
        defaultBaseUrl: 'https://api.perplexity.ai/orchestrator/v1',
        auth: 'bearer',
        capabilities: HOSTED_CLOUD,
        quirks: { supportsUsageInStream: true, maxTokensParam: 'max_completion_tokens', supportsJsonSchema: true, preserveAssistantState: true },
    },
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
    // Any server implementing the Open Responses specification (openresponses.org):
    // the Responses wire format by default, at `{baseUrl}/responses`. Point
    // baseUrl at the server's `/v1` (e.g. `http://localhost:11434/v1`).
    'open-responses': {
        engine: 'openaiChat',
        auth: 'bearer',
        listModelsPath: '/models',
        defaultProtocol: 'responses',
        capabilities: LOCAL_RUNTIME,
        quirks: { keyOptional: true, embeddings: false },
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
    if (provider === 'bedrock' && baseUrl && new URL(baseUrl).hostname.startsWith('bedrock-runtime.')) {
        const profile = PROVIDER_PROFILES.bedrock;
        return { ...profile, listModelsPath: undefined, quirks: { ...profile.quirks, unsupportedProbe: true } };
    }
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