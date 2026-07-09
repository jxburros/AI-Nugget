# Context Nugget

Context Nugget is a pliable context and memory scaffolding engine for AI apps.

It helps turn documents, memories, app state, workspace state, tool results, repo files, issue text, generated artifacts, and other sources into structured, cited, model-ready context.

It is intentionally **not** a full memory system, vector database, document parser, prompt library, model SDK, hosted memory layer, sync engine, UI framework, or agent platform.

```txt
Context Nugget -> finds, ranks, cites, budgets, and packs context
AI Nugget     -> talks to model providers
Your app      -> owns prompts, policy, storage, privacy, consent, UI, deletion, and lifecycle
```

## What is included in this seed

- Core public types for sources, chunks, memory records, layers, retrieval results, citations, packets, and packs.
- Text and Markdown chunkers with stable IDs, line ranges, heading paths, estimated tokens, trust metadata, and source refs.
- In-memory / JSON-serializable store.
- Dependency-light BM25 retrieval ported from the same pure TypeScript idea used in AI-model-test.
- Keyword and hybrid retrievers.
- Ranking helpers for source diversity, recency, importance, and confidence signals.
- Budget enforcement for max items, chars, tokens, and items per source.
- Citation formatting and source labels.
- Trusted/untrusted context packing, including an untrusted-source-data boundary inspired by QAI-ality.
- Manual memory records and approval-policy hooks. Auto-writing memory is not enabled by default.
- AI Nugget bridge helpers that produce compatible message and metadata objects without importing AI Nugget.
- Source selection helpers for policy-driven context and query-ranked source selection.
- Tests and recipes for document Q&A, layered memory, untrusted repo review, GitHub issue context, workspace context, card knowledge, and spec-driven context.

## Install / use

```ts
import { ContextEngine, markdownChunker, bm25Retriever } from '@jxburros/context-nugget';

const engine = new ContextEngine({
  chunker: markdownChunker({ maxWords: 360, overlapWords: 40 }),
  retriever: bm25Retriever(),
});

await engine.addSource({
  id: 'design-doc',
  kind: 'markdown',
  title: 'Design Notes',
  content: markdownText,
  trust: 'untrusted',
  metadata: { project: 'context-nugget', path: 'docs/design.md' },
});

const context = await engine.retrieveAndPack({
  query: 'How should memory layers work?',
  layers: ['documents'],
  budget: { maxTokens: 3000, maxItemsPerSource: 2 },
  pack: {
    trustBoundary: 'untrusted-source-data',
    includeCitations: true,
  },
});

console.log(context.text);
console.log(context.citations);
```

## AI Nugget bridge

Context Nugget does not call models. The bridge returns plain objects compatible with AI Nugget-style message arrays and metadata.

```ts
import { asAiNuggetContextMessages, asAiNuggetMetadata } from '@jxburros/context-nugget/ai-nugget';

const messages = [
  { role: 'system', content: 'Use provided context when relevant. Do not invent sources.' },
  ...asAiNuggetContextMessages(context),
  { role: 'user', content: latestUserMessage },
];

const metadata = asAiNuggetMetadata(context);
```

## Manual memory

Memory is visible and explicit by default. Apps can add records manually or wire an approval flow through `MemoryPolicy`.

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

## Retrieval strategies

```ts
await engine.retrieve({ query: 'project context stale', strategy: 'bm25' });
await engine.retrieve({ query: 'project context stale', strategy: 'keyword' });
await engine.retrieve({ query: 'project context stale', strategy: 'hybrid' });
```

If an app requests `strategy: 'semantic'` without configuring a semantic retriever, the packet is returned in degraded mode with a visible fallback reason rather than failing silently.

## Context packets before prompt strings

```ts
const packet = await engine.retrieve({
  query: 'How should repo review context be packed?',
  layers: ['documents', 'external'],
  budget: { maxItems: 8, maxItemsPerSource: 2 },
});

console.log(packet.visibilitySummary);
console.log(packet.diagnostics);

const pack = packContext(packet, {
  trustBoundary: 'untrusted-source-data',
  includeCitations: true,
  includeTrust: true,
});
```

The packet answers the questions the app and user will eventually care about: what was searched, what was included, which sources were used, whether retrieval degraded, how much budget was used, and what text the model would see.

## Non-goals

Context Nugget does not own:

- model calls
- prompts
- memory write policy
- privacy policy
- document conversion
- vector databases
- sync
- accounts
- UI
- deletion semantics
- multi-user permissions
- agent loops

Those belong to the consuming app.

## Design lineage

This seed intentionally borrows proven patterns from the surrounding portfolio:

- **AI-Server-Studio:** layered memory, scoped retrieval, budget-aware fallbacks, reversible memory lifecycle.
- **locus-os:** visible, inspectable context packets with permission/redaction thinking.
- **AI-model-test:** deterministic, dependency-light BM25 retrieval and retrieval fixtures.
- **QAI-ality:** evidence-first packing, file budgets, redaction choke points, and untrusted repository content boundaries.
- **Issues-Handler:** issue/repo/code context recipes and code-context ranking.
- **Blobsmith:** generated files, app plans, patch history, and workspace/artifact context.
- **CardSpoke:** local-first card knowledge and graph-ish retrieval adapters.
- **Spec-Driven-Docs:** policy-driven source selection instead of always reading everything.
- **ai-agent-skills:** curated operational memory as a source kind.
- **AI Nugget:** provider communication remains separate.

See `design.md` and `recipes/` for details.
