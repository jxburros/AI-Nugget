# Agent loop

```ts
import { runAgent, defineTool } from '@jxburros/ai-nugget/agent';
```

`runAgent()` drives a model↔tool loop over the full handler pipeline (so every
turn is policy-checked, key-resolved, retried, and recorded like any other
call). It streams `AgentEvent`s and resolves to an `AgentResult` with an honest
`stopReason`.

It is **not** an agent framework: no planning, no memory, no RAG, no
multi-agent. It consumes `messages`, calls tools, and stops.

## Tool modes

| Mode | Wire behavior |
|---|---|
| `native` | Provider-native function calling (`tools`/`tool_calls`, `tool_use`, `functionDeclarations`). |
| `promptJson` | A `{"tool","input"}` directive (or a batched `{"tools":[…]}`, or a bare array) parsed out of ordinary model text. Works with any model. History is serialized as plain text turns, not provider-native tool-call wire format. |
| `auto` (default) | Resolves per call from `profileFor(provider).capabilities.nativeTools` — hosted providers get `native`, local runtimes and `openai-compat` get `promptJson`. |

An explicit `toolMode` always wins. The resolved mode is disclosed once as a
`{ type: 'tool_mode', mode }` event, so a `promptJson` fallback is never silent.

In `promptJson` mode a directive-looking fragment is withheld from `delta`
events while it is being parsed, so a tool request never leaks into the visible
answer stream.

## Budgets, and what happens mid-step

```ts
runAgent({ handler, connection, model, messages, tools,
  budget: { maxSteps: 8, maxTokens: 50_000, deadlineMs: 60_000 } });
```

`maxSteps` defaults to **8**. `maxTokens` and `deadlineMs` are unset by default.
Each budget stops the loop at a different point, and the difference matters if a
tool is running when the budget is reached:

- **`maxSteps`** is checked at the top of each iteration. A step already in
  progress always runs to completion — its model turn finishes, and *all* of its
  tool calls execute. The loop then stops with `stopReason: 'max_steps'`. So the
  real ceiling is "at most `maxSteps` model turns", not "at most `maxSteps` tool
  executions."
- **`deadlineMs`** aborts a shared `AbortSignal`. That signal is passed to the
  provider stream **and** to every `tool.execute(args, ctx)` as `ctx.signal`. A
  tool that honors `ctx.signal` is interrupted mid-flight; a tool that ignores it
  runs to completion, since nothing can forcibly kill it. Either way the loop
  re-checks the signal before each remaining tool call and before the next model
  turn, and stops with `stopReason: 'deadline'`. A tool that finished after the
  deadline still has its result recorded in the message history — the loop just
  never sends that history to the model again.
- **`maxTokens`** is checked once at the **end** of each step, after all of that
  step's tool calls. It cannot interrupt a step in progress, so the actual token
  spend can overshoot by one step's worth. Stops with `stopReason: 'budget'`.

**If your tools do real work, honor `ctx.signal`.** It is the only mechanism
that stops an in-flight tool at a deadline:

```ts
async execute(args, ctx) {
  const res = await fetch(url, { signal: ctx.signal });   // aborts with the run
  return res.json();
}
```

The full set of stop reasons: `finished` (model produced a final answer with no
tool calls), `max_steps`, `budget`, `deadline`, `canceled` (caller's `signal`),
`error`.

## Approval gate

Tools declared `sideEffects: true` require an `ApprovalGate` — and **with no gate
configured they are denied, not run**. The denial is fed back to the model as
data, so it can explain itself or choose differently rather than crashing.

```ts
approval: async ({ call, tool, step }) => {
  if (!(await askHuman(call, tool))) return 'deny';
  return 'allow';
  // or: return { modifiedArguments: { ...args, amount: 100 } }
},
```

A returned `modifiedArguments` is re-validated before the tool runs.
`approvalMode: 'all'` gates every tool, not just side-effecting ones — the right
setting when tool output can be influenced by untrusted input.

## Tool results

`toolResult: { maxChars, wrapUntrusted }` bounds and fences what a tool returns
before it re-enters the model's context. `maxChars` stops one large return from
blowing the next turn's window; `wrapUntrusted` fences the content so the model
treats it as data rather than instructions. **Both are off by default** — see
[security.md](./security.md#prompt-and-tool-injection-opt-in-fail-open).

A tool returning a structured `{ ok: false, … }` is surfaced as
`tool_result` with `isError: true`: a recoverable error the model should react
to, not a run-ending failure. A thrown error becomes a `tool_error` fed back the
same way.

## Argument validation

`validateToolArgs` is intentionally light — object-ness, `required`, top-level
`properties[key].type`. It is **not** a security boundary. Re-validate inside
every `execute()`; see the
[secure-tool recipe](./security.md#tool-argument-validation-is-a-filter-not-a-boundary).

## Examples

- `examples/agent-prompt-json.mjs` — `promptJson` against a local model
- `examples/agent-native-tools.mjs` — `auto` resolving to native tool-calling
- `examples/agent-approval-gate.mjs` — allow / deny / rewrite
