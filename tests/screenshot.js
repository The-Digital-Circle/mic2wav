// Dev utility: capture app screenshots for visual review.
// Usage: node tests/screenshot.js [outdir]
import { chromium } from 'playwright';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outdir = process.argv[2] || '/tmp/mic2wav-shots';

const { server, port } = await startServer(root);
const url = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${join(here, 'fixtures/tone.wav')}`,
  ],
});

for (const [label, viewport] of [
  ['desktop', { width: 1280, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  const context = await browser.newContext({ viewport, permissions: ['microphone'] });
  const page = await context.newPage();
  await page.goto(url);
  await page.screenshot({ path: join(outdir, `${label}-1-welcome.png`) });
  await page.click('#btn-enable');
  await page.waitForFunction(() => document.getElementById('status-pill').dataset.level === 'good');
  await page.screenshot({ path: join(outdir, `${label}-2-setup.png`) });
  await page.fill('#name-input', 'Alice');
  await page.click('#btn-start');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outdir, `${label}-3-recording.png`) });
  await page.click('#btn-stop');
  await page.waitForSelector('#screen-done:not([hidden])');
  await page.screenshot({ path: join(outdir, `${label}-4-done.png`) });
  await page.evaluate(() => { delete window.showSaveFilePicker; }); // force anchor path
  await page.click('#btn-save');
  await page.waitForSelector('#save-confirm:not([hidden])');
  await page.screenshot({ path: join(outdir, `${label}-5-saved.png`) });
  page.on('dialog', (d) => d.accept());
  await page.reload();
  await page.waitForSelector('#stored-row:not([hidden])');
  await page.screenshot({ path: join(outdir, `${label}-6-storage.png`) });
  await context.close();
}

await browser.close();
server.close();
console.log(`screenshots in ${outdir}`);
