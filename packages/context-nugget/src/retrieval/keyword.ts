import type { ContextChunk, RetrievalQuery, RetrievalResult, Retriever } from '../types.js';
import { tokenize, uniqueTokens } from '../tokenize.js';

function keywordScore(query: string, chunk: ContextChunk): { score: number; reasons: string[] } {
  const queryTokens = uniqueTokens(query, { minLength: 2 });
  if (queryTokens.length === 0) return { score: 0, reasons: [] };
  const contentTokens = new Set(tokenize(chunk.text, { minLength: 2 }));
  const title = `${chunk.source.title ?? ''} ${chunk.source.path ?? ''} ${chunk.source.section ?? ''}`.toLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      score += 1;
      matched.push(token);
    }
    if (title.includes(token)) score += 0.5;
  }
  return {
    score: score / Math.max(1, queryTokens.length),
    reasons: matched.length ? [`keyword matches: ${matched.slice(0, 6).join(', ')}`] : [],
  };
}

export class KeywordRetriever implements Retriever {
  readonly mode = 'keyword' as const;

  retrieve(query: RetrievalQuery, chunks: ContextChunk[]): RetrievalResult[] {
    return chunks
      .map((chunk) => {
        const { score, reasons } = keywordScore(query.query, chunk);
        return {
          chunk,
          score,
          scoreBreakdown: { keyword: score },
          reasons,
          layer: chunk.layer,
          retrievalMode: this.mode,
        } satisfies RetrievalResult;
      })
      .filter((result) => result.score > (query.minScore ?? 0))
      .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
      .slice(0, query.topK ?? 8);
  }
}

export function keywordRetriever(): KeywordRetriever {
  return new KeywordRetriever();
}
