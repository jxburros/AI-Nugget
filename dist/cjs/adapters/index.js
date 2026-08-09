"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.profileFor = exports.PROVIDER_PROFILES = void 0;
exports.adapterFor = adapterFor;
const anthropic_js_1 = require("./engines/anthropic.js");
const google_js_1 = require("./engines/google.js");
const ollama_js_1 = require("./engines/ollama.js");
const openaiChat_js_1 = require("./engines/openaiChat.js");
const profiles_js_1 = require("./profiles.js");
function adapterFor(provider, baseUrl) {
    const profile = (0, profiles_js_1.profileFor)(provider, baseUrl);
    if (profile.engine === 'anthropic')
        return new anthropic_js_1.AnthropicAdapter(provider);
    if (profile.engine === 'google')
        return new google_js_1.GoogleAdapter(provider);
    if (profile.engine === 'ollama')
        return new ollama_js_1.OllamaAdapter(provider);
    return new openaiChat_js_1.OpenAIChatAdapter(provider, profile);
}
var profiles_js_2 = require("./profiles.js");
Object.defineProperty(exports, "PROVIDER_PROFILES", { enumerable: true, get: function () { return profiles_js_2.PROVIDER_PROFILES; } });
Object.defineProperty(exports, "profileFor", { enumerable: true, get: function () { return profiles_js_2.profileFor; } });
