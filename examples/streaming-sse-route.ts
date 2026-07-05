/**
 * Transcribe the normalized StreamEvent iterable into Server-Sent Events from a
 * plain Node HTTP handler. The whole adapter is: `for await (event) -> res.write`.
 * Run with: OPENAI_API_KEY=sk-... npx tsx examples/streaming-sse-route.ts
 * then: curl -N 'http://localhost:8787/chat?q=hello'
 */
import { createServer } from 'node:http';
import { AIHandler, envKeySource, type Connection } from '@jxburros/ai-handler';

const handler = new AIHandler({ keySource: envKeySource() });
const connection: Connection = { id: 'main', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/chat') { res.writeHead(404).end(); return; }
  const prompt = url.searchParams.get('q') ?? 'Say hello.';

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // Abort the model call if the client disconnects.
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    for await (const event of handler.stream(connection, {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      signal: ac.signal,
    })) {
      // The event stream is already SSE-shaped; just JSON-frame each event.
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done' || event.type === 'error') break;
    }
  } finally {
    res.end();
  }
});

server.listen(8787, () => console.log('SSE demo on http://localhost:8787/chat?q=hello'));
