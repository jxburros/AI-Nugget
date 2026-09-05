import type { AIHandler } from '../handler.js';
import type { AIErrorKind, ChatMessage, Connection, ReasoningEffort, StreamEvent, ToolCall, Usage } from '../types.js';
import type { ToolSpec } from './tools.js';
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
    /** Reasoning effort forwarded to every turn — see {@link ChatRequest.reasoningEffort}. */
    reasoningEffort?: ReasoningEffort;
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
    toolResult?: {
        maxChars?: number;
        wrapUntrusted?: boolean;
    };
    onEvent?: (e: AgentEvent) => void;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
}
export type ApprovalGate = (req: {
    call: ToolCall;
    tool: ToolSpec;
    step: number;
}) => Promise<'allow' | 'deny' | {
    modifiedArguments: unknown;
}>;
export type AgentEvent = StreamEvent | {
    type: 'step_start';
    step: number;
} | {
    type: 'tool_mode';
    mode: 'native' | 'promptJson';
} | {
    type: 'tool_start';
    step: number;
    call: ToolCall;
} | {
    type: 'tool_result';
    step: number;
    call: ToolCall;
    result: unknown;
    isError: boolean;
} | {
    type: 'tool_denied';
    step: number;
    call: ToolCall;
    reason: string;
} | {
    type: 'agent_done';
    result: AgentResult;
};
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
    error?: {
        kind: AIErrorKind;
        message: string;
    };
}
export declare function runAgent(opts: AgentOptions): AsyncIterable<AgentEvent> & {
    result: Promise<AgentResult>;
};
//# sourceMappingURL=loop.d.ts.map