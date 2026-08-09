import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const out = join(root, 'nugget');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'src'), join(out, 'src'), { recursive: true });

// Also vendor the compiled ESM output when present, so bundlers that can't
// resolve TypeScript `.js`-specifier source (e.g. Next.js Turbopack) can vendor
// `nugget/dist` instead of `nugget/src`. Best-effort: skipped if `dist/` has not
// been built yet (the VERSION hash below still covers `src/` only).
try {
  await cp(join(root, 'dist'), join(out, 'dist'), { recursive: true });
} catch {
  // dist/ not built — `npm run build` before `build:nugget` to include it.
}

const hash = createHash('sha256');
async function hashFiles(dir) {
  const { readdir, stat, readFile: read } = await import('node:fs/promises');
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) await hashFiles(path);
    else {
      const rel = relative(join(out, 'src'), path).split(sep).join('/');
      const data = await read(path);
      hash.update(`${rel.length}:${rel}:${data.length}:`).update(data);
    }
  }
}
await hashFiles(join(out, 'src'));
await writeFile(join(out, 'VERSION.txt'), `${pkg.version}\n${hash.digest('hex')}\n`, 'utf8');
