import type { GovernancePolicy } from './types.js';
export declare function allowAllPolicy(): GovernancePolicy;
export declare function blocklistPolicy(patterns: RegExp[]): GovernancePolicy;
export declare function allowlistPolicy(prefixesByProvider: Record<string, string[]>): GovernancePolicy;
export declare function composePolicies(...policies: GovernancePolicy[]): GovernancePolicy;
//# sourceMappingURL=policy.d.ts.map