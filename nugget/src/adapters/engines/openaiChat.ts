import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { postResponse, sseLines } from '../../transport.js';
import type { ChatMessage, ChatRequest, ChatResult, ProviderAdapter, ResolvedConnection, StreamEvent, ToolCall } from '../../types.js';
import { asNumber, asRecord, asString, textFromMessages } from '../../util.js';
import type { ProviderProfile } from '../profiles.js';
import { health, listOpenModels, streamError, streamTimeout } from './base.js';

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
    let finish: string | undefined;
    let sawTerminal = false;
    const timeout = streamTimeout(conn, req.signal);
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    try {
      const res = await postResponse(urlFor(conn, this.profile, req.model), openAiBody(req, this.profile), conn.headers, timeout.signal, conn.provider);
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
        if (text) yield { type: 'delta', text };
        for (const call of toolCalls) yield { type: 'tool_call', call };
      } else {
        const partialTools = new Map<number, { id?: string; name?: string; raw: string }>();
        for await (const line of sseLines(res)) {
          const chunk = safeParse(line);
          const record = asRecord(chunk);
          if (!record) continue;
          const usage = asRecord(record.usage);
          inputTokens = asNumber(usage?.prompt_tokens) ?? inputTokens;
          outputTokens = asNumber(usage?.completion_tokens) ?? outputTokens;
          const choices = Array.isArray(record.choices) ? record.choices : [];
          const choice = asRecord(choices[0]);
          finish = asString(choice?.finish_reason) ?? finish;
          if (choice?.finish_reason) sawTerminal = true;
          const delta = asRecord(choice?.delta);
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
        toolCalls = [...partialTools.values()].filter((call) => call.name).map((call) => ({
          id: call.id ?? randomId(),
          name: call.name!,
          raw: call.raw,
          arguments: parseArgs(call.raw),
        }));
        for (const call of toolCalls) yield { type: 'tool_call', call };
      }
      if (!sawTerminal) {
        yield { type: 'context', kind: 'stream_anomaly', data: { reason: 'stream ended without a finish_reason' } };
      }
      const result = makeResult(conn, req, text, toolCalls, finish, started, firstTokenMs, inputTokens, outputTokens);
      yield { type: 'done', result };
    } catch (error) {
      throw streamError(error, timeout, conn.provider);
    } finally {
      timeout.done();
    }
  }

  listModels(conn: ResolvedConnection) {
    return listOpenModels(conn, this.profile);
  }

  health(conn: ResolvedConnection) {
    return health(conn, this.profile);
  }
}

function openAiBody(req: ChatRequest, profile: ProviderProfile): Record<string, unknown> {
  const body: Record<string, unknown> = {
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
  if (req.maxTokens !== undefined) body[profile.quirks?.maxTokensParam ?? 'max_tokens'] = req.maxTokens;
  return body;
}

function responseFormatFor(req: ChatRequest, profile: ProviderProfile): Record<string, unknown> | undefined {
  if (req.responseFormat?.type !== 'json') return undefined;
  if (req.responseFormat.schema && profile.quirks?.supportsJsonSchema) {
    return { type: 'json_schema', json_schema: { name: 'response', schema: req.responseFormat.schema } };
  }
  return { type: 'json_object' };
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
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

function urlFor(conn: ResolvedConnection, profile: ProviderProfile, model: string): string {
  if (profile.quirks?.urlTemplate) {
    return profile.quirks.urlTemplate.replace('{baseUrl}', conn.baseUrl).replace('{model}', encodeURIComponent(model));
  }
  return `${conn.baseUrl}/chat/completions`;
}

function parseOpenAiResponse(raw: unknown): { text: string; toolCalls: ToolCall[]; inputTokens?: number; outputTokens?: number; finish?: string } {
  const record = asRecord(raw);
  const usage = asRecord(record?.usage);
  const choice = asRecord(Array.isArray(record?.choices) ? record.choices[0] : undefined);
  const message = asRecord(choice?.message);
  const text = asString(message?.content) ?? asString(record?.text) ?? '';
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return {
    text,
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

function makeResult(conn: ResolvedConnection, req: ChatRequest, text: string, toolCalls: ToolCall[], finish: string | undefined, started: number, firstTokenMs: number | null, inputTokens?: number, outputTokens?: number): ChatResult {
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

function mapFinish(finish: string | undefined, hasToolCalls: boolean): ChatResult['finishReason'] {
  if (hasToolCalls || finish === 'tool_calls' || finish === 'function_call') return 'tool';
  if (finish === 'length') return 'length';
  if (finish === 'content_filter') return 'content_filter';
  return 'stop';
}

function parseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) as unknown : {};
  } catch {
    return {};
  }
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
