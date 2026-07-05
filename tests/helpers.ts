import { vi } from 'vitest';
import type { ChatRequest, ResolvedConnection } from '../src/index.js';
import { applyAuth, profileFor } from '../src/adapters/profiles.js';

/**
 * Build a ResolvedConnection for engine-level tests, baking in the same auth
 * headers the handler's resolveConnection() would apply in production.
 */
export function resolved(provider: string, over: Partial<ResolvedConnection> = {}): ResolvedConnection {
  const apiKey = over.apiKey ?? 'sk-test';
  const baseUrl = over.baseUrl ?? 'https://api.test/v1';
  return {
    id: 'conn-1',
    provider,
    baseUrl,
    apiKey,
    headers: applyAuth(profileFor(provider, baseUrl), apiKey, over.headers ?? {}),
    timeoutMs: 5_000,
    ...over,
    // keep computed headers even when `over` supplied a partial
    ...(over.headers ? { headers: applyAuth(profileFor(provider, baseUrl), apiKey, over.headers) } : {}),
  };
}

export function chatReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], ...over };
}

/** SSE Response with a `[DONE]` sentinel, mirroring OpenAI/Anthropic/Gemini. */
export function sseResponse(frames: unknown[], includeDone = true): Response {
  const body = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')
    + (includeDone ? 'data: [DONE]\n\n' : '');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function ndjsonResponse(objs: unknown[]): Response {
  const body = objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

export function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}

/**
 * Replace global fetch with a scripted queue of responses. Each response is
 * consumed once (Response bodies are single-use); running past the end throws.
 * Captured calls expose URL / method / headers / parsed body for assertions.
 */
export function mockFetch(...responses: Array<Response | ((call: FetchCall) => Response | Promise<Response>)>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    let body: unknown;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call: FetchCall = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: normalizeHeaders(init.headers),
      body,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    if (index >= responses.length) throw new Error(`Unexpected fetch #${index + 1} to ${url}`);
    const next = responses[index++]!;
    return typeof next === 'function' ? next(call) : next;
  });
  return { calls };
}

/**
 * A streaming Response that emits `chunks`, then (if `hangUntilAbort`) blocks
 * until the request signal aborts — used to exercise mid-stream cancellation.
 */
export function streamingResponse(chunks: string[], opts: { contentType?: string; signal?: AbortSignal; hangUntilAbort?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!opts.hangUntilAbort) controller.close();
    },
    pull(controller) {
      if (!opts.hangUntilAbort) return;
      return new Promise<void>((_resolve, reject) => {
        const signal = opts.signal;
        const fail = () => reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        if (signal?.aborted) return fail();
        signal?.addEventListener('abort', fail, { once: true });
        // Otherwise never resolve: the stream stays open until aborted.
        void controller;
      });
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': opts.contentType ?? 'text/event-stream' } });
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  }
  return out;
}
