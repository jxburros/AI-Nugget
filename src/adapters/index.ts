import type { Connection, ProviderAdapter } from '../types.js';
import { AnthropicAdapter } from './engines/anthropic.js';
import { GoogleAdapter } from './engines/google.js';
import { OllamaAdapter } from './engines/ollama.js';
import { OpenAIChatAdapter } from './engines/openaiChat.js';
import { ResponsesAdapter } from './engines/responses.js';
import { ConverseAdapter } from './engines/converse.js';
import { profileFor } from './profiles.js';

export function adapterFor(provider: string, baseUrl?: string, protocol?: Connection['protocol']): ProviderAdapter {
  const profile = profileFor(provider, baseUrl);
  if (protocol === 'converse') return new ConverseAdapter(provider);
  if (protocol === 'responses') return new ResponsesAdapter(provider, profile);
  if (profile.engine === 'anthropic') return new AnthropicAdapter(provider);
  if (profile.engine === 'google') return new GoogleAdapter(provider);
  if (profile.engine === 'ollama') return new OllamaAdapter(provider);
  return new OpenAIChatAdapter(provider, profile);
}

export { PROVIDER_PROFILES, profileFor } from './profiles.js';
export type { ProviderProfile, EngineName, AuthMode } from './profiles.js';
