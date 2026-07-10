import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { fetchJson, postResponse, sseLines } from '../../transport.js';
import type { ChatMessage, ChatRequest, ChatResult, ProviderAdapter, ResolvedConnection, StreamEvent, ToolCall } from '../../types.js';
import { asNumber, asRecord, asString, textFromMessages } from '../../util.js';
import { DEFAULT_TIMEOUT_MS, buildBody, streamError, streamTimeout } from './base.js';

export class GoogleAdapter implements ProviderAdapter {
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
    if (!result) throw new AIError('Google stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
    return result;
  }

  async *stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent> {
    const started = Date.now();
    let firstTokenMs: number | null = null;
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finish: string | undefined;
    const toolCalls: ToolCall[] = [];
    const timeout = streamTimeout(conn, req.signal);
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    try {
      const streamUrl = `${conn.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
      const res = await postResponse(streamUrl, buildBody(() => body(req), conn.provider), conn.headers, timeout.signal, conn.provider);
      const contentType = res.headers.get('content-type') ?? '';
      const chunks = contentType.includes('text/event-stream') ? sseLines(res, () => timeout.bump()) : singleJsonLine(res);
      for await (const line of chunks) {
        const parsed = safeParse(line);
        const record = asRecord(parsed);
        const promptFeedback = asRecord(record?.promptFeedback);
        if (!firstCandidate(record) && promptFeedback?.blockReason) finish = 'SAFETY';
        for (const part of candidateParts(record)) {
          const partText = asString(asRecord(part)?.text);
          if (partText) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            text += partText;
            yield { type: 'delta', text: partText };
          }
          const fnCall = asRecord(asRecord(part)?.functionCall);
          if (fnCall) {
            const call: ToolCall = {
              id: randomId(),
              name: asString(fnCall.name) ?? 'unknown',
              arguments: fnCall.args ?? {},
              raw: JSON.stringify(fnCall.args ?? {}),
            };
            toolCalls.push(call);
            yield { type: 'tool_call', call };
          }
        }
        finish = asString(asRecord(firstCandidate(record))?.finishReason) ?? finish;
        const usage = asRecord(record?.usageMetadata);
        inputTokens = asNumber(usage?.promptTokenCount) ?? inputTokens;
        outputTokens = asNumber(usage?.candidatesTokenCount) ?? outputTokens;
      }
      const hasTools = toolCalls.length > 0;
      yield { type: 'done', result: {
        text,
        toolCalls: hasTools ? toolCalls : undefined,
        finishReason: mapFinish(finish, hasTools),
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

  /**
   * `GoogleAdapter` has no `listModels`, so without a `health` probe
   * `AIHandler.testConnection` would report `ok: true` without ever making a
   * network call. `/v1beta/models` is a lightweight, key-authenticated GET
   * that gives an honest connectivity/auth check.
   */
  async health(conn: ResolvedConnection): Promise<{ ok: boolean; detail?: string }> {
    try {
      await fetchJson(`${conn.baseUrl}/v1beta/models`, {
        method: 'GET',
        headers: conn.headers,
        timeoutMs: Math.min(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000),
        provider: conn.provider,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'Health check failed' };
    }
  }
}

function body(req: ChatRequest): Record<string, unknown> {
  const systemText = req.messages.filter((m) => m.role === 'system').map((m) => textContent(m.content)).join('\n\n');
  const jsonMode = req.responseFormat?.type === 'json' && !req.tools?.length;
  const responseSchema = req.responseFormat?.type === 'json' ? req.responseFormat.schema : undefined;
  const payload: Record<string, unknown> = {
    contents: toGoogleContents(req.messages.filter((m) => m.role !== 'system')),
    generationConfig: {
      temperature: req.temperature,
      topP: req.topP,
      maxOutputTokens: req.maxTokens,
      stopSequences: req.stopSequences,
      responseMimeType: jsonMode ? 'application/json' : undefined,
      responseSchema: jsonMode ? responseSchema : undefined,
    },
  };
  if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
  if (req.tools?.length) {
    payload.tools = [{ functionDeclarations: req.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
    const mode = req.toolChoice === 'none' ? 'NONE' : typeof req.toolChoice === 'object' ? 'ANY' : 'AUTO';
    const config: Record<string, unknown> = { mode };
    if (typeof req.toolChoice === 'object') config.allowedFunctionNames = [req.toolChoice.name];
    payload.toolConfig = { functionCallingConfig: config };
  }
  return payload;
}

function toGoogleContents(messages: ChatMessage[]): Record<string, unknown>[] {
  const contents: Record<string, unknown>[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool') {
      contents.push(toGoogleContent(message));
      continue;
    }
    const parts: unknown[] = [];
    while (index < messages.length && messages[index]?.role === 'tool') {
      const toolMessage = messages[index]!;
      parts.push({ functionResponse: { name: toolMessage.name ?? 'unknown', response: toolResponseObject(toolMessage) } });
      index += 1;
    }
    index -= 1;
    contents.push({ role: 'user', parts });
  }
  return contents;
}

function toGoogleContent(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'user',
      parts: [{ functionResponse: { name: m.name ?? 'unknown', response: toolResponseObject(m) } }],
    };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const parts: unknown[] = typeof m.content === 'string'
      ? (m.content ? [{ text: m.content }] : [])
      : m.content.map((part) => part.type === 'image'
          ? { inlineData: { mimeType: part.mimeType ?? 'image/png', data: part.imageBase64 ?? '' } }
          : { text: part.text ?? '' });
    for (const call of m.toolCalls) parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
    return { role: 'model', parts };
  }
  return {
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: typeof m.content === 'string'
      ? [{ text: m.content }]
      : m.content.map((part) => part.type === 'image'
        ? { inlineData: { mimeType: part.mimeType ?? 'image/png', data: part.imageBase64 ?? '' } }
        : { text: part.text ?? '' }),
  };
}

function textContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

function toolResponseObject(message: ChatMessage): Record<string, unknown> {
  if (typeof message.content !== 'string') return { content: textContent(message.content) };
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // keep string fallback
  }
  return { content: message.content };
}

async function* singleJsonLine(res: Response): AsyncIterable<string> {
  const data = await res.json() as unknown;
  // Non-SSE responses may be a single object or an array of streamed chunks.
  if (Array.isArray(data)) {
    for (const item of data) yield JSON.stringify(item);
  } else {
    yield JSON.stringify(data);
  }
}

function firstCandidate(record: Record<string, unknown> | undefined): unknown {
  const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
  return candidates[0];
}

function candidateParts(record: Record<string, unknown> | undefined): unknown[] {
  const content = asRecord(asRecord(firstCandidate(record))?.content);
  return Array.isArray(content?.parts) ? content.parts : [];
}

function mapFinish(finish: string | undefined, hasTools: boolean): ChatResult['finishReason'] {
  if (hasTools) return 'tool';
  if (finish === 'MAX_TOKENS') return 'length';
  if (finish === 'SAFETY' || finish === 'RECITATION' || finish === 'BLOCKLIST' || finish === 'PROHIBITED_CONTENT') return 'content_filter';
  return 'stop';
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
