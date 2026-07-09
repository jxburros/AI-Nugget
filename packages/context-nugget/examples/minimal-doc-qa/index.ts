import { ContextEngine } from '@jxburros/context-nugget';

const engine = new ContextEngine();

await engine.addSource({
  id: 'readme',
  kind: 'markdown',
  title: 'Example README',
  content: `# Example App

## Memory

Memory is manual by default and should be visible, editable, deletable, scoped, and traceable.

## Retrieval

BM25 retrieval works without embeddings or a vector database.
`,
  trust: 'trusted',
  metadata: { path: 'README.md' },
});

const pack = await engine.retrieveAndPack({
  query: 'Does this system require embeddings for retrieval?',
  layers: ['documents'],
  budget: { maxItems: 3, maxTokens: 800 },
  pack: { includeCitations: true },
});

console.log(pack.text);
console.log(pack.citations);
