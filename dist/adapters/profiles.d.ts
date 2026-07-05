export type EngineName = 'openaiChat' | 'anthropic' | 'google' | 'ollama';
export type AuthMode = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'api-key-header' | 'none';
export interface ProviderProfile {
    engine: EngineName;
    defaultBaseUrl?: string;
    auth: AuthMode;
    defaultHeaders?: Record<string, string>;
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