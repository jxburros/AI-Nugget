/**
 * Express integration starter.
 *
 * The four things a server host has to get right, and where each one is:
 *   1. Connections live server-side (CONNECTIONS below) — the client sends a
 *      `connectionId`, never a `provider` or `baseUrl`. See docs/security.md.
 *   2. Keys come from the environment through `envKeySource()`.
 *   3. Streaming maps `StreamEvent`s onto SSE frames.
 *   4. Every failure is an `AIError` with a `kind` mapped to one HTTP status.
 *
 * Run:
 *   npm install express
 *   OPENAI_API_KEY=sk-... node examples/integrations/express/server.mjs
 *   curl -N localhost:3000/api/chat -H 'content-type: application/json' \
 *        -d '{"connectionId":"cloud","message":"hi"}'
 *
 * Uses zero-key local Ollama by default: pass connectionId "local".
 */
import express from 'express';
import { AIHandler, allowlistPolicy, envKeySource } from '@jxburros/ai-nugget';

// 1. Server-owned connection allowlist. A client picks an id out of this map;
//    it can never name an endpoint of its own.
const CONNECTIONS = {
  cloud: { id: 'cloud', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
  local: { id: 'local', provider: 'ollama', baseUrl: process.env.AI_LOCAL_BASE_URL ?? 'http://127.0.0.1:11434', timeoutMs: 600_000, idleTimeoutMs: 30_000 },
};
const DEFAULT_MODEL = { cloud: 'gpt-4o-mini', local: 'llama3.2' };

const handler = new AIHandler({
  keySource: envKeySource(),
  // 2. Governance is explicit, so no "unrestricted" startup warning and no
  //    surprise if someone passes an unexpected model name.
  policy: allowlistPolicy({ openai: ['gpt-4o', 'gpt-4o-mini', '*'], ollama: ['*'] }),
  // 3. Per-instance limits. Behind N replicas the provider sees N x this.
  limits: { maxConcurrent: 8 },
  telemetry: { record: (r) => console.log('[ai]', r.provider, r.model, r.finishReason, r.timing.totalMs + 'ms') },
});

const app = express();
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const connection = CONNECTIONS[req.body?.connectionId];
  if (!connection) return res.status(400).json({ error: 'unknown connection' });
  const model = req.body?.model ?? DEFAULT_MODEL[connection.id];

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  // Abort the provider call when the client hangs up, so an abandoned browser
  // tab doesn't keep burning tokens.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    for await (const event of handler.stream(connection, {
      model,
      messages: [{ role: 'user', content: String(req.body?.message ?? '') }],
      signal: controller.signal,
    })) {
      if (event.type === 'delta') send('delta', { text: event.text });
      if (event.type === 'context') send('notice', { kind: event.kind, data: event.data });
      if (event.type === 'retry') send('notice', { kind: 'retry', data: { attempt: event.attempt } });
      if (event.type === 'done') send('done', { usage: event.result.usage, finishReason: event.result.finishReason });
      // `error` events carry an already-redacted AIError. Map, don't forward.
      if (event.type === 'error') send('error', httpError(event.error));
    }
  } catch (error) {
    send('error', httpError(error));
  } finally {
    res.end();
  }
});

/** 4. One place that turns an AIError kind into a status + safe message. */
function httpError(error) {
  const kind = error?.kind ?? 'server';
  const table = {
    invalid_request: [400, 'That request was invalid.'],
    context_length: [413, 'Your input is too long.'],
    not_found: [502, 'The AI service is not configured correctly.'],
    auth: [502, 'The AI service is not configured correctly.'],
    key_unavailable: [500, 'The AI service is not configured correctly.'],
    policy_blocked: [403, 'This request was blocked by policy.'],
    rate_limit: [429, 'The AI service is busy. Please try again shortly.'],
    timeout: [504, 'The request took too long.'],
    canceled: [499, 'The request was canceled.'],
    invalid_response: [502, "The AI response wasn't in the expected format."],
  };
  const [status, message] = table[kind] ?? [502, 'The AI service is temporarily unavailable.'];
  console.error('[ai:error]', kind, error?.message);   // full detail server-side only
  return { status, kind, message };
}

export { app, CONNECTIONS, DEFAULT_MODEL };

// Started directly (not imported by the verify script): listen.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`express starter on http://localhost:${port}`));
}
