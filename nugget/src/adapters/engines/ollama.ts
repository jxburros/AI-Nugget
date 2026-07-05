import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { fetchJson, ndjsonLines, postResponse } from '../../transport.js';
import type { ChatMessage, ChatRequest, ChatResult, ModelInfo, ProviderAdapter, ResolvedConnection, StreamEvent, ToolCall } from '../../types.js';
import { asNumber, asRecord, asString, textFromMessages } from '../../util.js';
import { DEFAULT_TIMEOUT_MS, streamError, streamTimeout } from './base.js';

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
    const toolCalls: ToolCall[] = [];
    const timeout = streamTimeout(conn, req.signal);
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    try {
      const res = await postResponse(`${conn.baseUrl}/api/chat`, body(req), conn.headers, timeout.signal, conn.provider);
      for await (const value of ndjsonLines(res)) {
        const record = asRecord(value);
        const message = asRecord(record?.message);
        const piece = asString(message?.content);
        if (piece) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - started;
          text += piece;
          yield { type: 'delta', text: piece };
        }
        inputTokens = asNumber(record?.prompt_eval_count) ?? inputTokens;
        outputTokens = asNumber(record?.eval_count) ?? outputTokens;
        doneReason = asString(record?.done_reason) ?? doneReason;
        const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        for (const callValue of calls) {
          const fn = asRecord(asRecord(callValue)?.function);
          const args = fn?.arguments ?? {};
          const toolCall: ToolCall = {
            id: randomId(),
            name: asString(fn?.name) ?? 'unknown',
            arguments: args,
            raw: typeof args === 'string' ? args : JSON.stringify(args),
          };
          toolCalls.push(toolCall);
          yield { type: 'tool_call', call: toolCall };
        }
      }
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
    // Probe /api/show per model for context window + capabilities (best effort).
    return Promise.all(ids.map(async (id) => {
      const info: ModelInfo = { id, source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl } };
      const probed = await this.showModel(conn, id).catch(() => undefined);
      if (probed?.contextWindow !== undefined) info.contextWindow = probed.contextWindow;
      if (probed?.capabilities) info.capabilities = probed.capabilities;
      return info;
    }));
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
  return {
    model: req.model,
    messages: req.messages.map(toOllamaMessage),
    stream: true,
    options: { temperature: req.temperature, num_predict: req.maxTokens, top_p: req.topP, stop: req.stopSequences },
    format: req.responseFormat?.type === 'json' ? (req.responseFormat.schema ?? 'json') : undefined,
    tools: req.tools?.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
  };
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

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
