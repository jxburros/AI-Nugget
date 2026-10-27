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
        try {
            const body = responsesBody(conn, req);
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
                    else if (event.type === 'response.reasoning_summary_text.delta') {
                        yield { type: 'reasoning', text: (0, util_js_1.asString)(event.delta) ?? '' };
                    }
                    else if (event.type === 'response.function_call_arguments.delta') {
                        yield { type: 'context', kind: 'tool_arguments_delta', data: { itemId: event.item_id, delta: event.delta } };
                    }
                    else if (event.type === 'error' || event.type === 'response.failed') {
                        throw invalid((0, util_js_1.asString)((0, util_js_1.asRecord)(event.error)?.message) ?? (0, util_js_1.asString)((0, util_js_1.asRecord)((0, util_js_1.asRecord)(event.response)?.error)?.message) ?? 'Responses request failed', conn);
                    }
                    else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
                        response = (0, util_js_1.asRecord)(event.response);
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
            if (response.status !== 'completed' && response.status !== 'incomplete')
                throw invalid(`Responses request did not complete (${String(response.status)})`, conn);
            const output = response.output.map(util_js_1.asRecord).filter((item) => !!item);
            const toolCalls = [];
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
            const result = {
                text: finalText || text,
                toolCalls: toolCalls.length ? toolCalls : undefined,
                providerState: { provider: conn.provider, model: req.model, protocol: 'responses', content: output },
                finishReason: response.status === 'incomplete'
                    ? (0, util_js_1.asRecord)(response.incomplete_details)?.reason === 'content_filter' ? 'content_filter' : 'length'
                    : toolCalls.length ? 'tool' : refused ? 'content_filter' : 'stop',
                usage: { inputTokens, outputTokens, estimated: inputTokens === undefined && outputTokens === undefined },
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
function responsesBody(conn, req) {
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
        input.push({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'image'
                ? { type: 'input_image', image_url: `data:${part.mimeType ?? 'image/png'};base64,${part.imageBase64 ?? ''}` }
                : { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text ?? '' }) });
        for (const call of message.toolCalls ?? [])
            input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.raw ?? JSON.stringify(call.arguments) });
    }
    return (0, util_js_1.applyProviderOptions)({
        model: req.model, input, stream: true, store: false,
        max_output_tokens: req.maxTokens, temperature: req.temperature, top_p: req.topP,
        reasoning: req.reasoningEffort === undefined ? undefined : { effort: req.reasoningEffort },
        tools: req.tools?.map(tool => ({ type: 'function', ...tool })),
        tool_choice: typeof req.toolChoice === 'object' ? { type: 'function', name: req.toolChoice.name } : req.toolChoice,
        text: req.responseFormat?.type === 'json' ? { format: req.responseFormat.schema
                ? { type: 'json_schema', name: 'response', schema: req.responseFormat.schema, strict: true }
                : { type: 'json_object' } } : undefined,
    }, req.providerOptions);
}
