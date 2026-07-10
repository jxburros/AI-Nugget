import { AIError } from '../../errors.js';
import { withTimeout } from '../../transport.js';
import type { ModelInfo, ResolvedConnection } from '../../types.js';
import type { ProviderProfile } from '../profiles.js';
export declare const DEFAULT_TIMEOUT_MS = 120000;
export declare const DEFAULT_IDLE_TIMEOUT_MS = 30000;
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
 * Builds a request body outside the wire call's retry path. Engines build the
 * body synchronously right before the fetch; without this, a deterministic
 * bug in that step (a malformed message shape, a circular `metadata` object)
 * throws a generic `Error` that `fromUnknown` classifies as retryable
 * `network`, burning every retry attempt on a failure that will never
 * succeed. Wrapping it here turns that into an honest, non-retryable
 * `invalid_request` before it ever reaches `streamError`/`fromUnknown`.
 */
export declare function buildBody<T>(build: () => T, provider: string): T;
/**
 * Create a timeout/abort scope covering the full stream lifetime, plus an
 * idle deadline (reset on every chunk via the returned `bump()`) so a
 * healthy-but-slow stream isn't killed by the total deadline while a
 * genuinely stalled one is still caught quickly. Set `conn.idleTimeoutMs` to
 * `Infinity` to disable the idle deadline and keep only the total one.
 */
export declare function streamTimeout(conn: ResolvedConnection, signal?: AbortSignal): ReturnType<typeof withTimeout>;
export declare function listOpenModels(conn: ResolvedConnection, profile: ProviderProfile): Promise<ModelInfo[]>;
export declare function health(conn: ResolvedConnection, profile: ProviderProfile): Promise<{
    ok: boolean;
    detail?: string;
}>;
export declare function requireResponse(condition: unknown, message: string): asserts condition;
//# sourceMappingURL=base.d.ts.map