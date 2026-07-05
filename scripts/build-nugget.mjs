import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const out = join(root, 'nugget');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'src'), join(out, 'src'), { recursive: true });

const hash = createHash('sha256');
async function hashFiles(dir) {
  const { readdir, stat, readFile: read } = await import('node:fs/promises');
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) await hashFiles(path);
    else hash.update(name).update(await read(path));
  }
}
await hashFiles(join(out, 'src'));
await writeFile(join(out, 'VERSION.txt'), `${pkg.version}\n${hash.digest('hex')}\n`, 'utf8');
