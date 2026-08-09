import { profileFor } from '../adapters/profiles.js';
import { AIError } from '../errors.js';
import { extractJson } from '../json.js';
import { mergeUsage } from '../tokens.js';
import type { AIHandler } from '../handler.js';
import type { AIErrorKind, ChatMessage, Connection, StreamEvent, ToolCall, Usage } from '../types.js';
import { asRecord, sleep } from '../util.js';
import type { ToolSpec } from './tools.js';
import { validateToolArgs } from './tools.js';

export interface AgentOptions {
  handler: AIHandler;
  connection: Connection;
  model: string;
  tools: ToolSpec[];
  messages: ChatMessage[];
  /**
   * `native` sends `tools` on the request; `promptJson` describes tools in a
   * system message and parses a JSON directive back out of plain text.
   * `auto` (the default) picks per-call from the connection's provider
   * capability profile (`profileFor(provider).capabilities.nativeTools`) —
   * hosted providers with reliable tool-calling get `native`, local runtimes
   * (Ollama, llama.cpp, LM Studio, vLLM) and the `openai-compat` escape hatch
   * default to `promptJson` since native tool support there is model-
   * dependent, not protocol-guaranteed.
   */
  toolMode?: 'native' | 'promptJson' | 'auto';
  /**
   * Discovered capabilities of the specific model (e.g. Ollama `/api/show`
   * `["tools"]`). When `toolMode` is `auto`, a `tools` capability here upgrades a
   * local model to `native` tool-calling instead of the profile's conservative
   * `promptJson` default — so a capable local model isn't forced onto the fallback.
   */
  modelCapabilities?: string[];
  /** Sampler/decoding options forwarded to every model turn (parity with a plain chat call). */
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
  /** Provider-native passthrough forwarded to every turn — see {@link ChatRequest.providerOptions}. */
  providerOptions?: Record<string, unknown>;
  budget?: {
    maxSteps?: number;
    maxTokens?: number;
    deadlineMs?: number;
  };
  approval?: ApprovalGate;
  /**
   * Which tools require the approval gate. `sideEffectsOnly` (default) gates only
   * tools declared `sideEffects: true`; `all` gates every tool — so `tool_denied`
   * is reachable without marking each tool, and a consumer can require approval
   * for a whole run in one place.
   */
  approvalMode?: 'sideEffectsOnly' | 'all';
  /**
   * Bounds and framing applied to each tool result before it re-enters the
   * model's context. `maxChars` truncates oversized results (with a notice) so a
   * single large return can't blow the next turn's window; `wrapUntrusted` fences
   * the result in an `<untrusted_tool_output>` envelope. Both are opt-in.
   */
  toolResult?: { maxChars?: number; wrapUntrusted?: boolean };
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export type ApprovalGate = (req: {
  call: ToolCall;
  tool: ToolSpec;
  step: number;
}) => Promise<'allow' | 'deny' | { modifiedArguments: unknown }>;

export type AgentEvent =
  | StreamEvent
  | { type: 'step_start'; step: number }
  // Discloses which tool-calling protocol this run resolved to, so a
  // `promptJson` fallback is visible rather than silent.
  | { type: 'tool_mode'; mode: 'native' | 'promptJson' }
  | { type: 'tool_start'; step: number; call: ToolCall }
  | { type: 'tool_result'; step: number; call: ToolCall; result: unknown; isError: boolean }
  | { type: 'tool_denied'; step: number; call: ToolCall; reason: string }
  | { type: 'agent_done'; result: AgentResult };

export interface AgentResult {
  finalText: string;
  messages: ChatMessage[];
  usage: Usage;
  steps: number;
  stopReason: 'finished' | 'max_steps' | 'budget' | 'deadline' | 'canceled' | 'error';
  /**
   * Populated when `stopReason` is `error`: the failure that ended the run, so
   * the caller can see what went wrong without replaying the event stream.
   */
  error?: { kind: AIErrorKind; message: string };
}

export function runAgent(opts: AgentOptions): AsyncIterable<AgentEvent> & { result: Promise<AgentResult> } {
  let resolveResult!: (result: AgentResult) => void;
  const result = new Promise<AgentResult>((resolve) => {
    resolveResult = resolve;
  });
  const iterable = run(opts, resolveResult);
  return Object.assign(iterable, { result });
}

async function* run(opts: AgentOptions, resolveResult: (result: AgentResult) => void): AsyncIterable<AgentEvent> {
  const messages = [...opts.messages];
  const toolMode = resolveToolMode(opts);
  const maxSteps = opts.budget?.maxSteps ?? 8;
  const agentSignal = createAgentSignal(opts.signal, opts.budget?.deadlineMs);
  let usage: Usage | undefined;
  let finalText = '';
  let step = 0;
  let settled = false;

  // Disclose the resolved tool protocol once up front (a silent promptJson
  // fallback was the friction behind FR‑2).
  yield emit(opts, { type: 'tool_mode', mode: toolMode });

  try {
    while (step < maxSteps) {
      step += 1;
      if (agentSignal.signal?.aborted) return yield* yieldDone(agentSignal.timedOut() ? 'deadline' : 'canceled');
      yield emit(opts, { type: 'step_start', step });

      const calls: ToolCall[] = [];
      let stepText = '';
      let streamFailure: AIError | undefined;
      // In promptJson mode a tool directive must not leak into the visible
      // stream, so directive-looking text is withheld from `delta` events (still
      // accumulated in `stepText` for parsing). Prose streams normally.
      const filter = toolMode === 'promptJson' ? new PromptJsonDeltaFilter() : undefined;
      const requestMessages = toolMode === 'promptJson' ? withPromptJsonInstruction(messages, opts.tools) : messages;
      for await (const event of opts.handler.stream(opts.connection, {
        model: opts.model,
        messages: requestMessages,
        tools: toolMode === 'promptJson' ? undefined : opts.tools,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        topP: opts.topP,
        stopSequences: opts.stopSequences,
        providerOptions: opts.providerOptions,
        signal: agentSignal.signal,
        metadata: { ...opts.metadata, agentStep: step },
      })) {
        if (event.type === 'delta') {
          stepText += event.text;
          if (filter) {
            const visible = filter.push(event.text);
            if (visible) yield emit(opts, { type: 'delta', text: visible });
            continue;
          }
        }
        if (event.type === 'tool_call') calls.push(event.call);
        if (event.type === 'error') streamFailure = event.error;
        if (event.type === 'done') {
          usage = usage ? mergeUsage(usage, event.result.usage) : event.result.usage;
          if (toolMode === 'promptJson' && calls.length === 0) calls.push(...callsFromPromptJson(stepText));
        }
        yield emit(opts, event);
      }
      // If withheld text turned out not to be a real directive, flush it so the
      // user still sees the model's answer.
      if (filter && calls.length === 0) {
        const flushed = filter.flush();
        if (flushed) yield emit(opts, { type: 'delta', text: flushed });
      }

      // A handler-level failure (auth, policy, cancel, exhausted retries) must
      // stop the loop honestly rather than looking like an empty completion.
      if (streamFailure) return yield* yieldDone(agentSignal.timedOut() ? 'deadline' : streamFailure.kind === 'canceled' ? 'canceled' : 'error', errorInfo(streamFailure));

      finalText = stepText;
      messages.push(toolMode === 'promptJson'
        ? { role: 'assistant', content: stepText }
        : { role: 'assistant', content: stepText, toolCalls: calls.length ? calls : undefined });
      if (calls.length === 0) return yield* yieldDone('finished');

      for (const call of calls) {
        if (agentSignal.signal?.aborted) return yield* yieldDone(agentSignal.timedOut() ? 'deadline' : 'canceled');
        const tool = opts.tools.find((candidate) => candidate.name === call.name);
        if (!tool) {
          yield* appendToolError(opts, messages, step, call, `Unknown tool: ${call.name}`);
          continue;
        }
        const validation = validateToolArgs(tool, call);
        if (!validation.ok) {
          yield* appendToolError(opts, messages, step, call, validation.message);
          continue;
        }
        let args = validation.args;
        const requiresApproval = tool.sideEffects || opts.approvalMode === 'all';
        if (requiresApproval) {
          if (!opts.approval) {
            yield* appendToolDenied(opts, messages, step, call, 'No approval gate configured');
            continue;
          }
          const approval = await opts.approval({ call, tool, step });
          if (agentSignal.signal?.aborted) return yield* yieldDone(agentSignal.timedOut() ? 'deadline' : 'canceled');
          if (approval === 'deny') {
            yield* appendToolDenied(opts, messages, step, call, 'Denied by approval gate');
            continue;
          }
          if (approval !== 'allow') {
            const modified = validateToolArgs(tool, { ...call, arguments: approval.modifiedArguments });
            if (!modified.ok) {
              yield* appendToolError(opts, messages, step, call, modified.message);
              continue;
            }
            args = modified.args;
          }
        }
        yield emit(opts, { type: 'tool_start', step, call });
        let executed: { ok: true; result: unknown } | { ok: false; message: string };
        try {
          const result = await tool.execute(args, {
            signal: agentSignal.signal ?? new AbortController().signal,
            callId: call.id,
            step,
            metadata: opts.metadata,
          });
          executed = { ok: true, result };
        } catch (error) {
          executed = { ok: false, message: error instanceof Error ? error.message : 'Tool failed' };
        }
        if (!executed.ok) {
          yield* appendToolError(opts, messages, step, call, executed.message);
          continue;
        }
        try {
          // Guard against a tool returning `undefined` (JSON.stringify(undefined)
          // is the value `undefined`, not a string) — an unguarded value here
          // used to crash the next step's message mapper and kill the whole run.
          const serialized = JSON.stringify(executed.result) ?? 'null';
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: formatToolResult(serialized, opts.toolResult) });
          // A tool that returns a structured `{ ok: false, ... }` is a recoverable
          // error the model should react to — surface it as an error result.
          const record = asRecord(executed.result);
          const isError = record?.ok === false;
          yield emit(opts, { type: 'tool_result', step, call, result: executed.result, isError });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Tool result was not serializable';
          yield* appendToolError(opts, messages, step, call, message);
        }
      }

      const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      if (opts.budget?.maxTokens && totalTokens > opts.budget.maxTokens) return yield* yieldDone('budget');
      await sleep(0, agentSignal.signal);
    }
    return yield* yieldDone('max_steps');
  } catch (error) {
    const stopReason = agentSignal.timedOut() ? 'deadline' : (agentSignal.signal?.aborted || (error instanceof AIError && error.kind === 'canceled')) ? 'canceled' : 'error';
    const result = makeResult(finalText, messages, usage ?? { estimated: true }, step, stopReason, stopReason === 'error' ? errorInfo(error) : undefined);
    settled = true;
    resolveResult(result);
    yield emit(opts, { type: 'agent_done', result });
  } finally {
    agentSignal.dispose();
    if (!settled) {
      const result = makeResult(finalText, messages, usage ?? { estimated: true }, step, 'canceled');
      resolveResult(result);
    }
  }

  function* yieldDone(stopReason: AgentResult['stopReason'], error?: AgentResult['error']): Generator<AgentEvent> {
    const result = makeResult(finalText, messages, usage ?? { estimated: true }, step, stopReason, error);
    settled = true;
    resolveResult(result);
    yield emit(opts, { type: 'agent_done', result });
  }
}

function emit<T extends AgentEvent>(opts: AgentOptions, event: T): T {
  opts.onEvent?.(event);
  return event;
}

function makeResult(finalText: string, messages: ChatMessage[], usage: Usage, steps: number, stopReason: AgentResult['stopReason'], error?: AgentResult['error']): AgentResult {
  return error ? { finalText, messages, usage, steps, stopReason, error } : { finalText, messages, usage, steps, stopReason };
}

function errorInfo(error: unknown): { kind: AIErrorKind; message: string } {
  if (error instanceof AIError) return { kind: error.kind, message: error.message };
  return { kind: 'tool_error', message: error instanceof Error ? error.message : 'Agent run failed' };
}

/**
 * Applies the optional size cap and untrusted-content framing to a serialized
 * tool result before it re-enters the model's context.
 */
function formatToolResult(serialized: string, opts: AgentOptions['toolResult']): string {
  let out = serialized;
  const max = opts?.maxChars;
  if (max !== undefined && out.length > max) {
    out = `${out.slice(0, max)}\n…[truncated ${out.length - max} chars]`;
  }
  if (opts?.wrapUntrusted) {
    out = `<untrusted_tool_output>\n${out}\n</untrusted_tool_output>`;
  }
  return out;
}

/**
 * Withholds a promptJson tool directive from the visible `delta` stream. Once
 * the leading non-whitespace character is known: a `{`, `[`, or fence marks a
 * directive candidate whose text is buffered (never streamed); anything else is
 * prose that streams through untouched. `flush()` returns any buffered text when
 * the stream ended without yielding a parsed directive.
 */
class PromptJsonDeltaFilter {
  private decided = false;
  private withhold = false;
  private buffer = '';

  push(text: string): string {
    if (!this.decided) {
      this.buffer += text;
      const lead = this.buffer.replace(/^\s+/, '');
      if (lead.length === 0) return '';
      this.decided = true;
      this.withhold = /^[[{`]/.test(lead);
      if (this.withhold) return '';
      const flushed = this.buffer;
      this.buffer = '';
      return flushed;
    }
    if (this.withhold) {
      this.buffer += text;
      return '';
    }
    return text;
  }

  flush(): string {
    if (!this.withhold) return '';
    const out = this.buffer;
    this.buffer = '';
    return out;
  }
}

function* appendToolError(opts: AgentOptions, messages: ChatMessage[], step: number, call: ToolCall, message: string): Generator<AgentEvent> {
  const result = { error: message };
  messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
  yield emit(opts, { type: 'tool_result', step, call, result, isError: true });
}

function* appendToolDenied(opts: AgentOptions, messages: ChatMessage[], step: number, call: ToolCall, reason: string): Generator<AgentEvent> {
  messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ denied: true, reason }) });
  yield emit(opts, { type: 'tool_denied', step, call, reason });
}

function resolveToolMode(opts: AgentOptions): 'native' | 'promptJson' {
  const mode = opts.toolMode ?? 'auto';
  if (mode !== 'auto') return mode;
  // A model that actually advertises tool support gets native tool-calling even
  // on a local runtime whose profile is conservatively `nativeTools: false`.
  if (opts.modelCapabilities?.includes('tools')) return 'native';
  return profileFor(opts.connection.provider, opts.connection.baseUrl).capabilities.nativeTools ? 'native' : 'promptJson';
}

function withPromptJsonInstruction(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  // Include each tool's parameter schema, not just its description, so the model
  // knows the argument shape instead of guessing it (FR‑3).
  const catalog = tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`)
    .join('\n');
  return [
    {
      role: 'system',
      content: `When you need tools, respond only with JSON. For one tool: {"tool":"name","input":{...}}. For several in one turn: {"tools":[{"tool":"name","input":{...}}]}. The "input" object must match the tool's parameters schema. Available tools:\n${catalog}`,
    },
    ...messages.map(toPromptJsonMessage),
  ];
}

function toPromptJsonMessage(message: ChatMessage): ChatMessage {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: `Tool ${message.name ?? message.toolCallId ?? 'unknown'} returned: ${textContent(message.content)}`,
    };
  }
  return {
    role: message.role,
    content: textContent(message.content),
  };
}

/**
 * Parses a promptJson tool directive into zero or more calls. Accepts the single
 * form ({"tool","input"}), the batched form ({"tools":[...]}), and a bare array
 * of directives, so a promptJson-mode model can request several tools per turn
 * just like native tool-calling can. Malformed entries are skipped, not thrown.
 */
function callsFromPromptJson(text: string): ToolCall[] {
  const value = extractJson(text);
  if (!value || typeof value !== 'object') return [];
  const entries: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray((value as Record<string, unknown>).tools)
      ? ((value as Record<string, unknown>).tools as unknown[])
      : [value];
  const calls: ToolCall[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.tool !== 'string') continue;
    calls.push({
      id: randomId(),
      name: record.tool,
      arguments: record.input && typeof record.input === 'object' ? record.input : {},
      raw: JSON.stringify(record.input ?? {}),
    });
  }
  return calls;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function textContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

function createAgentSignal(signal: AbortSignal | undefined, deadlineMs: number | undefined): {
  signal?: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  if (!signal && deadlineMs === undefined) return { signal: undefined, timedOut: () => false, dispose: () => undefined };
  const controller = new AbortController();
  let didTimeOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (deadlineMs !== undefined) {
    timer = setTimeout(() => {
      didTimeOut = true;
      controller.abort(new AIError(`Agent deadline exceeded after ${deadlineMs}ms`, { kind: 'budget_exceeded', retryable: false }));
    }, deadlineMs);
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
