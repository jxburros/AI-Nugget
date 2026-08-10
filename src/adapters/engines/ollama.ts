import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { fetchJson, ndjsonLines, postResponse } from '../../transport.js';
import type { ChatMessage, ChatRequest, ChatResult, EmbedRequest, EmbedResult, ModelInfo, ProviderAdapter, ResolvedConnection, StreamEvent, ToolCall } from '../../types.js';
import { applyProviderOptions, asNumber, asRecord, asString, joinUrl, mapWithConcurrency, textFromMessages } from '../../util.js';
import { DEFAULT_TIMEOUT_MS, parseArgs, randomId, streamAnomaly, streamError, streamTimeout } from './base.js';

/** Max concurrent /api/show probes when listing models — enough to be fast, few enough to be polite to a local daemon. */
const SHOW_CONCURRENCY = 6;

export class OllamaAdapter implements ProviderAdapter {
  readonly provider: string;
  constructor(provider: string) {
    this.provider = provider;
  }

  async chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult> {
    let result: ChatResult | undefined;
    for await (const event of this.stream(conn, req)) {
      if (event.type === 'done') result = event.result;
      if (event.type === 'error') throw event.error;
    }
    if (!result) throw new AIError('Ollama stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
    return result;
  }

  async *stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent> {
    const started = Date.now();
    let firstTokenMs: number | null = null;
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let doneReason: string | undefined;
    let sawTerminal = false;
    const toolCalls: ToolCall[] = [];
    const timeout = streamTimeout(conn, req.signal);
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    try {
      const res = await postResponse(joinUrl(conn.baseUrl, '/api/chat'), body(req), conn.headers, timeout.signal, conn.provider);
      for await (const value of ndjsonLines(res)) {
        timeout.bump();
        const record = asRecord(value);
        const message = asRecord(record?.message);
        const thinking = asString(message?.thinking);
        if (thinking) yield { type: 'reasoning', text: thinking };
        const piece = asString(message?.content);
        if (piece) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - started;
          text += piece;
          yield { type: 'delta', text: piece };
        }
        inputTokens = asNumber(record?.prompt_eval_count) ?? inputTokens;
        outputTokens = asNumber(record?.eval_count) ?? outputTokens;
        doneReason = asString(record?.done_reason) ?? doneReason;
        if (record?.done === true) sawTerminal = true;
        const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        for (const callValue of calls) {
          const fn = asRecord(asRecord(callValue)?.function);
          const args = fn?.arguments ?? {};
          const toolCall: ToolCall = {
            id: randomId(),
            name: asString(fn?.name) ?? 'unknown',
            // Ollama itself sends a native object, but llama.cpp-style backends
            // behind the same protocol send a JSON *string* — coerce either into
            // the object `validateToolArgs` expects.
            arguments: parseArgs(args),
            raw: typeof args === 'string' ? args : JSON.stringify(args),
          };
          toolCalls.push(toolCall);
          yield { type: 'tool_call', call: toolCall };
        }
      }
      if (!sawTerminal) yield streamAnomaly('NDJSON stream ended without a done record');
      const hasTools = toolCalls.length > 0;
      yield { type: 'done', result: {
        text,
        toolCalls: hasTools ? toolCalls : undefined,
        finishReason: hasTools ? 'tool' : doneReason === 'length' ? 'length' : 'stop',
        usage: inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens, estimated: false } : estimatedUsage(textFromMessages(req.messages), text),
        timing: { firstTokenMs, totalMs: Date.now() - started },
        model: req.model,
        source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
      } };
    } catch (error) {
      throw streamError(error, timeout, conn.provider);
    } finally {
      timeout.done();
    }
  }

  async listModels(conn: ResolvedConnection): Promise<ModelInfo[]> {
    const { data } = await fetchJson(`${conn.baseUrl}/api/tags`, {
      method: 'GET',
      headers: conn.headers,
      timeoutMs: conn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      provider: conn.provider,
    });
    const models = Array.isArray(asRecord(data)?.models) ? asRecord(data)!.models as unknown[] : [];
    const ids = models.map((model) => asString(asRecord(model)?.name) ?? asString(asRecord(model)?.model) ?? '').filter(Boolean);
    // Probe /api/show per model for context window + capabilities (best effort),
    // with bounded concurrency so a large model list resolves quickly without
    // opening an unbounded number of sockets against a local daemon.
    return mapWithConcurrency(ids, SHOW_CONCURRENCY, async (id) => {
      const info: ModelInfo = { id, source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl } };
      const probed = await this.showModel(conn, id).catch(() => undefined);
      if (probed?.contextWindow !== undefined) info.contextWindow = probed.contextWindow;
      if (probed?.capabilities) info.capabilities = probed.capabilities;
      return info;
    });
  }

  async embed(conn: ResolvedConnection, req: EmbedRequest): Promise<EmbedResult> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const { data } = await fetchJson(joinUrl(conn.baseUrl, '/api/embed'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...conn.headers },
      body: JSON.stringify(applyProviderOptions({ model: req.model, input: inputs }, req.providerOptions)),
      timeoutMs: conn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      provider: conn.provider,
    });
    const record = asRecord(data);
    const rows = Array.isArray(record?.embeddings) ? record.embeddings : [];
    const embeddings = rows.map((row) => (Array.isArray(row) ? row.filter((n): n is number => typeof n === 'number') : []));
    const inputTokens = asNumber(record?.prompt_eval_count);
    return {
      embeddings,
      model: req.model,
      usage: { inputTokens, outputTokens: 0, estimated: inputTokens === undefined },
      source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
      raw: data,
    };
  }

  private async showModel(conn: ResolvedConnection, model: string): Promise<{ contextWindow?: number; capabilities?: string[] }> {
    const { data } = await fetchJson(`${conn.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...conn.headers },
      body: JSON.stringify({ model }),
      timeoutMs: Math.min(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000),
      provider: conn.provider,
    });
    const record = asRecord(data);
    const modelInfo = asRecord(record?.model_info);
    let contextWindow: number | undefined;
    if (modelInfo) {
      for (const [key, value] of Object.entries(modelInfo)) {
        if (key.endsWith('.context_length') && typeof value === 'number') { contextWindow = value; break; }
      }
    }
    const caps = record?.capabilities;
    const capabilities = Array.isArray(caps) && caps.every((c) => typeof c === 'string') ? caps as string[] : undefined;
    const result: { contextWindow?: number; capabilities?: string[] } = {};
    if (contextWindow !== undefined) result.contextWindow = contextWindow;
    if (capabilities) result.capabilities = capabilities;
    return result;
  }
}

function body(req: ChatRequest): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toOllamaMessage),
    stream: true,
    options: { temperature: req.temperature, num_predict: req.maxTokens, top_p: req.topP, stop: req.stopSequences },
    format: req.responseFormat?.type === 'json' ? (req.responseFormat.schema ?? 'json') : undefined,
    tools: req.tools?.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
  };
  // providerOptions reaches Ollama's real request fields — `options.num_ctx`,
  // `options.num_keep`, top-level `keep_alive`, `think`, etc. `options` is
  // merged one level deep so num_ctx joins the samplers above rather than
  // replacing them.
  return applyProviderOptions(base, req.providerOptions, ['options']);
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  const images = typeof m.content === 'string' ? undefined : m.content.filter((part) => part.type === 'image').map((part) => part.imageBase64).filter(Boolean);
  const message: Record<string, unknown> = {
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
  };
  if (images && images.length) message.images = images;
  if (m.role === 'tool' && m.name) message.tool_name = m.name;
  if (m.role === 'assistant' && m.toolCalls?.length) {
    message.tool_calls = m.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments ?? {} } }));
  }
  return message;
}
