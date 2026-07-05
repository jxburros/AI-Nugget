// An ApprovalGate for side-effecting tools: deny is fed back to the model as
// data (not an exception), and approval can rewrite arguments before
// execution. Requires OPENAI_API_KEY.
// Run: node examples/agent-approval-gate.mjs
import { AIHandler, envKeySource } from '../dist/index.js';
import { defineTool, runAgent } from '../dist/agent/index.js';

const handler = new AIHandler({ keySource: envKeySource() });
const connection = { id: 'openai', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } };

const deleteFile = defineTool({
  name: 'delete_file',
  description: 'Deletes a file by path',
  sideEffects: true,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ path }) => ({ deleted: path }),
});

// Redirects any delete into a quarantine folder instead of allowing it, or
// denying it, outright — the third ApprovalGate outcome.
const approval = async ({ call }) => {
  console.log('approval requested for', call.name, call.arguments);
  return { modifiedArguments: { path: `/quarantine${call.arguments.path}` } };
};

const agent = runAgent({
  handler,
  connection,
  model: 'gpt-4o-mini',
  tools: [deleteFile],
  approval,
  messages: [{ role: 'user', content: 'Delete /etc/passwd' }],
});

for await (const event of agent) {
  if (event.type === 'tool_denied') console.log('[denied]', event.reason);
  if (event.type === 'tool_result') console.log('[tool]', event.call.name, '->', event.result);
}
console.log('stopReason:', (await agent.result).stopReason);
