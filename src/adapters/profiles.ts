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
    nativeTools?: boolean;   // provider/engine exposes real function-calling
    jsonMode?: boolean;      // provider/engine has a structured-JSON output mode
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

const OPENAI_CLOUD_CAPS = { nativeTools: true, jsonMode: true } as const;

export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  openai: {
    engine: 'openaiChat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    listModelsPath: '/models',
    capabilities: { ...OPENAI_CLOUD_CAPS },
    quirks: { supportsUsageInStream: true },
  },
  'azure-openai': {
    engine: 'openaiChat',
    auth: 'api-key-header',
    capabilities: { ...OPENAI_CLOUD_CAPS },
    quirks: {
      urlTemplate: '{baseUrl}/openai/deployments/{model}/chat/completions?api-version=2024-10-21',
      supportsUsageInStream: true,
    },
  },
  openrouter: {
    engine: 'openaiChat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    defaultHeaders: { 'X-Title': 'ai-handler' },
    listModelsPath: '/models',
    capabilities: { ...OPENAI_CLOUD_CAPS },
    quirks: { supportsUsageInStream: true },
  },
  groq: { engine: 'openaiChat', defaultBaseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: { ...OPENAI_CLOUD_CAPS }, quirks: { supportsUsageInStream: true } },
  deepseek: { engine: 'openaiChat', defaultBaseUrl: 'https://api.deepseek.com/v1', auth: 'bearer', listModelsPath: '/models', capabilities: { ...OPENAI_CLOUD_CAPS }, quirks: { supportsUsageInStream: true } },
  mistral: { engine: 'openaiChat', defaultBaseUrl: 'https://api.mistral.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: { ...OPENAI_CLOUD_CAPS }, quirks: { supportsUsageInStream: true } },
  together: { engine: 'openaiChat', defaultBaseUrl: 'https://api.together.xyz/v1', auth: 'bearer', listModelsPath: '/models', capabilities: { ...OPENAI_CLOUD_CAPS }, quirks: { supportsUsageInStream: true } },
  fireworks: { engine: 'openaiChat', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', auth: 'bearer', listModelsPath: '/models', capabilities: { ...OPENAI_CLOUD_CAPS }, quirks: { supportsUsageInStream: true } },
  lmstudio: {
    engine: 'openaiChat',
    defaultBaseUrl: 'http://localhost:1234/v1',
    auth: 'none',
    listModelsPath: '/models',
    // Local servers front arbitrary weights; native tool-calling is model-dependent
    // and often absent, so `toolMode: 'auto'` prefers the promptJson floor here.
    capabilities: { nativeTools: false, jsonMode: true },
    quirks: { keyOptional: true },
  },
  llamacpp: {
    engine: 'openaiChat',
    defaultBaseUrl: 'http://localhost:8080/v1',
    auth: 'none',
    listModelsPath: '/models',
    healthPath: '/health',
    capabilities: { nativeTools: false, jsonMode: true },
    quirks: { keyOptional: true, modelOptional: true },
  },
  vllm: {
    engine: 'openaiChat',
    defaultBaseUrl: 'http://localhost:8000/v1',
    auth: 'none',
    listModelsPath: '/models',
    capabilities: { nativeTools: false, jsonMode: true },
    quirks: { keyOptional: true },
  },
  ollama: {
    engine: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    auth: 'none',
    listModelsPath: '/api/tags',
    // Ollama's native /api/chat tools path is real, but the small local models it
    // usually serves rarely honor it; `auto` therefore uses the promptJson floor.
    capabilities: { nativeTools: false, jsonMode: true },
    quirks: { keyOptional: true },
  },
  anthropic: {
    engine: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    auth: 'x-api-key',
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
    capabilities: { nativeTools: true, jsonMode: true },
    quirks: { maxTokensRequired: true },
  },
  google: {
    engine: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    auth: 'x-goog-api-key',
    capabilities: { nativeTools: true, jsonMode: true },
  },
  'openai-compat': {
    engine: 'openaiChat',
    auth: 'bearer',
    listModelsPath: '/models',
    // Unknown endpoint: assume the OpenAI JSON mode works, but don't assume
    // native tools — the safe floor is promptJson until an app opts into native.
    capabilities: { nativeTools: false, jsonMode: true },
  },
};

export function profileFor(provider: string, baseUrl?: string): ProviderProfile {
  return PROVIDER_PROFILES[provider] ?? {
    ...PROVIDER_PROFILES['openai-compat']!,
    defaultBaseUrl: baseUrl,
  };
}

/**
 * Resolved static capabilities for a connection's provider. Apps can read this
 * to decide, e.g., whether to request native tools; the agent layer uses it to
 * resolve `toolMode: 'auto'`. Unknown providers fall through to the conservative
 * `openai-compat` defaults (JSON mode yes, native tools no).
 */
export function providerCapabilities(provider: string, baseUrl?: string): { nativeTools: boolean; jsonMode: boolean } {
  const profile = profileFor(provider, baseUrl);
  return {
    nativeTools: profile.capabilities?.nativeTools ?? false,
    jsonMode: profile.capabilities?.jsonMode ?? false,
  };
}

export function applyAuth(profile: ProviderProfile, apiKey: string | null, headers: Record<string, string>): Record<string, string> {
  const next = { ...profile.defaultHeaders, ...headers };
  if (!apiKey) return next;
  if (profile.auth === 'bearer') next.authorization = `Bearer ${apiKey}`;
  else if (profile.auth === 'x-api-key') next['x-api-key'] = apiKey;
  else if (profile.auth === 'x-goog-api-key') next['x-goog-api-key'] = apiKey;
  else if (profile.auth === 'api-key-header') next['api-key'] = apiKey;
  return next;
}
