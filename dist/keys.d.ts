import type { KeyRef, KeySource } from './types.js';
export declare function parseKeyRef(value?: string | null): KeyRef;
export declare function envKeySource(env?: Record<string, string | undefined>): KeySource;
export declare function literalKeySource(): KeySource;
export declare function memoryKeySource(values: Record<string, string | null | undefined>): KeySource;
export declare function chainKeySources(...sources: KeySource[]): KeySource;
//# sourceMappingURL=keys.d.ts.map