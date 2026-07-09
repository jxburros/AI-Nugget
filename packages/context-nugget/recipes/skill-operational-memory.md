# Recipe: Skill / Operational Memory

Use this when curated operating manuals or agent skills should be context sources.

## Source kind

```ts
await engine.addSource({
  id: 'skill:repo-review',
  kind: 'skill',
  title: 'Repo Review Skill',
  content: skillMarkdown,
  trust: 'trusted',
  metadata: {
    catalog: 'ai-agent-skills',
    repositories: ['QAI-ality', 'Issues-Handler'],
  },
});
```

## Boundary

Curated operational memory should be kept separate from noisy retrieved docs. Skills are generally high-trust procedural context, while repo/user/web text is often untrusted evidence.
