"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConverseAdapter = void 0;
const errors_js_1 = require("../../errors.js");
const transport_js_1 = require("../../transport.js");
const util_js_1 = require("../../util.js");
const base_js_1 = require("./base.js");
const awsEventStream_js_1 = require("./awsEventStream.js");
/** Bedrock native Converse/ConverseStream, distinct from its compatible APIs. */
class ConverseAdapter {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async chat(conn, req) {
        for await (const event of this.stream(conn, req))
            if (event.type === 'done')
                return event.result;
        throw new errors_js_1.AIError('Converse ended without a result', { kind: 'invalid_response', retryable: false });
    }
    async health() {
        return { ok: false, detail: 'Converse has no lightweight health probe; validate with an explicit model call.' };
    }
    async *stream(conn, req) {
        const timeout = (0, base_js_1.streamTimeout)(conn, req.signal);
        const started = Date.now();
        let firstTokenMs = null;
        let stop;
        let usage;
        const blocks = new Map();
        const argumentsByIndex = new Map();
        const redactedByIndex = new Map();
        const buffered = req.providerOptions?.stream === false;
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        try {
            const response = await (0, transport_js_1.postResponse)((0, util_js_1.joinUrl)(conn.baseUrl, `/model/${encodeURIComponent(req.model)}/${buffered ? 'converse' : 'converse-stream'}`), converseBody(conn, req), conn.headers, timeout.signal, conn.provider, conn.fetch);
            if (buffered) {
                const data = (0, util_js_1.asRecord)((0, base_js_1.safeParse)(await response.text()));
                const message = (0, util_js_1.asRecord)((0, util_js_1.asRecord)(data?.output)?.message);
                if (!Array.isArray(message?.content))
                    throw invalid('Converse response has no content');
                message.content.forEach((part, index) => { const block = (0, util_js_1.asRecord)(part); if (block)
                    blocks.set(index, block); });
                stop = (0, util_js_1.asString)(data?.stopReason);
                usage = (0, util_js_1.asRecord)(data?.usage);
            }
            else {
                for await (const event of (0, awsEventStream_js_1.awsEvents)(response, timeout.bump)) {
                    const data = (0, util_js_1.asRecord)(event.data);
                    if (event.type.endsWith('Exception') || event.type.endsWith('Error')) {
                        throw new errors_js_1.AIError((0, util_js_1.asString)(data?.message) ?? event.type, { kind: event.type === 'throttlingException' ? 'rate_limit' : 'server', provider: conn.provider });
                    }
                    const index = (0, util_js_1.asNumber)(data?.contentBlockIndex) ?? 0;
                    const current = blocks.get(index) ?? {};
                    if (event.type === 'contentBlockStart') {
                        const tool = (0, util_js_1.asRecord)((0, util_js_1.asRecord)(data?.start)?.toolUse);
                        if (tool)
                            current.toolUse = { ...tool, input: {} };
                        blocks.set(index, current);
                    }
                    else if (event.type === 'contentBlockDelta') {
                        const delta = (0, util_js_1.asRecord)(data?.delta);
                        const text = (0, util_js_1.asString)(delta?.text);
                        if (text) {
                            current.text = ((0, util_js_1.asString)(current.text) ?? '') + text;
                            firstTokenMs ??= Date.now() - started;
                            yield { type: 'delta', text };
                        }
                        const tool = (0, util_js_1.asRecord)(delta?.toolUse);
                        if (tool)
                            argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? '') + ((0, util_js_1.asString)(tool.input) ?? ''));
                        const reasoning = (0, util_js_1.asRecord)(delta?.reasoningContent);
                        if (reasoning) {
                            const content = (0, util_js_1.asRecord)(current.reasoningContent) ?? {};
                            const reasoningText = (0, util_js_1.asRecord)(content.reasoningText) ?? {};
                            if (reasoning.text) {
                                reasoningText.text = ((0, util_js_1.asString)(reasoningText.text) ?? '') + (0, util_js_1.asString)(reasoning.text);
                                yield { type: 'reasoning', text: (0, util_js_1.asString)(reasoning.text) ?? '' };
                            }
                            if (reasoning.signature)
                                reasoningText.signature = ((0, util_js_1.asString)(reasoningText.signature) ?? '') + (0, util_js_1.asString)(reasoning.signature);
                            if (typeof reasoning.redactedContent === 'string') {
                                const chunks = redactedByIndex.get(index) ?? [];
                                try {
                                    chunks.push(atob(reasoning.redactedContent));
                                }
                                catch {
                                    throw invalid('Malformed Converse redacted reasoning');
                                }
                                redactedByIndex.set(index, chunks);
                            }
                            if (Object.keys(reasoningText).length)
                                content.reasoningText = reasoningText;
                            current.reasoningContent = content;
                        }
                        blocks.set(index, current);
                    }
                    else if (event.type === 'messageStop')
                        stop = (0, util_js_1.asString)(data?.stopReason);
                    else if (event.type === 'metadata')
                        usage = (0, util_js_1.asRecord)(data?.usage);
                }
            }
            if (!stop)
                throw invalid('Converse stream ended without a stop reason');
            // Each event encodes its own binary chunk; joining base64 strings would
            // leave padding in the middle and corrupt the next-turn replay payload.
            for (const [index, chunks] of redactedByIndex) {
                const block = blocks.get(index);
                block.reasoningContent = { ...(0, util_js_1.asRecord)(block.reasoningContent), redactedContent: btoa(chunks.join('')) };
            }
            const toolCalls = [];
            for (const [index, block] of blocks) {
                const tool = (0, util_js_1.asRecord)(block.toolUse);
                if (!tool)
                    continue;
                const raw = argumentsByIndex.get(index);
                if (raw !== undefined)
                    tool.input = (0, base_js_1.safeParse)(raw);
                if (!tool.toolUseId || !tool.name || tool.input === undefined)
                    throw invalid('Malformed Converse tool call');
                const call = { id: String(tool.toolUseId), name: String(tool.name), arguments: tool.input, raw };
                toolCalls.push(call);
                yield { type: 'tool_call', call };
            }
            const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
            const text = content.map(block => (0, util_js_1.asString)(block.text) ?? '').join('');
            if (buffered && text) {
                firstTokenMs ??= Date.now() - started;
                yield { type: 'delta', text };
            }
            yield { type: 'done', result: {
                    text, toolCalls: toolCalls.length ? toolCalls : undefined,
                    providerState: { provider: conn.provider, model: req.model, protocol: 'converse', content },
                    finishReason: stop === 'max_tokens' ? 'length' : stop === 'guardrail_intervened' || stop === 'content_filtered' ? 'content_filter' : toolCalls.length ? 'tool' : 'stop',
                    usage: { inputTokens: (0, util_js_1.asNumber)(usage?.inputTokens), outputTokens: (0, util_js_1.asNumber)(usage?.outputTokens), estimated: !usage },
                    timing: { firstTokenMs, totalMs: Date.now() - started }, model: req.model,
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
}
exports.ConverseAdapter = ConverseAdapter;
function invalid(message) { return new errors_js_1.AIError(message, { kind: 'invalid_response', retryable: false }); }
function converseBody(conn, req) {
    const messages = [];
    const system = [];
    for (const message of req.messages) {
        if (message.role === 'system') {
            system.push(...parts(message));
            continue;
        }
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const state = message.providerState;
        const content = message.role === 'tool'
            ? [{ toolResult: { toolUseId: message.toolCallId, content: parts(message) } }]
            : role === 'assistant' && state?.provider === conn.provider && state.model === req.model && state.protocol === 'converse'
                ? state.content
                : [...parts(message), ...(message.toolCalls ?? []).map(call => ({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments } }))];
        const previous = messages.at(-1);
        if (previous?.role === role)
            previous.content.push(...content);
        else
            messages.push({ role, content: [...content] });
    }
    const { stream: _stream, ...options } = req.providerOptions ?? {};
    if (req.reasoningEffort !== undefined)
        throw new errors_js_1.AIError('Converse reasoning controls are model-specific; use providerOptions.additionalModelRequestFields', { kind: 'invalid_request', retryable: false });
    if (req.responseFormat?.type === 'json' && !options.outputConfig)
        throw new errors_js_1.AIError('Converse JSON output requires a model-supported providerOptions.outputConfig', { kind: 'invalid_request', retryable: false });
    return (0, util_js_1.applyProviderOptions)({
        messages, system: system.length ? system : undefined,
        inferenceConfig: { maxTokens: req.maxTokens, temperature: req.temperature, topP: req.topP, stopSequences: req.stopSequences },
        toolConfig: req.tools?.length && req.toolChoice !== 'none' ? {
            tools: req.tools.map(tool => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } })),
            toolChoice: typeof req.toolChoice === 'object' ? { tool: { name: req.toolChoice.name } } : { auto: {} },
        } : undefined,
    }, options);
}
function parts(message) {
    if (typeof message.content === 'string')
        return message.content ? [{ text: message.content }] : [];
    return message.content.map(part => part.type === 'image'
        ? { image: { format: (part.mimeType ?? 'image/png').split('/')[1], source: { bytes: part.imageBase64 } } }
        : { text: part.text ?? '' });
}
