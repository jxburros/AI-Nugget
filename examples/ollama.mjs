// Chat with a local Ollama server. Requires Ollama running with a model pulled:
//   ollama pull llama3.2
// Run: node examples/ollama.mjs
import { AIHandler, memoryKeySource } from '../dist/index.js';

const handler = new AIHandler({ keySource: memoryKeySource({}) });
const connection = { id: 'local-ollama', provider: 'ollama', keyRef: { kind: 'none' } };

for await (const event of handler.stream(connection, {
  model: process.env.OLLAMA_MODEL ?? 'llama3.2',
  messages: [{ role: 'user', content: 'In one sentence, why is Node.js single-threaded?' }],
})) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log('\n\nusage:', event.result.usage);
  if (event.type === 'error') console.error('error:', event.error.message);
}
