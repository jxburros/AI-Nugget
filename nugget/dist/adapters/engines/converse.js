import { AIError } from '../../errors.js';
import { postResponse } from '../../transport.js';
import { applyProviderOptions, asNumber, asRecord, asString, joinUrl } from '../../util.js';
import { safeParse, streamError, streamTimeout } from './base.js';
import { awsEvents } from './awsEventStream.js';
/** Bedrock native Converse/ConverseStream, distinct from its compatible APIs. */
export class ConverseAdapter {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async chat(conn, req) {
        for await (const event of this.stream(conn, req))
            if (event.type === 'done')
                return event.result;
        throw new AIError('Converse ended without a result', { kind: 'invalid_response', retryable: false });
    }
    async health() {
        return { ok: false, detail: 'Converse has no lightweight health probe; validate with an explicit model call.' };
    }
    async *stream(conn, req) {
        const timeout = streamTimeout(conn, req.signal);
        const started = Date.now();
        let firstTokenMs = null;
        let stop;
        let usage;
        const blocks = new Map();
        const argumentsByIndex = new Map();
        const buffered = req.providerOptions?.stream === false;
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        try {
            const response = await postResponse(joinUrl(conn.baseUrl, `/model/${encodeURIComponent(req.model)}/${buffered ? 'converse' : 'converse-stream'}`), converseBody(conn, req), conn.headers, timeout.signal, conn.provider, conn.fetch);
            if (buffered) {
                const data = asRecord(safeParse(await response.text()));
                const message = asRecord(asRecord(data?.output)?.message);
                if (!Array.isArray(message?.content))
                    throw invalid('Converse response has no content');
                message.content.forEach((part, index) => { const block = asRecord(part); if (block)
                    blocks.set(index, block); });
                stop = asString(data?.stopReason);
                usage = asRecord(data?.usage);
            }
            else {
                for await (const event of awsEvents(response, timeout.bump)) {
                    const data = asRecord(event.data);
                    if (event.type.endsWith('Exception') || event.type.endsWith('Error')) {
                        throw new AIError(asString(data?.message) ?? event.type, { kind: event.type === 'throttlingException' ? 'rate_limit' : 'server', provider: conn.provider });
                    }
                    const index = asNumber(data?.contentBlockIndex) ?? 0;
                    const current = blocks.get(index) ?? {};
                    if (event.type === 'contentBlockStart') {
                        const tool = asRecord(asRecord(data?.start)?.toolUse);
                        if (tool)
                            current.toolUse = { ...tool, input: {} };
                        blocks.set(index, current);
                    }
                    else if (event.type === 'contentBlockDelta') {
                        const delta = asRecord(data?.delta);
                        const text = asString(delta?.text);
                        if (text) {
                            current.text = (asString(current.text) ?? '') + text;
                            firstTokenMs ??= Date.now() - started;
                            yield { type: 'delta', text };
                        }
                        const tool = asRecord(delta?.toolUse);
                        if (tool)
                            argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? '') + (asString(tool.input) ?? ''));
                        const reasoning = asRecord(delta?.reasoningContent);
                        if (reasoning) {
                            const content = asRecord(current.reasoningContent) ?? {};
                            const reasoningText = asRecord(content.reasoningText) ?? {};
                            if (reasoning.text) {
                                reasoningText.text = (asString(reasoningText.text) ?? '') + asString(reasoning.text);
                                yield { type: 'reasoning', text: asString(reasoning.text) ?? '' };
                            }
                            if (reasoning.signature)
                                reasoningText.signature = (asString(reasoningText.signature) ?? '') + asString(reasoning.signature);
                            if (reasoning.redactedContent)
                                content.redactedContent = (asString(content.redactedContent) ?? '') + asString(reasoning.redactedContent);
                            if (Object.keys(reasoningText).length)
                                content.reasoningText = reasoningText;
                            current.reasoningContent = content;
                        }
                        blocks.set(index, current);
                    }
                    else if (event.type === 'messageStop')
                        stop = asString(data?.stopReason);
                    else if (event.type === 'metadata')
                        usage = asRecord(data?.usage);
                }
            }
            if (!stop)
                throw invalid('Converse stream ended without a stop reason');
            const toolCalls = [];
            for (const [index, block] of blocks) {
                const tool = asRecord(block.toolUse);
                if (!tool)
                    continue;
                const raw = argumentsByIndex.get(index);
                if (raw !== undefined)
                    tool.input = safeParse(raw);
                if (!tool.toolUseId || !tool.name || tool.input === undefined)
                    throw invalid('Malformed Converse tool call');
                const call = { id: String(tool.toolUseId), name: String(tool.name), arguments: tool.input, raw };
                toolCalls.push(call);
                yield { type: 'tool_call', call };
            }
            const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
            const text = content.map(block => asString(block.text) ?? '').join('');
            if (buffered && text) {
                firstTokenMs ??= Date.now() - started;
                yield { type: 'delta', text };
            }
            yield { type: 'done', result: {
                    text, toolCalls: toolCalls.length ? toolCalls : undefined,
                    providerState: { provider: conn.provider, model: req.model, protocol: 'converse', content },
                    finishReason: stop === 'max_tokens' ? 'length' : stop === 'guardrail_intervened' || stop === 'content_filtered' ? 'content_filter' : toolCalls.length ? 'tool' : 'stop',
                    usage: { inputTokens: asNumber(usage?.inputTokens), outputTokens: asNumber(usage?.outputTokens), estimated: !usage },
                    timing: { firstTokenMs, totalMs: Date.now() - started }, model: req.model,
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
function invalid(message) { return new AIError(message, { kind: 'invalid_response', retryable: false }); }
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
        throw new AIError('Converse reasoning controls are model-specific; use providerOptions.additionalModelRequestFields', { kind: 'invalid_request', retryable: false });
    if (req.responseFormat?.type === 'json' && !options.outputConfig)
        throw new AIError('Converse JSON output requires a model-supported providerOptions.outputConfig', { kind: 'invalid_request', retryable: false });
    return applyProviderOptions({
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
//# sourceMappingURL=converse.js.map