/**
 * A hermetic stand-in for a model provider, used by the integration starters'
 * `verify` scripts so CI can prove the package resolves, streams, and maps
 * errors inside a real host toolchain without any API key or network access.
 *
 * Speaks enough of two protocols to drive the engines end to end:
 *   OpenAI-compatible — GET /v1/models, POST /v1/chat/completions (SSE)
 *   Ollama            — GET /api/tags, POST /api/show, POST /api/chat (NDJSON)
 */
import { createServer } from 'node:http';

const REPLY = ['Hello', ' from', ' the', ' mock', ' provider.'];

export async function startMockProvider() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      return json(res, { data: [{ id: 'mock-model' }] });
    }
    if (req.method === 'GET' && path === '/api/tags') {
      return json(res, { models: [{ name: 'mock-model' }] });
    }
    if (req.method === 'POST' && path === '/api/show') {
      return json(res, { capabilities: ['completion'], model_info: { 'mock.context_length': 8192 } });
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const text of REPLY) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 5 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (req.method === 'POST' && path === '/api/chat') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const text of REPLY) res.write(JSON.stringify({ message: { role: 'assistant', content: text }, done: false }) + '\n');
      res.write(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 5 }) + '\n');
      return res.end();
    }
    return json(res, { error: { message: `no mock route for ${req.method} ${path}` } }, 404);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    expectedReply: REPLY.join(''),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
