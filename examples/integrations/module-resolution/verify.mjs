/**
 * The cheapest integration failure to ship is a broken `exports` map: the code
 * is fine, but a consumer's bundler or `require()` can't reach it. This checks
 * every published entry point through real resolution, in both module systems.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ESM: root and /agent subpath.
const esm = await import('@jxburros/ai-nugget');
const esmAgent = await import('@jxburros/ai-nugget/agent');
for (const name of ['AIHandler', 'envKeySource', 'AIError', 'classify', 'createDefaultRedactor', 'allowlistPolicy', 'profileFor', 'PROVIDER_PROFILES']) {
  assert.ok(esm[name], `ESM root export missing: ${name}`);
}
for (const name of ['runAgent', 'defineTool', 'validateToolArgs']) {
  assert.ok(esmAgent[name], `ESM agent export missing: ${name}`);
}

// CJS: the same two entry points via require(). A named export resolving to
// `undefined` here is the classic dual-package failure.
const cjs = require('@jxburros/ai-nugget');
const cjsAgent = require('@jxburros/ai-nugget/agent');
assert.equal(typeof cjs.AIHandler, 'function', 'CJS AIHandler must be constructible');
assert.equal(typeof cjs.envKeySource, 'function');
assert.equal(typeof cjsAgent.runAgent, 'function', 'CJS agent entry must expose runAgent');
assert.equal(typeof cjsAgent.defineTool, 'function');

// Types ship alongside both.
assert.ok(require.resolve('@jxburros/ai-nugget'), 'root must resolve');
assert.ok(require.resolve('@jxburros/ai-nugget/agent'), 'agent subpath must resolve');

// Constructing through each entry point must produce a working instance.
const handler = new cjs.AIHandler({ keySource: cjs.envKeySource(), policy: cjs.allowAllPolicy() });
assert.equal(typeof handler.chat, 'function');
assert.equal(typeof handler.stream, 'function');

console.log('module-resolution integration OK (ESM + CJS, root + /agent)');
