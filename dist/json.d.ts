export declare function extractJson(text: string): unknown | null;
export declare function extractJsonWithSchema<T>(text: string, parse: (value: unknown) => T): T;
export declare function requireString(record: Record<string, unknown>, key: string): string;
export declare function requireNumber(record: Record<string, unknown>, key: string): number;
export declare function requireStringArray(record: Record<string, unknown>, key: string): string[];
export declare function requireOptionalString(record: Record<string, unknown>, key: string): string | undefined;
//# sourceMappingURL=json.d.ts.map