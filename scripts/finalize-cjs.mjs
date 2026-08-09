import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// dist/cjs/ holds the CommonJS build (tsc -p tsconfig.cjs.json). This marker
// package.json makes Node treat those .js files as CommonJS despite the root
// package's "type": "module", so `require('@jxburros/ai-nugget')` resolves to a
// real CJS module instead of throwing ERR_REQUIRE_ESM.
await writeFile(join(process.cwd(), 'dist', 'cjs', 'package.json'), '{\n  "type": "commonjs"\n}\n', 'utf8');
