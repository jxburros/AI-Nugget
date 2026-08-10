export type EngineName = 'openaiChat' | 'anthropic' | 'google' | 'ollama';
export type AuthMode = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'api-key-header' | 'none';
/**
 * Answers the capability questions apps need before choosing behavior —
 * distinct from `quirks`, which are wire-format details an adapter consults
 * to build a request. These are per-provider defaults, not per-model: a
 * specific model behind a `true` profile can still lack a capability (a tiny
 * Ollama model ignoring `tools`), and callers that know better should pass an
 * explicit `toolMode` rather than rely on `auto`.
 */
export interface ProviderCapabilities {
    /** Native tool/function-calling is reliable for this provider's protocol, not just model-dependent. Drives `toolMode: 'auto'` in the agent loop. */
    nativeTools: boolean;
    /** A provider-enforced structured-output mode exists (not just prompt-and-hope JSON). */
    jsonMode: boolean;
    /** Runs on localhost / user-controlled infrastructure rather than a hosted cloud API. */
    local: boolean;
    /** Meant to run embedded alongside the app (a local sidecar process) rather than accessed as a standalone hosted service. */
    embeddable: boolean;
}
export interface ProviderProfile {
    engine: EngineName;
    defaultBaseUrl?: string;
    auth: AuthMode;
    defaultHeaders?: Record<string, string>;
    capabilities: ProviderCapabilities;
    quirks?: {
        keyOptional?: boolean;
        modelOptional?: boolean;
        urlTemplate?: string;
        supportsUsageInStream?: boolean;
        maxTokensRequired?: boolean;
        maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
        supportsJsonSchema?: boolean;
        /**
         * Default value for the `{apiVersion}` token in `urlTemplate` (Azure OpenAI).
         * Overridable per call via `ChatRequest.providerOptions.apiVersion`, so a
         * retired Azure api-version never requires a library release.
         */
        apiVersion?: string;
        /**
         * Provider honors an `Idempotency-Key` request header. When set, the handler
         * attaches one key per logical call and reuses it across retries, so a retry
         * after a connection drops post-generation is deduped by the provider rather
         * than billed twice. Left off unless the provider documents the header —
         * sending an unknown header is harmless, but claiming the guarantee is not.
         */
        supportsIdempotencyKey?: boolean;
    };
    listModelsPath?: string;
    healthPath?: string;
}
/**
 * The provider keys that have a profile in {@link PROVIDER_PROFILES}. Used to
 * type `Connection.provider` so IDEs autocomplete valid names and typos are a
 * compile error rather than a silent fall-through to `openai-compat`.
 */
export type KnownProvider = 'openai' | 'azure-openai' | 'openrouter' | 'groq' | 'deepseek' | 'mistral' | 'together' | 'fireworks' | 'cerebras' | 'moonshot' | 'cohere' | 'perplexity' | 'lmstudio' | 'llamacpp' | 'vllm' | 'ollama' | 'anthropic' | 'google' | 'openai-compat';
export declare const PROVIDER_PROFILES: Record<KnownProvider, ProviderProfile> & Record<string, ProviderProfile>;
export declare function profileFor(provider: string, baseUrl?: string): ProviderProfile;
export declare function applyAuth(profile: ProviderProfile, apiKey: string | null, headers: Record<string, string>): Record<string, string>;
//# sourceMappingURL=profiles.d.ts.map