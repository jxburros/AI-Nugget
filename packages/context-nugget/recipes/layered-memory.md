# Recipe: Layered Memory

Use this when context must come from distinct memory layers without collapsing policy into retrieval.

## Layers

```txt
session   temporary conversation/task state
user      durable user preferences/facts
project   project docs, decisions, issue history
app       app help text and workflows
agent     plans, tool traces, scratchpad, often temporary
model     model-specific notes/results
documents indexed files and uploaded docs
artifacts generated files and app outputs
external  web/search/tool/imported context
```

## Manual memory first

```ts
await engine.addMemory({
  id: 'ui-preference-minimal',
  layer: 'user',
  scope: 'user:jxburros',
  text: 'The user prefers minimal, modern, monochrome interfaces.',
  importance: 0.8,
  confidence: 1,
  createdAt: new Date().toISOString(),
});
```

## Retrieval

```ts
const packet = await engine.retrieve({
  query: latestUserMessage,
  layers: ['session', 'project', 'user', 'documents'],
  scope: 'project:context-nugget',
  budget: { maxTokens: 5000, maxItemsPerSource: 3 },
});
```

## App-owned policy

Context Nugget can represent candidates and call `MemoryPolicy` hooks, but the app decides whether to write, edit, expire, delete, or expose memory.

Default behavior should remain manual or approval-gated.
