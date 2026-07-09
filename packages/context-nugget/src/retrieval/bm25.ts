import type { ContextChunk, RetrievalQuery, RetrievalResult, Retriever } from '../types.js';
import { tokenize } from '../tokenize.js';

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

export interface BM25IndexOptions {
  k1?: number;
  b?: number;
}

export interface BM25TermContribution {
  term: string;
  score: number;
}

export interface BM25Hit {
  id: string;
  score: number;
  termContributions: BM25TermContribution[];
}

export class BM25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly chunks: ContextChunk[];
  private readonly tf = new Map<string, Map<number, number>>();
  private readonly df = new Map<string, number>();
  private readonly docLens: number[] = [];
  private readonly avgDocLen: number;

  constructor(chunks: ContextChunk[], options: BM25IndexOptions = {}) {
    this.k1 = options.k1 ?? DEFAULT_K1;
    this.b = options.b ?? DEFAULT_B;
    this.chunks = chunks;
    let totalLen = 0;

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (!chunk) continue;
      const tokens = tokenize(chunk.text);
      this.docLens.push(tokens.length);
      totalLen += tokens.length;
      const freq = new Map<string, number>();
      for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
      for (const [term, count] of freq) {
        let postings = this.tf.get(term);
        if (!postings) {
          postings = new Map();
          this.tf.set(term, postings);
        }
        postings.set(i, count);
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    this.avgDocLen = chunks.length > 0 ? totalLen / chunks.length : 1;
  }

  query(query: string, topK = 8, minScore = 0): BM25Hit[] {
    const N = this.chunks.length;
    if (N === 0) return [];
    const scores = new Float64Array(N);
    const contributions = new Map<number, Map<string, number>>();
    const queryTokens = tokenize(query);

    for (const term of queryTokens) {
      const postings = this.tf.get(term);
      if (!postings) continue;
      const df = this.df.get(term) ?? 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      for (const [docIdx, termFreq] of postings) {
        const dl = this.docLens[docIdx] ?? 0;
        const numerator = termFreq * (this.k1 + 1);
        const denominator = termFreq + this.k1 * (1 - this.b + this.b * (dl / this.avgDocLen));
        const termScore = idf * (numerator / denominator);
        scores[docIdx] = (scores[docIdx] ?? 0) + termScore;
        let byTerm = contributions.get(docIdx);
        if (!byTerm) {
          byTerm = new Map();
          contributions.set(docIdx, byTerm);
        }
        byTerm.set(term, (byTerm.get(term) ?? 0) + termScore);
      }
    }

    const out: BM25Hit[] = [];
    for (let i = 0; i < N; i += 1) {
      const score = scores[i] ?? 0;
      if (score <= minScore) continue;
      const byTerm = contributions.get(i) ?? new Map();
      out.push({
        id: this.chunks[i]?.id ?? String(i),
        score,
        termContributions: [...byTerm.entries()]
          .map(([term, score]) => ({ term, score }))
          .sort((a, b) => b.score - a.score),
      });
    }
    out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return out.slice(0, topK);
  }

  getChunk(id: string): ContextChunk | undefined {
    return this.chunks.find((chunk) => chunk.id === id);
  }
}

export class BM25Retriever implements Retriever {
  readonly mode = 'bm25' as const;
  constructor(private readonly options: BM25IndexOptions = {}) {}

  retrieve(query: RetrievalQuery, chunks: ContextChunk[]): RetrievalResult[] {
    const index = new BM25Index(chunks, this.options);
    const hits = index.query(query.query, query.topK ?? 8, query.minScore ?? 0);
    const results: RetrievalResult[] = [];
    for (const hit of hits) {
      const chunk = index.getChunk(hit.id);
      if (!chunk) continue;
      const topTerms = hit.termContributions.slice(0, 4).map((t) => t.term);
      results.push({
        chunk,
        score: hit.score,
        scoreBreakdown: { bm25: hit.score },
        reasons: topTerms.length ? [`matched terms: ${topTerms.join(', ')}`] : ['bm25 match'],
        layer: chunk.layer,
        retrievalMode: this.mode,
      });
    }
    return results;
  }
}

export function bm25Retriever(options: BM25IndexOptions = {}): BM25Retriever {
  return new BM25Retriever(options);
}
