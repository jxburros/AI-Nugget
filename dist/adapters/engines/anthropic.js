import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { postResponse, sseLines } from '../../transport.js';
import { asNumber, asRecord, asString, textFromMessages } from '../../util.js';
import { streamError, streamTimeout } from './base.js';
const JSON_MODE_TOOL = 'json_output';
export class AnthropicAdapter {
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
            throw new AIError('Anthropic stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
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
        const emittedTools = [];
        // Partial tool_use blocks keyed by content-block index (input_json_delta accumulation).
        const blocks = new Map();
        const timeout = streamTimeout(conn, req.signal);
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        try {
            const res = await postResponse(`${conn.baseUrl}/v1/messages`, body(req, jsonMode), conn.headers, timeout.signal, conn.provider);
            const contentType = res.headers.get('content-type') ?? '';
            if (!contentType.includes('text/event-stream')) {
                const data = await res.json();
                const parsed = parseResponse(data);
                inputTokens = parsed.inputTokens;
                outputTokens = parsed.outputTokens;
                stopReason = parsed.stopReason;
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
                for await (const line of sseLines(res)) {
                    const record = asRecord(safeParse(line));
                    if (!record)
                        continue;
                    const type = asString(record.type);
                    if (type === 'message_start') {
                        const usage = asRecord(asRecord(record.message)?.usage);
                        inputTokens = asNumber(usage?.input_tokens) ?? inputTokens;
                        outputTokens = asNumber(usage?.output_tokens) ?? outputTokens;
                    }
                    else if (type === 'content_block_start') {
                        const index = asNumber(record.index) ?? 0;
                        const block = asRecord(record.content_block);
                        if (block?.type === 'tool_use') {
                            blocks.set(index, { id: asString(block.id) ?? randomId(), name: asString(block.name) ?? 'unknown', raw: '' });
                        }
                    }
                    else if (type === 'content_block_delta') {
                        const index = asNumber(record.index) ?? 0;
                        const delta = asRecord(record.delta);
                        if (delta?.type === 'text_delta') {
                            const piece = asString(delta.text) ?? '';
                            if (piece) {
                                if (firstTokenMs === null)
                                    firstTokenMs = Date.now() - started;
                                text += piece;
                                yield { type: 'delta', text: piece };
                            }
                        }
                        else if (delta?.type === 'input_json_delta') {
                            const partial = blocks.get(index);
                            if (partial)
                                partial.raw += asString(delta.partial_json) ?? '';
                        }
                    }
                    else if (type === 'content_block_stop') {
                        const index = asNumber(record.index) ?? 0;
                        const partial = blocks.get(index);
                        if (partial) {
                            const call = { id: partial.id, name: partial.name, raw: partial.raw, arguments: parseArgs(partial.raw) };
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
                    else if (type === 'message_delta') {
                        const delta = asRecord(record.delta);
                        stopReason = asString(delta?.stop_reason) ?? stopReason;
                        const usage = asRecord(record.usage);
                        outputTokens = asNumber(usage?.output_tokens) ?? outputTokens;
                    }
                }
            }
            const hasTools = emittedTools.length > 0;
            yield { type: 'done', result: {
                    text,
                    toolCalls: hasTools ? emittedTools : undefined,
                    finishReason: mapStop(stopReason, hasTools),
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
}
function body(req, jsonMode) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => typeof m.content === 'string' ? m.content : '').join('\n\n') || undefined;
    const base = {
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature,
        top_p: req.topP,
        stop_sequences: req.stopSequences,
        system,
        messages: req.messages.filter((m) => m.role !== 'system').map(toAnthropicMessage),
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
    return base;
}
function toAnthropicMessage(m) {
    // tool result messages map to a user turn carrying a tool_result content block.
    if (m.role === 'tool') {
        return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: typeof m.content === 'string' ? m.content : '' }],
        };
    }
    // assistant turns that carried tool calls replay them as tool_use blocks.
    if (m.role === 'assistant' && m.toolCalls?.length) {
        const content = [];
        if (typeof m.content === 'string' && m.content)
            content.push({ type: 'text', text: m.content });
        for (const call of m.toolCalls)
            content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
        return { role: 'assistant', content };
    }
    return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content : m.content.map((part) => part.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: part.mimeType ?? 'image/png', data: part.imageBase64 ?? '' } }
            : { type: 'text', text: part.text ?? '' }),
    };
}
function parseResponse(data) {
    const record = asRecord(data);
    const content = Array.isArray(record?.content) ? record.content : [];
    let text = '';
    const toolCalls = [];
    for (const blockValue of content) {
        const block = asRecord(blockValue);
        if (block?.type === 'text')
            text += asString(block.text) ?? '';
        if (block?.type === 'tool_use') {
            toolCalls.push({
                id: asString(block.id) ?? randomId(),
                name: asString(block.name) ?? 'unknown',
                arguments: block.input ?? {},
                raw: JSON.stringify(block.input ?? {}),
            });
        }
    }
    const usage = asRecord(record?.usage);
    return { text, inputTokens: asNumber(usage?.input_tokens), outputTokens: asNumber(usage?.output_tokens), stopReason: asString(record?.stop_reason), toolCalls };
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
function parseArgs(raw) {
    try {
        return raw ? JSON.parse(raw) : {};
    }
    catch {
        return {};
    }
}
function safeParse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
function randomId() {
    return globalThis.crypto?.randomUUID?.() ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
//# sourceMappingURL=anthropic.js.map