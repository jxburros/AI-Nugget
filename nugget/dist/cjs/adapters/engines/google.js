"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleAdapter = void 0;
const errors_js_1 = require("../../errors.js");
const tokens_js_1 = require("../../tokens.js");
const transport_js_1 = require("../../transport.js");
const util_js_1 = require("../../util.js");
const base_js_1 = require("./base.js");
class GoogleAdapter {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async chat(conn, req) {
        let result;
        for await (const event of this.stream(conn, req)) {
            if (event.type === 'done')
                result = event.result;
            if (event.type === 'error')
                throw event.error;
        }
        if (!result)
            throw new errors_js_1.AIError('Google stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
        return result;
    }
    async *stream(conn, req) {
        const started = Date.now();
        let firstTokenMs = null;
        let text = '';
        let inputTokens;
        let outputTokens;
        let finish;
        const toolCalls = [];
        const timeout = (0, base_js_1.streamTimeout)(conn, req.signal);
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        // Gemini rejects `responseMimeType: application/json` combined with function
        // declarations, so `body()` drops JSON mode when tools are present. Surface
        // that downgrade instead of silently returning unstructured text.
        if (jsonModeDowngraded(req)) {
            yield {
                type: 'context',
                kind: 'json_mode_downgraded',
                data: { reason: 'Gemini does not accept JSON response mode together with tools; the request was sent without JSON mode', provider: conn.provider },
            };
        }
        try {
            const streamUrl = `${conn.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
            const res = await (0, transport_js_1.postResponse)(streamUrl, body(req), conn.headers, timeout.signal, conn.provider);
            const contentType = res.headers.get('content-type') ?? '';
            const chunks = contentType.includes('text/event-stream') ? (0, transport_js_1.sseLines)(res) : singleJsonLine(res);
            for await (const line of chunks) {
                timeout.bump();
                const parsed = (0, base_js_1.safeParse)(line);
                const record = (0, util_js_1.asRecord)(parsed);
                const promptFeedback = (0, util_js_1.asRecord)(record?.promptFeedback);
                if (!firstCandidate(record) && promptFeedback?.blockReason)
                    finish = 'SAFETY';
                for (const part of candidateParts(record)) {
                    const partText = (0, util_js_1.asString)((0, util_js_1.asRecord)(part)?.text);
                    if (partText) {
                        // Gemini marks reasoning parts with `thought: true`; route those to
                        // the reasoning channel so they don't blend into the answer text.
                        if ((0, util_js_1.asRecord)(part)?.thought === true) {
                            yield { type: 'reasoning', text: partText };
                            continue;
                        }
                        if (firstTokenMs === null)
                            firstTokenMs = Date.now() - started;
                        text += partText;
                        yield { type: 'delta', text: partText };
                    }
                    const fnCall = (0, util_js_1.asRecord)((0, util_js_1.asRecord)(part)?.functionCall);
                    if (fnCall) {
                        const call = {
                            id: (0, base_js_1.randomId)(),
                            name: (0, util_js_1.asString)(fnCall.name) ?? 'unknown',
                            arguments: fnCall.args ?? {},
                            raw: JSON.stringify(fnCall.args ?? {}),
                        };
                        toolCalls.push(call);
                        yield { type: 'tool_call', call };
                    }
                }
                finish = (0, util_js_1.asString)((0, util_js_1.asRecord)(firstCandidate(record))?.finishReason) ?? finish;
                const usage = (0, util_js_1.asRecord)(record?.usageMetadata);
                inputTokens = (0, util_js_1.asNumber)(usage?.promptTokenCount) ?? inputTokens;
                outputTokens = (0, util_js_1.asNumber)(usage?.candidatesTokenCount) ?? outputTokens;
            }
            if (!finish)
                yield (0, base_js_1.streamAnomaly)('stream ended without a finishReason');
            const hasTools = toolCalls.length > 0;
            yield { type: 'done', result: {
                    text,
                    toolCalls: hasTools ? toolCalls : undefined,
                    finishReason: mapFinish(finish, hasTools),
                    usage: inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens, estimated: false } : (0, tokens_js_1.estimatedUsage)((0, util_js_1.textFromMessages)(req.messages), text),
                    timing: { firstTokenMs, totalMs: Date.now() - started },
                    model: req.model,
                    source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
                } };
        }
        catch (error) {
            throw (0, base_js_1.streamError)(error, timeout, conn.provider);
        }
        finally {
            timeout.done();
        }
    }
    /**
     * `GoogleAdapter` has no `listModels`, so without a `health` probe
     * `AIHandler.testConnection` would report `ok: true` without ever making a
     * network call. `/v1beta/models` is a lightweight, key-authenticated GET
     * that gives an honest connectivity/auth check.
     */
    async health(conn) {
        try {
            await (0, transport_js_1.fetchJson)((0, util_js_1.joinUrl)(conn.baseUrl, '/v1beta/models'), {
                method: 'GET',
                headers: conn.headers,
                timeoutMs: Math.min(conn.timeoutMs ?? base_js_1.DEFAULT_TIMEOUT_MS, 10_000),
                provider: conn.provider,
            });
            return { ok: true };
        }
        catch (error) {
            return { ok: false, detail: error instanceof Error ? error.message : 'Health check failed' };
        }
    }
    /**
     * Lists models from Google's `/v1beta/models`. Strips the `models/` name
     * prefix, and maps `inputTokenLimit` → `contextWindow` and
     * `supportedGenerationMethods` → `capabilities`.
     */
    async listModels(conn) {
        const { data } = await (0, transport_js_1.fetchJson)((0, util_js_1.joinUrl)(conn.baseUrl, '/v1beta/models'), {
            method: 'GET',
            headers: conn.headers,
            timeoutMs: Math.min(conn.timeoutMs ?? base_js_1.DEFAULT_TIMEOUT_MS, 15_000),
            provider: conn.provider,
        });
        const rows = Array.isArray((0, util_js_1.asRecord)(data)?.models) ? (0, util_js_1.asRecord)(data).models : [];
        const models = [];
        for (const value of rows) {
            const row = (0, util_js_1.asRecord)(value);
            const name = (0, util_js_1.asString)(row?.name);
            if (!name)
                continue;
            const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
            const model = { id, source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl } };
            const contextWindow = (0, util_js_1.asNumber)(row?.inputTokenLimit);
            if (contextWindow !== undefined)
                model.contextWindow = contextWindow;
            const methods = row?.supportedGenerationMethods;
            if (Array.isArray(methods) && methods.every((m) => typeof m === 'string'))
                model.capabilities = methods;
            models.push(model);
        }
        return models;
    }
}
exports.GoogleAdapter = GoogleAdapter;
/** True when the caller asked for JSON mode but tools force it off. */
function jsonModeDowngraded(req) {
    return req.responseFormat?.type === 'json' && !!req.tools?.length;
}
function body(req) {
    const systemText = req.messages.filter((m) => m.role === 'system').map((m) => textContent(m.content)).join('\n\n');
    const jsonMode = req.responseFormat?.type === 'json' && !req.tools?.length;
    const responseSchema = req.responseFormat?.type === 'json' ? req.responseFormat.schema : undefined;
    const payload = {
        contents: toGoogleContents(req.messages.filter((m) => m.role !== 'system')),
        generationConfig: {
            temperature: req.temperature,
            topP: req.topP,
            maxOutputTokens: req.maxTokens,
            stopSequences: req.stopSequences,
            responseMimeType: jsonMode ? 'application/json' : undefined,
            responseSchema: jsonMode ? responseSchema : undefined,
        },
    };
    if (systemText)
        payload.systemInstruction = { parts: [{ text: systemText }] };
    if (req.tools?.length) {
        payload.tools = [{ functionDeclarations: req.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
        const mode = req.toolChoice === 'none' ? 'NONE' : typeof req.toolChoice === 'object' ? 'ANY' : 'AUTO';
        const config = { mode };
        if (typeof req.toolChoice === 'object')
            config.allowedFunctionNames = [req.toolChoice.name];
        payload.toolConfig = { functionCallingConfig: config };
    }
    // providerOptions reaches Google-native fields: top-level `safetySettings`,
    // `cachedContent`, and `generationConfig` extras (`thinkingConfig`,
    // `responseModalities`, …) merged one level deep into generationConfig.
    return (0, util_js_1.applyProviderOptions)(payload, req.providerOptions, ['generationConfig']);
}
function toGoogleContents(messages) {
    const contents = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role !== 'tool') {
            contents.push(toGoogleContent(message));
            continue;
        }
        const parts = [];
        while (index < messages.length && messages[index]?.role === 'tool') {
            const toolMessage = messages[index];
            parts.push({ functionResponse: { name: toolMessage.name ?? 'unknown', response: toolResponseObject(toolMessage) } });
            index += 1;
        }
        index -= 1;
        contents.push({ role: 'user', parts });
    }
    return contents;
}
function toGoogleContent(m) {
    // Tool-role messages are handled by toGoogleContents' batching loop and never
    // reach here, so no tool branch is needed.
    if (m.role === 'assistant' && m.toolCalls?.length) {
        const parts = [...googleParts(m.content)];
        for (const call of m.toolCalls)
            parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
        return { role: 'model', parts };
    }
    return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: googleParts(m.content),
    };
}
/** Maps text/image content — a string or a ContentPart[] — onto Google parts. */
function googleParts(content) {
    if (typeof content === 'string')
        return content ? [{ text: content }] : [];
    return content.map((part) => part.type === 'image'
        ? { inlineData: { mimeType: part.mimeType ?? 'image/png', data: part.imageBase64 ?? '' } }
        : { text: part.text ?? '' });
}
function textContent(content) {
    if (typeof content === 'string')
        return content;
    if (!content)
        return '';
    return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}
function toolResponseObject(message) {
    if (typeof message.content !== 'string')
        return { content: textContent(message.content) };
    try {
        const parsed = JSON.parse(message.content);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    }
    catch {
        // keep string fallback
    }
    return { content: message.content };
}
async function* singleJsonLine(res) {
    const data = await res.json();
    // Non-SSE responses may be a single object or an array of streamed chunks.
    if (Array.isArray(data)) {
        for (const item of data)
            yield JSON.stringify(item);
    }
    else {
        yield JSON.stringify(data);
    }
}
function firstCandidate(record) {
    const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
    return candidates[0];
}
function candidateParts(record) {
    const content = (0, util_js_1.asRecord)((0, util_js_1.asRecord)(firstCandidate(record))?.content);
    return Array.isArray(content?.parts) ? content.parts : [];
}
function mapFinish(finish, hasTools) {
    if (hasTools)
        return 'tool';
    if (finish === 'MAX_TOKENS')
        return 'length';
    if (finish === 'SAFETY' || finish === 'RECITATION' || finish === 'BLOCKLIST' || finish === 'PROHIBITED_CONTENT')
        return 'content_filter';
    return 'stop';
}
