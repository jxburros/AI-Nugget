import express from 'express';
import { fileURLToPath } from 'node:url';
import { AIError, AIHandler, envKeySource, extractJsonWithSchema, requireNumber, requireOptionalString, requireString } from '@jxburros/ai-nugget';
import { statusForError, messageForError } from './ai-error-map.mjs';

// AI Nugget ships an `envConnection()` helper (next release after 0.3.1) that
// collapses this block into one call; this example still targets the
// published 0.3.1 range, so it stays inline until that release goes out.
const app = express();
const port = process.env.PORT || 3032;
const handler = new AIHandler({ keySource: envKeySource() });
const connection = { id: 'release-room', provider: process.env.AI_PROVIDER || 'openai', keyRef: { kind: 'env', name: process.env.AI_KEY_ENV || 'OPENAI_API_KEY' } };
const model = process.env.AI_MODEL || 'gpt-4o-mini';

app.use(express.json());
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

function parseTask(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a task object');
  return {
    title: requireString(raw, 'title'),
    detail: requireString(raw, 'detail'),
    minutes: requireNumber(raw, 'minutes'),
  };
}

function parseSprint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a JSON object');
  const tasks = raw.tasks;
  if (!Array.isArray(tasks) || tasks.length !== 3) throw new Error('Expected exactly three tasks');
  return {
    headline: requireString(raw, 'headline'),
    whyNow: requireString(raw, 'whyNow'),
    tasks: tasks.map(parseTask),
    parkingLot: requireOptionalString(raw, 'parkingLot') ?? '',
  };
}

app.post('/api/sprint', async (req, res) => {
  try {
    const result = await handler.chat(connection, {
      model,
      messages: [
        { role: 'system', content: 'Return only JSON containing headline, whyNow, tasks (exactly three objects with title, detail, minutes), and parkingLot. Turn the task dump into a realistic short sprint.' },
        { role: 'user', content: String(req.body.goals || '').slice(0, 4000) },
      ],
    });
    // extractJsonWithSchema recovers JSON from surrounding prose/fences and
    // enforces the exactly-three-tasks / numeric-minutes shape the UI relies
    // on, throwing a typed AIError('invalid_response') on any mismatch.
    res.json(extractJsonWithSchema(result.text, parseSprint));
  } catch (error) {
    const kind = error instanceof AIError ? error.kind : undefined;
    console.error('[release-room] /api/sprint failed', kind ?? 'unknown', error.message);
    res.status(statusForError(kind)).json({ error: messageForError(kind) });
  }
});

app.listen(port, () => console.log('http://localhost:' + port));
