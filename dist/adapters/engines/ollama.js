import { estimatedUsage } from '../../tokens.js';
import { ndjsonLines, postJsonResponse } from '../../transport.js';
import { asNumber, asRecord, asString, textFromMessages } from '../../util.js';
export class OllamaAdapter {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async chat(conn, req) {
        let result;
        for await (const event of this.stream(conn, req))
            if (event.type === 'done')
                result = event.result;
        if (!result)
            throw new Error('Ollama stream ended without a result');
        return result;
    }
    async *stream(conn, req) {
        const started = Date.now();
        let firstTokenMs = null;
        let text = '';
        let inputTokens;
        let outputTokens;
        const toolCalls = [];
        yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
        const res = await postJsonResponse(`${conn.baseUrl}/api/chat`, body(req), conn.headers, conn.timeoutMs ?? 120_000, req.signal, conn.provider);
        for await (const value of ndjsonLines(res)) {
            const record = asRecord(value);
            const message = asRecord(record?.message);
            const piece = asString(message?.content);
            if (piece) {
                if (firstTokenMs === null)
                    firstTokenMs = Date.now() - started;
                text += piece;
                yield { type: 'delta', text: piece };
            }
            inputTokens = asNumber(record?.prompt_eval_count) ?? inputTokens;
            outputTokens = asNumber(record?.eval_count) ?? outputTokens;
            const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
            for (const callValue of calls) {
                const call = asRecord(callValue);
                const fn = asRecord(call?.function);
                const toolCall = {
                    id: crypto.randomUUID(),
                    name: asString(fn?.name) ?? 'unknown',
                    arguments: fn?.arguments ?? {},
                    raw: JSON.stringify(fn?.arguments ?? {}),
                };
                toolCalls.push(toolCall);
                yield { type: 'tool_call', call: toolCall };
            }
        }
        yield { type: 'done', result: {
                text,
                toolCalls: toolCalls.length ? toolCalls : undefined,
                finishReason: toolCalls.length ? 'tool' : 'stop',
                usage: inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens, estimated: false } : estimatedUsage(textFromMessages(req.messages), text),
                timing: { firstTokenMs, totalMs: Date.now() - started },
                model: req.model,
                source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
            } };
    }
    async listModels(conn) {
        const res = await fetch(`${conn.baseUrl}/api/tags`, { headers: conn.headers, signal: reqTimeoutSignal(conn.timeoutMs ?? 120_000) });
        const data = await res.json();
        const models = Array.isArray(asRecord(data)?.models) ? asRecord(data).models : [];
        return models.map((model) => ({
            id: asString(asRecord(model)?.name) ?? '',
            source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
        })).filter((model) => model.id);
    }
}
function body(req) {
    return {
        model: req.model,
        messages: req.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : m.content.map((part) => part.text ?? '').join('\n'),
            images: typeof m.content === 'string' ? undefined : m.content.filter((part) => part.type === 'image').map((part) => part.imageBase64),
            tool_call_id: m.toolCallId,
        })),
        stream: true,
        options: { temperature: req.temperature, num_predict: req.maxTokens, top_p: req.topP },
        format: req.responseFormat?.type === 'json' ? 'json' : undefined,
        tools: req.tools,
    };
}
function reqTimeoutSignal(ms) {
    if ('timeout' in AbortSignal && typeof AbortSignal.timeout === 'function')
        return AbortSignal.timeout(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}
//# sourceMappingURL=ollama.js.map