"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponsesAdapter = void 0;
const errors_js_1 = require("../../errors.js");
const transport_js_1 = require("../../transport.js");
const util_js_1 = require("../../util.js");
const openaiChat_js_1 = require("./openaiChat.js");
const base_js_1 = require("./base.js");
/** Responses wire format shared by compatible providers. Explicit opt-in only. */
class ResponsesAdapter extends openaiChat_js_1.OpenAIChatAdapter {
    responsesProfile;
    constructor(provider, responsesProfile) {
        super(provider, responsesProfile);
        this.responsesProfile = responsesProfile;
    }
    async *stream(conn, req) {
        const started = Date.now();
        const timeout = (0, base_js_1.streamTimeout)(conn, req.signal);
        let firstTokenMs = null;
        let text = '';
        let response;
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        if (req.promptCache && !this.responsesProfile.quirks?.promptCache)
            yield (0, base_js_1.promptCacheUnsupported)(conn.provider);
        try {
            const body = responsesBody(conn, req, this.responsesProfile.quirks?.promptCache === true);
            if (this.responsesProfile.quirks?.responsesStreaming === false) {
                body.stream = false;
                yield { type: 'context', kind: 'buffered_response', data: { reason: 'This provider only supports buffered Responses requests.' } };
            }
            const res = await (0, transport_js_1.postResponse)((0, util_js_1.joinUrl)(conn.baseUrl, '/responses'), body, conn.headers, timeout.signal, conn.provider, conn.fetch);
            if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
                for await (const line of (0, transport_js_1.sseLines)(res)) {
                    timeout.bump();
                    const event = (0, util_js_1.asRecord)((0, base_js_1.safeParse)(line));
                    if (!event)
                        throw invalid('Malformed Responses event', conn);
                    if (event.type === 'response.output_text.delta') {
                        const delta = (0, util_js_1.asString)(event.delta) ?? '';
                        text += delta;
                        if (delta) {
                            firstTokenMs ??= Date.now() - started;
                            yield { type: 'delta', text: delta };
                        }
                    }
                    else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
                        yield { type: 'reasoning', text: (0, util_js_1.asString)(event.delta) ?? '' };
                    }
                    else if (event.type === 'response.function_call_arguments.delta') {
                        yield { type: 'context', kind: 'tool_arguments_delta', data: { itemId: event.item_id, delta: event.delta } };
                    }
                    else if (event.type === 'error' || event.type === 'response.failed') {
                        throw responseFailure((0, util_js_1.asRecord)(event.error) ?? (0, util_js_1.asRecord)((0, util_js_1.asRecord)(event.response)?.error), conn);
                    }
                    else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
                        response = (0, util_js_1.asRecord)(event.response);
                    }
                    else if (typeof event.type === 'string' && event.type.includes(':')) {
                        // Open Responses extension events are `slug:name`; surface, never drop.
                        yield { type: 'context', kind: 'provider_event', data: event };
                    }
                }
                if (!response)
                    throw invalid('Responses stream ended without a terminal response', conn);
            }
            else {
                response = (0, util_js_1.asRecord)((0, base_js_1.safeParse)(await res.text()));
            }
            if (!response || !Array.isArray(response.output))
                throw invalid('Responses result has no output array', conn);
            if (response.status === 'failed')
                throw responseFailure((0, util_js_1.asRecord)(response.error), conn);
            if (response.status !== 'completed' && response.status !== 'incomplete')
                throw invalid(`Responses request did not complete (${String(response.status)})`, conn);
            const output = response.output.map(util_js_1.asRecord).filter((item) => !!item);
            const toolCalls = [];
            const media = [];
            let finalText = '';
            let refused = false;
            for (const item of output) {
                if (item.type === 'message' && Array.isArray(item.content)) {
                    for (const value of item.content) {
                        const part = (0, util_js_1.asRecord)(value);
                        if (part?.type === 'output_text')
                            finalText += (0, util_js_1.asString)(part.text) ?? '';
                        if (part?.type === 'refusal') {
                            refused = true;
                            yield { type: 'context', kind: 'refusal', data: part };
                        }
                        if (Array.isArray(part?.annotations) && part.annotations.length)
                            yield { type: 'context', kind: 'annotations', data: part.annotations };
                    }
                }
                else if (item.type === 'function_call') {
                    const id = (0, util_js_1.asString)(item.call_id);
                    const name = (0, util_js_1.asString)(item.name);
                    const raw = (0, util_js_1.asString)(item.arguments);
                    const args = raw === undefined ? undefined : (0, base_js_1.safeParse)(raw);
                    if (!id || !name || args === undefined)
                        throw invalid('Malformed Responses function call', conn);
                    toolCalls.push({ id, name, arguments: args, raw });
                }
                else if (item.type === 'image_generation_call' && typeof item.result === 'string') {
                    const format = (0, util_js_1.asString)(item.output_format) ?? 'png';
                    const image = { type: 'image', mimeType: `image/${format === 'jpg' ? 'jpeg' : format}`, dataBase64: item.result };
                    media.push(image);
                    yield { type: 'context', kind: 'media', data: image };
                }
                else if (item.type !== 'reasoning') {
                    yield { type: 'context', kind: 'provider_output', data: item };
                }
            }
            if (!text && finalText) {
                firstTokenMs ??= Date.now() - started;
                yield { type: 'delta', text: finalText };
            }
            for (const call of toolCalls)
                yield { type: 'tool_call', call };
            const usage = (0, util_js_1.asRecord)(response.usage);
            const inputTokens = (0, util_js_1.asNumber)(usage?.input_tokens);
            const outputTokens = (0, util_js_1.asNumber)(usage?.output_tokens);
            const inputDetails = (0, util_js_1.asRecord)(usage?.input_tokens_details);
            const cachedInputTokens = (0, util_js_1.asNumber)(inputDetails?.cached_tokens);
            const cacheWriteTokens = (0, util_js_1.asNumber)(inputDetails?.cache_write_tokens);
            const result = {
                text: finalText || text,
                ...(media.length ? { media } : {}),
                toolCalls: toolCalls.length ? toolCalls : undefined,
                providerState: { provider: conn.provider, model: req.model, protocol: 'responses', content: output },
                finishReason: response.status === 'incomplete'
                    ? (0, util_js_1.asRecord)(response.incomplete_details)?.reason === 'content_filter' ? 'content_filter' : 'length'
                    : toolCalls.length ? 'tool' : refused ? 'content_filter' : 'stop',
                usage: {
                    inputTokens, outputTokens,
                    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
                    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
                    estimated: inputTokens === undefined && outputTokens === undefined,
                },
                timing: { firstTokenMs, totalMs: Date.now() - started },
                model: req.model,
                source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
            };
            yield { type: 'done', result };
        }
        catch (error) {
            throw (0, base_js_1.streamError)(error, timeout, conn.provider);
        }
        finally {
            timeout.done();
        }
    }
}
exports.ResponsesAdapter = ResponsesAdapter;
function invalid(message, conn) {
    return new errors_js_1.AIError(message, { kind: 'invalid_response', retryable: false, provider: conn.provider });
}
/**
 * Typed failure for `error` / `response.failed`. Open Responses error types
 * (`too_many_requests`, `server_error`, `model_error`, `invalid_request`,
 * `not_found`) map onto their HTTP status so retryability matches a plain
 * HTTP failure; unknown types stay `invalid_response`.
 */
function responseFailure(error, conn) {
    const statuses = {
        too_many_requests: 429, rate_limit_exceeded: 429, server_error: 500, model_error: 500,
        invalid_request: 400, invalid_request_error: 400, not_found: 404, context_length_exceeded: 400,
    };
    const status = statuses[(0, util_js_1.asString)(error?.type) ?? ''] ?? statuses[(0, util_js_1.asString)(error?.code) ?? ''];
    if (status !== undefined)
        return (0, errors_js_1.classify)(status, JSON.stringify(error), conn.provider);
    return invalid((0, util_js_1.asString)(error?.message) ?? 'Responses request failed', conn);
}
/** Responses `mcp` tool entries for provider-hosted MCP servers. */
function mcpTools(req) {
    return (req.mcpServers ?? []).map((server) => {
        const token = (0, util_js_1.mcpToken)(server);
        return {
            type: 'mcp',
            server_label: server.name,
            server_url: server.url,
            ...(token ? { authorization: token } : {}),
            ...(server.allowedTools ? { allowed_tools: server.allowedTools } : {}),
            ...(server.requireApproval ? { require_approval: server.requireApproval } : {}),
        };
    });
}
function responsesBody(conn, req, promptCache = false) {
    if (req.stopSequences?.length)
        throw new errors_js_1.AIError('Responses does not support stopSequences', { kind: 'invalid_request', retryable: false, provider: conn.provider });
    const input = [];
    for (const message of req.messages) {
        const state = message.providerState;
        if (message.role === 'assistant' && state?.provider === conn.provider && state.model === req.model && state.protocol === 'responses') {
            input.push(...state.content);
            continue;
        }
        if (message.role === 'tool') {
            input.push({ type: 'function_call_output', call_id: message.toolCallId, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) });
            continue;
        }
        input.push({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text'
                ? { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text ?? '' }
                : responsesPart(part, conn.provider)) });
        for (const call of message.toolCalls ?? [])
            input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.raw ?? JSON.stringify(call.arguments) });
    }
    return (0, util_js_1.applyProviderOptions)({
        model: req.model, input, stream: true, store: false,
        max_output_tokens: req.maxTokens, temperature: req.temperature, top_p: req.topP,
        reasoning: req.reasoningEffort === undefined ? undefined : { effort: req.reasoningEffort },
        tools: req.tools?.length || req.mcpServers?.length ? [...(req.tools ?? []).map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })), ...mcpTools(req)] : undefined,
        ...(promptCache && req.promptCache ? (0, openaiChat_js_1.openAiPromptCache)(req, true) : {}),
        tool_choice: typeof req.toolChoice === 'object' ? { type: 'function', name: req.toolChoice.name } : req.toolChoice,
        text: req.responseFormat?.type === 'json' ? { format: req.responseFormat.schema
                ? { type: 'json_schema', name: 'response', schema: req.responseFormat.schema, strict: true }
                : { type: 'json_object' } } : undefined,
    }, req.providerOptions);
}
/** Responses input parts: `input_image` and `input_file` by data URL or URL; no audio/video input. */
function responsesPart(part, provider) {
    if (part.type === 'image')
        return { type: 'input_image', image_url: (0, base_js_1.partUrl)(part) };
    if (part.type === 'file') {
        return (0, base_js_1.partHasBytes)(part)
            ? { type: 'input_file', filename: part.filename ?? 'document', file_data: (0, base_js_1.partUrl)(part) }
            : { type: 'input_file', file_url: part.url ?? '' };
    }
    throw (0, base_js_1.unsupportedPart)(provider, part);
}
