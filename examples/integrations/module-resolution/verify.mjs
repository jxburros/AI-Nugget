/**
 * The cheapest integration failure to ship is a broken `exports` map: the code
 * is fine, but a consumer's bundler or `require()` can't reach it. This checks
 * every published entry point through real resolution, in both module systems.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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

// Types: a TypeScript consumer must reach both entry points' declarations
// under every common moduleResolution. `node10` (the default for
// `module: commonjs`, e.g. older Express/Nest backends) ignores `exports`
// entirely, so `/agent` resolves only through `typesVersions` in package.json.
const ts = require('typescript');
const fixture = fileURLToPath(new URL('./types-check.ts', import.meta.url));
const modes = [
  { name: 'node10', module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 },
  // The fixture is ESM (package "type": "module"), so this is node16 from an ESM file.
  { name: 'node16', module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 },
  { name: 'bundler', module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
];
for (const mode of modes) {
  const program = ts.createProgram([fixture], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    module: mode.module,
    moduleResolution: mode.moduleResolution,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const text = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  });
  assert.equal(diagnostics.length, 0, `types must resolve under moduleResolution ${mode.name}:\n${text}`);
}

console.log('module-resolution integration OK (ESM + CJS, root + /agent; types under node10, node16, bundler)');
