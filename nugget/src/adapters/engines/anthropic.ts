import { AIError } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { fetchJson, postResponse, sseLines } from '../../transport.js';
import type { ChatMessage, ChatRequest, ChatResult, ModelInfo, ProviderAdapter, ResolvedConnection, StreamEvent, ToolCall } from '../../types.js';
import { applyProviderOptions, asNumber, asRecord, asString, joinUrl, textFromMessages } from '../../util.js';
import { DEFAULT_TIMEOUT_MS, parseArgs, randomId, safeParse, streamAnomaly, streamError, streamTimeout } from './base.js';

const JSON_MODE_TOOL = 'json_output';

export class AnthropicAdapter implements ProviderAdapter {
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
    if (!result) throw new AIError('Anthropic stream ended without a result', { kind: 'invalid_response', provider: conn.provider });
    return result;
  }

  async *stream(conn: ResolvedConnection, req: ChatRequest): AsyncIterable<StreamEvent> {
    const started = Date.now();
    const jsonMode = req.responseFormat?.type === 'json' && !req.tools?.length;
    let firstTokenMs: number | null = null;
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    let sawTerminal = false;
    const emittedTools: ToolCall[] = [];
    // Partial tool_use blocks keyed by content-block index (input_json_delta accumulation).
    const blocks = new Map<number, { id: string; name: string; raw: string }>();
    const timeout = streamTimeout(conn, req.signal);
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    // Anthropic JSON mode is implemented as a forced `json_output` tool, which
    // cannot coexist with the caller's own tools — same silent-downgrade shape
    // as Gemini, so it gets the same signal rather than quietly dropping.
    if (req.responseFormat?.type === 'json' && req.tools?.length) {
      yield {
        type: 'context',
        kind: 'json_mode_downgraded',
        data: { reason: 'Anthropic JSON mode uses a forced tool and cannot be combined with caller tools; the request was sent without JSON mode', provider: conn.provider },
      };
    }
    try {
      const res = await postResponse(`${conn.baseUrl}/v1/messages`, body(req, jsonMode), conn.headers, timeout.signal, conn.provider);
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        const data = await res.json() as unknown;
        const parsed = parseResponse(data);
        inputTokens = parsed.inputTokens;
        outputTokens = parsed.outputTokens;
        stopReason = parsed.stopReason;
        sawTerminal = true;
        if (jsonMode) {
          text = jsonTextFrom(parsed.toolCalls, parsed.text);
          if (text) yield { type: 'delta', text };
        } else {
          text = parsed.text;
          if (text) yield { type: 'delta', text };
          for (const call of parsed.toolCalls) {
            emittedTools.push(call);
            yield { type: 'tool_call', call };
          }
        }
      } else {
        for await (const line of sseLines(res)) {
          timeout.bump();
          const record = asRecord(safeParse(line));
          if (!record) continue;
          const type = asString(record.type);
          if (type === 'message_start') {
            const usage = asRecord(asRecord(record.message)?.usage);
            inputTokens = asNumber(usage?.input_tokens) ?? inputTokens;
            outputTokens = asNumber(usage?.output_tokens) ?? outputTokens;
          } else if (type === 'content_block_start') {
            const index = asNumber(record.index) ?? 0;
            const block = asRecord(record.content_block);
            if (block?.type === 'tool_use') {
              blocks.set(index, { id: asString(block.id) ?? randomId(), name: asString(block.name) ?? 'unknown', raw: '' });
            }
          } else if (type === 'content_block_delta') {
            const index = asNumber(record.index) ?? 0;
            const delta = asRecord(record.delta);
            if (delta?.type === 'text_delta') {
              const piece = asString(delta.text) ?? '';
              if (piece) {
                if (firstTokenMs === null) firstTokenMs = Date.now() - started;
                text += piece;
                yield { type: 'delta', text: piece };
              }
            } else if (delta?.type === 'thinking_delta') {
              // Extended-thinking tokens ride the reasoning channel, kept out of `text`.
              const piece = asString(delta.thinking) ?? '';
              if (piece) yield { type: 'reasoning', text: piece };
            } else if (delta?.type === 'input_json_delta') {
              const partial = blocks.get(index);
              if (partial) partial.raw += asString(delta.partial_json) ?? '';
            }
          } else if (type === 'content_block_stop') {
            const index = asNumber(record.index) ?? 0;
            const partial = blocks.get(index);
            if (partial) {
              const call: ToolCall = { id: partial.id, name: partial.name, raw: partial.raw, arguments: parseArgs(partial.raw) };
              blocks.delete(index);
              if (jsonMode && call.name === JSON_MODE_TOOL) {
                text = jsonTextFrom([call], text);
                if (firstTokenMs === null) firstTokenMs = Date.now() - started;
                yield { type: 'delta', text };
              } else {
                emittedTools.push(call);
                yield { type: 'tool_call', call };
              }
            }
          } else if (type === 'message_stop') {
            sawTerminal = true;
          } else if (type === 'message_delta') {
            const delta = asRecord(record.delta);
            if (asString(delta?.stop_reason)) sawTerminal = true;
            stopReason = asString(delta?.stop_reason) ?? stopReason;
            const usage = asRecord(record.usage);
            outputTokens = asNumber(usage?.output_tokens) ?? outputTokens;
          }
        }
      }
      if (!sawTerminal) yield streamAnomaly('stream ended without a stop_reason or message_stop');
      const hasTools = emittedTools.length > 0;
      yield { type: 'done', result: {
        text,
        toolCalls: hasTools ? emittedTools : undefined,
        finishReason: mapStop(stopReason, hasTools),
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
   * Lists models from Anthropic's `/v1/models` endpoint (auth + version headers
   * already applied to `conn.headers`). The endpoint does not report a context
   * window, so `contextWindow` is left undefined rather than guessed.
   */
  async listModels(conn: ResolvedConnection): Promise<ModelInfo[]> {
    const { data } = await fetchJson(joinUrl(conn.baseUrl, '/v1/models'), {
      method: 'GET',
      headers: conn.headers,
      timeoutMs: Math.min(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000),
      provider: conn.provider,
    });
    const rows = Array.isArray(asRecord(data)?.data) ? asRecord(data)!.data as unknown[] : [];
    return rows
      .map((row) => asString(asRecord(row)?.id))
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl } }));
  }
}

function body(req: ChatRequest, jsonMode: boolean): Record<string, unknown> {
  const system = req.messages.filter((m) => m.role === 'system').map((m) => textContent(m.content)).join('\n\n') || undefined;
  const base: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature,
    top_p: req.topP,
    stop_sequences: req.stopSequences,
    system,
    messages: toAnthropicMessages(req.messages.filter((m) => m.role !== 'system')),
    stream: true,
  };
  if (jsonMode) {
    // Forced-tool JSON mode: Anthropic has no response_format, so we make the
    // model answer through a single required tool whose input is the JSON we want.
    base.tools = [{ name: JSON_MODE_TOOL, description: 'Return the answer as a JSON object.', input_schema: schemaFor(req) }];
    base.tool_choice = { type: 'tool', name: JSON_MODE_TOOL };
  } else if (req.tools?.length) {
    base.tools = req.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    if (typeof req.toolChoice === 'object') base.tool_choice = { type: 'tool', name: req.toolChoice.name };
    else if (req.toolChoice === 'auto') base.tool_choice = { type: 'auto' };
    else if (req.toolChoice === 'none') base.tool_choice = { type: 'none' };
  }
  // providerOptions carries Anthropic-native fields (`thinking`, `metadata`,
  // top-level `cache_control` extras, `service_tier`, …) without a release.
  return applyProviderOptions(base, req.providerOptions);
}

function toAnthropicMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool') {
      out.push(toAnthropicMessage(message));
      continue;
    }
    const content: unknown[] = [];
    while (index < messages.length && messages[index]?.role === 'tool') {
      const toolMessage = messages[index]!;
      content.push({ type: 'tool_result', tool_use_id: toolMessage.toolCallId ?? '', content: textContent(toolMessage.content) });
      index += 1;
    }
    index -= 1;
    out.push({ role: 'user', content });
  }
  return out;
}

function toAnthropicMessage(m: ChatMessage): Record<string, unknown> {
  // Tool-role messages are handled by toAnthropicMessages' batching loop and
  // never reach here, so no tool branch is needed.

  // assistant turns that carried tool calls replay them as tool_use blocks,
  // preserving any text/image content parts that accompanied the calls.
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const content: unknown[] = [...contentBlocks(m.content)];
    for (const call of m.toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
    return { role: 'assistant', content };
  }
  return {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : contentBlocks(m.content),
  };
}

/** Maps text/image content — a string or a ContentPart[] — onto Anthropic content blocks. */
function contentBlocks(content: ChatMessage['content']): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.map((part) => part.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: part.mimeType ?? 'image/png', data: part.imageBase64 ?? '' } }
    : { type: 'text', text: part.text ?? '' });
}

function textContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

function parseResponse(data: unknown): { text: string; inputTokens?: number; outputTokens?: number; stopReason?: string; toolCalls: ToolCall[] } {
  const record = asRecord(data);
  const content = Array.isArray(record?.content) ? record.content : [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const blockValue of content) {
    const block = asRecord(blockValue);
    if (block?.type === 'text') text += asString(block.text) ?? '';
    if (block?.type === 'tool_use') {
      toolCalls.push({
        id: asString(block.id) ?? randomId(),
        name: asString(block.name) ?? 'unknown',
        arguments: block.input ?? {},
        raw: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const usage = asRecord(record?.usage);
  return { text, inputTokens: asNumber(usage?.input_tokens), outputTokens: asNumber(usage?.output_tokens), stopReason: asString(record?.stop_reason), toolCalls };
}

function schemaFor(req: ChatRequest): object {
  const schema = req.responseFormat?.type === 'json' ? req.responseFormat.schema : undefined;
  return schema ?? { type: 'object' };
}

function jsonTextFrom(toolCalls: ToolCall[], fallback: string): string {
  const json = toolCalls.find((call) => call.name === JSON_MODE_TOOL) ?? toolCalls[0];
  if (json) return json.raw && json.raw.trim() ? json.raw : JSON.stringify(json.arguments ?? {});
  return fallback;
}

function mapStop(stop: string | undefined, hasTools: boolean): ChatResult['finishReason'] {
  if (stop === 'tool_use' && hasTools) return 'tool';
  if (stop === 'max_tokens') return 'length';
  return 'stop';
}

