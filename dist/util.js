export function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
export function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
export function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function promptChars(messages) {
    return messages.reduce((sum, message) => {
        if (typeof message.content === 'string')
            return sum + message.content.length;
        return sum + message.content.reduce((partSum, part) => partSum + (part.text?.length ?? 0) + (part.imageBase64?.length ?? 0), 0);
    }, 0);
}
export function textFromMessages(messages) {
    return messages.map((message) => {
        if (typeof message.content === 'string')
            return message.content;
        return message.content.map((part) => part.text ?? '').join('');
    }).join('\n');
}
export function sleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const timer = setTimeout(() => {
            settled = true;
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new DOMException('Sleep aborted', 'AbortError'));
        };
        if (signal) {
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}
//# sourceMappingURL=util.js.map