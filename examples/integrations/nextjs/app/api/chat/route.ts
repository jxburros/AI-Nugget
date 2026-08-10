/**
 * Next.js App Router integration starter — `app/api/chat/route.ts`.
 *
 * Copy this file into a Next.js app as `app/api/chat/route.ts` and change the
 * import to `@jxburros/ai-nugget`. The handler is module-scoped on purpose:
 * one instance per server process means its concurrency queue actually does
 * something (a per-request instance would enforce nothing).
 *
 * Runtime choice:
 *   - `nodejs` (below) — full Node APIs, the safe default.
 *   - `edge` — also works: the core is isomorphic (fetch/ReadableStream/
 *     AbortController/TextDecoder only). Use `envKeySource()` there too, but
 *     remember edge env vars are configured separately.
 *
 * Bundler note: if you vendor `nugget/` rather than installing the package,
 * point Turbopack at `nugget/dist/*.js`, not `nugget/src/*.ts` — see
 * docs/distribution.md.
 */
import { AIHandler, allowlistPolicy, envKeySource, type Connection } from '@jxburros/ai-nugget';

export const runtime = 'nodejs';

// Server-owned connection allowlist: the client sends `connectionId`, never a
// provider or baseUrl. See docs/security.md.
const CONNECTIONS: Record<string, { connection: Connection; defaultModel: string }> = {
  cloud: {
    connection: { id: 'cloud', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
    defaultModel: 'gpt-4o-mini',
  },
  local: {
    connection: { id: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', timeoutMs: 600_000, idleTimeoutMs: 30_000 },
    defaultModel: 'llama3.2',
  },
};

// Module scope: one handler per server process, so `limits` are meaningful.
// They are still per-instance — N serverless instances allow N x maxConcurrent.
const handler = new AIHandler({
  keySource: envKeySource(),
  policy: allowlistPolicy({ openai: ['gpt-4o', 'gpt-4o-mini'], ollama: ['*'] }),
  limits: { maxConcurrent: 8 },
});

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { connectionId?: string; model?: string; message?: string };
  const entry = CONNECTIONS[body.connectionId ?? 'cloud'];
  if (!entry) return Response.json({ error: 'unknown connection' }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        for await (const event of handler.stream(entry.connection, {
          model: body.model ?? entry.defaultModel,
          messages: [{ role: 'user', content: String(body.message ?? '') }],
          // `request.signal` aborts when the client disconnects — pass it
          // through so an abandoned request stops costing tokens.
          signal: request.signal,
        })) {
          if (event.type === 'delta') send('delta', { text: event.text });
          if (event.type === 'context') send('notice', { kind: event.kind, data: event.data });
          if (event.type === 'done') send('done', { usage: event.result.usage });
          if (event.type === 'error') send('error', { kind: event.error.kind, message: safeMessage(event.error.kind) });
        }
      } catch (error) {
        const kind = (error as { kind?: string }).kind ?? 'server';
        send('error', { kind, message: safeMessage(kind) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' },
  });
}

/** Never forward a provider message to the client; map the kind instead. */
function safeMessage(kind: string): string {
  const table: Record<string, string> = {
    invalid_request: 'That request was invalid.',
    context_length: 'Your input is too long.',
    rate_limit: 'The AI service is busy. Please try again shortly.',
    timeout: 'The request took too long.',
    policy_blocked: 'This request was blocked by policy.',
    auth: 'The AI service is not configured correctly.',
    key_unavailable: 'The AI service is not configured correctly.',
    not_found: 'The AI service is not configured correctly.',
  };
  return table[kind] ?? 'The AI service is temporarily unavailable.';
}
