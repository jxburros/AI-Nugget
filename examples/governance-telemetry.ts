/**
 * Wiring the policy / redaction / telemetry seams. The library ships NEUTRAL — no
 * default block list — so an app enforces its own rules at these seams. Every
 * call (success or failure) produces exactly one redacted CallRecord.
 * Run with: OPENAI_API_KEY=sk-... npx tsx examples/governance-telemetry.ts
 */
import {
  AIHandler,
  allowlistPolicy,
  createDefaultRedactor,
  envKeySource,
  type CallRecord,
  type Connection,
  type TelemetrySink,
} from '@jxburros/ai-handler';

// App policy, configured at the seam — here: only allow gpt-4o* models on openai.
const policy = allowlistPolicy({ openai: ['gpt-4o'] });

// Default redactor (built-in secret patterns) + any literal keys resolved this session.
const redactor = createDefaultRedactor();

// Telemetry gets sizes, never content — the app persists bodies from ChatResult itself.
const telemetry: TelemetrySink = {
  record(r: CallRecord) {
    console.log(JSON.stringify({
      provider: r.provider, model: r.model, finish: r.finishReason,
      attempts: r.attempts, promptChars: r.promptChars, responseChars: r.responseChars,
      error: r.error?.kind, usage: r.usage,
    }));
  },
};

const handler = new AIHandler({ keySource: envKeySource(), policy, redactor, telemetry });
const connection: Connection = { id: 'main', provider: 'openai', keyRef: { kind: 'env', name: 'OPENAI_API_KEY' } };

// Allowed model → succeeds, one telemetry row.
await handler.chat(connection, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] });

// Blocked model → policy_blocked error, STILL one telemetry row (traceability holds).
for await (const event of handler.stream(connection, { model: 'o1-preview', messages: [{ role: 'user', content: 'Hi' }] })) {
  if (event.type === 'error') console.log('blocked as expected:', event.error.kind);
}
