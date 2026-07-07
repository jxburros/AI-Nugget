import express from 'express';
import { AIHandler, envKeySource } from '@jxburros/ai-nugget';
const app = express();
const handler = new AIHandler({ keySource: envKeySource() });
const port = process.env.PORT || 3033;
const connection = { id: 'story-choice', provider: process.env.AI_PROVIDER || 'openai', keyRef: { kind: 'env', name: process.env.AI_KEY_ENV || 'OPENAI_API_KEY' } };
app.use(express.json());
app.use(express.static(new URL('./public', import.meta.url).pathname));
app.post('/api/turn', async (req, res) => {
  try {
    const result = await handler.chat(connection, { model: process.env.AI_MODEL || 'gpt-4o-mini', messages: [
      { role: 'system', content: 'Return only JSON with headline, scene, meters (mood, curiosity, community numbers 0 to 10), and choices (exactly three short strings). Create playful, nonviolent small-town interactive fiction.' },
      { role: 'user', content: JSON.stringify({ premise: String(req.body.premise || '').slice(0, 800), history: req.body.history || [] }) },
    ] });
    res.json(JSON.parse(result.text.match(/\{[\s\S]*\}/)[0]));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.listen(port, () => console.log(`http://localhost:${port}`));
