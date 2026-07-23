import type { ContextBudget, ContextSource, RetrievalQuery } from './types.js';
import { bm25Retriever } from './retrieval/bm25.js';
import { textChunker } from './chunk.js';

export interface SourceSelectionResult {
  source: ContextSource;
  score: number;
  reasons: string[];
}

export interface PolicyDrivenSourceRule {
  taskType: string;
  requiredSourceIds?: string[];
  optionalSourceIds?: string[];
  requiredKinds?: string[];
  optionalKinds?: string[];
}

export function selectSourcesByPolicy(
  sources: ContextSource[],
  taskType: string,
  rules: PolicyDrivenSourceRule[],
): { selected: ContextSource[]; missingRequired: string[]; coverageWarning?: string } {
  const rule = rules.find((candidate) => candidate.taskType === taskType);
  if (!rule) return { selected: [], missingRequired: [], coverageWarning: `No context rule was defined for task type "${taskType}".` };
  const byId = new Map(sources.map((source) => [source.id, source]));
  const selected: ContextSource[] = [];
  const missingRequired: string[] = [];

  for (const id of rule.requiredSourceIds ?? []) {
    const source = byId.get(id);
    if (source) selected.push(source);
    else missingRequired.push(id);
  }
  for (const kind of rule.requiredKinds ?? []) {
    const matches = sources.filter((source) => source.kind === kind);
    if (matches.length === 0) missingRequired.push(`kind:${kind}`);
    selected.push(...matches);
  }
  for (const id of rule.optionalSourceIds ?? []) {
    const source = byId.get(id);
    if (source) selected.push(source);
  }
  for (const kind of rule.optionalKinds ?? []) selected.push(...sources.filter((source) => source.kind === kind));

  const unique = [...new Map(selected.map((source) => [source.id, source])).values()];
  return {
    selected: unique,
    missingRequired,
    coverageWarning: missingRequired.length ? `Missing required context: ${missingRequired.join(', ')}` : undefined,
  };
}

export function rankSourcesByQuery(sources: ContextSource[], query: RetrievalQuery, budget: ContextBudget = {}): SourceSelectionResult[] {
  const chunks = sources.flatMap((source) => textChunker({ maxWords: 240, overlapWords: 0 }).chunk(source, { layer: 'external' }));
  const results = bm25Retriever().retrieve({ ...query, topK: Math.max(query.topK ?? 10, sources.length) }, chunks);
  const bestBySource = new Map<string, SourceSelectionResult>();
  for (const result of results) {
    const source = sources.find((candidate) => candidate.id === result.chunk.source.sourceId);
    if (!source) continue;
    const existing = bestBySource.get(source.id);
    if (!existing || result.score > existing.score) {
      bestBySource.set(source.id, { source, score: result.score, reasons: result.reasons ?? [] });
    }
  }
  return [...bestBySource.values()]
    .sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id))
    .slice(0, budget.maxItems ?? query.topK ?? 10);
}
