import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function deployedFiles() {
  const files = ['index.html', 'styles.css'];
  for (const f of await readdir(join(root, 'js'))) files.push(join('js', f));
  return files;
}

// The spec budget is transfer size; static hosts (GitHub Pages included) serve gzip.
test('deployed payload transfers in under 30 KB gzipped', async () => {
  let total = 0;
  for (const f of await deployedFiles()) {
    total += gzipSync(await readFile(join(root, f))).length;
  }
  assert.ok(total < 30 * 1024, `gzipped payload is ${total} bytes (budget 30720)`);
});

test('deployed payload stays under 64 KB raw (bloat backstop)', async () => {
  let total = 0;
  for (const f of await deployedFiles()) {
    total += (await readFile(join(root, f))).length;
  }
  assert.ok(total < 64 * 1024, `raw payload is ${total} bytes (budget 65536)`);
});
