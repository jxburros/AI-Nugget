import { estimatedUsage } from '../../tokens.js';
import { postJsonResponse, sseLines } from '../../transport.js';
import type { ChatRequest, ChatResult, ProviderAdapter, ResolvedConnection, StreamEvent } from '../../types.js';
import { asNumber, asRecord, asString, textFromMessages } from '../../util.js';

export class GoogleAdapter implements ProviderAdapter {
  readonly provider: string;
  constructor(provider: string) {
    this.provider = provider;
  }

  async chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult> {
    let result: ChatResult | undefined;
    for await (const event of this.stream(conn, req)) if (event.type === 'done') result = event.result;
    if (!result) throw new Error('Google stream ended without a result');
    return result;
  }

  async *stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent> {
    const started = Date.now();
    let firstTokenMs: number | null = null;
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    const streamUrl = `${conn.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
    const res = await postJsonResponse(streamUrl, body(req), conn.headers, conn.timeoutMs ?? 120_000, req.signal, conn.provider);
    const contentType = res.headers.get('content-type') ?? '';
    const chunks = contentType.includes('text/event-stream') ? sseLines(res) : singleJsonLine(res);
    for await (const line of chunks) {
      const parsed = JSON.parse(line) as unknown;
      const piece = candidateText(parsed);
      if (piece) {
        if (firstTokenMs === null) firstTokenMs = Date.now() - started;
        text += piece;
        yield { type: 'delta', text: piece };
      }
      const usage = asRecord(asRecord(parsed)?.usageMetadata);
      inputTokens = asNumber(usage?.promptTokenCount) ?? inputTokens;
      outputTokens = asNumber(usage?.candidatesTokenCount) ?? outputTokens;
    }
    yield { type: 'done', result: {
      text,
      finishReason: 'stop',
      usage: inputTokens !== undefined || outputTokens !== undefined ? { inputTokens, outputTokens, estimated: false } : estimatedUsage(textFromMessages(req.messages), text),
      timing: { firstTokenMs, totalMs: Date.now() - started },
      model: req.model,
      source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
    } };
  }
}

function body(req: ChatRequest): Record<string, unknown> {
  return {
    contents: req.messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: typeof m.content === 'string'
        ? [{ text: m.content }]
        : m.content.map((part) => part.type === 'image'
          ? { inlineData: { mimeType: part.mimeType ?? 'image/png', data: part.imageBase64 ?? '' } }
          : { text: part.text ?? '' }),
    })),
    systemInstruction: {
      parts: req.messages.filter((m) => m.role === 'system').map((m) => ({ text: typeof m.content === 'string' ? m.content : '' })),
    },
    generationConfig: {
      temperature: req.temperature,
      topP: req.topP,
      maxOutputTokens: req.maxTokens,
      responseMimeType: req.responseFormat?.type === 'json' ? 'application/json' : undefined,
    },
    tools: req.tools?.length ? [{ functionDeclarations: req.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] : undefined,
  };
}

async function* singleJsonLine(res: Response): AsyncIterable<string> {
  yield JSON.stringify(await res.json());
}

function candidateText(value: unknown): string {
  const record = asRecord(value);
  const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
  const parts = Array.isArray(asRecord(asRecord(candidates[0])?.content)?.parts) ? asRecord(asRecord(candidates[0])?.content)!.parts as unknown[] : [];
  return parts.map((part) => asString(asRecord(part)?.text) ?? '').join('');
}
