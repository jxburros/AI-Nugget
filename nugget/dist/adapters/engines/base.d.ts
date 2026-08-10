import { AIError } from '../../errors.js';
import { withTimeout } from '../../transport.js';
import type { ModelInfo, ResolvedConnection } from '../../types.js';
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
//# sourceMappingURL=base.d.ts.map