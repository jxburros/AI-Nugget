import { profileFor } from '../adapters/profiles.js';
import { AIError } from '../errors.js';
import { extractJson } from '../json.js';
import { mergeUsage } from '../tokens.js';
import type { AIHandler } from '../handler.js';
import type { ChatMessage, Connection, StreamEvent, ToolCall, Usage } from '../types.js';
import { sleep } from '../util.js';
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
  budget?: {
    maxSteps?: number;
    maxTokens?: number;
    deadlineMs?: number;
  };
  approval?: ApprovalGate;
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
}

export function runAgent(opts: AgentOptions): AsyncIterable<AgentEvent> & { result: Promise<AgentResult> } {
  let resolveResult!: (result: AgentResult) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<AgentResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const iterable = run(opts, resolveResult, rejectResult);
  return Object.assign(iterable, { result });
}

async function* run(opts: AgentOptions, resolveResult: (result: AgentResult) => void, rejectResult: (error: unknown) => void): AsyncIterable<AgentEvent> {
  const messages = [...opts.messages];
  const toolMode = resolveToolMode(opts);
  const maxSteps = opts.budget?.maxSteps ?? 8;
  const deadlineAt = opts.budget?.deadlineMs ? Date.now() + opts.budget.deadlineMs : null;
  let usage: Usage = { estimated: true };
  let finalText = '';
  let step = 0;

  try {
    while (step < maxSteps) {
      step += 1;
      if (opts.signal?.aborted) return yield* yieldDone('canceled');
      if (deadlineAt && Date.now() > deadlineAt) return yield* yieldDone('deadline');
      yield emit(opts, { type: 'step_start', step });

      const calls: ToolCall[] = [];
      let stepText = '';
      let streamFailure: AIError | undefined;
      const requestMessages = toolMode === 'promptJson' ? withPromptJsonInstruction(messages, opts.tools) : messages;
      for await (const event of opts.handler.stream(opts.connection, {
        model: opts.model,
        messages: requestMessages,
        tools: toolMode === 'promptJson' ? undefined : opts.tools,
        signal: opts.signal,
        metadata: { ...opts.metadata, agentStep: step },
      })) {
        if (event.type === 'delta') stepText += event.text;
        if (event.type === 'tool_call') calls.push(event.call);
        if (event.type === 'error') streamFailure = event.error;
        if (event.type === 'done') {
          usage = mergeUsage(usage, event.result.usage);
          if (toolMode === 'promptJson' && calls.length === 0) calls.push(...callsFromPromptJson(stepText));
        }
        yield emit(opts, event);
      }

      // A handler-level failure (auth, policy, cancel, exhausted retries) must
      // stop the loop honestly rather than looking like an empty completion.
      if (streamFailure) return yield* yieldDone(streamFailure.kind === 'canceled' ? 'canceled' : 'error');

      finalText = stepText;
      messages.push({ role: 'assistant', content: stepText, toolCalls: calls.length ? calls : undefined });
      if (calls.length === 0) return yield* yieldDone('finished');

      for (const call of calls) {
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
        if (tool.sideEffects) {
          if (!opts.approval) {
            yield* appendToolDenied(opts, messages, step, call, 'No approval gate configured');
            continue;
          }
          const approval = await opts.approval({ call, tool, step });
          if (approval === 'deny') {
            yield* appendToolDenied(opts, messages, step, call, 'Denied by approval gate');
            continue;
          }
          if (approval !== 'allow') args = approval.modifiedArguments;
        }
        yield emit(opts, { type: 'tool_start', step, call });
        try {
          const result = await tool.execute(args, {
            signal: opts.signal ?? new AbortController().signal,
            callId: call.id,
            step,
            metadata: opts.metadata,
          });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
          yield emit(opts, { type: 'tool_result', step, call, result, isError: false });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Tool failed';
          yield* appendToolError(opts, messages, step, call, message);
        }
      }

      const totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (opts.budget?.maxTokens && totalTokens > opts.budget.maxTokens) return yield* yieldDone('budget');
      await sleep(0, opts.signal);
    }
    return yield* yieldDone('max_steps');
  } catch (error) {
    const result = makeResult(finalText, messages, usage, step, error instanceof AIError && error.kind === 'canceled' ? 'canceled' : 'error');
    resolveResult(result);
    yield emit(opts, { type: 'agent_done', result });
    rejectResult(error);
  }

  function* yieldDone(stopReason: AgentResult['stopReason']): Generator<AgentEvent> {
    const result = makeResult(finalText, messages, usage, step, stopReason);
    resolveResult(result);
    yield emit(opts, { type: 'agent_done', result });
  }
}

function emit<T extends AgentEvent>(opts: AgentOptions, event: T): T {
  opts.onEvent?.(event);
  return event;
}

function makeResult(finalText: string, messages: ChatMessage[], usage: Usage, steps: number, stopReason: AgentResult['stopReason']): AgentResult {
  return { finalText, messages, usage, steps, stopReason };
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
  return profileFor(opts.connection.provider, opts.connection.baseUrl).capabilities.nativeTools ? 'native' : 'promptJson';
}

function withPromptJsonInstruction(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `When you need tools, respond only with JSON. For one tool: {"tool":"name","input":{...}}. For several in one turn: {"tools":[{"tool":"name","input":{...}}]}. Available tools: ${tools.map((tool) => `${tool.name}: ${tool.description}`).join('; ')}`,
    },
    ...messages,
  ];
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
      id: crypto.randomUUID(),
      name: record.tool,
      arguments: record.input && typeof record.input === 'object' ? record.input : {},
      raw: JSON.stringify(record.input ?? {}),
    });
  }
  return calls;
}
