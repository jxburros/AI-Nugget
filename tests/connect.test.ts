import { describe, expect, it } from 'vitest';
import { envConnection } from '../src/index.js';

describe('envConnection', () => {
  it('falls back to conservative defaults when no env vars are set', () => {
    expect(envConnection({ env: {} })).toEqual({
      connection: { id: 'app', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
      model: 'gpt-4o-mini',
    });
  });

  it('reads AI_PROVIDER, AI_MODEL, AI_KEY_ENV, and AI_BASE_URL by default', () => {
    const env = {
      AI_PROVIDER: 'anthropic',
      AI_MODEL: 'claude-sonnet-5',
      AI_KEY_ENV: 'ANTHROPIC_API_KEY',
      AI_BASE_URL: 'https://proxy.example.com',
    };
    expect(envConnection({ env, id: 'my-app' })).toEqual({
      connection: {
        id: 'my-app',
        provider: 'anthropic',
        keyRef: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
        baseUrl: 'https://proxy.example.com',
      },
      model: 'claude-sonnet-5',
    });
  });

  it('supports custom var names and per-call defaults', () => {
    const env = { MY_PROVIDER: 'ollama' };
    const result = envConnection({
      env,
      providerVar: 'MY_PROVIDER',
      defaultModel: 'llama3.2',
      defaultKeyEnv: 'none-needed',
    });
    expect(result.connection.provider).toBe('ollama');
    expect(result.model).toBe('llama3.2');
    expect(result.connection.keyRef).toEqual({ kind: 'env', name: 'none-needed' });
  });

  it('ignores blank env values in favor of defaults', () => {
    const env = { AI_PROVIDER: '  ', AI_MODEL: '', AI_BASE_URL: '   ' };
    const result = envConnection({ env });
    expect(result.connection.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.connection.baseUrl).toBeUndefined();
  });
});
