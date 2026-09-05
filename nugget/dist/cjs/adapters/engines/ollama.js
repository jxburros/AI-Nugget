"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaAdapter = void 0;
const errors_js_1 = require("../../errors.js");
const tokens_js_1 = require("../../tokens.js");
const transport_js_1 = require("../../transport.js");
const util_js_1 = require("../../util.js");
const base_js_1 = require("./base.js");
/** Max concurrent /api/show probes when listing models — enough to be fast, few enough to be polite to a local daemon. */
const SHOW_CONCURRENCY = 6;
class OllamaAdapter {
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
            throw new errors_js_1.AIError('Ollama stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
        return result;
    }
    async *stream(conn, req) {
        const started = Date.now();
        let firstTokenMs = null;
        let text = '';
        let inputTokens;
        let outputTokens;
        let doneReason;
        let sawTerminal = false;
        const toolCalls = [];
        const timeout = (0, base_js_1.streamTimeout)(conn, req.signal);
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        try {
            const res = await (0, transport_js_1.postResponse)((0, util_js_1.joinUrl)(conn.baseUrl, '/api/chat'), body(req), conn.headers, timeout.signal, conn.provider);
            for await (const value of (0, transport_js_1.ndjsonLines)(res)) {
                timeout.bump();
                const record = (0, util_js_1.asRecord)(value);
                const message = (0, util_js_1.asRecord)(record?.message);
                const thinking = (0, util_js_1.asString)(message?.thinking);
                if (thinking)
                    yield { type: 'reasoning', text: thinking };
                const piece = (0, util_js_1.asString)(message?.content);
                if (piece) {
                    if (firstTokenMs === null)
                        firstTokenMs = Date.now() - started;
                    text += piece;
                    yield { type: 'delta', text: piece };
                }
                inputTokens = (0, util_js_1.asNumber)(record?.prompt_eval_count) ?? inputTokens;
                outputTokens = (0, util_js_1.asNumber)(record?.eval_count) ?? outputTokens;
                doneReason = (0, util_js_1.asString)(record?.done_reason) ?? doneReason;
                if (record?.done === true)
                    sawTerminal = true;
                const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
                for (const callValue of calls) {
                    const fn = (0, util_js_1.asRecord)((0, util_js_1.asRecord)(callValue)?.function);
                    const args = fn?.arguments ?? {};
                    const toolCall = {
                        id: (0, base_js_1.randomId)(),
                        name: (0, util_js_1.asString)(fn?.name) ?? 'unknown',
                        // Ollama itself sends a native object, but llama.cpp-style backends
                        // behind the same protocol send a JSON *string* — coerce either into
                        // the object `validateToolArgs` expects.
                        arguments: (0, base_js_1.parseArgs)(args),
                        raw: typeof args === 'string' ? args : JSON.stringify(args),
                    };
                    toolCalls.push(toolCall);
                    yield { type: 'tool_call', call: toolCall };
                }
            }
            if (!sawTerminal)
                yield (0, base_js_1.streamAnomaly)('NDJSON stream ended without a done record');
            const hasTools = toolCalls.length > 0;
            yield { type: 'done', result: {
                    text,
                    toolCalls: hasTools ? toolCalls : undefined,
                    finishReason: hasTools ? 'tool' : doneReason === 'length' ? 'length' : 'stop',
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
    async listModels(conn) {
        const { data } = await (0, transport_js_1.fetchJson)(`${conn.baseUrl}/api/tags`, {
            method: 'GET',
            headers: conn.headers,
            timeoutMs: conn.timeoutMs ?? base_js_1.DEFAULT_TIMEOUT_MS,
            provider: conn.provider,
        });
        const models = Array.isArray((0, util_js_1.asRecord)(data)?.models) ? (0, util_js_1.asRecord)(data).models : [];
        const ids = models.map((model) => (0, util_js_1.asString)((0, util_js_1.asRecord)(model)?.name) ?? (0, util_js_1.asString)((0, util_js_1.asRecord)(model)?.model) ?? '').filter(Boolean);
        // Probe /api/show per model for context window + capabilities (best effort),
        // with bounded concurrency so a large model list resolves quickly without
        // opening an unbounded number of sockets against a local daemon.
        return (0, util_js_1.mapWithConcurrency)(ids, SHOW_CONCURRENCY, async (id) => {
            const info = { id, source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl } };
            const probed = await this.showModel(conn, id).catch(() => undefined);
            if (probed?.contextWindow !== undefined)
                info.contextWindow = probed.contextWindow;
            if (probed?.capabilities)
                info.capabilities = probed.capabilities;
            return info;
        });
    }
    async embed(conn, req) {
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        const { data } = await (0, transport_js_1.fetchJson)((0, util_js_1.joinUrl)(conn.baseUrl, '/api/embed'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...conn.headers },
            body: JSON.stringify((0, util_js_1.applyProviderOptions)({ model: req.model, input: inputs }, req.providerOptions)),
            timeoutMs: conn.timeoutMs ?? base_js_1.DEFAULT_TIMEOUT_MS,
            provider: conn.provider,
        });
        const record = (0, util_js_1.asRecord)(data);
        const rows = Array.isArray(record?.embeddings) ? record.embeddings : [];
        const embeddings = rows.map((row) => (Array.isArray(row) ? row.filter((n) => typeof n === 'number') : []));
        const inputTokens = (0, util_js_1.asNumber)(record?.prompt_eval_count);
        return {
            embeddings,
            model: req.model,
            usage: { inputTokens, outputTokens: 0, estimated: inputTokens === undefined },
            source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
            raw: data,
        };
    }
    async showModel(conn, model) {
        const { data } = await (0, transport_js_1.fetchJson)(`${conn.baseUrl}/api/show`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...conn.headers },
            body: JSON.stringify({ model }),
            timeoutMs: Math.min(conn.timeoutMs ?? base_js_1.DEFAULT_TIMEOUT_MS, 15_000),
            provider: conn.provider,
        });
        const record = (0, util_js_1.asRecord)(data);
        const modelInfo = (0, util_js_1.asRecord)(record?.model_info);
        let contextWindow;
        if (modelInfo) {
            for (const [key, value] of Object.entries(modelInfo)) {
                if (key.endsWith('.context_length') && typeof value === 'number') {
                    contextWindow = value;
                    break;
                }
            }
        }
        const caps = record?.capabilities;
        const capabilities = Array.isArray(caps) && caps.every((c) => typeof c === 'string') ? caps : undefined;
        const result = {};
        if (contextWindow !== undefined)
            result.contextWindow = contextWindow;
        if (capabilities)
            result.capabilities = capabilities;
        return result;
    }
}
exports.OllamaAdapter = OllamaAdapter;
function body(req) {
    const base = {
        model: req.model,
        messages: req.messages.map(toOllamaMessage),
        stream: true,
        options: { temperature: req.temperature, num_predict: req.maxTokens, top_p: req.topP, stop: req.stopSequences },
        format: req.responseFormat?.type === 'json' ? (req.responseFormat.schema ?? 'json') : undefined,
        tools: req.tools?.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
    };
    // First-class reasoning effort → Ollama's `think` flag (reasoning arrives in
    // `message.thinking`, which this engine already routes to `reasoning` events).
    // Ollama has no graded effort for most models, so anything but `'none'` is
    // `true`. Only sent when asked for: a model without thinking support rejects it.
    if (req.reasoningEffort !== undefined)
        base.think = req.reasoningEffort !== 'none';
    // providerOptions reaches Ollama's real request fields — `options.num_ctx`,
    // `options.num_keep`, top-level `keep_alive`, `think`, etc. `options` is
    // merged one level deep so num_ctx joins the samplers above rather than
    // replacing them.
    return (0, util_js_1.applyProviderOptions)(base, req.providerOptions, ['options']);
}
function toOllamaMessage(m) {
    const images = typeof m.content === 'string' ? undefined : m.content.filter((part) => part.type === 'image').map((part) => part.imageBase64).filter(Boolean);
    const message = {
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
    };
    if (images && images.length)
        message.images = images;
    if (m.role === 'tool' && m.name)
        message.tool_name = m.name;
    if (m.role === 'assistant' && m.toolCalls?.length) {
        message.tool_calls = m.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments ?? {} } }));
    }
    return message;
}
