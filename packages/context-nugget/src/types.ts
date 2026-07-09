export type ContextTrust = 'trusted' | 'untrusted' | 'app' | 'user' | 'system';

export interface ContextSource {
  id: string;
  kind: 'text' | 'markdown' | 'json' | 'file' | 'url' | 'memory' | 'app_state' | string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
  trust?: ContextTrust;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContextSourceRef {
  sourceId: string;
  sourceKind: string;
  title?: string;
  path?: string;
  url?: string;
  page?: number;
  lineStart?: number;
  lineEnd?: number;
  section?: string;
  paragraph?: number;
}

export type ContextLayer =
  | 'session'
  | 'user'
  | 'project'
  | 'app'
  | 'agent'
  | 'model'
  | 'documents'
  | 'artifacts'
  | 'external'
  | string;

export interface ContextChunk {
  id: string;
  source: ContextSourceRef;
  text: string;
  layer?: ContextLayer;
  trust?: ContextTrust;
  metadata?: Record<string, unknown>;
  tokensEstimated?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemoryRecord {
  id: string;
  layer: ContextLayer;
  scope: string;
  text: string;
  source?: ContextSourceRef;
  tags?: string[];
  importance?: number;
  confidence?: number;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  status?: 'active' | 'archived' | 'superseded';
  supersedes?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryCandidate {
  layer: ContextLayer;
  scope: string;
  text: string;
  source?: ContextSourceRef;
  tags?: string[];
  importance?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryDecision {
  store: boolean;
  reason?: string;
  record?: Partial<MemoryRecord>;
}

export interface MemoryPolicy {
  mode: 'manual' | 'suggested' | 'auto';
  shouldStore?: (candidate: MemoryCandidate) => Promise<MemoryDecision> | MemoryDecision;
  shouldRetrieve?: (record: MemoryRecord, query: RetrievalQuery) => Promise<boolean> | boolean;
  shouldExpire?: (record: MemoryRecord) => Promise<boolean> | boolean;
}

export interface RetrievalQuery {
  query: string;
  layers?: ContextLayer[];
  filters?: Record<string, unknown>;
  budget?: ContextBudget;
  topK?: number;
  minScore?: number;
  strategy?: 'keyword' | 'bm25' | 'semantic' | 'hybrid' | 'manual' | string;
  scope?: string;
}

export interface RetrievalResult {
  chunk: ContextChunk;
  score: number;
  scoreBreakdown?: Record<string, number>;
  reasons?: string[];
  layer?: ContextLayer;
  retrievalMode: 'keyword' | 'bm25' | 'semantic' | 'hybrid' | 'manual' | 'recency' | string;
}

export interface ContextBudget {
  maxTokens?: number;
  maxChars?: number;
  maxItems?: number;
  maxItemsPerSource?: number;
  reserveTokens?: number;
}

export interface Citation {
  id: string;
  label: string;
  source: ContextSourceRef;
}

export interface ContextItem {
  id: string;
  text: string;
  source: ContextSourceRef;
  score?: number;
  layer?: ContextLayer;
  citation?: Citation;
  trust?: ContextTrust;
  tokensEstimated?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextPacket {
  id: string;
  query: string;
  layers: ContextLayer[];
  items: ContextItem[];
  sources: ContextSourceRef[];
  budget: ContextBudget;
  retrievalMode: 'keyword' | 'bm25' | 'semantic' | 'hybrid' | 'manual' | 'none' | string;
  degraded?: boolean;
  degradedReason?: string;
  visibilitySummary?: string;
  createdAt: string;
  diagnostics?: ContextDiagnostics;
}

export interface ContextDiagnostics {
  searchedChunks: number;
  returnedItems: number;
  excludedItems?: number;
  estimatedTokens: number;
  estimatedChars: number;
  reasons?: string[];
}

export interface ContextPack {
  packet: ContextPacket;
  text: string;
  citations: Citation[];
  sources: ContextSourceRef[];
  tokensEstimated?: number;
}

export interface ChunkerOptions {
  maxWords?: number;
  overlapWords?: number;
  layer?: ContextLayer;
}

export interface Chunker {
  chunk(source: ContextSource, options?: ChunkerOptions): ContextChunk[];
}

export interface StoreSnapshot {
  sources: ContextSource[];
  chunks: ContextChunk[];
  memories: MemoryRecord[];
}

export interface ContextStore {
  addSource(source: ContextSource): Promise<void> | void;
  addChunks(chunks: ContextChunk[]): Promise<void> | void;
  addMemory(record: MemoryRecord): Promise<void> | void;
  listSources(): Promise<ContextSource[]> | ContextSource[];
  listChunks(query?: RetrievalQuery): Promise<ContextChunk[]> | ContextChunk[];
  listMemories(query?: RetrievalQuery): Promise<MemoryRecord[]> | MemoryRecord[];
  export(): Promise<StoreSnapshot> | StoreSnapshot;
  import(snapshot: StoreSnapshot): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface Retriever {
  mode: RetrievalResult['retrievalMode'];
  retrieve(query: RetrievalQuery, chunks: ContextChunk[]): Promise<RetrievalResult[]> | RetrievalResult[];
}

export interface RankOptions {
  maxItemsPerSource?: number;
  diversityPenalty?: number;
}

export interface PackOptions {
  format?: 'markdown' | 'plain';
  includeCitations?: boolean;
  includeScores?: boolean;
  includeTrust?: boolean;
  trustBoundary?: 'none' | 'untrusted-source-data';
  heading?: string;
}

export interface RetrieveAndPackOptions extends RetrievalQuery {
  pack?: PackOptions;
}
