"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.envConnection = envConnection;
const util_js_1 = require("./util.js");
/**
 * Resolves a server-side `Connection` plus a default `model` from app-owned
 * env vars (`AI_PROVIDER`, `AI_MODEL`, `AI_KEY_ENV`, `AI_BASE_URL` unless
 * overridden). This only collapses the config-reading boilerplate that was
 * being hand-rolled the same way in every small server app; it does not add
 * policy. `provider`/`baseUrl` still come from the server's own environment,
 * never from client input, and the returned `keyRef` still resolves through
 * `KeySource` at call time like any other `Connection`.
 */
function envConnection(options = {}) {
    const env = options.env ?? (0, util_js_1.globalEnv)();
    const provider = env[options.providerVar ?? 'AI_PROVIDER']?.trim() || options.defaultProvider || 'openai';
    const model = env[options.modelVar ?? 'AI_MODEL']?.trim() || options.defaultModel || 'gpt-4o-mini';
    const keyEnvName = env[options.keyEnvVar ?? 'AI_KEY_ENV']?.trim() || options.defaultKeyEnv || 'OPENAI_API_KEY';
    const baseUrl = env[options.baseUrlVar ?? 'AI_BASE_URL']?.trim();
    const connection = {
        id: options.id ?? 'app',
        provider,
        keyRef: { kind: 'env', name: keyEnvName },
        ...(baseUrl ? { baseUrl } : {}),
    };
    return { connection, model };
}
