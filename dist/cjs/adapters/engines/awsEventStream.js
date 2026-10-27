"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.awsEvents = awsEvents;
exports.crc32 = crc32;
const errors_js_1 = require("../../errors.js");
/** AWS EventStream framing, using Web APIs only. Bound frames and verify CRCs. */
async function* awsEvents(res, bump) {
    if (!res.body)
        throw malformed();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = new Uint8Array();
    let completed = false;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                completed = true;
                break;
            }
            bump();
            const next = new Uint8Array(pending.length + value.length);
            next.set(pending);
            next.set(value, pending.length);
            pending = next;
            while (pending.length >= 12) {
                const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
                const length = view.getUint32(0);
                const headersLength = view.getUint32(4);
                if (length < 16 || length > 16 * 1024 * 1024 || headersLength > length - 16 || crc32(pending.subarray(0, 8)) !== view.getUint32(8))
                    throw malformed();
                if (pending.length < length)
                    break;
                if (crc32(pending.subarray(0, length - 4)) !== view.getUint32(length - 4))
                    throw malformed();
                const headers = {};
                let offset = 12;
                const end = 12 + headersLength;
                while (offset < end) {
                    const nameLength = pending[offset++];
                    if (offset + nameLength + 3 > end)
                        throw malformed();
                    const name = decoder.decode(pending.subarray(offset, offset + nameLength));
                    offset += nameLength;
                    // Bedrock protocol headers are UTF-8 strings (type 7).
                    if (pending[offset++] !== 7)
                        throw malformed();
                    const size = view.getUint16(offset);
                    offset += 2;
                    if (offset + size > end)
                        throw malformed();
                    headers[name] = decoder.decode(pending.subarray(offset, offset + size));
                    offset += size;
                }
                let data;
                try {
                    data = JSON.parse(decoder.decode(pending.subarray(end, length - 4)));
                }
                catch {
                    throw malformed();
                }
                const type = headers[':event-type'] ?? headers[':exception-type'] ?? headers[':error-code'];
                if (!type)
                    throw malformed();
                yield { type, data };
                pending = pending.slice(length);
            }
        }
        if (pending.length)
            throw malformed();
    }
    finally {
        if (!completed)
            await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
function malformed() { return new errors_js_1.AIError('Malformed AWS EventStream frame', { kind: 'invalid_response', retryable: false }); }
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
