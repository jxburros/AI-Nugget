import type { Usage } from './types.js';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimatedUsage(inputText: string, outputText: string): Usage {
  return {
    inputTokens: estimateTokens(inputText),
    outputTokens: estimateTokens(outputText),
    estimated: true,
  };
}

export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    estimated: a.estimated || b.estimated,
  };
}
