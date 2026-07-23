import type { Citation, ContextItem, ContextSourceRef } from './types.js';

function joinDefined(parts: Array<string | undefined>, sep: string): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
}

export function formatSourceLabel(source: ContextSourceRef): string {
  const base = source.title ?? source.path ?? source.url ?? source.sourceId;
  const section = source.section ? ` > ${source.section}` : '';
  const location = source.page
    ? ` p.${source.page}`
    : source.lineStart
      ? ` L${source.lineStart}${source.lineEnd && source.lineEnd !== source.lineStart ? `-L${source.lineEnd}` : ''}`
      : '';
  return `${base}${section}${location}`;
}

export function createCitation(source: ContextSourceRef, index: number): Citation {
  return {
    id: `c${index}`,
    label: `[${index}] ${formatSourceLabel(source)}`,
    source,
  };
}

export function citationKey(source: ContextSourceRef): string {
  return joinDefined([
    source.sourceId,
    source.sourceKind,
    source.path,
    source.url,
    source.section,
    source.page === undefined ? undefined : String(source.page),
    source.lineStart === undefined ? undefined : String(source.lineStart),
    source.lineEnd === undefined ? undefined : String(source.lineEnd),
  ], '|');
}

export function attachCitations(items: Omit<ContextItem, 'citation'>[]): ContextItem[] {
  return items.map((item, index) => ({ ...item, citation: createCitation(item.source, index + 1) }));
}
