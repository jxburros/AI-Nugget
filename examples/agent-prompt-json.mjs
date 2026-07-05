// The agent loop's promptJson tool-calling fallback — the universal floor for
// small/local models that don't reliably support native function-calling.
// Requires a local Ollama server (see ollama.mjs). Leaving toolMode unset
// would resolve the same way here: ollama's capability profile marks
// nativeTools:false, so `auto` already picks promptJson for it.
// Run: node examples/agent-prompt-json.mjs
import { AIHandler, memoryKeySource } from '../dist/index.js';
import { defineTool, runAgent } from '../dist/agent/index.js';

const handler = new AIHandler({ keySource: memoryKeySource({}) });
const connection = { id: 'local-ollama', provider: 'ollama', keyRef: { kind: 'none' } };

const getTime = defineTool({
  name: 'get_time',
  description: 'Returns the current UTC time as an ISO string',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ time: new Date().toISOString() }),
});

const agent = runAgent({
  handler,
  connection,
  model: process.env.OLLAMA_MODEL ?? 'llama3.2',
  tools: [getTime],
  toolMode: 'promptJson',
  messages: [{ role: 'user', content: 'What time is it right now?' }],
});

for await (const event of agent) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'tool_result') console.log('\n[tool]', event.call.name, '->', event.result);
}
console.log('\nstopReason:', (await agent.result).stopReason);
