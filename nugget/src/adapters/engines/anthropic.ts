import { estimatedUsage } from '../../tokens.js';
import { postJsonResponse, sseLines } from '../../transport.js';
import type { ChatRequest, ChatResult, ProviderAdapter, ResolvedConnection, StreamEvent, ToolCall } from '../../types.js';
import { asNumber, asRecord, asString, textFromMessages } from '../../util.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider: string;
  constructor(provider: string) {
    this.provider = provider;
  }

  async chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult> {
    let result: ChatResult | undefined;
    for await (const event of this.stream(conn, req)) if (event.type === 'done') result = event.result;
    if (!result) throw new Error('Anthropic stream ended without a result');
    return result;
  }

  async *stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent> {
    const started = Date.now();
    let firstTokenMs: number | null = null;
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const toolCalls: ToolCall[] = [];
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    const res = await postJsonResponse(`${conn.baseUrl}/v1/messages`, body(req), conn.headers, conn.timeoutMs ?? 120_000, req.signal, conn.provider);
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const data = await res.json() as unknown;
      const parsed = parseResponse(data);
      text = parsed.text;
      inputTokens = parsed.inputTokens;
      outputTokens = parsed.outputTokens;
      toolCalls.push(...parsed.toolCalls);
      if (text) yield { type: 'delta', text };
    } else {
      for await (const line of sseLines(res)) {
        const event = JSON.parse(line) as unknown;
        const record = asRecord(event);
        const delta = asRecord(record?.delta);
        const piece = asString(delta?.text);
        if (piece) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - started;
          text += piece;
          yield { type: 'delta', text: piece };
        }
        const usage = asRecord(record?.usage);
        inputTokens = asNumber(usage?.input_tokens) ?? inputTokens;
        outputTokens = asNumber(usage?.output_tokens) ?? outputTokens;
      }
    }
    for (const call of toolCalls) yield { type: 'tool_call', call };
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
}

function body(req: ChatRequest): Record<string, unknown> {
  const system = req.messages.filter((m) => m.role === 'system').map((m) => typeof m.content === 'string' ? m.content : '').join('\n\n') || undefined;
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature,
    top_p: req.topP,
    system,
    messages: req.messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map((part) => part.type === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: part.mimeType ?? 'image/png', data: part.imageBase64 ?? '' } }
        : { type: 'text', text: part.text ?? '' }),
    })),
    tools: req.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
    stream: true,
  };
}

function parseResponse(data: unknown): { text: string; inputTokens?: number; outputTokens?: number; toolCalls: ToolCall[] } {
  const record = asRecord(data);
  const content = Array.isArray(record?.content) ? record.content : [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const blockValue of content) {
    const block = asRecord(blockValue);
    if (block?.type === 'text') text += asString(block.text) ?? '';
    if (block?.type === 'tool_use') {
      toolCalls.push({
        id: asString(block.id) ?? crypto.randomUUID(),
        name: asString(block.name) ?? 'unknown',
        arguments: block.input ?? {},
        raw: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const usage = asRecord(record?.usage);
  return { text, inputTokens: asNumber(usage?.input_tokens), outputTokens: asNumber(usage?.output_tokens), toolCalls };
}
