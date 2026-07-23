import type { ContextChunk, RetrievalQuery, RetrievalResult, Retriever } from '../types.js';
import { bm25Retriever } from './bm25.js';
import { keywordRetriever } from './keyword.js';

export class HybridRetriever implements Retriever {
  readonly mode = 'hybrid' as const;

  retrieve(query: RetrievalQuery, chunks: ContextChunk[]): RetrievalResult[] {
    const bm25 = bm25Retriever().retrieve({ ...query, topK: Math.max(query.topK ?? 8, 20), minScore: 0 }, chunks);
    const keyword = keywordRetriever().retrieve({ ...query, topK: Math.max(query.topK ?? 8, 20), minScore: 0 }, chunks);
    const merged = new Map<string, RetrievalResult>();

    for (const result of bm25) {
      merged.set(result.chunk.id, {
        ...result,
        retrievalMode: this.mode,
        scoreBreakdown: { bm25: result.score, keyword: 0 },
      });
    }
    for (const result of keyword) {
      const existing = merged.get(result.chunk.id);
      if (existing) {
        existing.score += result.score;
        existing.scoreBreakdown = { ...existing.scoreBreakdown, keyword: result.score };
        existing.reasons = [...(existing.reasons ?? []), ...(result.reasons ?? [])];
      } else {
        merged.set(result.chunk.id, {
          ...result,
          retrievalMode: this.mode,
          scoreBreakdown: { bm25: 0, keyword: result.score },
        });
      }
    }

    return [...merged.values()]
      .filter((result) => result.score > (query.minScore ?? 0))
      .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
      .slice(0, query.topK ?? 8);
  }
}

export function hybridRetriever(): HybridRetriever {
  return new HybridRetriever();
}
