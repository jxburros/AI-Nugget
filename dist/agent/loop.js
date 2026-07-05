import { profileFor } from '../adapters/profiles.js';
import { AIError } from '../errors.js';
import { extractJson } from '../json.js';
import { mergeUsage } from '../tokens.js';
import { sleep } from '../util.js';
import { validateToolArgs } from './tools.js';
export function runAgent(opts) {
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    const iterable = run(opts, resolveResult, rejectResult);
    return Object.assign(iterable, { result });
}
async function* run(opts, resolveResult, rejectResult) {
    const messages = [...opts.messages];
    const toolMode = resolveToolMode(opts);
    const maxSteps = opts.budget?.maxSteps ?? 8;
    const agentSignal = createAgentSignal(opts.signal, opts.budget?.deadlineMs);
    let usage;
    let finalText = '';
    let step = 0;
    let settled = false;
    try {
        while (step < maxSteps) {
            step += 1;
            if (agentSignal.signal?.aborted)
                return yield* yieldDone(agentSignal.timedOut() ? 'deadline' : 'canceled');
            yield emit(opts, { type: 'step_start', step });
            const calls = [];
            let stepText = '';
            let streamFailure;
            const requestMessages = toolMode === 'promptJson' ? withPromptJsonInstruction(messages, opts.tools) : messages;
            for await (const event of opts.handler.stream(opts.connection, {
                model: opts.model,
                messages: requestMessages,
                tools: toolMode === 'promptJson' ? undefined : opts.tools,
                signal: agentSignal.signal,
                metadata: { ...opts.metadata, agentStep: step },
            })) {
                if (event.type === 'delta')
                    stepText += event.text;
                if (event.type === 'tool_call')
                    calls.push(event.call);
                if (event.type === 'error')
                    streamFailure = event.error;
                if (event.type === 'done') {
                    usage = usage ? mergeUsage(usage, event.result.usage) : event.result.usage;
                    if (toolMode === 'promptJson' && calls.length === 0)
                        calls.push(...callsFromPromptJson(stepText));
                }
                yield emit(opts, event);
            }
            // A handler-level failure (auth, policy, cancel, exhausted retries) must
            // stop the loop honestly rather than looking like an empty completion.
            if (streamFailure)
                return yield* yieldDone(agentSignal.timedOut() ? 'deadline' : streamFailure.kind === 'canceled' ? 'canceled' : 'error');
            finalText = stepText;
            messages.push(toolMode === 'promptJson'
                ? { role: 'assistant', content: stepText }
                : { role: 'assistant', content: stepText, toolCalls: calls.length ? calls : undefined });
            if (calls.length === 0)
                return yield* yieldDone('finished');
            for (const call of calls) {
                if (agentSignal.signal?.aborted)
                    return yield* yieldDone(agentSignal.timedOut() ? 'deadline' : 'canceled');
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
                    if (agentSignal.signal?.aborted)
                        return yield* yieldDone(agentSignal.timedOut() ? 'deadline' : 'canceled');
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
                try {
                    const result = await tool.execute(args, {
                        signal: agentSignal.signal ?? new AbortController().signal,
                        callId: call.id,
                        step,
                        metadata: opts.metadata,
                    });
                    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
                    yield emit(opts, { type: 'tool_result', step, call, result, isError: false });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : 'Tool failed';
                    yield* appendToolError(opts, messages, step, call, message);
                }
            }
            const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
            if (opts.budget?.maxTokens && totalTokens > opts.budget.maxTokens)
                return yield* yieldDone('budget');
            await sleep(0, agentSignal.signal);
        }
        return yield* yieldDone('max_steps');
    }
    catch (error) {
        const result = makeResult(finalText, messages, usage ?? { estimated: true }, step, agentSignal.timedOut() ? 'deadline' : error instanceof AIError && error.kind === 'canceled' ? 'canceled' : 'error');
        settled = true;
        resolveResult(result);
        yield emit(opts, { type: 'agent_done', result });
        rejectResult(error);
    }
    finally {
        agentSignal.dispose();
        if (!settled) {
            const result = makeResult(finalText, messages, usage ?? { estimated: true }, step, 'canceled');
            resolveResult(result);
        }
    }
    function* yieldDone(stopReason) {
        const result = makeResult(finalText, messages, usage ?? { estimated: true }, step, stopReason);
        settled = true;
        resolveResult(result);
        yield emit(opts, { type: 'agent_done', result });
    }
}
function emit(opts, event) {
    opts.onEvent?.(event);
    return event;
}
function makeResult(finalText, messages, usage, steps, stopReason) {
    return { finalText, messages, usage, steps, stopReason };
}
function* appendToolError(opts, messages, step, call, message) {
    const result = { error: message };
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
    yield emit(opts, { type: 'tool_result', step, call, result, isError: true });
}
function* appendToolDenied(opts, messages, step, call, reason) {
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ denied: true, reason }) });
    yield emit(opts, { type: 'tool_denied', step, call, reason });
}
function resolveToolMode(opts) {
    const mode = opts.toolMode ?? 'auto';
    if (mode !== 'auto')
        return mode;
    return profileFor(opts.connection.provider, opts.connection.baseUrl).capabilities.nativeTools ? 'native' : 'promptJson';
}
function withPromptJsonInstruction(messages, tools) {
    return [
        {
            role: 'system',
            content: `When you need tools, respond only with JSON. For one tool: {"tool":"name","input":{...}}. For several in one turn: {"tools":[{"tool":"name","input":{...}}]}. Available tools: ${tools.map((tool) => `${tool.name}: ${tool.description}`).join('; ')}`,
        },
        ...messages.map(toPromptJsonMessage),
    ];
}
function toPromptJsonMessage(message) {
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
function callsFromPromptJson(text) {
    const value = extractJson(text);
    if (!value || typeof value !== 'object')
        return [];
    const entries = Array.isArray(value)
        ? value
        : Array.isArray(value.tools)
            ? value.tools
            : [value];
    const calls = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            continue;
        const record = entry;
        if (typeof record.tool !== 'string')
            continue;
        calls.push({
            id: crypto.randomUUID(),
            name: record.tool,
            arguments: record.input && typeof record.input === 'object' ? record.input : {},
            raw: JSON.stringify(record.input ?? {}),
        });
    }
    return calls;
}
function textContent(content) {
    if (typeof content === 'string')
        return content;
    return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}
function createAgentSignal(signal, deadlineMs) {
    if (!signal && deadlineMs === undefined)
        return { signal: undefined, timedOut: () => false, dispose: () => undefined };
    const controller = new AbortController();
    let didTimeOut = false;
    let timer;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener('abort', onAbort, { once: true });
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
            if (timer)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        },
    };
}
//# sourceMappingURL=loop.js.map