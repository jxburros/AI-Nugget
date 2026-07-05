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

export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  openai: {
    engine: 'openaiChat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    listModelsPath: '/models',
    quirks: { supportsUsageInStream: true },
  },
  'azure-openai': {
    engine: 'openaiChat',
    auth: 'api-key-header',
    quirks: { urlTemplate: '{baseUrl}/openai/deployments/{model}/chat/completions?api-version=2024-10-21' },
  },
  openrouter: {
    engine: 'openaiChat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    defaultHeaders: { 'X-Title': 'ai-handler' },
    listModelsPath: '/models',
    quirks: { supportsUsageInStream: true },
  },
  groq: { engine: 'openaiChat', defaultBaseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', listModelsPath: '/models' },
  deepseek: { engine: 'openaiChat', defaultBaseUrl: 'https://api.deepseek.com/v1', auth: 'bearer', listModelsPath: '/models' },
  mistral: { engine: 'openaiChat', defaultBaseUrl: 'https://api.mistral.ai/v1', auth: 'bearer', listModelsPath: '/models' },
  together: { engine: 'openaiChat', defaultBaseUrl: 'https://api.together.xyz/v1', auth: 'bearer', listModelsPath: '/models' },
  fireworks: { engine: 'openaiChat', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', auth: 'bearer', listModelsPath: '/models' },
  lmstudio: {
    engine: 'openaiChat',
    defaultBaseUrl: 'http://localhost:1234/v1',
    auth: 'none',
    listModelsPath: '/models',
    quirks: { keyOptional: true },
  },
  llamacpp: {
    engine: 'openaiChat',
    defaultBaseUrl: 'http://localhost:8080/v1',
    auth: 'none',
    listModelsPath: '/models',
    healthPath: '/health',
    quirks: { keyOptional: true, modelOptional: true },
  },
  vllm: {
    engine: 'openaiChat',
    defaultBaseUrl: 'http://localhost:8000/v1',
    auth: 'none',
    listModelsPath: '/models',
    quirks: { keyOptional: true },
  },
  ollama: {
    engine: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    auth: 'none',
    listModelsPath: '/api/tags',
    quirks: { keyOptional: true },
  },
  anthropic: {
    engine: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    auth: 'x-api-key',
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
    quirks: { maxTokensRequired: true },
  },
  google: {
    engine: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    auth: 'x-goog-api-key',
  },
  'openai-compat': {
    engine: 'openaiChat',
    auth: 'bearer',
    listModelsPath: '/models',
  },
};

export function profileFor(provider: string, baseUrl?: string): ProviderProfile {
  return PROVIDER_PROFILES[provider] ?? {
    ...PROVIDER_PROFILES['openai-compat']!,
    defaultBaseUrl: baseUrl,
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
