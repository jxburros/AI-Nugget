// The telemetry seam: every call — success or failure — produces exactly one
// redacted CallRecord, with secrets and API keys never appearing in it.
// Requires OPENAI_API_KEY.
// Run: node examples/telemetry.mjs
import { AIHandler, envKeySource } from '../dist/index.js';

const records = [];
const handler = new AIHandler({
  keySource: envKeySource(),
  telemetry: { record: (r) => records.push(r) },
});

await handler.chat(
  { id: 'openai', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } },
  { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Say hi in five words.' }] },
);

console.log(JSON.stringify(records, null, 2));
