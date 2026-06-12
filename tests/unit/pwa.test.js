import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('manifest is valid and its icons exist as PNGs', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.start_url && manifest.theme_color);
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const bytes = await readFile(join(root, icon.src));
    assert.equal(bytes.readUInt32BE(0), 0x89504e47, `${icon.src} must be a PNG`);
    assert.ok(bytes.length < 100 * 1024, `${icon.src} stays reasonably small`);
  }
});

test('service worker caches every deployed file', async () => {
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const listed = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);

  const deployed = ['index.html', 'styles.css', 'manifest.webmanifest'];
  for (const f of await readdir(join(root, 'js'))) deployed.push(`js/${f}`);

  for (const f of deployed) {
    assert.ok(listed.includes(f), `sw.js ASSETS is missing ${f} - offline would break`);
  }
  for (const f of listed) {
    await stat(join(root, f)); // every listed asset must actually exist
  }
});
