import type { ContextBudget, RetrievalResult } from './types.js';
import { estimateTokens } from './util.js';

export interface BudgetReport {
  included: RetrievalResult[];
  excluded: RetrievalResult[];
  tokensEstimated: number;
  chars: number;
}

export function applyContextBudget(results: RetrievalResult[], budget: ContextBudget = {}): BudgetReport {
  const maxItems = budget.maxItems ?? results.length;
  const maxChars = budget.maxChars ?? Number.POSITIVE_INFINITY;
  const maxTokens = Math.max(0, (budget.maxTokens ?? Number.POSITIVE_INFINITY) - (budget.reserveTokens ?? 0));
  const maxItemsPerSource = budget.maxItemsPerSource ?? Number.POSITIVE_INFINITY;
  const perSource = new Map<string, number>();
  const included: RetrievalResult[] = [];
  const excluded: RetrievalResult[] = [];
  let chars = 0;
  let tokensEstimated = 0;

  for (const result of results) {
    const sourceId = result.chunk.source.sourceId;
    const sourceCount = perSource.get(sourceId) ?? 0;
    const nextChars = chars + result.chunk.text.length;
    const nextTokens = tokensEstimated + (result.chunk.tokensEstimated ?? estimateTokens(result.chunk.text));
    const fits =
      included.length < maxItems &&
      sourceCount < maxItemsPerSource &&
      nextChars <= maxChars &&
      nextTokens <= maxTokens;
    if (!fits) {
      excluded.push(result);
      continue;
    }
    included.push(result);
    perSource.set(sourceId, sourceCount + 1);
    chars = nextChars;
    tokensEstimated = nextTokens;
  }

  return { included, excluded, chars, tokensEstimated };
}
