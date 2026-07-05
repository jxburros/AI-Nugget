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
/** Create a timeout/abort scope covering the full stream lifetime. */
export declare function streamTimeout(conn: ResolvedConnection, signal?: AbortSignal): ReturnType<typeof withTimeout>;
export declare function listOpenModels(conn: ResolvedConnection, profile: ProviderProfile): Promise<ModelInfo[]>;
export declare function health(conn: ResolvedConnection, profile: ProviderProfile): Promise<{
    ok: boolean;
    detail?: string;
}>;
export declare function requireResponse(condition: unknown, message: string): asserts condition;
//# sourceMappingURL=base.d.ts.map