import type { Connection } from './types.js';
import { globalEnv } from './util.js';

export interface EnvConnectionOptions {
  /** Read from this env-like object instead of the process/global environment. */
  env?: Record<string, string | undefined>;
  /** Connection id. Defaults to `'app'`. */
  id?: string;
  /** Env var names to read (override if an app already uses different names). */
  providerVar?: string;
  modelVar?: string;
  keyEnvVar?: string;
  baseUrlVar?: string;
  /** Fallbacks used when the corresponding env var is unset. */
  defaultProvider?: string;
  defaultModel?: string;
  defaultKeyEnv?: string;
}

export interface EnvConnection {
  connection: Connection;
  model: string;
}

/**
 * Resolves a server-side `Connection` plus a default `model` from app-owned
 * env vars (`AI_PROVIDER`, `AI_MODEL`, `AI_KEY_ENV`, `AI_BASE_URL` unless
 * overridden). This only collapses the config-reading boilerplate that was
 * being hand-rolled the same way in every small server app; it does not add
 * policy. `provider`/`baseUrl` still come from the server's own environment,
 * never from client input, and the returned `keyRef` still resolves through
 * `KeySource` at call time like any other `Connection`.
 */
export function envConnection(options: EnvConnectionOptions = {}): EnvConnection {
  const env = options.env ?? globalEnv();
  const provider = env[options.providerVar ?? 'AI_PROVIDER']?.trim() || options.defaultProvider || 'openai';
  const model = env[options.modelVar ?? 'AI_MODEL']?.trim() || options.defaultModel || 'gpt-4o-mini';
  const keyEnvName = env[options.keyEnvVar ?? 'AI_KEY_ENV']?.trim() || options.defaultKeyEnv || 'OPENAI_API_KEY';
  const baseUrl = env[options.baseUrlVar ?? 'AI_BASE_URL']?.trim();

  const connection: Connection = {
    id: options.id ?? 'app',
    provider,
    keyRef: { kind: 'env', name: keyEnvName },
    ...(baseUrl ? { baseUrl } : {}),
  };
  return { connection, model };
}
