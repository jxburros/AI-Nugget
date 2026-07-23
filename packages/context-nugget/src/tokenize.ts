export interface TokenizeOptions {
  minLength?: number;
  stopwords?: Set<string>;
}

export const DEFAULT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'will', 'with', 'you', 'your', 'we', 'our', 'they', 'their'
]);

export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const minLength = options.minLength ?? 1;
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const stopwords = options.stopwords;
  return raw.filter((token) => token.length >= minLength && !stopwords?.has(token));
}

export function uniqueTokens(text: string, options: TokenizeOptions = {}): string[] {
  return [...new Set(tokenize(text, options))];
}
