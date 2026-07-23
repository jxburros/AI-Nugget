# Recipe: Workspace Context

Use this when context comes from active UI state rather than documents alone.

## Sources

```txt
active app
selected object
visible objects
recent activity
generated artifacts
current files
workspace scope
readable capabilities
visibility summary
```

## Packet-first rule

The app should build a `ContextPacket` that can power an inspector before it builds a prompt string.

A packet should answer:

```txt
What can the assistant read?
What was hidden from AI?
Which objects/sources are included?
What was redacted?
What will the model see?
What was excluded due to budget or policy?
```

## Suggested source shape

```ts
await engine.addSource({
  id: `object:${selected.id}`,
  kind: 'app_state',
  title: selected.title,
  content: selected.summary,
  trust: 'app',
  metadata: {
    workspaceId,
    activeApp,
    objectType: selected.type,
    hideFromAI: selected.hideFromAI,
  },
});
```
