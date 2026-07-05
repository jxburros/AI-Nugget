/**
 * Buffered and streamed calls against a cloud provider, resolving the key from an
 * environment variable. Run with: OPENAI_API_KEY=sk-... npx tsx examples/basic-chat.ts
 */
import { AIHandler, envKeySource, type Connection } from '@jxburros/ai-handler';

const handler = new AIHandler({ keySource: envKeySource() });

const connection: Connection = {
  id: 'main',
  provider: 'openai',
  keyRef: { kind: 'env', name: 'OPENAI_API_KEY' },
};

// --- Non-streaming ---------------------------------------------------------
const result = await handler.chat(connection, {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Give me one fact about octopuses.' }],
});
console.log('text:', result.text);
console.log('usage:', result.usage, 'finish:', result.finishReason);
console.log('source:', result.source); // provenance always travels with the result

// --- Streaming (same iterable works in Node, browsers, and Web Workers) -----
process.stdout.write('\nstreamed: ');
for await (const event of handler.stream(connection, {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Count to five, one number per line.' }],
})) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log('\nfirstTokenMs:', event.result.timing.firstTokenMs);
  if (event.type === 'error') console.error('\nerror:', event.error.kind, event.error.message);
}
