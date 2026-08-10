"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicAdapter = void 0;
const errors_js_1 = require("../../errors.js");
const tokens_js_1 = require("../../tokens.js");
const transport_js_1 = require("../../transport.js");
const util_js_1 = require("../../util.js");
const base_js_1 = require("./base.js");
const JSON_MODE_TOOL = 'json_output';
class AnthropicAdapter {
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
            throw new errors_js_1.AIError('Anthropic stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
        return result;
    }
    async *stream(conn, req) {
        const started = Date.now();
        const jsonMode = req.responseFormat?.type === 'json' && !req.tools?.length;
        let firstTokenMs = null;
        let text = '';
        let inputTokens;
        let outputTokens;
        let stopReason;
        let sawTerminal = false;
        const emittedTools = [];
        // Partial tool_use blocks keyed by content-block index (input_json_delta accumulation).
        const blocks = new Map();
        const timeout = (0, base_js_1.streamTimeout)(conn, req.signal);
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        // Anthropic JSON mode is implemented as a forced `json_output` tool, which
        // cannot coexist with the caller's own tools — same silent-downgrade shape
        // as Gemini, so it gets the same signal rather than quietly dropping.
        if (req.responseFormat?.type === 'json' && req.tools?.length) {
            yield {
                type: 'context',
                kind: 'json_mode_downgraded',
                data: { reason: 'Anthropic JSON mode uses a forced tool and cannot be combined with caller tools; the request was sent without JSON mode', provider: conn.provider },
            };
        }
        try {
            const res = await (0, transport_js_1.postResponse)(`${conn.baseUrl}/v1/messages`, body(req, jsonMode), conn.headers, timeout.signal, conn.provider);
            const contentType = res.headers.get('content-type') ?? '';
            if (!contentType.includes('text/event-stream')) {
                const data = await res.json();
                const parsed = parseResponse(data);
                inputTokens = parsed.inputTokens;
                outputTokens = parsed.outputTokens;
                stopReason = parsed.stopReason;
                sawTerminal = true;
                if (jsonMode) {
                    text = jsonTextFrom(parsed.toolCalls, parsed.text);
                    if (text)
                        yield { type: 'delta', text };
                }
                else {
                    text = parsed.text;
                    if (text)
                        yield { type: 'delta', text };
                    for (const call of parsed.toolCalls) {
                        emittedTools.push(call);
                        yield { type: 'tool_call', call };
                    }
                }
            }
            else {
                for await (const line of (0, transport_js_1.sseLines)(res)) {
                    timeout.bump();
                    const record = (0, util_js_1.asRecord)((0, base_js_1.safeParse)(line));
                    if (!record)
                        continue;
                    const type = (0, util_js_1.asString)(record.type);
                    if (type === 'message_start') {
                        const usage = (0, util_js_1.asRecord)((0, util_js_1.asRecord)(record.message)?.usage);
                        inputTokens = (0, util_js_1.asNumber)(usage?.input_tokens) ?? inputTokens;
                        outputTokens = (0, util_js_1.asNumber)(usage?.output_tokens) ?? outputTokens;
                    }
                    else if (type === 'content_block_start') {
                        const index = (0, util_js_1.asNumber)(record.index) ?? 0;
                        const block = (0, util_js_1.asRecord)(record.content_block);
                        if (block?.type === 'tool_use') {
                            blocks.set(index, { id: (0, util_js_1.asString)(block.id) ?? (0, base_js_1.randomId)(), name: (0, util_js_1.asString)(block.name) ?? 'unknown', raw: '' });
                        }
                    }
                    else if (type === 'content_block_delta') {
                        const index = (0, util_js_1.asNumber)(record.index) ?? 0;
                        const delta = (0, util_js_1.asRecord)(record.delta);
                        if (delta?.type === 'text_delta') {
                            const piece = (0, util_js_1.asString)(delta.text) ?? '';
                            if (piece) {
                                if (firstTokenMs === null)
                                    firstTokenMs = Date.now() - started;
                                text += piece;
                                yield { type: 'delta', text: piece };
                            }
                        }
                        else if (delta?.type === 'thinking_delta') {
                            // Extended-thinking tokens ride the reasoning channel, kept out of `text`.
                            const piece = (0, util_js_1.asString)(delta.thinking) ?? '';
                            if (piece)
                                yield { type: 'reasoning', text: piece };
                        }
                        else if (delta?.type === 'input_json_delta') {
                            const partial = blocks.get(index);
                            if (partial)
                                partial.raw += (0, util_js_1.asString)(delta.partial_json) ?? '';
                        }
                    }
                    else if (type === 'content_block_stop') {
                        const index = (0, util_js_1.asNumber)(record.index) ?? 0;
                        const partial = blocks.get(index);
                        if (partial) {
                            const call = { id: partial.id, name: partial.name, raw: partial.raw, arguments: (0, base_js_1.parseArgs)(partial.raw) };
                            blocks.delete(index);
                            if (jsonMode && call.name === JSON_MODE_TOOL) {
                                text = jsonTextFrom([call], text);
                                if (firstTokenMs === null)
                                    firstTokenMs = Date.now() - started;
                                yield { type: 'delta', text };
                            }
                            else {
                                emittedTools.push(call);
                                yield { type: 'tool_call', call };
                            }
                        }
                    }
                    else if (type === 'message_stop') {
                        sawTerminal = true;
                    }
                    else if (type === 'message_delta') {
                        const delta = (0, util_js_1.asRecord)(record.delta);
                        if ((0, util_js_1.asString)(delta?.stop_reason))
                            sawTerminal = true;
                        stopReason = (0, util_js_1.asString)(delta?.stop_reason) ?? stopReason;
                        const usage = (0, util_js_1.asRecord)(record.usage);
                        outputTokens = (0, util_js_1.asNumber)(usage?.output_tokens) ?? outputTokens;
                    }
                }
            }
            if (!sawTerminal)
                yield (0, base_js_1.streamAnomaly)('stream ended without a stop_reason or message_stop');
            const hasTools = emittedTools.length > 0;
            yield { type: 'done', result: {
                    text,
                    toolCalls: hasTools ? emittedTools : undefined,
                    finishReason: mapStop(stopReason, hasTools),
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
     * Lists models from Anthropic's `/v1/models` endpoint (auth + version headers
     * already applied to `conn.headers`). The endpoint does not report a context
     * window, so `contextWindow` is left undefined rather than guessed.
     */
    async listModels(conn) {
        const { data } = await (0, transport_js_1.fetchJson)((0, util_js_1.joinUrl)(conn.baseUrl, '/v1/models'), {
            method: 'GET',
            headers: conn.headers,
            timeoutMs: Math.min(conn.timeoutMs ?? base_js_1.DEFAULT_TIMEOUT_MS, 15_000),
            provider: conn.provider,
        });
        const rows = Array.isArray((0, util_js_1.asRecord)(data)?.data) ? (0, util_js_1.asRecord)(data).data : [];
        return rows
            .map((row) => (0, util_js_1.asString)((0, util_js_1.asRecord)(row)?.id))
            .filter((id) => Boolean(id))
            .map((id) => ({ id, source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl } }));
    }
}
exports.AnthropicAdapter = AnthropicAdapter;
function body(req, jsonMode) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => textContent(m.content)).join('\n\n') || undefined;
    const base = {
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature,
        top_p: req.topP,
        stop_sequences: req.stopSequences,
        system,
        messages: toAnthropicMessages(req.messages.filter((m) => m.role !== 'system')),
        stream: true,
    };
    if (jsonMode) {
        // Forced-tool JSON mode: Anthropic has no response_format, so we make the
        // model answer through a single required tool whose input is the JSON we want.
        base.tools = [{ name: JSON_MODE_TOOL, description: 'Return the answer as a JSON object.', input_schema: schemaFor(req) }];
        base.tool_choice = { type: 'tool', name: JSON_MODE_TOOL };
    }
    else if (req.tools?.length) {
        base.tools = req.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
        if (typeof req.toolChoice === 'object')
            base.tool_choice = { type: 'tool', name: req.toolChoice.name };
        else if (req.toolChoice === 'auto')
            base.tool_choice = { type: 'auto' };
        else if (req.toolChoice === 'none')
            base.tool_choice = { type: 'none' };
    }
    // providerOptions carries Anthropic-native fields (`thinking`, `metadata`,
    // top-level `cache_control` extras, `service_tier`, …) without a release.
    return (0, util_js_1.applyProviderOptions)(base, req.providerOptions);
}
function toAnthropicMessages(messages) {
    const out = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role !== 'tool') {
            out.push(toAnthropicMessage(message));
            continue;
        }
        const content = [];
        while (index < messages.length && messages[index]?.role === 'tool') {
            const toolMessage = messages[index];
            content.push({ type: 'tool_result', tool_use_id: toolMessage.toolCallId ?? '', content: textContent(toolMessage.content) });
            index += 1;
        }
        index -= 1;
        out.push({ role: 'user', content });
    }
    return out;
}
function toAnthropicMessage(m) {
    // Tool-role messages are handled by toAnthropicMessages' batching loop and
    // never reach here, so no tool branch is needed.
    // assistant turns that carried tool calls replay them as tool_use blocks,
    // preserving any text/image content parts that accompanied the calls.
    if (m.role === 'assistant' && m.toolCalls?.length) {
        const content = [...contentBlocks(m.content)];
        for (const call of m.toolCalls)
            content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
        return { role: 'assistant', content };
    }
    return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : contentBlocks(m.content),
    };
}
/** Maps text/image content — a string or a ContentPart[] — onto Anthropic content blocks. */
function contentBlocks(content) {
    if (typeof content === 'string')
        return content ? [{ type: 'text', text: content }] : [];
    return content.map((part) => part.type === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: part.mimeType ?? 'image/png', data: part.imageBase64 ?? '' } }
        : { type: 'text', text: part.text ?? '' });
}
function textContent(content) {
    if (typeof content === 'string')
        return content;
    if (!content)
        return '';
    return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}
function parseResponse(data) {
    const record = (0, util_js_1.asRecord)(data);
    const content = Array.isArray(record?.content) ? record.content : [];
    let text = '';
    const toolCalls = [];
    for (const blockValue of content) {
        const block = (0, util_js_1.asRecord)(blockValue);
        if (block?.type === 'text')
            text += (0, util_js_1.asString)(block.text) ?? '';
        if (block?.type === 'tool_use') {
            toolCalls.push({
                id: (0, util_js_1.asString)(block.id) ?? (0, base_js_1.randomId)(),
                name: (0, util_js_1.asString)(block.name) ?? 'unknown',
                arguments: block.input ?? {},
                raw: JSON.stringify(block.input ?? {}),
            });
        }
    }
    const usage = (0, util_js_1.asRecord)(record?.usage);
    return { text, inputTokens: (0, util_js_1.asNumber)(usage?.input_tokens), outputTokens: (0, util_js_1.asNumber)(usage?.output_tokens), stopReason: (0, util_js_1.asString)(record?.stop_reason), toolCalls };
}
function schemaFor(req) {
    const schema = req.responseFormat?.type === 'json' ? req.responseFormat.schema : undefined;
    return schema ?? { type: 'object' };
}
function jsonTextFrom(toolCalls, fallback) {
    const json = toolCalls.find((call) => call.name === JSON_MODE_TOOL) ?? toolCalls[0];
    if (json)
        return json.raw && json.raw.trim() ? json.raw : JSON.stringify(json.arguments ?? {});
    return fallback;
}
function mapStop(stop, hasTools) {
    if (stop === 'tool_use' && hasTools)
        return 'tool';
    if (stop === 'max_tokens')
        return 'length';
    return 'stop';
}
