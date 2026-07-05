import { AnthropicAdapter } from './engines/anthropic.js';
import { GoogleAdapter } from './engines/google.js';
import { OllamaAdapter } from './engines/ollama.js';
import { OpenAIChatAdapter } from './engines/openaiChat.js';
import { profileFor } from './profiles.js';
export function adapterFor(provider, baseUrl) {
    const profile = profileFor(provider, baseUrl);
    if (profile.engine === 'anthropic')
        return new AnthropicAdapter(provider);
    if (profile.engine === 'google')
        return new GoogleAdapter(provider);
    if (profile.engine === 'ollama')
        return new OllamaAdapter(provider);
    return new OpenAIChatAdapter(provider, profile);
}
export { PROVIDER_PROFILES, profileFor, providerCapabilities } from './profiles.js';
//# sourceMappingURL=index.js.map