import type { RankOptions, RetrievalResult } from './types.js';
import { recencyBoost } from './util.js';

export function applySourceDiversity(results: RetrievalResult[], options: RankOptions = {}): RetrievalResult[] {
  const diversityPenalty = options.diversityPenalty ?? 0.12;
  const sourceCounts = new Map<string, number>();
  return results
    .map((result) => {
      const sourceId = result.chunk.source.sourceId;
      const count = sourceCounts.get(sourceId) ?? 0;
      sourceCounts.set(sourceId, count + 1);
      const adjustedScore = result.score / (1 + diversityPenalty * count);
      return {
        ...result,
        score: adjustedScore,
        scoreBreakdown: { ...result.scoreBreakdown, diversityAdjusted: adjustedScore },
      };
    })
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
}

export function applyMemorySignals(results: RetrievalResult[]): RetrievalResult[] {
  return results
    .map((result) => {
      const importance = typeof result.chunk.metadata?.importance === 'number' ? result.chunk.metadata.importance : 0;
      const confidence = typeof result.chunk.metadata?.confidence === 'number' ? result.chunk.metadata.confidence : 0;
      const recent = recencyBoost(result.chunk.updatedAt ?? result.chunk.createdAt ?? String(result.chunk.metadata?.updatedAt ?? ''));
      const memoryBoost = result.chunk.source.sourceKind === 'memory' ? 0.2 * importance + 0.1 * confidence + 0.05 * recent : 0;
      return {
        ...result,
        score: result.score + memoryBoost,
        scoreBreakdown: { ...result.scoreBreakdown, memoryBoost },
        reasons: memoryBoost > 0 ? [...(result.reasons ?? []), 'memory importance/confidence/recency boost'] : result.reasons,
      };
    })
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
}

export function rankResults(results: RetrievalResult[], options: RankOptions = {}): RetrievalResult[] {
  return applySourceDiversity(applyMemorySignals(results), options);
}
