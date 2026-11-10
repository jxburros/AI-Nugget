export declare function extractJson(text: string): unknown | null;
export declare function extractJsonWithSchema<T>(text: string, parse: (value: unknown) => T): T;
export declare function requireString(record: Record<string, unknown>, key: string): string;
export declare function requireNumber(record: Record<string, unknown>, key: string): number;
export declare function requireStringArray(record: Record<string, unknown>, key: string): string[];
export declare function requireOptionalString(record: Record<string, unknown>, key: string): string | undefined;
/**
 * JSON Schema for a Standard Schema validator that implements the
 * [Standard JSON Schema](https://standardschema.dev/json-schema) extension,
 * or undefined when it does not (or cannot convert). Targets draft-07 first —
 * the dialect provider tool/response schemas accept most widely — then
 * draft-2020-12. The top-level `$schema` marker is removed because several
 * providers reject unknown keywords there.
 */
export declare function standardJsonSchema(schema: unknown, io?: 'input' | 'output'): Record<string, unknown> | undefined;
//# sourceMappingURL=json.d.ts.map