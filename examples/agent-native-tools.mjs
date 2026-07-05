// Native tool-calling against a provider whose protocol supports it reliably.
// toolMode is left unset here on purpose: 'auto' resolves to 'native' for
// openai because its capability profile marks nativeTools:true (see
// src/adapters/profiles.ts). Requires OPENAI_API_KEY.
// Run: node examples/agent-native-tools.mjs
import { AIHandler, envKeySource } from '../dist/index.js';
import { defineTool, runAgent } from '../dist/agent/index.js';

const handler = new AIHandler({ keySource: envKeySource() });
const connection = { id: 'openai', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } };

const addNumbers = defineTool({
  name: 'add_numbers',
  description: 'Adds two numbers',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  execute: async ({ a, b }) => ({ sum: a + b }),
});

const agent = runAgent({
  handler,
  connection,
  model: 'gpt-4o-mini',
  tools: [addNumbers],
  messages: [{ role: 'user', content: 'What is 482 + 917? Use the tool.' }],
});

for await (const event of agent) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'tool_result') console.log('\n[tool]', event.call.name, '->', event.result);
}
console.log('\nstopReason:', (await agent.result).stopReason);
