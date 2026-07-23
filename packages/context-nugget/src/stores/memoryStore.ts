import type { ContextChunk, ContextSource, ContextStore, MemoryRecord, RetrievalQuery, StoreSnapshot } from '../types.js';
import { metadataMatches, nowIso } from '../util.js';

function recordIsActive(record: MemoryRecord): boolean {
  if ((record.status ?? 'active') !== 'active') return false;
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return false;
  return true;
}

function chunkMatchesQuery(chunk: ContextChunk, query?: RetrievalQuery): boolean {
  if (!query) return true;
  if (query.layers?.length && (!chunk.layer || !query.layers.includes(chunk.layer))) return false;
  if (query.scope && chunk.metadata?.scope !== query.scope) return false;
  return metadataMatches(chunk.metadata, query.filters);
}

function memoryMatchesQuery(record: MemoryRecord, query?: RetrievalQuery): boolean {
  if (!query) return recordIsActive(record);
  if (!recordIsActive(record)) return false;
  if (query.layers?.length && !query.layers.includes(record.layer)) return false;
  if (query.scope && record.scope !== query.scope) return false;
  return metadataMatches(record.metadata, query.filters);
}

export class InMemoryContextStore implements ContextStore {
  private readonly sources = new Map<string, ContextSource>();
  private readonly chunks = new Map<string, ContextChunk>();
  private readonly memories = new Map<string, MemoryRecord>();

  addSource(source: ContextSource): void {
    this.sources.set(source.id, { ...source, updatedAt: source.updatedAt ?? nowIso() });
  }

  addChunks(chunks: ContextChunk[]): void {
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk);
  }

  addMemory(record: MemoryRecord): void {
    this.memories.set(record.id, { ...record, status: record.status ?? 'active' });
  }

  listSources(): ContextSource[] {
    return [...this.sources.values()];
  }

  listChunks(query?: RetrievalQuery): ContextChunk[] {
    const sourceVisibility = new Map([...this.sources.values()].map((s) => [s.id, s.metadata?.hideFromAI !== true]));
    return [...this.chunks.values()].filter((chunk) => {
      if (sourceVisibility.get(chunk.source.sourceId) === false) return false;
      return chunkMatchesQuery(chunk, query);
    });
  }

  listMemories(query?: RetrievalQuery): MemoryRecord[] {
    return [...this.memories.values()].filter((record) => memoryMatchesQuery(record, query));
  }

  export(): StoreSnapshot {
    return {
      sources: this.listSources(),
      chunks: [...this.chunks.values()],
      memories: [...this.memories.values()],
    };
  }

  import(snapshot: StoreSnapshot): void {
    this.clear();
    for (const source of snapshot.sources) this.sources.set(source.id, source);
    for (const chunk of snapshot.chunks) this.chunks.set(chunk.id, chunk);
    for (const memory of snapshot.memories) this.memories.set(memory.id, memory);
  }

  clear(): void {
    this.sources.clear();
    this.chunks.clear();
    this.memories.clear();
  }
}

export function jsonStoreSnapshot(store: ContextStore): StoreSnapshot | Promise<StoreSnapshot> {
  return store.export();
}

export function snapshotToJson(snapshot: StoreSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function snapshotFromJson(json: string): StoreSnapshot {
  const parsed = JSON.parse(json) as Partial<StoreSnapshot>;
  return {
    sources: parsed.sources ?? [],
    chunks: parsed.chunks ?? [],
    memories: parsed.memories ?? [],
  };
}
