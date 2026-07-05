import type { Redactor } from './types.js';
export declare function createDefaultRedactor(extraSecrets?: Iterable<string>): Redactor;
export declare class SessionRedactor implements Redactor {
    private secrets;
    addSecret(value: string | null | undefined): void;
    redact(text: string): string;
}
//# sourceMappingURL=redact.d.ts.map