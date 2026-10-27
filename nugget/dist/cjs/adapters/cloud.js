"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectionBaseUrl = connectionBaseUrl;
const errors_js_1 = require("../errors.js");
const profiles_js_1 = require("./profiles.js");
/** Resolve only documented endpoint shapes; explicit gateway URLs always win. */
function connectionBaseUrl(conn) {
    if (conn.baseUrl)
        return conn.baseUrl;
    const coordinate = (name) => {
        const value = conn.cloud?.[name];
        if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) {
            throw new errors_js_1.AIError(`${conn.provider} requires a valid cloud.${name} or baseUrl`, { kind: 'invalid_request', retryable: false, provider: conn.provider });
        }
        return value;
    };
    if (conn.provider === 'cloudflare')
        return `https://api.cloudflare.com/client/v4/accounts/${coordinate('accountId')}/ai/v1`;
    if (conn.provider === 'bedrock') {
        const region = coordinate('region');
        return conn.protocol === 'converse'
            ? `https://bedrock-runtime.${region}.amazonaws.com`
            : conn.cloud?.bedrockEndpoint === 'mantle'
                ? `https://bedrock-mantle.${region}.api.aws/v1`
                : `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
    }
    if (conn.provider === 'dashscope' && conn.cloud?.workspace)
        return `https://${coordinate('workspace')}.${coordinate('region')}.maas.aliyuncs.com/compatible-mode/v1`;
    if (conn.provider === 'vertex') {
        const location = coordinate('location');
        const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
        return `https://${host}/v1/projects/${coordinate('project')}/locations/${location}/endpoints/openapi`;
    }
    return (0, profiles_js_1.profileFor)(conn.provider).defaultBaseUrl;
}
