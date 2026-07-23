import type {
  Chunker,
  ChunkerOptions,
  ContextPack,
  ContextPacket,
  ContextSource,
  ContextStore,
  MemoryCandidate,
  MemoryPolicy,
  MemoryRecord,
  PackOptions,
  RetrievalQuery,
  RetrieveAndPackOptions,
  Retriever,
} from './types.js';
import { markdownChunker } from './chunk.js';
import { bm25Retriever } from './retrieval/bm25.js';
import { keywordRetriever } from './retrieval/keyword.js';
import { hybridRetriever } from './retrieval/hybrid.js';
import { InMemoryContextStore } from './stores/memoryStore.js';
import { memoryRecordFromCandidate, memoryToChunk, shouldStoreMemory, manualMemoryPolicy } from './memory.js';
import { packetFromResults, packContext } from './pack.js';
import { rankResults } from './rank.js';

export interface ContextEngineOptions {
  store?: ContextStore;
  chunker?: Chunker;
  retriever?: Retriever;
  memoryPolicy?: MemoryPolicy;
  chunkerOptions?: ChunkerOptions;
}

export class ContextEngine {
  readonly store: ContextStore;
  private readonly chunker: Chunker;
  private readonly retriever: Retriever;
  private readonly memoryPolicy: MemoryPolicy;
  private readonly defaultChunkerOptions: ChunkerOptions;

  constructor(options: ContextEngineOptions = {}) {
    this.store = options.store ?? new InMemoryContextStore();
    this.chunker = options.chunker ?? markdownChunker();
    this.retriever = options.retriever ?? bm25Retriever();
    this.memoryPolicy = options.memoryPolicy ?? manualMemoryPolicy;
    this.defaultChunkerOptions = options.chunkerOptions ?? {};
  }

  async addSource(source: ContextSource, options: ChunkerOptions = {}): Promise<void> {
    await this.store.addSource(source);
    const chunker = source.kind === 'markdown' ? markdownChunker() : this.chunker;
    const chunks = chunker.chunk(source, { ...this.defaultChunkerOptions, ...options });
    await this.store.addChunks(chunks);
  }

  async addSources(sources: ContextSource[], options: ChunkerOptions = {}): Promise<void> {
    for (const source of sources) await this.addSource(source, options);
  }

  async addMemory(record: MemoryRecord): Promise<void> {
    await this.store.addMemory(record);
    await this.store.addChunks([memoryToChunk(record)]);
  }

  async suggestMemory(candidate: MemoryCandidate): Promise<{ decision: Awaited<ReturnType<typeof shouldStoreMemory>>; record?: MemoryRecord }> {
    const decision = await shouldStoreMemory(this.memoryPolicy, candidate);
    if (!decision.store) return { decision };
    const record = memoryRecordFromCandidate(candidate, decision);
    await this.addMemory(record);
    return { decision, record };
  }

  async retrieve(query: RetrievalQuery): Promise<ContextPacket> {
    const chunks = await this.store.listChunks(query);
    let retriever = this.retriever;
    if (query.strategy === 'keyword') retriever = keywordRetriever();
    if (query.strategy === 'hybrid') retriever = hybridRetriever();
    if (query.strategy === 'bm25') retriever = bm25Retriever();

    let degraded = false;
    let degradedReason: string | undefined;
    if ((query.strategy === 'semantic' || query.strategy === 'hybrid-semantic') && retriever.mode !== 'semantic') {
      degraded = true;
      degradedReason = 'Semantic retrieval is not configured; used dependency-light BM25/keyword retrieval instead.';
      retriever = bm25Retriever();
    }

    const rawResults = await retriever.retrieve(query, chunks);
    const ranked = rankResults(rawResults, { maxItemsPerSource: query.budget?.maxItemsPerSource });
    return packetFromResults(ranked, {
      query: query.query,
      layers: query.layers,
      budget: query.budget,
      retrievalMode: retriever.mode,
      degraded,
      degradedReason,
      diagnosticsReasons: ranked.flatMap((result) => result.reasons ?? []).slice(0, 12),
    });
  }

  async retrieveAndPack(options: RetrieveAndPackOptions, packOptions?: PackOptions): Promise<ContextPack> {
    const packet = await this.retrieve(options);
    return packContext(packet, { ...(options.pack ?? {}), ...(packOptions ?? {}) });
  }
}

export function createContextEngine(options: ContextEngineOptions = {}): ContextEngine {
  return new ContextEngine(options);
}
