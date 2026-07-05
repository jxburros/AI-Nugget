import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { postJsonResponse, sseLines } from '../../transport.js';
import type { ChatMessage, ChatRequest, ChatResult, ProviderAdapter, ResolvedConnection, StreamEvent, ToolCall } from '../../types.js';
import { asNumber, asRecord, asString, textFromMessages } from '../../util.js';
import type { ProviderProfile } from '../profiles.js';
import { health, listOpenModels } from './base.js';

export class OpenAIChatAdapter implements ProviderAdapter {
  readonly provider: string;
  constructor(provider: string, private profile: ProviderProfile) {
    this.provider = provider;
  }

  async chat(conn: ResolvedConnection, req: ChatRequest): Promise<ChatResult> {
    let final: ChatResult | undefined;
    for await (const event of this.stream(conn, req)) {
      if (event.type === 'done') final = event.result;
      if (event.type === 'error') throw event.error;
    }
    if (!final) throw new AIError('Provider stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
    return final;
  }

  async *stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent> {
    const started = Date.now();
    let firstTokenMs: number | null = null;
    let text = '';
    let toolCalls: ToolCall[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    const res = await postJsonResponse(urlFor(conn, this.profile, req.model), openAiBody(req), conn.headers, conn.timeoutMs ?? 120_000, req.signal, conn.provider);
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const raw = await res.json().catch(async () => ({ text: await res.text().catch(() => '') })) as unknown;
      const parsed = parseOpenAiResponse(raw);
      text = parsed.text;
      toolCalls = parsed.toolCalls;
      inputTokens = parsed.inputTokens;
      outputTokens = parsed.outputTokens;
      if (text) yield { type: 'delta', text };
    } else {
      const partialTools = new Map<number, { id?: string; name?: string; raw: string }>();
      for await (const line of sseLines(res)) {
        const chunk = JSON.parse(line) as unknown;
        const record = asRecord(chunk);
        const usage = asRecord(record?.usage);
        inputTokens = asNumber(usage?.prompt_tokens) ?? inputTokens;
        outputTokens = asNumber(usage?.completion_tokens) ?? outputTokens;
        const choices = Array.isArray(record?.choices) ? record.choices : [];
        const delta = asRecord(asRecord(choices[0])?.delta);
        const piece = asString(delta?.content);
        if (piece) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - started;
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
      toolCalls = [...partialTools.values()].filter((call) => call.id && call.name).map((call) => ({
        id: call.id!,
        name: call.name!,
        raw: call.raw,
        arguments: parseArgs(call.raw),
      }));
      for (const call of toolCalls) yield { type: 'tool_call', call };
    }
    const result = makeResult(conn, req, text, toolCalls, started, firstTokenMs, inputTokens, outputTokens);
    yield { type: 'done', result };
  }

  listModels(conn: ResolvedConnection) {
    return listOpenModels(conn, this.profile);
  }

  health(conn: ResolvedConnection) {
    return health(conn, this.profile);
  }
}

function openAiBody(req: ChatRequest): Record<string, unknown> {
  return {
    model: req.model,
    messages: req.messages.map(toOpenAiMessage),
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    top_p: req.topP,
    stop: req.stopSequences,
    response_format: req.responseFormat?.type === 'json' ? { type: 'json_object' } : undefined,
    tools: req.tools?.map((tool) => ({ type: 'function', function: tool })),
    tool_choice: typeof req.toolChoice === 'object' ? { type: 'function', function: { name: req.toolChoice.name } } : req.toolChoice,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => part.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${part.mimeType ?? 'image/png'};base64,${part.imageBase64 ?? ''}` } }
        : { type: 'text', text: part.text ?? '' }),
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.arguments) } })),
  };
}

function urlFor(conn: ResolvedConnection, profile: ProviderProfile, model: string): string {
  if (profile.quirks?.urlTemplate) {
    return profile.quirks.urlTemplate.replace('{baseUrl}', conn.baseUrl).replace('{model}', encodeURIComponent(model));
  }
  return `${conn.baseUrl}/chat/completions`;
}

function parseOpenAiResponse(raw: unknown): { text: string; toolCalls: ToolCall[]; inputTokens?: number; outputTokens?: number } {
  const record = asRecord(raw);
  const usage = asRecord(record?.usage);
  const choice = asRecord(Array.isArray(record?.choices) ? record.choices[0] : undefined);
  const message = asRecord(choice?.message);
  const text = asString(message?.content) ?? asString(record?.text) ?? '';
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return {
    text,
    toolCalls: calls.map((value) => {
      const call = asRecord(value);
      const fn = asRecord(call?.function);
      const rawArgs = asString(fn?.arguments) ?? '{}';
      return { id: asString(call?.id) ?? crypto.randomUUID(), name: asString(fn?.name) ?? 'unknown', raw: rawArgs, arguments: parseArgs(rawArgs) };
    }),
    inputTokens: asNumber(usage?.prompt_tokens),
    outputTokens: asNumber(usage?.completion_tokens),
  };
}

function makeResult(conn: ResolvedConnection, req: ChatRequest, text: string, toolCalls: ToolCall[], started: number, firstTokenMs: number | null, inputTokens?: number, outputTokens?: number): ChatResult {
  const usage = inputTokens !== undefined || outputTokens !== undefined
    ? { inputTokens, outputTokens, estimated: false }
    : estimatedUsage(textFromMessages(req.messages), text);
  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: toolCalls.length ? 'tool' : 'stop',
    usage,
    timing: { firstTokenMs, totalMs: Date.now() - started },
    model: req.model,
    source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
  };
}

function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) as unknown : {};
  } catch {
    return {};
  }
}
