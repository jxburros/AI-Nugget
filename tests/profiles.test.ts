import { describe, expect, it } from 'vitest';
import { adapterFor, allowlistPolicy, PROVIDER_PROFILES, profileFor } from '../src/index.js';
import { applyAuth } from '../src/adapters/profiles.js';

describe('provider profiles', () => {
  it('ships the documented v1 provider set and no grok/xai profile', () => {
    const expected = ['openai', 'azure-openai', 'openrouter', 'groq', 'deepseek', 'mistral', 'together', 'fireworks', 'lmstudio', 'llamacpp', 'vllm', 'ollama', 'anthropic', 'google', 'openai-compat'];
    for (const key of expected) expect(PROVIDER_PROFILES[key], key).toBeDefined();
    expect(PROVIDER_PROFILES['grok']).toBeUndefined();
    expect(PROVIDER_PROFILES['xai']).toBeUndefined();
  });

  it('routes each provider to the correct engine via adapterFor', () => {
    expect(adapterFor('openai').provider).toBe('openai');
    expect(adapterFor('anthropic').constructor.name).toBe('AnthropicAdapter');
    expect(adapterFor('google').constructor.name).toBe('GoogleAdapter');
    expect(adapterFor('ollama').constructor.name).toBe('OllamaAdapter');
    expect(adapterFor('groq').constructor.name).toBe('OpenAIChatAdapter');
  });

  it('falls back unknown providers to the openai-compat escape hatch', () => {
    const profile = profileFor('some-new-provider', 'https://example.test/v1');
    expect(profile.engine).toBe('openaiChat');
    expect(profile.defaultBaseUrl).toBe('https://example.test/v1');
    expect(adapterFor('some-new-provider', 'https://example.test/v1').constructor.name).toBe('OpenAIChatAdapter');
  });

  it('constructs auth headers per auth mode', () => {
    expect(applyAuth(PROVIDER_PROFILES['openai']!, 'k', {})).toEqual({ authorization: 'Bearer k' });
    expect(applyAuth(PROVIDER_PROFILES['anthropic']!, 'k', {})).toEqual({ 'anthropic-version': '2023-06-01', 'x-api-key': 'k' });
    expect(applyAuth(PROVIDER_PROFILES['google']!, 'k', {})).toEqual({ 'x-goog-api-key': 'k' });
    expect(applyAuth(PROVIDER_PROFILES['azure-openai']!, 'k', {})).toEqual({ 'api-key': 'k' });
  });

  it('omits auth headers for key-optional local profiles', () => {
    expect(applyAuth(PROVIDER_PROFILES['ollama']!, null, {})).toEqual({});
    expect(applyAuth(PROVIDER_PROFILES['lmstudio']!, null, {})).toEqual({});
    expect(applyAuth(PROVIDER_PROFILES['llamacpp']!, null, {})).toEqual({});
  });

  it('merges profile default headers under caller overrides (openrouter attribution)', () => {
    const merged = applyAuth(PROVIDER_PROFILES['openrouter']!, 'k', { 'HTTP-Referer': 'https://app.test', 'X-Title': 'My App' });
    expect(merged).toEqual({ 'X-Title': 'My App', 'HTTP-Referer': 'https://app.test', authorization: 'Bearer k' });
    expect(applyAuth(PROVIDER_PROFILES['openrouter']!, 'k', {})).toEqual({
      'HTTP-Referer': 'https://github.com/jxburros/AI-Nugget',
      'X-Title': 'ai-handler',
      authorization: 'Bearer k',
    });
  });

  it('marks local quirks: key-optional, model-optional, health path', () => {
    expect(PROVIDER_PROFILES['llamacpp']!.quirks?.keyOptional).toBe(true);
    expect(PROVIDER_PROFILES['llamacpp']!.quirks?.modelOptional).toBe(true);
    expect(PROVIDER_PROFILES['llamacpp']!.healthPath).toBe('/health');
    expect(PROVIDER_PROFILES['anthropic']!.quirks?.maxTokensRequired).toBe(true);
  });

  it('carries an azure deployment URL template', () => {
    expect(PROVIDER_PROFILES['azure-openai']!.quirks?.urlTemplate).toContain('/openai/deployments/{model}/chat/completions');
    expect(PROVIDER_PROFILES['azure-openai']!.quirks?.urlTemplate).toContain('api-version=');
  });

  it('marks hosted cloud providers as having reliable native tools and a real JSON mode', () => {
    for (const key of ['openai', 'anthropic', 'google', 'openrouter', 'groq', 'azure-openai']) {
      expect(PROVIDER_PROFILES[key]!.capabilities, key).toEqual({ nativeTools: true, jsonMode: true, local: false, embeddable: false });
    }
  });

  it('marks local runtimes as local/embeddable with model-dependent tool support', () => {
    for (const key of ['lmstudio', 'llamacpp', 'vllm']) {
      const capabilities = PROVIDER_PROFILES[key]!.capabilities;
      expect(capabilities, key).toEqual({ nativeTools: false, jsonMode: false, local: true, embeddable: true });
    }
    // Ollama's format:'json' is engine-enforced regardless of model, unlike its tools field.
    expect(PROVIDER_PROFILES['ollama']!.capabilities).toEqual({ nativeTools: false, jsonMode: true, local: true, embeddable: true });
  });

  it('treats the openai-compat escape hatch and unknown providers as conservative local defaults', () => {
    expect(PROVIDER_PROFILES['openai-compat']!.capabilities).toEqual({ nativeTools: false, jsonMode: false, local: true, embeddable: true });
    expect(profileFor('some-new-provider', 'https://example.test/v1').capabilities).toEqual({ nativeTools: false, jsonMode: false, local: true, embeddable: true });
  });

  it('fails closed for providers absent from allowlistPolicy', () => {
    const policy = allowlistPolicy({ openai: ['gpt-'] });
    expect(policy.checkModel('openai', 'gpt-5-mini')).toEqual({ allowed: true });
    expect(policy.checkModel('anthropic', 'claude-test')).toEqual({ allowed: false, reason: 'No models are allowed for provider anthropic' });
    expect(allowlistPolicy({ openai: ['*'] }).checkModel('openai', '__listModels__')).toEqual({ allowed: true });
  });
});
