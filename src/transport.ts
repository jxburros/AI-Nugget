import { AIError, classify, fromUnknown } from './errors.js';

export function withTimeout(ms: number, external?: AbortSignal): {
  signal: AbortSignal;
  done(): void;
  timedOut(): boolean;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new AIError(`Request timed out after ${ms}ms`, { kind: 'timeout' }));
  }, ms);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
    timedOut() {
      return didTimeOut;
    },
  };
}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs: number; provider?: string }): Promise<{
  data: unknown;
  status: number;
  totalMs: number;
}> {
  const timeout = withTimeout(init.timeoutMs, init.signal ?? undefined);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: timeout.signal });
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw classify(res.status, raw, init.provider, res.headers);
    return { data: raw.trim() ? tolerantJson(raw) : null, status: res.status, totalMs: Date.now() - started };
  } catch (error) {
    if (timeout.timedOut()) throw new AIError(`Request timed out after ${init.timeoutMs}ms`, { kind: 'timeout', provider: init.provider });
    throw fromUnknown(error, init.provider);
  } finally {
    timeout.done();
  }
}

export async function* sseLines(res: Response): AsyncIterable<string> {
  for await (const line of textLines(res)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    yield data;
  }
}

export async function* ndjsonLines(res: Response): AsyncIterable<unknown> {
  for await (const line of textLines(res)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as unknown;
    } catch {
      throw new AIError('Provider returned malformed NDJSON', { kind: 'invalid_response' });
    }
  }
}

export async function* textLines(res: Response): AsyncIterable<string> {
  if (!res.body) {
    const raw = await res.text().catch(() => '');
    for (const line of raw.split(/\r?\n/)) yield line;
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

export async function postJsonResponse(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number, signal: AbortSignal | undefined, provider: string): Promise<Response> {
  const timeout = withTimeout(timeoutMs, signal);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw classify(res.status, raw, provider, res.headers);
    }
    return res;
  } catch (error) {
    if (timeout.timedOut()) throw new AIError(`Request timed out after ${timeoutMs}ms`, { kind: 'timeout', provider });
    throw fromUnknown(error, provider);
  } finally {
    timeout.done();
  }
}

function tolerantJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { text: raw };
  }
}
