import { AIError, fromUnknown } from '../../errors.js';
import { fetchJson, withTimeout } from '../../transport.js';
import type { ContentPart, MediaOutput, ModelInfo, ResolvedConnection, StreamEvent } from '../../types.js';
import { asRecord, asString, joinUrl } from '../../util.js';
import type { ProviderProfile } from '../profiles.js';

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Maps a raw streaming failure onto a typed {@link AIError}. A fired timeout is
 * reported as `timeout` regardless of how the underlying `fetch` surfaced the
 * abort; anything else is normalized through {@link fromUnknown} (which passes
 * an existing {@link AIError} through untouched, preserving retryability).
 */
export function streamError(error: unknown, timeout: { timedOut(): boolean }, provider: string): AIError {
  if (timeout.timedOut()) return new AIError('Request timed out', { kind: 'timeout', provider });
  return fromUnknown(error, provider);
}

/**
 * Create a timeout/abort scope covering the full stream lifetime, plus an
 * optional idle timeout (`conn.idleTimeoutMs`) that the engine rearms via
 * `bump()` on each received chunk.
 */
export function streamTimeout(conn: ResolvedConnection, signal?: AbortSignal): ReturnType<typeof withTimeout> {
  return withTimeout(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal, conn.idleTimeoutMs);
}

export async function listOpenModels(conn: ResolvedConnection, profile: ProviderProfile): Promise<ModelInfo[]> {
  if (!profile.listModelsPath) return [];
  const { data } = await fetchJson(joinUrl(conn.baseUrl, profile.listModelsPath), {
    method: 'GET',
    headers: conn.headers,
    timeoutMs: conn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    provider: conn.provider,
      fetch: conn.fetch,
  });
  const record = asRecord(data);
  const items = Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : [];
  const models: ModelInfo[] = [];
  for (const item of items) {
    const row = asRecord(item);
    const id = asString(row?.id) ?? asString(row?.name);
    if (!id) continue;
    const contextWindow = asContextWindow(row);
    const capabilities = asCapabilities(row);
    const model: ModelInfo = {
      id,
      source: { provider: conn.provider, connectionId: conn.id, baseUrl: conn.baseUrl },
    };
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    if (capabilities) model.capabilities = capabilities;
    models.push(model);
  }
  return models;
}

export async function health(conn: ResolvedConnection, profile: ProviderProfile): Promise<{ ok: boolean; detail?: string }> {
  const path = profile.healthPath ?? profile.listModelsPath;
  if (!path && profile.quirks?.unsupportedProbe) return { ok: false, detail: 'This endpoint has no lightweight health probe; validate with an explicit model call.' };
  if (!path) return { ok: true };
  try {
    await fetchJson(joinUrl(conn.baseUrl, path), {
      method: 'GET',
      headers: conn.headers,
      timeoutMs: Math.min(conn.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000),
      provider: conn.provider,
      fetch: conn.fetch,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Health check failed' };
  }
}

/**
 * Coerce a provider's tool-call `arguments` into an object. Providers disagree
 * on the shape: OpenAI/Anthropic stream a JSON *string*, Google and Ollama send
 * a native object — but Ollama-compatible backends (llama.cpp and friends)
 * sometimes send a string too. Malformed JSON degrades to `{}` so a single bad
 * tool call surfaces as an argument-validation error rather than a stream crash.
 */
export function parseArgs(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return raw;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/** JSON.parse that returns undefined instead of throwing — for per-line stream frames. */
export function safeParse(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** Stable-enough id for a tool call a provider didn't give one for. */
export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * A stream that ended without the provider's terminal marker (an OpenAI
 * `finish_reason`, an Anthropic `message_delta.stop_reason`, a Google
 * `finishReason`, an Ollama `done`) was almost certainly truncated. Every
 * engine yields this so a dropped connection is diagnosable identically
 * regardless of provider.
 */
export function streamAnomaly(reason = 'stream ended without a terminal finish reason'): { type: 'context'; kind: string; data: unknown } {
  return { type: 'context', kind: 'stream_anomaly', data: { reason } };
}

/**
 * Pulls a context-window figure out of the many shapes providers use for it
 * (OpenRouter `context_length`, OpenAI-style `context_window`, Ollama
 * `/api/show` `model_info` entries surfaced as `contextWindow`).
 */
function asContextWindow(row: Record<string, unknown> | undefined): number | undefined {
  if (!row) return undefined;
  const direct = row['context_length'] ?? row['context_window'] ?? row['contextWindow'];
  return typeof direct === 'number' && Number.isFinite(direct) ? direct : undefined;
}

function asCapabilities(row: Record<string, unknown> | undefined): string[] | undefined {
  if (!row) return undefined;
  const value = row['capabilities'] ?? asRecord(row['architecture'])?.['modality'];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value as string[];
  if (typeof value === 'string') return [value];
  return undefined;
}

/** Base64 payload of a non-text part (`dataBase64`, or the legacy `imageBase64`). */
export function partBase64(part: ContentPart): string | undefined {
  return part.dataBase64 ?? part.imageBase64 ?? dataUrlPayload(part.url);
}

/** Default MIME type per part kind when the caller did not set one. */
export function partMime(part: ContentPart): string {
  if (part.mimeType) return part.mimeType;
  const fromUrl = part.url?.match(/^data:([^;,]+)[;,]/)?.[1];
  if (fromUrl) return fromUrl;
  return part.type === 'image' ? 'image/png' : part.type === 'audio' ? 'audio/wav' : part.type === 'video' ? 'video/mp4' : part.type === 'file' ? 'application/pdf' : 'text/plain';
}

/** A `data:` URL for the part, or its caller-supplied URL. */
export function partUrl(part: ContentPart): string {
  if (part.url) return part.url;
  return `data:${partMime(part)};base64,${partBase64(part) ?? ''}`;
}

/** True when the part carries inline bytes rather than only a remote URL. */
export function partHasBytes(part: ContentPart): boolean {
  return (part.dataBase64 ?? part.imageBase64) !== undefined || (part.url?.startsWith('data:') ?? false);
}

/** Typed, non-retryable failure for a content part this protocol cannot carry. */
export function unsupportedPart(provider: string, part: ContentPart, detail = ''): AIError {
  return new AIError(`${provider} cannot accept ${part.type} input${detail ? ` ${detail}` : ''} on this protocol`, { kind: 'invalid_request', retryable: false, provider });
}

/** Builds a {@link MediaOutput} from a `data:` URL or a remote URL. */
export function mediaFromUrl(type: MediaOutput['type'], url: string, fallbackMime: string): MediaOutput {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
  return match ? { type, mimeType: match[1]!, dataBase64: match[2]! } : { type, mimeType: fallbackMime, url };
}

function dataUrlPayload(url: string | undefined): string | undefined {
  return url?.match(/^data:[^,]*;base64,(.*)$/s)?.[1];
}

/** Context event for a provider with no request-level prompt-cache control. */
export function promptCacheUnsupported(provider: string): StreamEvent {
  return { type: 'context', kind: 'prompt_cache_unsupported', data: { provider, reason: 'This provider has no request-level prompt-cache control here; any caching it does is implicit.' } };
}

/** Typed failure when a protocol cannot hand MCP servers to the provider. */
export function mcpUnsupported(provider: string, protocol: string): AIError {
  return new AIError(`${provider} ${protocol} cannot connect provider-hosted MCP servers; use protocol: 'responses' or the anthropic engine`, { kind: 'invalid_request', retryable: false, provider });
}
