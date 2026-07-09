# Recipe: Document Q&A

Use this when an app has Markdown/text docs and needs cited, model-ready evidence.

## Pipeline

```txt
Load docs
-> chunk by Markdown headings / paragraphs
-> retrieve with BM25
-> rank for source diversity
-> budget
-> pack with citations
-> pass to AI Nugget or another model SDK
```

## Minimal code

```ts
import { ContextEngine, markdownChunker, bm25Retriever } from '@jxburros/context-nugget';

const engine = new ContextEngine({
  chunker: markdownChunker({ maxWords: 360, overlapWords: 40 }),
  retriever: bm25Retriever(),
});

await engine.addSource({
  id: 'architecture',
  kind: 'markdown',
  title: 'Architecture',
  content: architectureMarkdown,
  metadata: { path: 'development-docs/architecture.md' },
  trust: 'trusted',
});

const pack = await engine.retrieveAndPack({
  query: userQuestion,
  layers: ['documents'],
  budget: { maxTokens: 3000, maxItemsPerSource: 2 },
  pack: { includeCitations: true },
});
```

## Test expectations

- Expected source appears in `packet.sources`.
- Each context item has a citation.
- Source refs preserve path, section, and line range when available.
- Budget exclusions are visible in diagnostics.
