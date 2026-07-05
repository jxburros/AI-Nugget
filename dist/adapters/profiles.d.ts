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
    };
    listModelsPath?: string;
    healthPath?: string;
}
export declare const PROVIDER_PROFILES: Record<string, ProviderProfile>;
export declare function profileFor(provider: string, baseUrl?: string): ProviderProfile;
export declare function applyAuth(profile: ProviderProfile, apiKey: string | null, headers: Record<string, string>): Record<string, string>;
//# sourceMappingURL=profiles.d.ts.map