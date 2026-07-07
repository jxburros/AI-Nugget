import express from 'express';
import { fileURLToPath } from 'node:url';
import { AIError, AIHandler, envKeySource, extractJsonWithSchema, requireString, requireStringArray } from '@jxburros/ai-nugget';
import { statusForError, messageForError } from './ai-error-map.mjs';

// AI Nugget ships an `envConnection()` helper (next release after 0.3.1) that
// collapses this block into one call; this example still targets the
// published 0.3.1 range, so it stays inline until that release goes out.
const app = express();
const handler = new AIHandler({ keySource: envKeySource() });
const port = process.env.PORT || 3033;
const connection = { id: 'story-choice', provider: process.env.AI_PROVIDER || 'openai', keyRef: { kind: 'env', name: process.env.AI_KEY_ENV || 'OPENAI_API_KEY' } };
const model = process.env.AI_MODEL || 'gpt-4o-mini';

app.use(express.json());
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

function requireMeter(raw, key) {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
    throw new Error(`Expected ${key} to be a number between 0 and 10`);
  }
  return value;
}

function parseTurn(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a JSON object');
  const meters = raw.meters;
  if (!meters || typeof meters !== 'object' || Array.isArray(meters)) throw new Error('Expected a meters object');
  const choices = requireStringArray(raw, 'choices');
  if (choices.length !== 3) throw new Error('Expected exactly three choices');
  return {
    headline: requireString(raw, 'headline'),
    scene: requireString(raw, 'scene'),
    meters: {
      mood: requireMeter(meters, 'mood'),
      curiosity: requireMeter(meters, 'curiosity'),
      community: requireMeter(meters, 'community'),
    },
    choices,
  };
}

app.post('/api/turn', async (req, res) => {
  try {
    const result = await handler.chat(connection, {
      model,
      messages: [
        { role: 'system', content: 'Return only JSON with headline, scene, meters (mood, curiosity, community numbers 0 to 10), and choices (exactly three short strings). Create playful, nonviolent small-town interactive fiction.' },
        { role: 'user', content: JSON.stringify({ premise: String(req.body.premise || '').slice(0, 800), history: req.body.history || [] }) },
      ],
    });
    // extractJsonWithSchema recovers JSON from surrounding prose/fences and
    // validates meter ranges and choice count, throwing a typed
    // AIError('invalid_response') instead of passing untrusted values to the UI.
    res.json(extractJsonWithSchema(result.text, parseTurn));
  } catch (error) {
    const kind = error instanceof AIError ? error.kind : undefined;
    console.error('[story-choice] /api/turn failed', kind ?? 'unknown', error.message);
    res.status(statusForError(kind)).json({ error: messageForError(kind) });
  }
});

app.listen(port, () => console.log('http://localhost:' + port));
