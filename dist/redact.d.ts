import type { Redactor } from './types.js';
export declare function createDefaultRedactor(extraSecrets?: Iterable<string>): Redactor;
export declare class SessionRedactor implements Redactor {
    private secrets;
    private cached?;
    addSecret(value: string | null | undefined): void;
    redact(text: string): string;
}
//# sourceMappingURL=redact.d.ts.map