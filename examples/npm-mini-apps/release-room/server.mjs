import express from 'express';
import { AIHandler, envKeySource } from '@jxburros/ai-nugget';

const app = express();
const port = process.env.PORT || 3032;
const handler = new AIHandler({ keySource: envKeySource() });
const connection = {
  id: 'release-room',
  provider: process.env.AI_PROVIDER || 'openai',
  keyRef: { kind: 'env', name: process.env.AI_KEY_ENV || 'OPENAI_API_KEY' },
};

app.use(express.json());
app.use(express.static(new URL('./public', import.meta.url).pathname));

app.post('/api/sprint', async (req, res) => {
  try {
    const result = await handler.chat(connection, {
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Return only JSON containing headline, whyNow, tasks (exactly three objects with title, detail, minutes), and parkingLot. Turn the task dump into a realistic short sprint.' },
        { role: 'user', content: String(req.body.goals || '').slice(0, 4000) },
      ],
    });
    res.json(JSON.parse(result.text.match(/\{[\s\S]*\}/)[0]));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => console.log(`http://localhost:${port}`));
