import type {
  Citation,
  ContextBudget,
  ContextItem,
  ContextLayer,
  ContextPack,
  ContextPacket,
  PackOptions,
  RetrievalResult,
} from './types.js';
import { applyContextBudget } from './budget.js';
import { attachCitations, citationKey, createCitation, formatSourceLabel } from './citations.js';
import { wrapUntrustedSourceData } from './safety.js';
import { estimateTokens, makeId, nowIso, uniqueBy } from './util.js';

export interface PacketOptions {
  query: string;
  layers?: ContextLayer[];
  budget?: ContextBudget;
  retrievalMode?: ContextPacket['retrievalMode'];
  degraded?: boolean;
  degradedReason?: string;
  diagnosticsReasons?: string[];
}

export function packetFromResults(results: RetrievalResult[], options: PacketOptions): ContextPacket {
  const budget = options.budget ?? {};
  const report = applyContextBudget(results, budget);
  const baseItems: Omit<ContextItem, 'citation'>[] = report.included.map((result) => ({
    id: result.chunk.id,
    text: result.chunk.text,
    source: result.chunk.source,
    score: result.score,
    layer: result.layer ?? result.chunk.layer,
    trust: result.chunk.trust,
    tokensEstimated: result.chunk.tokensEstimated ?? estimateTokens(result.chunk.text),
    metadata: {
      ...(result.chunk.metadata ?? {}),
      scoreBreakdown: result.scoreBreakdown,
      reasons: result.reasons,
    },
  }));
  const items = attachCitations(baseItems);
  const sources = uniqueBy(items.map((item) => item.source), citationKey);
  const layers = options.layers?.length ? options.layers : uniqueBy(items.map((item) => item.layer).filter((l): l is ContextLayer => Boolean(l)), (l) => l);
  const visibilitySummary = `Included ${items.length} item${items.length === 1 ? '' : 's'} from ${sources.length} source${sources.length === 1 ? '' : 's'} across ${layers.length} layer${layers.length === 1 ? '' : 's'}.`;

  return {
    id: makeId('packet', `${options.query}:${nowIso()}:${items.map((i) => i.id).join(',')}`),
    query: options.query,
    layers,
    items,
    sources,
    budget,
    retrievalMode: options.retrievalMode ?? 'none',
    degraded: options.degraded,
    degradedReason: options.degradedReason,
    visibilitySummary,
    createdAt: nowIso(),
    diagnostics: {
      searchedChunks: results.length,
      returnedItems: items.length,
      excludedItems: report.excluded.length,
      estimatedTokens: report.tokensEstimated,
      estimatedChars: report.chars,
      reasons: options.diagnosticsReasons,
    },
  };
}

function itemHeader(item: ContextItem, options: PackOptions): string {
  const citation = item.citation?.label ?? formatSourceLabel(item.source);
  const extras: string[] = [];
  if (options.includeScores && typeof item.score === 'number') extras.push(`score ${item.score.toFixed(3)}`);
  if (options.includeTrust && item.trust) extras.push(`trust ${item.trust}`);
  if (item.layer) extras.push(`layer ${item.layer}`);
  return extras.length ? `${citation} (${extras.join('; ')})` : citation;
}

export function packContext(packet: ContextPacket, options: PackOptions = {}): ContextPack {
  const includeCitations = options.includeCitations ?? true;
  const heading = options.heading ?? 'Relevant context';
  const lines: string[] = [];

  if (options.format === 'plain') {
    if (heading) lines.push(heading, '');
    for (const item of packet.items) {
      lines.push(itemHeader(item, options));
      lines.push(item.text.trim());
      lines.push('');
    }
  } else {
    if (heading) lines.push(`## ${heading}`, '');
    if (packet.degraded && packet.degradedReason) lines.push(`_Retrieval degraded: ${packet.degradedReason}_`, '');
    for (const item of packet.items) {
      lines.push(`### ${itemHeader(item, options)}`);
      lines.push('');
      lines.push(item.text.trim());
      lines.push('');
    }
  }

  let text = lines.join('\n').trim();
  if (options.trustBoundary === 'untrusted-source-data') text = wrapUntrustedSourceData(text);
  const citations: Citation[] = includeCitations
    ? packet.items.map((item, i) => item.citation ?? createCitation(item.source, i + 1))
    : [];
  return {
    packet,
    text,
    citations,
    sources: packet.sources,
    tokensEstimated: estimateTokens(text),
  };
}
