import express from 'express';
import { fileURLToPath } from 'node:url';
import { AIError, AIHandler, envKeySource, extractJsonWithSchema, requireString } from '@jxburros/ai-nugget';
import { statusForError, messageForError } from './ai-error-map.mjs';

// AI Nugget ships an `envConnection()` helper (next release after 0.3.1) that
// collapses this block into one call; this example still targets the
// published 0.3.1 range, so it stays inline until that release goes out.
const app = express();
const port = process.env.PORT || 3031;
const handler = new AIHandler({ keySource: envKeySource() });
const connection = { id: 'prompt-mirror', provider: process.env.AI_PROVIDER || 'openai', keyRef: { kind: 'env', name: process.env.AI_KEY_ENV || 'OPENAI_API_KEY' } };
const model = process.env.AI_MODEL || 'gpt-4o-mini';

app.use(express.json());
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

function parseReflection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a JSON object');
  const record = raw;
  return {
    reflection: requireString(record, 'reflection'),
    reframe: requireString(record, 'reframe'),
    tinyStep: requireString(record, 'tinyStep'),
    question: requireString(record, 'question'),
  };
}

app.post('/api/reflect', async (req, res) => {
  try {
    const note = String(req.body.note || '').slice(0, 2000);
    const out = await handler.chat(connection, {
      model,
      messages: [
        { role: 'system', content: 'Return ONLY JSON with reflection,reframe,tinyStep,question. Be warm and practical.' },
        { role: 'user', content: note },
      ],
    });
    // extractJsonWithSchema recovers JSON from surrounding prose/fences and
    // throws a typed AIError('invalid_response') if it can't, so this shares
    // the same catch block below as any other provider failure.
    res.json(extractJsonWithSchema(out.text, parseReflection));
  } catch (error) {
    const kind = error instanceof AIError ? error.kind : undefined;
    console.error('[prompt-mirror] /api/reflect failed', kind ?? 'unknown', error.message);
    res.status(statusForError(kind)).json({ error: messageForError(kind) });
  }
});

app.listen(port, () => console.log('http://localhost:' + port));
