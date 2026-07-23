import type { ContextPack } from './types.js';

export interface AiNuggetCompatibleMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function asAiNuggetContextMessages(pack: ContextPack): AiNuggetCompatibleMessage[] {
  if (!pack.text.trim()) return [];
  return [
    {
      role: 'system',
      content: pack.text,
    },
  ];
}

export function asAiNuggetMetadata(pack: ContextPack): Record<string, unknown> {
  return {
    contextPacketId: pack.packet.id,
    contextRetrievalMode: pack.packet.retrievalMode,
    contextDegraded: pack.packet.degraded ?? false,
    contextSources: pack.sources,
    contextCitations: pack.citations,
    contextTokensEstimated: pack.tokensEstimated,
  };
}
