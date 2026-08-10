/**
 * Proves the Express starter works end to end inside a real Node/Express host:
 * the package resolves through its `exports` map, the SSE bridge streams, and
 * the error mapper is reachable — all against the hermetic mock provider, so
 * no key and no network are needed.
 */
import assert from 'node:assert/strict';
import { startMockProvider } from '../mock-provider.mjs';

const mock = await startMockProvider();
process.env.AI_LOCAL_BASE_URL = mock.url;

const { app } = await import('./server.mjs');
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: 'local', model: 'mock-model', message: 'hi' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const body = await res.text();
  const deltas = [...body.matchAll(/^event: delta\ndata: (.*)$/gm)].map((m) => JSON.parse(m[1]).text);
  assert.equal(deltas.join(''), mock.expectedReply, 'streamed text should match the mock reply');
  assert.match(body, /^event: done$/m, 'a done frame must close the stream');

  const rejected = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: 'http://attacker.example', message: 'hi' }),
  });
  assert.equal(rejected.status, 400, 'an unknown connection id must be refused, never used as an endpoint');

  console.log('express integration OK');
} finally {
  server.close();
  await mock.close();
}
