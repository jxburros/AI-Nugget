import { AIError } from '../../errors.js';
import { withTimeout } from '../../transport.js';
import type { ContentPart, MediaOutput, ModelInfo, ResolvedConnection, StreamEvent } from '../../types.js';
import type { ProviderProfile } from '../profiles.js';
export declare const DEFAULT_TIMEOUT_MS = 120000;
/**
 * Maps a raw streaming failure onto a typed {@link AIError}. A fired timeout is
 * reported as `timeout` regardless of how the underlying `fetch` surfaced the
 * abort; anything else is normalized through {@link fromUnknown} (which passes
 * an existing {@link AIError} through untouched, preserving retryability).
 */
export declare function streamError(error: unknown, timeout: {
    timedOut(): boolean;
}, provider: string): AIError;
/**
 * Create a timeout/abort scope covering the full stream lifetime, plus an
 * optional idle timeout (`conn.idleTimeoutMs`) that the engine rearms via
 * `bump()` on each received chunk.
 */
export declare function streamTimeout(conn: ResolvedConnection, signal?: AbortSignal): ReturnType<typeof withTimeout>;
export declare function listOpenModels(conn: ResolvedConnection, profile: ProviderProfile): Promise<ModelInfo[]>;
export declare function health(conn: ResolvedConnection, profile: ProviderProfile): Promise<{
    ok: boolean;
    detail?: string;
}>;
/**
 * Coerce a provider's tool-call `arguments` into an object. Providers disagree
 * on the shape: OpenAI/Anthropic stream a JSON *string*, Google and Ollama send
 * a native object — but Ollama-compatible backends (llama.cpp and friends)
 * sometimes send a string too. Malformed JSON degrades to `{}` so a single bad
 * tool call surfaces as an argument-validation error rather than a stream crash.
 */
export declare function parseArgs(raw: unknown): unknown;
/** JSON.parse that returns undefined instead of throwing — for per-line stream frames. */
export declare function safeParse(line: string): unknown;
/** Stable-enough id for a tool call a provider didn't give one for. */
export declare function randomId(): string;
/**
 * A stream that ended without the provider's terminal marker (an OpenAI
 * `finish_reason`, an Anthropic `message_delta.stop_reason`, a Google
 * `finishReason`, an Ollama `done`) was almost certainly truncated. Every
 * engine yields this so a dropped connection is diagnosable identically
 * regardless of provider.
 */
export declare function streamAnomaly(reason?: string): {
    type: 'context';
    kind: string;
    data: unknown;
};
/** Base64 payload of a non-text part (`dataBase64`, or the legacy `imageBase64`). */
export declare function partBase64(part: ContentPart): string | undefined;
/** Default MIME type per part kind when the caller did not set one. */
export declare function partMime(part: ContentPart): string;
/** A `data:` URL for the part, or its caller-supplied URL. */
export declare function partUrl(part: ContentPart): string;
/** True when the part carries inline bytes rather than only a remote URL. */
export declare function partHasBytes(part: ContentPart): boolean;
/** Typed, non-retryable failure for a content part this protocol cannot carry. */
export declare function unsupportedPart(provider: string, part: ContentPart, detail?: string): AIError;
/** Builds a {@link MediaOutput} from a `data:` URL or a remote URL. */
export declare function mediaFromUrl(type: MediaOutput['type'], url: string, fallbackMime: string): MediaOutput;
/** Context event for a provider with no request-level prompt-cache control. */
export declare function promptCacheUnsupported(provider: string): StreamEvent;
/** Typed failure when a protocol cannot hand MCP servers to the provider. */
export declare function mcpUnsupported(provider: string, protocol: string): AIError;
//# sourceMappingURL=base.d.ts.map