// A minimal, model-agnostic picker: a server-side allowlist of Connections
// (never client input, per README "Letting an app's users pick a model"),
// handler.listModels() per connection with a defaultModel fallback for
// engines that don't support discovery (anthropic/google), then a stream
// against the first available choice. Nothing here assumes any single
// hosted provider is configured: the local Ollama connection needs no key
// and is always present; hosted connections only appear once their env key
// is actually set.
// Run: node examples/model-picker.mjs
//   requires `ollama pull llama3.2` running locally for the default path
//   set OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY to also list
//   those connections
import { AIHandler, envKeySource } from '../dist/index.js';

const handler = new AIHandler({ keySource: envKeySource() });

const CONNECTIONS = [
  { id: 'local-ollama', provider: 'ollama', keyRef: { kind: 'none' }, defaultModel: process.env.OLLAMA_MODEL ?? 'llama3.2' },
  { id: 'openai', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' }, defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', provider: 'anthropic', keyRef: { kind: 'env', name: 'ANTHROPIC_API_KEY' }, defaultModel: 'claude-3-5-haiku-latest' },
  { id: 'google', provider: 'google', keyRef: { kind: 'env', name: 'GOOGLE_API_KEY' }, defaultModel: 'gemini-1.5-flash' },
].filter((conn) => conn.keyRef.kind === 'none' || !!process.env[conn.keyRef.name]);

const entries = [];
for (const connection of CONNECTIONS) {
  const models = await handler.listModels(connection).catch(() => []);
  entries.push({ connection, models: models.length ? models.map((m) => m.id) : [connection.defaultModel] });
}

console.log('Available connections:');
for (const { connection, models } of entries) {
  console.log(`  ${connection.id} (${connection.provider}): ${models.join(', ')}`);
}

const { connection, models } = entries[0];
const model = models[0];
console.log(`\nUsing ${connection.id} / ${model}\n`);

for await (const event of handler.stream(connection, {
  model,
  messages: [{ role: 'user', content: 'In one sentence, what makes a model picker "model-agnostic"?' }],
})) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log('\n\nusage:', event.result.usage);
  if (event.type === 'error') console.error('error:', event.error.message);
}
