import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { AIHandler, envKeySource } from '../../dist/index.js';

const handler = new AIHandler({ keySource: envKeySource() });
const port = Number(process.env.PORT ?? 3210);
const publicDir = new URL('./public/', import.meta.url);
const packageJsonUrl = new URL('../../package.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));

const furnaceFacts = [
  'Steel gets stronger when the right heat meets the right cooling curve.',
  'A blast furnace can run for years before a major relining shutdown.',
  'Rolling mills turn rough slabs into precise sheets with repeated high-pressure passes.',
  'Tempering trades a little hardness for a lot more toughness.',
];

const quirkySignoffs = [
  'Shift whistle says we nailed it.',
  'That answer is fresh off the conveyor.',
  'Certified by the Department of Dramatic Clanks.',
  'Stamped, cooled, and ready for dispatch.',
];

const allConnections = [
  {
    id: 'local-ollama',
    label: 'Local Ollama',
    provider: 'ollama',
    keyRef: { kind: 'none' },
    defaultModel: process.env.OLLAMA_MODEL ?? 'llama3.2',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    keyRef: { kind: 'env', name: 'OPENAI_API_KEY' },
    defaultModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    keyRef: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
    defaultModel: process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
  },
  {
    id: 'google',
    label: 'Google',
    provider: 'google',
    keyRef: { kind: 'env', name: 'GOOGLE_API_KEY' },
    defaultModel: process.env.GOOGLE_MODEL ?? 'gemini-1.5-flash',
  },
].filter((connection) => connection.keyRef.kind === 'none' || !!process.env[connection.keyRef.name]);

const connectionCatalog = await Promise.all(
  allConnections.map(async (connection) => {
    const models = await handler.listModels(connection).catch(() => []);
    return {
      id: connection.id,
      label: connection.label,
      provider: connection.provider,
      defaultModel: connection.defaultModel,
      models: models.length ? models.map((model) => model.id) : [connection.defaultModel],
    };
  }),
);

const connectionById = new Map(allConnections.map((connection) => [connection.id, connection]));
const catalogById = new Map(connectionCatalog.map((connection) => [connection.id, connection]));

const SYSTEM_PROMPT = [
  'You are Millie, an upbeat industrial chatbot with a steel mill personality.',
  'Answer clearly and helpfully, with occasional metalworking flavor and light humor.',
  'Keep responses practical first, playful second.',
  'If the user enables forge mode, lean a little more theatrical and vivid.',
].join(' ');

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content.slice(0, 4000) : '',
    }))
    .filter((message) => message.content.trim());
}

async function serveStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url;
  const fileUrl = new URL(`.${requestPath}`, publicDir);

  try {
    const body = await readFile(fileUrl);
    const contentType = mimeTypes[extname(fileUrl.pathname)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: 'Missing URL' });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/meta') {
    sendJson(res, 200, {
      appName: 'Steel Mill Chat',
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      furnaceFact: pickRandom(furnaceFacts),
      connections: connectionCatalog,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk.toString('utf8');
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(rawBody || '{}');
        const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : connectionCatalog[0]?.id;
        const model = typeof payload.model === 'string' ? payload.model : catalogById.get(connectionId)?.defaultModel;
        const forgeMode = Boolean(payload.forgeMode);
        const messages = sanitizeMessages(payload.messages);

        if (!connectionId || !model || !messages.length) {
          sendJson(res, 400, { error: 'Connection, model, and at least one message are required.' });
          return;
        }

        const connection = connectionById.get(connectionId);
        if (!connection) {
          sendJson(res, 404, { error: 'Unknown connection.' });
          return;
        }

        const result = await handler.chat(connection, {
          model,
          temperature: forgeMode ? 0.9 : 0.7,
          messages: [
            {
              role: 'system',
              content: forgeMode
                ? `${SYSTEM_PROMPT} Forge mode is on, so add a bit more flamboyant shop-floor energy and one short metal-themed flourish.`
                : SYSTEM_PROMPT,
            },
            ...messages,
          ],
        });

        sendJson(res, 200, {
          reply: `${result.text}\n\n${pickRandom(quirkySignoffs)}`,
          usage: result.usage,
          timing: result.timing,
          finishReason: result.finishReason,
          source: result.source,
          packageVersion: packageJson.version,
          furnaceFact: pickRandom(furnaceFacts),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        sendJson(res, 500, { error: message });
      }
    });
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(port, () => {
  console.log(`Steel Mill Chat listening on http://localhost:${port}`);
});
