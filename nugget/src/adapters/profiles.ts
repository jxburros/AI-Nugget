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

const HOSTED_CLOUD: ProviderCapabilities = { nativeTools: true, jsonMode: true, local: false, embeddable: false };
const LOCAL_RUNTIME: ProviderCapabilities = { nativeTools: false, jsonMode: false, local: true, embeddable: true };

export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  openai: {
    engine: 'openaiChat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    listModelsPath: '/models',
    capabilities: HOSTED_CLOUD,
    quirks: { supportsUsageInStream: true },
  },
  'azure-openai': {
    engine: 'openaiChat',
    auth: 'api-key-header',
    capabilities: HOSTED_CLOUD,
    quirks: { urlTemplate: '{baseUrl}/openai/deployments/{model}/chat/completions?api-version=2024-10-21' },
  },
  openrouter: {
    engine: 'openaiChat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    defaultHeaders: { 'X-Title': 'ai-handler' },
    listModelsPath: '/models',
    capabilities: HOSTED_CLOUD,
    quirks: { supportsUsageInStream: true },
  },
  groq: { engine: 'openaiChat', defaultBaseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
  deepseek: { engine: 'openaiChat', defaultBaseUrl: 'https://api.deepseek.com/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
  mistral: { engine: 'openaiChat', defaultBaseUrl: 'https://api.mistral.ai/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
  together: { engine: 'openaiChat', defaultBaseUrl: 'https://api.together.xyz/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
  fireworks: { engine: 'openaiChat', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', auth: 'bearer', listModelsPath: '/models', capabilities: HOSTED_CLOUD },
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
