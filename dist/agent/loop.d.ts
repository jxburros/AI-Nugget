import type { AIHandler } from '../handler.js';
import type { ChatMessage, Connection, StreamEvent, ToolCall, Usage } from '../types.js';
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
}) => Promise<'allow' | 'deny' | {
    modifiedArguments: unknown;
}>;
export type AgentEvent = StreamEvent | {
    type: 'step_start';
    step: number;
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
}
export declare function runAgent(opts: AgentOptions): AsyncIterable<AgentEvent> & {
    result: Promise<AgentResult>;
};
//# sourceMappingURL=loop.d.ts.map