import type { Chunker, ChunkerOptions, ContextChunk, ContextSource, ContextSourceRef } from './types.js';
import { estimateTokens, makeId } from './util.js';

export interface TextChunkerOptions extends ChunkerOptions {
  preserveParagraphs?: boolean;
}

function sourceRefFor(source: ContextSource, extra: Partial<ContextSourceRef> = {}): ContextSourceRef {
  return {
    sourceId: source.id,
    sourceKind: source.kind,
    title: source.title,
    path: typeof source.metadata?.path === 'string' ? source.metadata.path : undefined,
    url: typeof source.metadata?.url === 'string' ? source.metadata.url : undefined,
    ...extra,
  };
}

function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function chunkWords(words: string[], maxWords: number, overlapWords: number): { text: string; startWord: number; endWord: number }[] {
  if (words.length === 0) return [];
  const safeMax = Math.max(1, maxWords);
  const safeOverlap = Math.max(0, Math.min(overlapWords, safeMax - 1));
  const out: { text: string; startWord: number; endWord: number }[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(words.length, start + safeMax);
    out.push({ text: words.slice(start, end).join(' '), startWord: start, endWord: end });
    if (end >= words.length) break;
    start = end - safeOverlap;
  }
  return out;
}

function lineRangeForText(fullText: string, chunkText: string, searchStart = 0): { lineStart?: number; lineEnd?: number; nextSearchStart: number } {
  const idx = fullText.indexOf(chunkText.slice(0, Math.min(80, chunkText.length)), searchStart);
  if (idx < 0) return { nextSearchStart: searchStart };
  const before = fullText.slice(0, idx);
  const lineStart = before.split('\n').length;
  const lineEnd = lineStart + chunkText.split('\n').length - 1;
  return { lineStart, lineEnd, nextSearchStart: idx + Math.max(1, chunkText.length) };
}

export function textChunker(defaults: TextChunkerOptions = {}): Chunker {
  return {
    chunk(source: ContextSource, options: ChunkerOptions = {}): ContextChunk[] {
      const maxWords = options.maxWords ?? defaults.maxWords ?? 400;
      const overlapWords = options.overlapWords ?? defaults.overlapWords ?? 60;
      const layer = options.layer ?? defaults.layer ?? 'documents';
      const words = wordsOf(source.content);
      const chunks = chunkWords(words, maxWords, overlapWords);
      let searchStart = 0;
      return chunks.map((chunk, index) => {
        const range = lineRangeForText(source.content, chunk.text, searchStart);
        searchStart = range.nextSearchStart;
        return {
          id: makeId('chunk', `${source.id}:${index}:${chunk.text.slice(0, 120)}`),
          source: sourceRefFor(source, { lineStart: range.lineStart, lineEnd: range.lineEnd }),
          text: chunk.text,
          layer,
          trust: source.trust ?? 'untrusted',
          metadata: { ...source.metadata, chunkIndex: index, startWord: chunk.startWord, endWord: chunk.endWord },
          tokensEstimated: estimateTokens(chunk.text),
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        };
      });
    },
  };
}

interface MarkdownSection {
  headingPath: string[];
  startLine: number;
  lines: string[];
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  let headingStack: string[] = [];
  let current: MarkdownSection = { headingPath: [], startLine: 1, lines: [] };

  const pushCurrent = () => {
    if (current.lines.join('\n').trim()) sections.push(current);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      pushCurrent();
      const level = heading[1]?.length ?? 1;
      const title = heading[2]?.replace(/#+\s*$/, '').trim() ?? '';
      headingStack = headingStack.slice(0, level - 1);
      headingStack[level - 1] = title;
      current = { headingPath: headingStack.filter(Boolean), startLine: i + 1, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  pushCurrent();
  return sections;
}

function splitSection(section: MarkdownSection, maxWords: number, overlapWords: number): string[] {
  const text = section.lines.join('\n').trim();
  if (wordsOf(text).length <= maxWords) return [text];

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buffer: string[] = [];
  let bufferWords = 0;

  const flush = () => {
    if (buffer.length) {
      out.push(buffer.join('\n\n'));
      buffer = [];
      bufferWords = 0;
    }
  };

  for (const paragraph of paragraphs) {
    const count = wordsOf(paragraph).length;
    if (count > maxWords) {
      flush();
      out.push(...chunkWords(wordsOf(paragraph), maxWords, overlapWords).map((c) => c.text));
      continue;
    }
    if (bufferWords + count > maxWords && bufferWords > 0) flush();
    buffer.push(paragraph);
    bufferWords += count;
  }
  flush();
  return out;
}

export function markdownChunker(defaults: TextChunkerOptions = {}): Chunker {
  return {
    chunk(source: ContextSource, options: ChunkerOptions = {}): ContextChunk[] {
      const maxWords = options.maxWords ?? defaults.maxWords ?? 360;
      const overlapWords = options.overlapWords ?? defaults.overlapWords ?? 40;
      const layer = options.layer ?? defaults.layer ?? 'documents';
      const sections = parseMarkdownSections(source.content);
      const chunks: ContextChunk[] = [];
      for (const section of sections) {
        const sectionText = section.lines.join('\n').trim();
        const pieces = splitSection(section, maxWords, overlapWords);
        let searchStart = 0;
        for (const piece of pieces) {
          const localRange = lineRangeForText(sectionText, piece, searchStart);
          searchStart = localRange.nextSearchStart;
          const lineStart = localRange.lineStart ? section.startLine + localRange.lineStart - 1 : section.startLine;
          const lineEnd = localRange.lineEnd ? section.startLine + localRange.lineEnd - 1 : section.startLine + section.lines.length - 1;
          const sectionLabel = section.headingPath.join(' > ') || undefined;
          chunks.push({
            id: makeId('chunk', `${source.id}:${section.startLine}:${chunks.length}:${piece.slice(0, 160)}`),
            source: sourceRefFor(source, { section: sectionLabel, lineStart, lineEnd }),
            text: piece,
            layer,
            trust: source.trust ?? 'untrusted',
            metadata: { ...source.metadata, chunkIndex: chunks.length, headingPath: section.headingPath },
            tokensEstimated: estimateTokens(piece),
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
          });
        }
      }
      if (chunks.length === 0 && source.content.trim()) {
        return textChunker(defaults).chunk(source, options);
      }
      return chunks;
    },
  };
}
