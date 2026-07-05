/**
 * A minimal agent: one validated tool, an approval gate for a side-effecting
 * tool, and budgets. Every model call in the loop still flows through the full
 * handler pipeline (policy, keys, redaction, retry, telemetry).
 * Run with: OPENAI_API_KEY=sk-... npx tsx examples/agent-tools.ts
 */
import { AIHandler, envKeySource, type Connection } from '@jxburros/ai-handler';
import { defineTool, runAgent, type ApprovalGate } from '@jxburros/ai-handler/agent';

const handler = new AIHandler({ keySource: envKeySource() });
const connection: Connection = { id: 'main', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } };

// A read-only tool: args are validated against the JSON schema before execute().
const getWeather = defineTool<{ city: string }, { city: string; tempC: number }>({
  name: 'get_weather',
  description: 'Look up the current temperature for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

// A side-effecting tool: gated by the ApprovalGate (deny is fed back as data).
const sendEmail = defineTool<{ to: string; body: string }, { sent: boolean }>({
  name: 'send_email',
  description: 'Send an email',
  sideEffects: true,
  parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
  execute: async () => ({ sent: true }),
});

const approval: ApprovalGate = async ({ call }) => {
  // In a real app this suspends for a human decision (locus-os broker, a dialog…).
  console.log('approval requested for', call.name, call.arguments);
  return 'deny'; // demo: refuse; the model gets told and plans around it
};

const agent = runAgent({
  handler,
  connection,
  model: 'gpt-4o-mini',
  tools: [getWeather, sendEmail],
  toolMode: 'auto', // native for gpt-4o-mini; promptJson for a local model
  approval,
  budget: { maxSteps: 6, maxTokens: 4000, deadlineMs: 30_000 },
  messages: [
    { role: 'system', content: 'You are a helpful assistant with tools.' },
    { role: 'user', content: "What's the weather in Paris, then email it to me?" },
  ],
});

for await (const event of agent) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'tool_start') console.log('\n→ calling', event.call.name);
  if (event.type === 'tool_result') console.log('  result:', event.result, 'error:', event.isError);
  if (event.type === 'tool_denied') console.log('  denied:', event.reason);
}

const result = await agent.result;
console.log('\nstopReason:', result.stopReason, '| steps:', result.steps, '| usage:', result.usage);
// result.messages is the full transcript — feed it back to resume later.
