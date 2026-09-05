"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIChatAdapter = void 0;
exports.shouldRetryWithoutReasoningEffort = shouldRetryWithoutReasoningEffort;
const errors_js_1 = require("../../errors.js");
const tokens_js_1 = require("../../tokens.js");
const transport_js_1 = require("../../transport.js");
const util_js_1 = require("../../util.js");
const base_js_1 = require("./base.js");
class OpenAIChatAdapter {
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
            throw new errors_js_1.AIError('Provider stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
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
        const timeout = (0, base_js_1.streamTimeout)(conn, req.signal);
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        try {
            let res;
            try {
                res = await (0, transport_js_1.postResponse)(urlFor(conn, this.profile, req), openAiBody(req, this.profile), conn.headers, timeout.signal, conn.provider);
            }
            catch (error) {
                // OpenAI's `/chat/completions` refuses function tools on a reasoning model
                // unless `reasoning_effort` is `'none'` ("Function tools with reasoning_effort
                // are not supported … use /v1/responses or set reasoning_effort to 'none'").
                // The nugget never sets `reasoning_effort` itself, so the provider default
                // applies and every tool-using turn 400s. Rather than make each app learn
                // this the hard way, retry the one request once with the effort disabled
                // and say so on the stream. Reactive on purpose: sending
                // `reasoning_effort` up front would 400 on non-reasoning models instead.
                // A caller-requested effort is overridden too — the alternative is a hard
                // 400 with no tool call at all — and the context event says so.
                if (!shouldRetryWithoutReasoningEffort(error, req))
                    throw error;
                yield {
                    type: 'context',
                    kind: 'reasoning_effort_disabled_for_tools',
                    data: {
                        reason: 'provider rejected function tools with reasoning_effort; retried with reasoning_effort: none',
                        requested: req.providerOptions?.reasoning_effort ?? req.reasoningEffort ?? null,
                    },
                };
                const retryReq = { ...req, providerOptions: { ...req.providerOptions, reasoning_effort: 'none' } };
                res = await (0, transport_js_1.postResponse)(urlFor(conn, this.profile, retryReq), openAiBody(retryReq, this.profile), conn.headers, timeout.signal, conn.provider);
            }
            const contentType = res.headers.get('content-type') ?? '';
            if (!contentType.includes('text/event-stream')) {
                // Server ignored stream:true (or is a buffered gateway) — recover the whole body.
                const rawText = await res.text().catch(() => '');
                const raw = (0, base_js_1.safeParse)(rawText) ?? { text: rawText };
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
                for await (const line of (0, transport_js_1.sseLines)(res)) {
                    timeout.bump();
                    const chunk = (0, base_js_1.safeParse)(line);
                    const record = (0, util_js_1.asRecord)(chunk);
                    if (!record)
                        continue;
                    const usage = (0, util_js_1.asRecord)(record.usage);
                    inputTokens = (0, util_js_1.asNumber)(usage?.prompt_tokens) ?? inputTokens;
                    outputTokens = (0, util_js_1.asNumber)(usage?.completion_tokens) ?? outputTokens;
                    const choices = Array.isArray(record.choices) ? record.choices : [];
                    const choice = (0, util_js_1.asRecord)(choices[0]);
                    finish = (0, util_js_1.asString)(choice?.finish_reason) ?? finish;
                    if (choice?.finish_reason)
                        sawTerminal = true;
                    const delta = (0, util_js_1.asRecord)(choice?.delta);
                    // Reasoning tokens (DeepSeek `reasoning_content`, others `reasoning`)
                    // ride their own channel so they don't contaminate the answer text.
                    const reasoning = (0, util_js_1.asString)(delta?.reasoning_content) ?? (0, util_js_1.asString)(delta?.reasoning);
                    if (reasoning)
                        yield { type: 'reasoning', text: reasoning };
                    const piece = (0, util_js_1.asString)(delta?.content);
                    if (piece) {
                        if (firstTokenMs === null)
                            firstTokenMs = Date.now() - started;
                        text += piece;
                        yield { type: 'delta', text: piece };
                    }
                    const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
                    for (const callValue of calls) {
                        const call = (0, util_js_1.asRecord)(callValue);
                        const index = (0, util_js_1.asNumber)(call?.index) ?? 0;
                        const current = partialTools.get(index) ?? { raw: '' };
                        current.id = (0, util_js_1.asString)(call?.id) ?? current.id;
                        const fn = (0, util_js_1.asRecord)(call?.function);
                        current.name = (0, util_js_1.asString)(fn?.name) ?? current.name;
                        current.raw += (0, util_js_1.asString)(fn?.arguments) ?? '';
                        partialTools.set(index, current);
                    }
                }
                toolCalls = [...partialTools.values()].filter((call) => call.name).map((call) => ({
                    id: call.id ?? (0, base_js_1.randomId)(),
                    name: call.name,
                    raw: call.raw,
                    arguments: (0, base_js_1.parseArgs)(call.raw),
                }));
                for (const call of toolCalls)
                    yield { type: 'tool_call', call };
            }
            if (!sawTerminal)
                yield (0, base_js_1.streamAnomaly)('stream ended without a finish_reason');
            const result = makeResult(conn, req, text, toolCalls, finish, started, firstTokenMs, inputTokens, outputTokens);
            yield { type: 'done', result };
        }
        catch (error) {
            throw (0, base_js_1.streamError)(error, timeout, conn.provider);
        }
        finally {
            timeout.done();
        }
    }
    listModels(conn) {
        return (0, base_js_1.listOpenModels)(conn, this.profile);
    }
    health(conn) {
        return (0, base_js_1.health)(conn, this.profile);
    }
    async embed(conn, req) {
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        const { data } = await (0, transport_js_1.fetchJson)((0, util_js_1.joinUrl)(conn.baseUrl, '/embeddings'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...conn.headers },
            body: JSON.stringify((0, util_js_1.applyProviderOptions)({ model: req.model, input: inputs }, req.providerOptions)),
            timeoutMs: conn.timeoutMs ?? base_js_1.DEFAULT_TIMEOUT_MS,
            provider: conn.provider,
        });
        const record = (0, util_js_1.asRecord)(data);
        const rows = Array.isArray(record?.data) ? record.data : [];
        // Order by the `index` each row reports, falling back to array order.
        const byIndex = rows
            .map((row, i) => ({ index: (0, util_js_1.asNumber)((0, util_js_1.asRecord)(row)?.index) ?? i, embedding: asEmbedding((0, util_js_1.asRecord)(row)?.embedding) }))
            .sort((a, b) => a.index - b.index);
        const usage = (0, util_js_1.asRecord)(record?.usage);
        const inputTokens = (0, util_js_1.asNumber)(usage?.prompt_tokens);
        return {
            embeddings: byIndex.map((row) => row.embedding),
            model: req.model,
            usage: { inputTokens, outputTokens: 0, estimated: inputTokens === undefined },
            source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
            raw: data,
        };
    }
}
exports.OpenAIChatAdapter = OpenAIChatAdapter;
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
    // First-class reasoning effort → OpenAI's `reasoning_effort`. Only sent when
    // asked for: non-reasoning models reject the parameter outright.
    if (req.reasoningEffort !== undefined)
        body.reasoning_effort = req.reasoningEffort;
    // providerOptions carries OpenAI-native fields the nugget doesn't model
    // (`reasoning_effort`, `parallel_tool_calls`, `seed`, `logprobs`, …). `apiVersion`
    // is consumed by urlFor for Azure and stripped here so it never hits the body.
    const { apiVersion, ...passthrough } = req.providerOptions ?? {};
    void apiVersion;
    return (0, util_js_1.applyProviderOptions)(body, Object.keys(passthrough).length ? passthrough : undefined);
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
        const apiVersion = (0, util_js_1.asString)(req.providerOptions?.apiVersion) ?? profile.quirks.apiVersion ?? '';
        return profile.quirks.urlTemplate
            .replace('{baseUrl}', conn.baseUrl)
            .replace('{model}', encodeURIComponent(req.model))
            .replace('{apiVersion}', apiVersion);
    }
    return (0, util_js_1.joinUrl)(conn.baseUrl, '/chat/completions');
}
function parseOpenAiResponse(raw) {
    const record = (0, util_js_1.asRecord)(raw);
    const usage = (0, util_js_1.asRecord)(record?.usage);
    const choice = (0, util_js_1.asRecord)(Array.isArray(record?.choices) ? record.choices[0] : undefined);
    const message = (0, util_js_1.asRecord)(choice?.message);
    const text = (0, util_js_1.asString)(message?.content) ?? (0, util_js_1.asString)(record?.text) ?? '';
    const reasoning = (0, util_js_1.asString)(message?.reasoning_content) ?? (0, util_js_1.asString)(message?.reasoning);
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    return {
        text,
        reasoning,
        finish: (0, util_js_1.asString)(choice?.finish_reason),
        toolCalls: calls.map((value) => {
            const call = (0, util_js_1.asRecord)(value);
            const fn = (0, util_js_1.asRecord)(call?.function);
            const rawArgs = (0, util_js_1.asString)(fn?.arguments) ?? '{}';
            return { id: (0, util_js_1.asString)(call?.id) ?? (0, base_js_1.randomId)(), name: (0, util_js_1.asString)(fn?.name) ?? 'unknown', raw: rawArgs, arguments: (0, base_js_1.parseArgs)(rawArgs) };
        }),
        inputTokens: (0, util_js_1.asNumber)(usage?.prompt_tokens),
        outputTokens: (0, util_js_1.asNumber)(usage?.completion_tokens),
    };
}
function makeResult(conn, req, text, toolCalls, finish, started, firstTokenMs, inputTokens, outputTokens) {
    const usage = inputTokens !== undefined || outputTokens !== undefined
        ? { inputTokens, outputTokens, estimated: false }
        : (0, tokens_js_1.estimatedUsage)((0, util_js_1.textFromMessages)(req.messages), text);
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
/**
 * True when a `/chat/completions` 400 is the "function tools with reasoning_effort
 * are not supported" refusal AND the request actually carried tools AND the caller
 * did not already pin `reasoning_effort` (in which case the choice is theirs).
 */
function shouldRetryWithoutReasoningEffort(error, req) {
    if (!(error instanceof errors_js_1.AIError) || error.status !== 400)
        return false;
    if (!req.tools || req.tools.length === 0)
        return false;
    // Already `'none'` (from either knob) — the refusal is about something else.
    const effective = req.providerOptions && 'reasoning_effort' in req.providerOptions
        ? req.providerOptions.reasoning_effort
        : req.reasoningEffort;
    if (effective === 'none')
        return false;
    const text = `${error.raw ?? ''} ${error.message}`.toLowerCase();
    return text.includes('reasoning_effort') && text.includes('tool');
}
