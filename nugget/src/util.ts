import type { ChatMessage } from './types.js';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function promptChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    if (typeof message.content === 'string') return sum + message.content.length;
    return sum + message.content.reduce((partSum, part) => partSum + (part.text?.length ?? 0) + (part.imageBase64?.length ?? 0), 0);
  }, 0);
}

export function textFromMessages(messages: ChatMessage[]): string {
  return messages.map((message) => {
    if (typeof message.content === 'string') return message.content;
    return message.content.map((part) => part.text ?? '').join('');
  }).join('\n');
}

export function globalEnv(): Record<string, string | undefined> {
  const maybeProcess = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env ?? {};
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('Sleep aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
