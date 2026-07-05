import type { ModelInfo, ResolvedConnection } from '../../types.js';
import type { ProviderProfile } from '../profiles.js';
export declare function listOpenModels(conn: ResolvedConnection, profile: ProviderProfile): Promise<ModelInfo[]>;
export declare function health(conn: ResolvedConnection, profile: ProviderProfile): Promise<{
    ok: boolean;
    detail?: string;
}>;
export declare function requireResponse(condition: unknown, message: string): asserts condition;
//# sourceMappingURL=base.d.ts.map