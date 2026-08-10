/**
 * Local-Ollama (desktop / self-hosted) integration starter.
 *
 * The local path has different failure modes from a hosted one, and this
 * starter is mostly about handling them honestly:
 *
 *   - No API key at all (`ollama` is `keyOptional`), so `keyRef` is omitted.
 *   - The daemon may simply not be running. `testConnection()` answers that
 *     without throwing, so the UI can say "start Ollama" instead of surfacing a
 *     raw fetch error.
 *   - First generation pays model load time. `prewarm()` moves that off the hot
 *     path; a generous `timeoutMs` with a tight `idleTimeoutMs` keeps a slow but
 *     healthy stream alive while still killing a stalled one.
 *   - Tool-calling is model-dependent, not protocol-guaranteed, so the agent
 *     layer's `auto` mode picks `promptJson` here. That is the right default.
 *
 * Run: `ollama pull llama3.2 && node examples/integrations/ollama-desktop/main.mjs`
 */
import { AIHandler, allowAllPolicy, envKeySource, profileFor } from '@jxburros/ai-nugget';

const connection = {
  id: 'local',
  provider: 'ollama',
  baseUrl: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
  // Generous total ceiling, tight idle bound: a 10-minute generation is fine as
  // long as tokens keep arriving; 30s of silence means something is wrong.
  timeoutMs: 600_000,
  idleTimeoutMs: 30_000,
};

const handler = new AIHandler({
  keySource: envKeySource(),
  // A local-only app has nothing to govern, but say so explicitly rather than
  // taking the default and its "unrestricted" startup warning.
  policy: allowAllPolicy(),
});

// 1. Is the daemon actually there? An honest typed answer, never a fake success.
const health = await handler.testConnection(connection);
if (!health.ok) {
  console.error(`Ollama is not reachable at ${connection.baseUrl}: ${health.message}`);
  console.error('Start it with `ollama serve`, then pull a model: `ollama pull llama3.2`');
  process.exit(1);
}

// 2. What is installed? Discovery is live — never hardcode a model list for a
//    machine you do not control.
const models = await handler.listModels(connection);
if (models.length === 0) {
  console.error('Ollama is running but has no models. Try: ollama pull llama3.2');
  process.exit(1);
}
const model = process.env.OLLAMA_MODEL ?? models[0].id;
console.log(`Using ${model} (${models.length} installed).`);
console.log('Capabilities:', profileFor('ollama').capabilities);

// 3. Pay model-load cost before the user is waiting on a prompt.
await handler.prewarm(connection);

// 4. Stream, watching for the truncation signal a local daemon can produce when
//    it is killed or runs out of memory mid-generation.
for await (const event of handler.stream(connection, {
  model,
  messages: [{ role: 'user', content: 'In one sentence: why run a model locally?' }],
})) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'reasoning') process.stdout.write(`\x1b[2m${event.text}\x1b[0m`);
  if (event.type === 'context' && event.kind === 'stream_anomaly') {
    console.warn('\n[warning] stream ended without a done record — the reply may be truncated:', event.data);
  }
  if (event.type === 'done') {
    console.log('\n---');
    console.log('finish:', event.result.finishReason, '| usage:', event.result.usage);
  }
  if (event.type === 'error') {
    console.error('\nfailed:', event.error.kind, '-', event.error.message);
    process.exitCode = 1;
  }
}
