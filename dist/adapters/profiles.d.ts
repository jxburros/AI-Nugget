export type EngineName = 'openaiChat' | 'anthropic' | 'google' | 'ollama';
export type AuthMode = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'api-key-header' | 'none';
export interface ProviderProfile {
    engine: EngineName;
    defaultBaseUrl?: string;
    auth: AuthMode;
    defaultHeaders?: Record<string, string>;
    /**
     * What this provider can do at the protocol level, independent of the specific
     * model. Consumed by the library: `nativeTools` drives the agent layer's
     * `toolMode: 'auto'` resolution (native vs promptJson) and `jsonMode` gates
     * whether the OpenAI engine sends `response_format`. Model-level capabilities
     * discovered at runtime (Ollama `/api/show`, OpenRouter metadata) still land on
     * `ModelInfo.capabilities`; these are the static, always-known defaults.
     */
    capabilities?: {
        nativeTools?: boolean;
        jsonMode?: boolean;
    };
    quirks?: {
        keyOptional?: boolean;
        modelOptional?: boolean;
        urlTemplate?: string;
        supportsUsageInStream?: boolean;
        maxTokensRequired?: boolean;
    };
    listModelsPath?: string;
    healthPath?: string;
}
export declare const PROVIDER_PROFILES: Record<string, ProviderProfile>;
export declare function profileFor(provider: string, baseUrl?: string): ProviderProfile;
/**
 * Resolved static capabilities for a connection's provider. Apps can read this
 * to decide, e.g., whether to request native tools; the agent layer uses it to
 * resolve `toolMode: 'auto'`. Unknown providers fall through to the conservative
 * `openai-compat` defaults (JSON mode yes, native tools no).
 */
export declare function providerCapabilities(provider: string, baseUrl?: string): {
    nativeTools: boolean;
    jsonMode: boolean;
};
export declare function applyAuth(profile: ProviderProfile, apiKey: string | null, headers: Record<string, string>): Record<string, string>;
//# sourceMappingURL=profiles.d.ts.map