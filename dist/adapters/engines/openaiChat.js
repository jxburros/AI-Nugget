import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { fetchJson, postResponse, sseLines } from '../../transport.js';
import { applyProviderOptions, asNumber, asRecord, asString, joinUrl, textFromMessages } from '../../util.js';
import { DEFAULT_TIMEOUT_MS, health, listOpenModels, parseArgs, randomId, safeParse, streamAnomaly, streamError, streamTimeout } from './base.js';
export class OpenAIChatAdapter {
    profile;
    provider;
    constructor(provider, profile) {
        this.profile = profile;
        this.provider = provider;
    }
    async chat(conn, req) {
        let final;
        for await (const event of this.stream(conn, req)) {
            if (event.type === 'done')
                final = event.result;
            if (event.type === 'error')
                throw event.error;
        }
        if (!final)
            throw new AIError('Provider stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
        return final;
    }
    async *stream(conn, req) {
        const started = Date.now();
        let firstTokenMs = null;
        let text = '';
        let toolCalls = [];
        let inputTokens;
        let outputTokens;
        let finish;
        let sawTerminal = false;
        const timeout = streamTimeout(conn, req.signal);
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        try {
            const res = await postResponse(urlFor(conn, this.profile, req), openAiBody(req, this.profile), conn.headers, timeout.signal, conn.provider);
            const contentType = res.headers.get('content-type') ?? '';
            if (!contentType.includes('text/event-stream')) {
                // Server ignored stream:true (or is a buffered gateway) — recover the whole body.
                const rawText = await res.text().catch(() => '');
                const raw = safeParse(rawText) ?? { text: rawText };
                const parsed = parseOpenAiResponse(raw);
                text = parsed.text;
                toolCalls = parsed.toolCalls;
                inputTokens = parsed.inputTokens;
                outputTokens = parsed.outputTokens;
                finish = parsed.finish;
                sawTerminal = true;
                if (parsed.reasoning)
                    yield { type: 'reasoning', text: parsed.reasoning };
                if (text)
                    yield { type: 'delta', text };
                for (const call of toolCalls)
                    yield { type: 'tool_call', call };
            }
            else {
                const partialTools = new Map();
                for await (const line of sseLines(res)) {
                    timeout.bump();
                    const chunk = safeParse(line);
                    const record = asRecord(chunk);
                    if (!record)
                        continue;
                    const usage = asRecord(record.usage);
                    inputTokens = asNumber(usage?.prompt_tokens) ?? inputTokens;
                    outputTokens = asNumber(usage?.completion_tokens) ?? outputTokens;
                    const choices = Array.isArray(record.choices) ? record.choices : [];
                    const choice = asRecord(choices[0]);
                    finish = asString(choice?.finish_reason) ?? finish;
                    if (choice?.finish_reason)
                        sawTerminal = true;
                    const delta = asRecord(choice?.delta);
                    // Reasoning tokens (DeepSeek `reasoning_content`, others `reasoning`)
                    // ride their own channel so they don't contaminate the answer text.
                    const reasoning = asString(delta?.reasoning_content) ?? asString(delta?.reasoning);
                    if (reasoning)
                        yield { type: 'reasoning', text: reasoning };
                    const piece = asString(delta?.content);
                    if (piece) {
                        if (firstTokenMs === null)
                            firstTokenMs = Date.now() - started;
                        text += piece;
                        yield { type: 'delta', text: piece };
                    }
                    const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
                    for (const callValue of calls) {
                        const call = asRecord(callValue);
                        const index = asNumber(call?.index) ?? 0;
                        const current = partialTools.get(index) ?? { raw: '' };
                        current.id = asString(call?.id) ?? current.id;
                        const fn = asRecord(call?.function);
                        current.name = asString(fn?.name) ?? current.name;
                        current.raw += asString(fn?.arguments) ?? '';
                        partialTools.set(index, current);
                    }
                }
                toolCalls = [...partialTools.values()].filter((call) => call.name).map((call) => ({
                    id: call.id ?? randomId(),
                    name: call.name,
                    raw: call.raw,
                    arguments: parseArgs(call.raw),
                }));
                for (const call of toolCalls)
                    yield { type: 'tool_call', call };
            }
            if (!sawTerminal)
                yield streamAnomaly('stream ended without a finish_reason');
            const result = makeResult(conn, req, text, toolCalls, finish, started, firstTokenMs, inputTokens, outputTokens);
            yield { type: 'done', result };
        }
        catch (error) {
            throw streamError(error, timeout, conn.provider);
        }
        finally {
            timeout.done();
        }
    }
    listModels(conn) {
        return listOpenModels(conn, this.profile);
    }
    health(conn) {
        return health(conn, this.profile);
    }
    async embed(conn, req) {
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        const { data } = await fetchJson(joinUrl(conn.baseUrl, '/embeddings'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...conn.headers },
            body: JSON.stringify(applyProviderOptions({ model: req.model, input: inputs }, req.providerOptions)),
            timeoutMs: conn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            provider: conn.provider,
        });
        const record = asRecord(data);
        const rows = Array.isArray(record?.data) ? record.data : [];
        // Order by the `index` each row reports, falling back to array order.
        const byIndex = rows
            .map((row, i) => ({ index: asNumber(asRecord(row)?.index) ?? i, embedding: asEmbedding(asRecord(row)?.embedding) }))
            .sort((a, b) => a.index - b.index);
        const usage = asRecord(record?.usage);
        const inputTokens = asNumber(usage?.prompt_tokens);
        return {
            embeddings: byIndex.map((row) => row.embedding),
            model: req.model,
            usage: { inputTokens, outputTokens: 0, estimated: inputTokens === undefined },
            source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
            raw: data,
        };
    }
}
function asEmbedding(value) {
    return Array.isArray(value) ? value.filter((n) => typeof n === 'number') : [];
}
function openAiBody(req, profile) {
    const body = {
        model: req.model,
        messages: req.messages.map(toOpenAiMessage),
        temperature: req.temperature,
        top_p: req.topP,
        stop: req.stopSequences,
        response_format: responseFormatFor(req, profile),
        tools: req.tools?.map((tool) => ({ type: 'function', function: tool })),
        tool_choice: typeof req.toolChoice === 'object' ? { type: 'function', function: { name: req.toolChoice.name } } : req.toolChoice,
        stream: true,
        // Many OpenAI-compatible local servers (llama.cpp, LM Studio, vLLM) choke
        // on or ignore stream_options — only send it where the profile confirms
        // the server understands it.
        stream_options: profile.quirks?.supportsUsageInStream ? { include_usage: true } : undefined,
    };
    if (req.maxTokens !== undefined)
        body[profile.quirks?.maxTokensParam ?? 'max_tokens'] = req.maxTokens;
    // providerOptions carries OpenAI-native fields the nugget doesn't model
    // (`reasoning_effort`, `parallel_tool_calls`, `seed`, `logprobs`, …). `apiVersion`
    // is consumed by urlFor for Azure and stripped here so it never hits the body.
    const { apiVersion, ...passthrough } = req.providerOptions ?? {};
    void apiVersion;
    return applyProviderOptions(body, Object.keys(passthrough).length ? passthrough : undefined);
}
function responseFormatFor(req, profile) {
    if (req.responseFormat?.type !== 'json')
        return undefined;
    if (req.responseFormat.schema && profile.quirks?.supportsJsonSchema) {
        return { type: 'json_schema', json_schema: { name: 'response', schema: req.responseFormat.schema } };
    }
    return { type: 'json_object' };
}
function toOpenAiMessage(message) {
    return {
        role: message.role,
        content: typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.type === 'image'
                ? { type: 'image_url', image_url: { url: `data:${part.mimeType ?? 'image/png'};base64,${part.imageBase64 ?? ''}` } }
                : { type: 'text', text: part.text ?? '' }),
        name: message.role === 'tool' ? message.name : undefined,
        tool_call_id: message.toolCallId,
        tool_calls: message.toolCalls?.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.arguments) } })),
    };
}
function urlFor(conn, profile, req) {
    if (profile.quirks?.urlTemplate) {
        // `{apiVersion}` (Azure) is filled from a per-call override, then the
        // profile default — so a retired Azure api-version is fixable without a
        // library release: pass `providerOptions: { apiVersion: '2025-01-01-preview' }`.
        const apiVersion = asString(req.providerOptions?.apiVersion) ?? profile.quirks.apiVersion ?? '';
        return profile.quirks.urlTemplate
            .replace('{baseUrl}', conn.baseUrl)
            .replace('{model}', encodeURIComponent(req.model))
            .replace('{apiVersion}', apiVersion);
    }
    return joinUrl(conn.baseUrl, '/chat/completions');
}
function parseOpenAiResponse(raw) {
    const record = asRecord(raw);
    const usage = asRecord(record?.usage);
    const choice = asRecord(Array.isArray(record?.choices) ? record.choices[0] : undefined);
    const message = asRecord(choice?.message);
    const text = asString(message?.content) ?? asString(record?.text) ?? '';
    const reasoning = asString(message?.reasoning_content) ?? asString(message?.reasoning);
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    return {
        text,
        reasoning,
        finish: asString(choice?.finish_reason),
        toolCalls: calls.map((value) => {
            const call = asRecord(value);
            const fn = asRecord(call?.function);
            const rawArgs = asString(fn?.arguments) ?? '{}';
            return { id: asString(call?.id) ?? randomId(), name: asString(fn?.name) ?? 'unknown', raw: rawArgs, arguments: parseArgs(rawArgs) };
        }),
        inputTokens: asNumber(usage?.prompt_tokens),
        outputTokens: asNumber(usage?.completion_tokens),
    };
}
function makeResult(conn, req, text, toolCalls, finish, started, firstTokenMs, inputTokens, outputTokens) {
    const usage = inputTokens !== undefined || outputTokens !== undefined
        ? { inputTokens, outputTokens, estimated: false }
        : estimatedUsage(textFromMessages(req.messages), text);
    return {
        text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        finishReason: mapFinish(finish, toolCalls.length > 0),
        usage,
        timing: { firstTokenMs, totalMs: Date.now() - started },
        model: req.model,
        source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
    };
}
function mapFinish(finish, hasToolCalls) {
    if (hasToolCalls || finish === 'tool_calls' || finish === 'function_call')
        return 'tool';
    if (finish === 'length')
        return 'length';
    if (finish === 'content_filter')
        return 'content_filter';
    return 'stop';
}
//# sourceMappingURL=openaiChat.js.map