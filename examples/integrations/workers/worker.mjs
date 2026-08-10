/**
 * Cloudflare Workers (edge runtime) integration starter.
 *
 * Why this works with no shims: the core is isomorphic — `fetch`,
 * `ReadableStream`, `AbortController`, `TextDecoder`, and nothing else. There
 * are no Node built-ins in `src/`, so the same code runs on workerd, Deno
 * Deploy, Vercel Edge, and Bun.
 *
 * Two things differ from a Node host:
 *   1. There is no `process.env`. Secrets arrive as the `env` binding on each
 *      request, so build the KeySource per request from that binding instead of
 *      calling `envKeySource()` at module scope.
 *   2. Isolates are short-lived and numerous. `limits` are per-isolate, which at
 *      the edge means effectively per-request — do not rely on them for a global
 *      rate ceiling; use your provider's project limits or a gateway.
 *
 * Deploy: `npx wrangler deploy`, with `wrangler secret put OPENAI_API_KEY`.
 */
import { AIHandler, allowlistPolicy } from '@jxburros/ai-nugget';

const CONNECTIONS = {
  cloud: { connection: { id: 'cloud', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } }, defaultModel: 'gpt-4o-mini' },
};

/** A KeySource over the Workers `env` binding — the edge equivalent of envKeySource(). */
function bindingKeySource(env) {
  return {
    async resolve(ref) {
      if (ref.kind === 'none') return { ok: true, apiKey: null };
      if (ref.kind !== 'env') return { ok: false, reason: 'denied' };
      const value = env[ref.name];
      return value ? { ok: true, apiKey: value } : { ok: false, reason: 'missing' };
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });

    const body = await request.json().catch(() => ({}));
    const entry = CONNECTIONS[body.connectionId ?? 'cloud'];
    if (!entry) return Response.json({ error: 'unknown connection' }, { status: 400 });

    const handler = new AIHandler({
      keySource: bindingKeySource(env),
      policy: allowlistPolicy({ openai: ['gpt-4o', 'gpt-4o-mini'] }),
      // `waitUntil` lets a telemetry write outlive the response without holding
      // the client connection open — the edge-native way to record a call.
      telemetry: { record: (r) => ctx.waitUntil(recordCall(env, r)) },
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        try {
          for await (const event of handler.stream(entry.connection, {
            model: body.model ?? entry.defaultModel,
            messages: [{ role: 'user', content: String(body.message ?? '') }],
            signal: request.signal,
          })) {
            if (event.type === 'delta') send('delta', { text: event.text });
            if (event.type === 'done') send('done', { usage: event.result.usage });
            if (event.type === 'error') send('error', { kind: event.error.kind });
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
};

async function recordCall(env, record) {
  // Replace with an Analytics Engine / KV / queue write. The record is already
  // redacted — no key can appear in it.
  if (env.AI_ANALYTICS) env.AI_ANALYTICS.writeDataPoint({ blobs: [record.provider, record.model, record.finishReason] });
}
