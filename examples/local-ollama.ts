/**
 * A keyless local provider. No API key, honest failure when the server is down,
 * and `toolMode: 'auto'` transparently choosing the promptJson floor because
 * Ollama does not advertise reliable native tools.
 * Run with: npx tsx examples/local-ollama.ts  (needs a local Ollama on :11434)
 */
import { AIHandler, memoryKeySource, providerCapabilities, type Connection } from '@jxburros/ai-handler';
import { defineTool, runAgent } from '@jxburros/ai-handler/agent';

const handler = new AIHandler({ keySource: memoryKeySource({}) });
const connection: Connection = { id: 'local', provider: 'ollama', keyRef: { kind: 'none' } };

console.log('ollama capabilities:', providerCapabilities('ollama'));
// -> { nativeTools: false, jsonMode: true }  => auto uses promptJson here

const health = await handler.testConnection(connection);
if (!health.ok) {
  console.error('Ollama not reachable:', health.message); // honest typed failure, not fake success
  process.exit(1);
}

const models = await handler.listModels(connection);
console.log('local models:', models.map((m) => m.id));

const model = models[0]?.id ?? 'llama3.2';

const clock = defineTool<Record<string, never>, { iso: string }>({
  name: 'now',
  description: 'Return the current time as an ISO string',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ iso: new Date().toISOString() }),
});

const agent = runAgent({
  handler,
  connection,
  model,
  tools: [clock],
  toolMode: 'auto', // resolves to promptJson for Ollama
  messages: [{ role: 'user', content: 'What time is it? Use the tool.' }],
});

for await (const event of agent) {
  if (event.type === 'tool_result') console.log('tool result:', event.result);
}
console.log('final:', (await agent.result).finalText);
