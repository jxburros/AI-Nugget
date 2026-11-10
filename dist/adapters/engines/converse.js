import { AIError } from '../../errors.js';
import { postResponse } from '../../transport.js';
import { applyProviderOptions, asNumber, asRecord, asString, joinUrl } from '../../util.js';
import { mcpUnsupported, partBase64, promptCacheUnsupported, partHasBytes, partMime, safeParse, streamError, streamTimeout, unsupportedPart } from './base.js';
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
        const redactedByIndex = new Map();
        const buffered = req.providerOptions?.stream === false;
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        if (req.mcpServers?.length)
            throw mcpUnsupported(conn.provider, 'Converse');
        if (req.promptCache)
            yield promptCacheUnsupported(conn.provider);
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
                        stop = asString(data?.stopReason);
                    else if (event.type === 'metadata')
                        usage = asRecord(data?.usage);
                }
            }
            if (!stop)
                throw invalid('Converse stream ended without a stop reason');
            // Each event encodes its own binary chunk; joining base64 strings would
            // leave padding in the middle and corrupt the next-turn replay payload.
            for (const [index, chunks] of redactedByIndex) {
                const block = blocks.get(index);
                block.reasoningContent = { ...asRecord(block.reasoningContent), redactedContent: btoa(chunks.join('')) };
            }
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
                    usage: converseUsage(usage),
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
    return message.content.map(conversePart);
}
/**
 * Converse image/document/video blocks carry raw bytes (base64 in JSON) or,
 * for video, an `s3://` location. Converse has no audio block.
 */
function conversePart(part) {
    if (part.type === 'text')
        return { text: part.text ?? '' };
    if (part.type === 'audio')
        throw unsupportedPart('bedrock', part);
    const format = converseFormat(partMime(part));
    if (!partHasBytes(part)) {
        if (part.type === 'video' && part.url?.startsWith('s3://'))
            return { video: { format, source: { s3Location: { uri: part.url } } } };
        throw unsupportedPart('bedrock', part, 'by URL (send base64 bytes)');
    }
    const source = { bytes: partBase64(part) };
    if (part.type === 'image')
        return { image: { format, source } };
    if (part.type === 'video')
        return { video: { format, source } };
    // Converse document names allow only alphanumerics, spaces, hyphens, parens and brackets.
    const name = (part.filename ?? 'document').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9 \-()[\]]/g, ' ').trim() || 'document';
    return { document: { format, name, source } };
}
/** Converse `format` from a MIME type (`image/jpeg` → `jpeg`, `application/pdf` → `pdf`, `text/plain` → `txt`). */
function converseFormat(mime) {
    const sub = mime.split('/')[1]?.split(';')[0] ?? '';
    if (sub === 'plain')
        return 'txt';
    if (sub === 'vnd.openxmlformats-officedocument.wordprocessingml.document')
        return 'docx';
    if (sub === 'vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        return 'xlsx';
    if (sub === 'msword')
        return 'doc';
    if (sub === 'vnd.ms-excel')
        return 'xls';
    if (sub === 'quicktime')
        return 'mov';
    if (sub === 'x-matroska')
        return 'mkv';
    return sub;
}
/** Converse `inputTokens` excludes cache reads/writes; report the total, with the split alongside. */
function converseUsage(usage) {
    const input = asNumber(usage?.inputTokens);
    const read = asNumber(usage?.cacheReadInputTokens);
    const write = asNumber(usage?.cacheWriteInputTokens);
    return {
        inputTokens: input === undefined ? undefined : input + (read ?? 0) + (write ?? 0),
        outputTokens: asNumber(usage?.outputTokens),
        ...(read !== undefined ? { cachedInputTokens: read } : {}),
        ...(write !== undefined ? { cacheWriteTokens: write } : {}),
        estimated: !usage,
    };
}
//# sourceMappingURL=converse.js.map