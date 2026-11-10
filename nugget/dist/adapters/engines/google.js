import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { fetchJson, postResponse, sseLines } from '../../transport.js';
import { applyProviderOptions, REASONING_BUDGET_TOKENS, asNumber, asRecord, asString, joinUrl, textFromMessages } from '../../util.js';
import { DEFAULT_TIMEOUT_MS, partBase64, partHasBytes, partMime, randomId, safeParse, streamAnomaly, streamError, streamTimeout } from './base.js';
export class GoogleAdapter {
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
            throw new AIError('Google stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
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
        const media = [];
        // The model turn exactly as streamed (text merged, signatures kept), for
        // replay: Gemini 3 rejects a function-call history without its thoughtSignature.
        const modelParts = [];
        const timeout = streamTimeout(conn, req.signal);
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
            const res = await postResponse(streamUrl, body(req, conn.provider), conn.headers, timeout.signal, conn.provider, conn.fetch);
            const contentType = res.headers.get('content-type') ?? '';
            const chunks = contentType.includes('text/event-stream') ? sseLines(res) : singleJsonLine(res);
            for await (const line of chunks) {
                timeout.bump();
                const parsed = safeParse(line);
                const record = asRecord(parsed);
                const promptFeedback = asRecord(record?.promptFeedback);
                if (!firstCandidate(record) && promptFeedback?.blockReason)
                    finish = 'SAFETY';
                for (const part of candidateParts(record)) {
                    keepPart(modelParts, asRecord(part));
                    const inline = asRecord(asRecord(part)?.inlineData);
                    const inlineData = asString(inline?.data);
                    if (inlineData && asRecord(part)?.thought !== true) {
                        const mimeType = asString(inline?.mimeType) ?? 'application/octet-stream';
                        const item = { type: mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'file', mimeType, dataBase64: inlineData };
                        media.push(item);
                        yield { type: 'context', kind: 'media', data: item };
                    }
                    const partText = asString(asRecord(part)?.text);
                    if (partText) {
                        // Gemini marks reasoning parts with `thought: true`; route those to
                        // the reasoning channel so they don't blend into the answer text.
                        if (asRecord(part)?.thought === true) {
                            yield { type: 'reasoning', text: partText };
                            continue;
                        }
                        if (firstTokenMs === null)
                            firstTokenMs = Date.now() - started;
                        text += partText;
                        yield { type: 'delta', text: partText };
                    }
                    const fnCall = asRecord(asRecord(part)?.functionCall);
                    if (fnCall) {
                        const call = {
                            id: randomId(),
                            name: asString(fnCall.name) ?? 'unknown',
                            arguments: fnCall.args ?? {},
                            raw: JSON.stringify(fnCall.args ?? {}),
                        };
                        toolCalls.push(call);
                        yield { type: 'tool_call', call };
                    }
                }
                finish = asString(asRecord(firstCandidate(record))?.finishReason) ?? finish;
                const usage = asRecord(record?.usageMetadata);
                inputTokens = asNumber(usage?.promptTokenCount) ?? inputTokens;
                outputTokens = asNumber(usage?.candidatesTokenCount) ?? outputTokens;
            }
            if (!finish)
                yield streamAnomaly('stream ended without a finishReason');
            const hasTools = toolCalls.length > 0;
            yield { type: 'done', result: {
                    text,
                    ...(media.length ? { media } : {}),
                    providerState: { provider: conn.provider, model: req.model, content: [{ role: 'model', parts: modelParts }] },
                    toolCalls: hasTools ? toolCalls : undefined,
                    finishReason: mapFinish(finish, hasTools),
                    usage: inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens, estimated: false } : estimatedUsage(textFromMessages(req.messages), text),
                    timing: { firstTokenMs, totalMs: Date.now() - started },
                    model: req.model,
                    source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
                } };
        }
        catch (error) {
            throw streamError(error, timeout, conn.provider);
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
            await fetchJson(joinUrl(conn.baseUrl, '/v1beta/models'), {
                method: 'GET',
                headers: conn.headers,
                timeoutMs: Math.min(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000),
                provider: conn.provider,
                fetch: conn.fetch,
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
        const { data } = await fetchJson(joinUrl(conn.baseUrl, '/v1beta/models'), {
            method: 'GET',
            headers: conn.headers,
            timeoutMs: Math.min(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000),
            provider: conn.provider,
            fetch: conn.fetch,
        });
        const rows = Array.isArray(asRecord(data)?.models) ? asRecord(data).models : [];
        const models = [];
        for (const value of rows) {
            const row = asRecord(value);
            const name = asString(row?.name);
            if (!name)
                continue;
            const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
            const model = { id, source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl } };
            const contextWindow = asNumber(row?.inputTokenLimit);
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
/** True when the caller asked for JSON mode but tools force it off. */
function jsonModeDowngraded(req) {
    return req.responseFormat?.type === 'json' && !!req.tools?.length;
}
function body(req, provider) {
    const systemText = req.messages.filter((m) => m.role === 'system').map((m) => textContent(m.content)).join('\n\n');
    const jsonMode = req.responseFormat?.type === 'json' && !req.tools?.length;
    const responseSchema = req.responseFormat?.type === 'json' ? req.responseFormat.schema : undefined;
    const payload = {
        contents: toGoogleContents(req.messages.filter((m) => m.role !== 'system'), req.model, provider),
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
    if (req.reasoningEffort !== undefined) {
        // First-class reasoning effort. Gemini 3+ takes a discrete `thinkingLevel`
        // (sending it to 2.x, or sending both knobs, is a 400); 2.x takes a token
        // `thinkingBudget` where 0 disables thinking on models that allow it.
        payload.generationConfig.thinkingConfig = thinkingLevelModel(req.model)
            ? { thinkingLevel: THINKING_LEVEL[req.reasoningEffort] }
            : { thinkingBudget: REASONING_BUDGET_TOKENS[req.reasoningEffort] };
    }
    // providerOptions reaches Google-native fields: top-level `safetySettings`,
    // `cachedContent`, and `generationConfig` extras (`thinkingConfig`,
    // `responseModalities`, …) merged one level deep into generationConfig.
    return applyProviderOptions(payload, req.providerOptions, ['generationConfig']);
}
function toGoogleContents(messages, model, provider) {
    const contents = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const state = message.providerState;
        if (message.role === 'assistant' && state?.provider === provider && state.model === model && state.protocol === undefined && state.content[0]) {
            contents.push(state.content[0]);
            continue;
        }
        if (message.role !== 'tool') {
            contents.push(toGoogleContent(message, model));
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
function toGoogleContent(m, model) {
    // Tool-role messages are handled by toGoogleContents' batching loop and never
    // reach here, so no tool branch is needed.
    if (m.role === 'assistant' && m.toolCalls?.length) {
        const parts = [...googleParts(m.content)];
        m.toolCalls.forEach((call, i) => {
            const part = { functionCall: { name: call.name, args: call.arguments ?? {} } };
            // History without the original signature (rebuilt by the app, or from
            // another provider): Gemini 3 requires one on the first call of a step,
            // and Google documents this sentinel for exactly that case.
            if (i === 0 && thinkingLevelModel(model))
                part.thoughtSignature = SKIP_SIGNATURE;
            parts.push(part);
        });
        return { role: 'model', parts };
    }
    return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: googleParts(m.content),
    };
}
/** Maps text/media content — a string or a ContentPart[] — onto Google parts. */
function googleParts(content) {
    if (typeof content === 'string')
        return content ? [{ text: content }] : [];
    return content.map((part) => part.type === 'text' ? { text: part.text ?? '' } : mediaPart(part));
}
/**
 * Gemini accepts images, audio, video and documents as `inlineData` bytes, or
 * by URI (`fileData`) for Files API / Cloud Storage / public URLs.
 */
function mediaPart(part) {
    if (partHasBytes(part))
        return { inlineData: { mimeType: partMime(part), data: partBase64(part) ?? '' } };
    return { fileData: { mimeType: partMime(part), fileUri: part.url ?? '' } };
}
/** Collects a streamed model part for replay, merging adjacent text of the same kind. */
function keepPart(parts, part) {
    if (!part)
        return;
    const last = parts.at(-1);
    const isText = typeof part.text === 'string' && Object.keys(part).every((key) => key === 'text' || key === 'thought' || key === 'thoughtSignature');
    const lastIsText = last && typeof last.text === 'string' && !last.thoughtSignature && Object.keys(last).every((key) => key === 'text' || key === 'thought');
    if (isText && lastIsText && (last.thought === true) === (part.thought === true)) {
        last.text = `${String(last.text)}${String(part.text)}`;
        if (part.thoughtSignature)
            last.thoughtSignature = part.thoughtSignature;
        return;
    }
    parts.push({ ...part });
}
const SKIP_SIGNATURE = 'skip_thought_signature_validator';
/** Gemini 3 and later use `thinkingLevel`; 2.x models use `thinkingBudget`. */
function thinkingLevelModel(model) {
    const major = /^(?:models\/)?gemini-(\d+)/.exec(model)?.[1];
    return major !== undefined && Number(major) >= 3;
}
/**
 * Effort → Gemini 3 `thinkingLevel`. Gemini 3 cannot fully disable thinking, so
 * `none` maps to its lowest level. Level support varies by model (3 Pro has only
 * `low`/`high`); an unsupported level is the provider's honest 400.
 */
const THINKING_LEVEL = {
    none: 'minimal', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};
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
    const content = asRecord(asRecord(firstCandidate(record))?.content);
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
//# sourceMappingURL=google.js.map