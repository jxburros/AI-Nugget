import type { AIHandler } from '../handler.js';
import type { ChatMessage, Connection, StreamEvent, ToolCall, Usage } from '../types.js';
import type { ToolSpec } from './tools.js';
export interface AgentOptions {
    handler: AIHandler;
    connection: Connection;
    model: string;
    tools: ToolSpec[];
    messages: ChatMessage[];
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