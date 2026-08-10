/**
 * Runs the local-runtime starter against the mock provider, proving the
 * no-key path: health probe, live model discovery, prewarm, NDJSON streaming.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMockProvider } from '../mock-provider.mjs';

const mock = await startMockProvider();
try {
  const { stdout } = await promisify(execFile)(process.execPath, ['main.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, OLLAMA_HOST: mock.url, OLLAMA_MODEL: 'mock-model' },
  });
  assert.match(stdout, /Using mock-model/, 'should discover models from the daemon, not hardcode them');
  assert.ok(stdout.includes(mock.expectedReply), 'should stream the reply');
  assert.match(stdout, /finish: stop/, 'should report an honest finish reason');
  console.log('ollama-desktop integration OK');
} finally {
  await mock.close();
}
