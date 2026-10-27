import { AIError, classify } from '../../errors.js';
import { estimatedUsage } from '../../tokens.js';
import { fetchJson, postResponse, sseLines } from '../../transport.js';
import type { ChatMessage, ChatRequest, ChatResult, ModelInfo, ProviderAdapter, ResolvedConnection, StreamEvent, ToolCall } from '../../types.js';
import { applyProviderOptions, REASONING_BUDGET_TOKENS, asNumber, asRecord, asString, joinUrl, textFromMessages } from '../../util.js';
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
    const nativeJson = modernModel(req.model);
    const jsonMode = req.responseFormat?.type === 'json' && !nativeJson && !req.tools?.length;
    let firstTokenMs: number | null = null;
    let text = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    let sawTerminal = false;
    const emittedTools: ToolCall[] = [];
    const responseBlocks = new Map<number, Record<string, unknown>>();
    // Partial tool_use blocks keyed by content-block index (input_json_delta accumulation).
    const blocks = new Map<number, { id: string; name: string; raw: string }>();
    const timeout = streamTimeout(conn, req.signal);
    yield { type: 'start', callId: '', provider: conn.provider, model: req.model };
    // Anthropic JSON mode is implemented as a forced `json_output` tool, which
    // cannot coexist with the caller's own tools — same silent-downgrade shape
    // as Gemini, so it gets the same signal rather than quietly dropping.
    if (req.responseFormat?.type === 'json' && !nativeJson && req.tools?.length) {
      yield {
        type: 'context',
        kind: 'json_mode_downgraded',
        data: { reason: 'Anthropic JSON mode uses a forced tool and cannot be combined with caller tools; the request was sent without JSON mode', provider: conn.provider },
      };
    }
    if (req.responseFormat?.type === 'json' && nativeJson && !req.responseFormat.schema) {
      yield { type: 'context', kind: 'json_mode_downgraded', data: { provider: conn.provider, reason: 'Claude native JSON outputs require a schema; using a JSON instruction without constrained decoding.' } };
    }
    try {
      const res = await postResponse(`${conn.baseUrl}/v1/messages`, body(req, jsonMode), conn.headers, timeout.signal, conn.provider, conn.fetch);
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        const data = await res.json() as unknown;
        const parsed = parseResponse(data);
        const content = asRecord(data)?.content;
        if (Array.isArray(content)) content.forEach((block, i) => {
          const record = asRecord(block);
          if (record) responseBlocks.set(i, record);
        });
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
          if (type === 'error') {
            const error = asRecord(record.error);
            const statuses: Record<string, number> = { overloaded_error: 529, rate_limit_error: 429, authentication_error: 401, permission_error: 403, invalid_request_error: 400, not_found_error: 404, api_error: 500, billing_error: 402, timeout_error: 504, request_too_large: 413 };
            throw classify(statuses[asString(error?.type) ?? ''] ?? 500, JSON.stringify(record), conn.provider);
          } else if (type === 'message_start') {
            const usage = asRecord(asRecord(record.message)?.usage);
            inputTokens = asNumber(usage?.input_tokens) ?? inputTokens;
            outputTokens = asNumber(usage?.output_tokens) ?? outputTokens;
          } else if (type === 'content_block_start') {
            const index = asNumber(record.index) ?? 0;
            const block = asRecord(record.content_block);
            if (block) responseBlocks.set(index, { ...block });
            if (block?.type === 'tool_use') {
              blocks.set(index, { id: asString(block.id) ?? randomId(), name: asString(block.name) ?? 'unknown', raw: '' });
            }
          } else if (type === 'content_block_delta') {
            const index = asNumber(record.index) ?? 0;
            const delta = asRecord(record.delta);
            const block = responseBlocks.get(index);
            if (block && delta) {
              const field = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : delta.type === 'signature_delta' ? 'signature' : undefined;
              if (field) block[field] = String(block[field] ?? '') + String(delta[field] ?? '');
              if (delta.type === 'citations_delta') block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
            }
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
              const block = responseBlocks.get(index);
              if (block) block.input = call.arguments;
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
        providerState: { provider: conn.provider, model: req.model, content: [...responseBlocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block) },
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
      fetch: conn.fetch,
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
    messages: toAnthropicMessages(req.messages.filter((m) => m.role !== 'system'), req.model),
    stream: true,
  };
  if (req.responseFormat?.type === 'json' && modernModel(req.model) && req.responseFormat.schema) {
    base.output_config = { format: { type: 'json_schema', schema: schemaFor(req) } };
  }
  if (req.responseFormat?.type === 'json' && modernModel(req.model) && !req.responseFormat.schema) {
    base.system = [system, 'Return only valid JSON, without markdown fences or a preamble.'].filter(Boolean).join('\n\n');
  }
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
  if (req.reasoningEffort !== undefined) {
    // First-class reasoning effort → extended thinking. Anthropic requires
    // `budget_tokens < max_tokens` and rejects temperature/top_p alongside
    // thinking, so the budget is fitted under max_tokens (raising max_tokens
    // when the caller's value leaves no room) and the samplers are dropped.
    if (modernModel(req.model)) {
      const none = req.reasoningEffort === 'none';
      if (none && alwaysThinking(req.model)) throw new AIError('This Claude model cannot disable thinking; choose a reasoning effort instead.', { kind: 'invalid_request', provider: 'anthropic' });
      base.thinking = { type: none ? (/^claude-sonnet-5-5(?:-|$)/.test(req.model) ? 'between_tools' : 'disabled') : 'adaptive' };
      base.output_config = { ...asRecord(base.output_config), effort: none ? 'low' : req.reasoningEffort === 'minimal' ? 'low' : req.reasoningEffort };
    } else if (req.reasoningEffort === 'none') {
      base.thinking = { type: 'disabled' };
    } else {
      const budget = REASONING_BUDGET_TOKENS[req.reasoningEffort];
      const maxTokens = typeof base.max_tokens === 'number' ? base.max_tokens : 4096;
      if (maxTokens <= budget) base.max_tokens = budget + 1024;
      base.thinking = { type: 'enabled', budget_tokens: budget };
      delete base.temperature;
      delete base.top_p;
    }
  }
  // providerOptions carries Anthropic-native fields (`thinking`, `metadata`,
  // top-level `cache_control` extras, `service_tier`, …) without a release.
  const result = applyProviderOptions(base, req.providerOptions, ['output_config']);
  if (modernModel(req.model)) {
    delete result.temperature;
    delete result.top_p;
    delete result.top_k;
  }
  const choice = asRecord(result.tool_choice);
  if (noForcedTools(req.model) && (choice?.type === 'tool' || choice?.type === 'any')) {
    throw new AIError('This Claude model does not support forced tool choice; use auto or structured outputs.', { kind: 'invalid_request', provider: 'anthropic' });
  }
  return result;
}

function toAnthropicMessages(messages: ChatMessage[], model: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== 'tool') {
      out.push(toAnthropicMessage(message, model));
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

function toAnthropicMessage(m: ChatMessage, model: string): Record<string, unknown> {
  if (m.role === 'assistant' && m.providerState?.provider === 'anthropic' && m.providerState.model === model) {
    return { role: 'assistant', content: m.providerState.content };
  }
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
  if (stop === 'refusal') return 'content_filter';
  if (stop === 'max_tokens') return 'length';
  return 'stop';
}


/** Models released after Opus 4.6 use adaptive effort and reject sampling knobs.
 * Unknown/custom IDs retain legacy behavior rather than guessing capabilities. */
function modernModel(model: string): boolean {
  return /^claude-(?:opus-(?:4-[78]|5(?:-5)?)|sonnet-5(?:-5)?|haiku-5-5|(?:fable|mythos)-5(?:-1)?|mythos-preview)(?:-\d{8}|-latest)?$/.test(model);
}
function alwaysThinking(model: string): boolean {
  return /^claude-(?:fable-|mythos-|opus-5-5(?:-|$))/.test(model);
}
function noForcedTools(model: string): boolean {
  return /^claude-(?:(?:opus|sonnet)-5-5(?:-|$)|(?:fable|mythos)-5-1(?:-|$))/.test(model);
}
