// Dev utility: render the app icons. Usage: node tests/make-icons.js
import { chromium } from 'playwright';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tile = (size, emojiPx) => `<!DOCTYPE html><html><body style="margin:0">
  <div style="width:${size}px;height:${size}px;display:grid;place-items:center;
              background:#181b24;font-size:${emojiPx}px;line-height:1">🎙️</div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });

const shots = [
  ['icon-512.png', 512, 340],          // standard: generous glyph
  ['icon-192.png', 192, 128],
  ['icon-512-maskable.png', 512, 250], // maskable: glyph inside the 80% safe zone
];
for (const [name, size, emojiPx] of shots) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(tile(size, emojiPx));
  await page.screenshot({ path: join(root, 'icons', name) });
}
await browser.close();
console.log('icons written');
