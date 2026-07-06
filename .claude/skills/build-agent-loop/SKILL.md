---
name: build-agent-loop
description: Build a model↔tool agent loop with the ai-handler agent layer — defineTool, runAgent, toolMode selection (native vs promptJson vs auto), budgets, ApprovalGate, and AgentEvent streaming. Use when adding tool-calling / function-calling or an agent loop to an app that uses this nugget, or when debugging why tools aren't being called.
---

# Building an agent loop with ai-handler

The agent layer lives at `@jxburros/ai-handler/agent` (source:
`src/agent/`). It is a single model↔tool loop over the full handler pipeline —
no planning, memory, RAG, or multi-agent (those are explicit non-goals).

## Define tools

```ts
import { runAgent, defineTool } from '@jxburros/ai-handler/agent';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  sideEffects: false,           // true routes the call through the ApprovalGate
  async execute(args: { city: string }, ctx) {
    // ctx: { signal, callId, step, metadata? } — honor ctx.signal for aborts
    return { tempC: 21 };
  },
});
```

**Validation caveat:** built-in arg validation is intentionally light —
object-ness, `required` presence, and top-level `properties[key].type` only.
No `enum`, nested schemas, `oneOf`, bounds, `pattern`, or array `items`. If a
tool needs stricter guarantees, validate `args` again inside `execute` with the
app's own schema library. Tool results are fed back to the model; thrown errors
become `tool_result` events with `isError: true` (the model sees them as data).

## Run the loop

```ts
const agent = runAgent({
  handler, connection, model: 'gpt-4o-mini',
  tools: [getWeather],
  messages: [{ role: 'user', content: 'Weather in Oslo?' }],
  budget: { maxSteps: 8, maxTokens: 20_000, deadlineMs: 60_000 },
});

for await (const event of agent) {
  // StreamEvent (delta/tool_call/error/done) plus:
  // step_start, tool_start, tool_result, tool_denied, agent_done
}
const result = await agent.result;
// { finalText, messages, usage, steps,
//   stopReason: 'finished' | 'max_steps' | 'budget' | 'deadline' | 'canceled' | 'error' }
```

`runAgent` returns an async iterable **and** a `result` promise — consume
either. Always check `stopReason`; the loop reports budget/deadline/error
exhaustion honestly instead of pretending it finished. Default `maxSteps` is 8.

## toolMode: native vs promptJson vs auto

- `native` — sends `tools` on the wire; provider streams `tool_calls` back.
- `promptJson` — describes tools in a system message and parses a JSON
  directive (`{"tool","input"}`, batched `{"tools":[…]}`, or a bare array) out
  of plain text. The universal fallback for small/local models. History is
  serialized as plain text turns, not provider tool-call wire format.
- `auto` (default) — resolves per call from
  `profileFor(provider).capabilities.nativeTools`: hosted providers get
  `native`; local runtimes (Ollama, llama.cpp, LM Studio, vLLM) and
  `openai-compat` get `promptJson`.

Capabilities are provider-level defaults, not per-model guarantees. If you know
the actual model (e.g. a tool-capable model on Ollama, or a weak model behind
OpenRouter), pass an explicit `toolMode` instead of trusting `auto`.

## ApprovalGate for side-effecting tools

```ts
const approval: ApprovalGate = async ({ call, tool, step }) =>
  tool.name === 'delete_file' ? 'deny'
  : needsRewrite(call) ? { modifiedArguments: fixed }
  : 'allow';
```

Only tools with `sideEffects: true` are gated. A denial is not an exception —
it is fed back to the model as data (and emitted as a `tool_denied` event) so
the model can adapt.

## Working examples

`examples/agent-native-tools.mjs`, `examples/agent-prompt-json.mjs`, and
`examples/agent-approval-gate.mjs` are runnable end-to-end (see
`examples/README.md`). Contract tests for loop behavior live in
`tests/agent.test.ts`.
