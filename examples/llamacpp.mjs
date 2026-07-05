// Chat with a local llama.cpp server. Requires llama-server started with its
// OpenAI-compatible endpoint, e.g.: llama-server -m model.gguf --port 8080
// Run: node examples/llamacpp.mjs
import { AIHandler, memoryKeySource } from '../dist/index.js';

const handler = new AIHandler({ keySource: memoryKeySource({}) });
const connection = { id: 'local-llamacpp', provider: 'llamacpp', keyRef: { kind: 'none' } };

const result = await handler.chat(connection, {
  // llama.cpp's server hosts a single model, so this id is a placeholder —
  // the llamacpp profile's modelOptional quirk means it isn't validated.
  model: 'local',
  messages: [{ role: 'user', content: 'List three uses for a Raspberry Pi.' }],
});
console.log(result.text);
console.log('usage:', result.usage);
