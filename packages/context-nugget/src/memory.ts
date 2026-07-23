import type { ContextChunk, ContextSourceRef, MemoryCandidate, MemoryDecision, MemoryPolicy, MemoryRecord } from './types.js';
import { estimateTokens, makeId, nowIso } from './util.js';

export const manualMemoryPolicy: MemoryPolicy = {
  mode: 'manual',
  shouldStore: () => ({ store: false, reason: 'manual policy does not auto-store memories' }),
};

export function memoryRecordFromCandidate(candidate: MemoryCandidate, decision?: MemoryDecision): MemoryRecord {
  const now = nowIso();
  const id = decision?.record?.id ?? makeId('mem', `${candidate.scope}:${candidate.layer}:${candidate.text}`);
  return {
    id,
    layer: candidate.layer,
    scope: candidate.scope,
    text: candidate.text,
    source: candidate.source,
    tags: candidate.tags,
    importance: candidate.importance,
    confidence: candidate.confidence,
    createdAt: decision?.record?.createdAt ?? now,
    updatedAt: decision?.record?.updatedAt ?? now,
    expiresAt: decision?.record?.expiresAt,
    status: decision?.record?.status ?? 'active',
    supersedes: decision?.record?.supersedes,
    metadata: { ...candidate.metadata, ...decision?.record?.metadata },
  };
}

export function memoryToChunk(record: MemoryRecord): ContextChunk {
  const source: ContextSourceRef = record.source ?? {
    sourceId: record.id,
    sourceKind: 'memory',
    title: `Memory ${record.scope}`,
  };
  return {
    id: makeId('chunk', `memory:${record.id}:${record.updatedAt ?? record.createdAt}:${record.text}`),
    source: { ...source, sourceKind: source.sourceKind || 'memory' },
    text: record.text,
    layer: record.layer,
    trust: 'user',
    metadata: {
      ...(record.metadata ?? {}),
      memoryId: record.id,
      scope: record.scope,
      tags: record.tags ?? [],
      importance: record.importance ?? 0,
      confidence: record.confidence ?? 0,
      status: record.status ?? 'active',
    },
    tokensEstimated: estimateTokens(record.text),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function shouldStoreMemory(policy: MemoryPolicy, candidate: MemoryCandidate): Promise<MemoryDecision> {
  if (policy.mode === 'manual') return { store: false, reason: 'manual memory mode' };
  if (policy.shouldStore) return policy.shouldStore(candidate);
  if (policy.mode === 'suggested') return { store: false, reason: 'suggested memory requires app approval' };
  return { store: true, reason: 'auto memory policy allowed storage' };
}
