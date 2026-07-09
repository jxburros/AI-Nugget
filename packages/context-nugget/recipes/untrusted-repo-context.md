# Recipe: Untrusted Repo Review Context

Use this when reading repository files, issue text, PR comments, README content, or other user-controlled text.

## Why

Repo content can contain prompt-injection text such as fake system messages or instructions to ignore previous instructions. Context Nugget should pack repository content as evidence, not authority.

## Pipeline

```txt
select repo files
-> redact secrets
-> chunk/rank by issue or review query
-> budget per source and total context
-> pack behind untrusted-source-data boundary
```

## Minimal packing

```ts
const pack = await engine.retrieveAndPack({
  query: 'Find likely stale context bugs',
  layers: ['external', 'documents'],
  budget: { maxItems: 10, maxItemsPerSource: 2, maxTokens: 6000 },
  pack: {
    trustBoundary: 'untrusted-source-data',
    includeCitations: true,
    includeTrust: true,
  },
});
```

## Safety checklist

- Redact key/token-shaped text before packing.
- Use source labels with file path and line ranges.
- Do not mix source text with system/developer instructions.
- Require citations for any model-facing review finding.
- Keep action policy outside Context Nugget.
