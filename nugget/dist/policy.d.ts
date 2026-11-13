import type { GovernancePolicy } from './types.js';
export declare function allowAllPolicy(): GovernancePolicy;
export declare function blocklistPolicy(patterns: RegExp[]): GovernancePolicy;
export declare function allowlistPolicy(prefixesByProvider: Record<string, string[]>): GovernancePolicy;
/**
 * Allow provider-hosted MCP servers only when their URL starts with one of the
 * given prefixes (e.g. `https://mcp.example.com/`). Every model stays allowed;
 * compose with a model policy via {@link composePolicies}.
 */
export declare function mcpServerAllowlistPolicy(urlPrefixes: string[]): GovernancePolicy;
export declare function composePolicies(...policies: GovernancePolicy[]): GovernancePolicy;
//# sourceMappingURL=policy.d.ts.map