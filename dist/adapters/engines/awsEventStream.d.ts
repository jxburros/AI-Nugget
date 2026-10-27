/** AWS EventStream framing, using Web APIs only. Bound frames and verify CRCs. */
export declare function awsEvents(res: Response, bump: () => void): AsyncIterable<{
    type: string;
    data: unknown;
}>;
export declare function crc32(bytes: Uint8Array): number;
//# sourceMappingURL=awsEventStream.d.ts.map