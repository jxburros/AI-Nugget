import { describe, expect, it } from 'vitest';
import { AIHandler, createDefaultRedactor, memoryKeySource } from '../src/index.js';
import type { CallRecord } from '../src/index.js';
import { jsonResponse, mockFetch, sseResponse } from './helpers.js';

/**
 * Every prefixed pattern in `SECRET_PATTERNS` gets a representative sample, so
 * deleting or breaking one is a test failure rather than a silent leak. The
 * library's headline invariant is that keys never reach telemetry/errors/logs.
 *
 * Each fixture is assembled at runtime from a prefix and a body. These are all
 * fake, but a whole credential-shaped literal sitting in a source file trips
 * secret scanners (and rightly so) — splitting them keeps the fixtures honest
 * without putting a scannable token in the repo.
 */
const BODY = 'abcdefghijklmnopqrstuvwxyz0123';
const PREFIXED_SAMPLES: Array<[name: string, sample: string]> = [
  ['openai sk-', 'sk-' + BODY],
  ['openai project', 'sk-' + 'proj-' + BODY],
  ['anthropic', 'sk-' + 'ant-' + 'api03-' + BODY],
  ['google', 'AIza' + 'SyA1234567890abcdefghijklmnopq'],
  ['groq', 'gsk_' + BODY],
  ['xai', 'xai-' + BODY],
  ['huggingface', 'hf_' + BODY],
  ['nvidia', 'nvapi-' + BODY],
  ['github pat (classic)', 'ghp_' + BODY],
  ['github fine-grained pat', 'github_' + 'pat_' + BODY],
  ['gitlab', 'glpat-' + BODY],
  ['slack bot', 'xoxb-' + '1234567890-abcdefghijkl'],
  ['slack user', 'xoxp-' + '1234567890-abcdefghijkl'],
  ['aws access key id', 'AKIA' + 'IOSFODNN7EXAMPLE'],
  ['aws session access key id', 'ASIA' + 'IOSFODNN7EXAMPLE'],
  ['sendgrid', 'SG.' + 'abcdefghijklmno' + '.pqrstuvwxyz012345'],
  ['stripe restricted live', 'rk_' + 'live_' + BODY],
  ['stripe publishable live', 'pk_' + 'live_' + BODY],
  ['jwt', 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1'],
];

describe('redactor: prefixed secret formats', () => {
  it.each(PREFIXED_SAMPLES)('redacts a %s token', (_name, sample) => {
    const output = createDefaultRedactor().redact(`prefix ${sample} suffix`);
    expect(output).not.toContain(sample);
    expect(output).toContain('[REDACTED]');
  });

  it('redacts a bearer header value', () => {
    expect(createDefaultRedactor().redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456')).toBe('Authorization: [REDACTED]');
  });

  it('redacts a PEM private key block including its body', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----';
    const output = createDefaultRedactor().redact(`key:\n${pem}\ndone`);
    expect(output).not.toContain('MIIEowIBAAKCAQEA1234');
    expect(output).toBe('key:\n[REDACTED]\ndone');
  });
});

describe('redactor: unprefixed secrets behind a label', () => {
  it.each([
    ['azure api-key', 'api-key: 0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
    ['aws secret access key', '"aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['client secret', 'client_secret=Abc123Def456Ghi789Jkl', 'Abc123Def456Ghi789Jkl'],
    ['session token', 'session-token FQoGZXIvYXdzEBYaDJ0123456789abcdef', 'FQoGZXIvYXdzEBYaDJ0123456789abcdef'],
    ['password', 'password: correct-horse-battery-staple', 'correct-horse-battery-staple'],
  ])('redacts the value after a %s label', (_name, input, secret) => {
    const output = createDefaultRedactor().redact(input);
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });

  it('keeps the label readable so logs stay diagnosable', () => {
    expect(createDefaultRedactor().redact('api-key: 0123456789abcdef0123456789abcdef')).toBe('api-key: [REDACTED]');
  });

  it('leaves unlabeled hex-looking values (commit SHAs, hashes) alone', () => {
    const sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(createDefaultRedactor().redact(`commit ${sha}`)).toBe(`commit ${sha}`);
  });
});

describe('redaction is end-to-end for non-sk secret formats', () => {
  it('scrubs an AWS-shaped key out of an error message and telemetry record', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    mockFetch(jsonResponse({ error: { message: `invalid credential ${secret}` } }, 401));
    const records: CallRecord[] = [];
    const handler = new AIHandler({
      keySource: memoryKeySource({ AWS_KEY: secret }),
      policy: { checkModel: () => ({ allowed: true }) },
      telemetry: { record: (r) => { records.push(r); } },
    });

    const events = [];
    for await (const event of handler.stream(
      { id: 'c1', provider: 'openai', keyRef: { kind: 'env', name: 'AWS_KEY' } },
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    )) events.push(event);

    const failure = events.find((e) => e.type === 'error');
    expect(failure?.type).toBe('error');
    if (failure?.type === 'error') {
      expect(failure.error.message).not.toContain(secret);
      expect(failure.error.raw ?? '').not.toContain(secret);
    }
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it('never hands a plaintext literal keyRef or auth header to a beforeCall hook', async () => {
    const secret = 'sk-literalsecret1234567890abcdef';
    mockFetch(sseResponse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    const seen: unknown[] = [];
    const handler = new AIHandler({
      keySource: { async resolve(ref) { return { ok: true, apiKey: ref.kind === 'literal' ? ref.value : null }; } },
      policy: { checkModel: () => ({ allowed: true }) },
      hooks: { async beforeCall(info) { seen.push({ connection: info.connection, resolved: info.resolved }); } },
    });

    await handler.chat(
      { id: 'c1', provider: 'openai', keyRef: { kind: 'literal', value: secret } },
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain(secret);
    expect(JSON.stringify(seen)).toContain('[REDACTED]');
  });
});
