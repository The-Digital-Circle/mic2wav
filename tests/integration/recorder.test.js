import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../serve.js';
import { readWav } from './wavread.js';
import { ffmpegDecode } from '../flacref.js';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const fixture = (name) => join(here, '../fixtures', name);

let server;
let baseURL;

before(async () => {
  const s = await startServer(root);
  server = s.server;
  baseURL = `http://127.0.0.1:${s.port}/`;
});

after(() => server.close());

async function launch(fixtureWav, initScript) {
  const args = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    `--use-file-for-fake-audio-capture=${fixtureWav}`,
  ];
  const browser = await chromium.launch({ channel: 'chrome', args });
  const context = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true });
  // The native save picker can't be driven headlessly, so tests default to
  // the anchor-download path; picker tests stub the API explicitly.
  await context.addInitScript(initScript || (() => { delete window.showSaveFilePicker; }));
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  return { browser, page };
}

async function enableAndWaitLevel(page, level, timeout = 15000) {
  await page.goto(baseURL);
  await page.click('#btn-enable');
  await page.waitForSelector('#setup-controls:not([hidden])');
  await page.waitForFunction(
    (lvl) => document.getElementById('status-pill').dataset.level === lvl,
    level,
    { timeout },
  );
}

test('happy path: mic check, record, stop, save a valid WAV', async () => {
  const { browser, page } = await launch(fixture('tone.wav'));
  try {
    await enableAndWaitLevel(page, 'good');
    assert.equal(await page.isEnabled('#btn-start'), true);

    await page.fill('#name-input', 'Alice Smith');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-record:not([hidden])');
    await page.waitForTimeout(2000);
    assert.match(await page.textContent('#rec-size'), /KB|MB/, 'live size readout ticks');

    await page.click('#btn-pause');
    assert.equal(await page.textContent('#rec-state-label'), 'Paused');
    await page.waitForTimeout(2000); // must NOT appear in the file
    await page.click('#btn-pause');
    await page.waitForTimeout(2000);

    await page.click('#btn-stop');
    await page.waitForSelector('#screen-done:not([hidden])');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-save-wav'),
    ]);
    assert.match(download.suggestedFilename(), /^alice-smith-recording-\d{4}-\d{2}-\d{2}-\d{4}\.wav$/);
    const wav = await readWav(await download.path());

    assert.equal(wav.channels, 1);
    assert.equal(wav.bitDepth, 16);
    assert.ok(wav.sampleRate >= 8000, `sane sample rate, got ${wav.sampleRate}`);
    assert.equal(wav.dataSize, wav.fileSize - 44, 'header data size matches file');
    // 2s + 2s recorded with a 2s pause in between: the pause must be excluded.
    assert.ok(wav.durationSeconds > 2.5 && wav.durationSeconds < 5.5,
      `expected ~4s of audio (pause excluded), got ${wav.durationSeconds}`);
    assert.ok(wav.peak > 0.05 && wav.peak <= 1, `expected audible signal, peak=${wav.peak}`);

    // Anchor downloads give no completion signal: the human-confirmed
    // cleanup offer must appear.
    await page.waitForSelector('#save-confirm:not([hidden])');

    // A saved session stays recoverable after reload (a cancelled save dialog
    // must not lose the interview), with "already saved" copy.
    await page.reload();
    await page.waitForSelector('#recovery-card:not([hidden])');
    assert.match(await page.textContent('#recovery-text'), /already saved/);
    assert.equal(await page.textContent('#btn-recover-save'), 'Download again');

    // Discard (confirm auto-accepted) removes it for good.
    await page.click('#btn-recover-discard');
    await page.waitForSelector('#recovery-card', { state: 'hidden' });
    await page.reload();
    await page.waitForSelector('#screen-setup:not([hidden])');
    await page.waitForTimeout(300);
    assert.equal(await page.isHidden('#recovery-card'), true);
  } finally {
    await browser.close();
  }
});

test('silent input is flagged and Start stays disabled', async () => {
  const { browser, page } = await launch(fixture('silence.wav'));
  try {
    await page.goto(baseURL);
    await page.click('#btn-enable');
    await page.waitForSelector('#setup-controls:not([hidden])');
    await page.waitForTimeout(4000);
    assert.equal(await page.getAttribute('#status-pill', 'data-level'), 'silent');
    assert.equal(await page.isEnabled('#btn-start'), false);
  } finally {
    await browser.close();
  }
});

test('hot input is classified as clipping', async () => {
  const { browser, page } = await launch(fixture('hot.wav'));
  try {
    await enableAndWaitLevel(page, 'clipping');
  } finally {
    await browser.close();
  }
});

test('crash recovery: reload mid-recording offers a saveable WAV', async () => {
  const { browser, page } = await launch(fixture('tone.wav'));
  try {
    await enableAndWaitLevel(page, 'good');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-record:not([hidden])');
    await page.waitForTimeout(6500); // > one 5s chunk committed to IndexedDB

    await page.reload(); // beforeunload dialog auto-accepted
    await page.waitForSelector('#recovery-card:not([hidden])', { timeout: 10000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-recover-save'),
    ]);
    assert.match(download.suggestedFilename(), /\.flac$/);
    const flacBytes = await readFile(await download.path());
    const sampleRate = (flacBytes[18] << 12) | (flacBytes[19] << 4) | (flacBytes[20] >> 4);
    const { pcm, stderr } = await ffmpegDecode(flacBytes);
    assert.equal(stderr, '', `reference decoder reported: ${stderr}`);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]) / 32767);
    const durationSeconds = samples.length / sampleRate;
    assert.ok(durationSeconds >= 4.5, `recovered at least one chunk, got ${durationSeconds}s`);
    assert.ok(peak > 0.05, `recovered audio is audible, peak=${peak}`);
    await page.waitForSelector('#recovery-card', { state: 'hidden' });
  } finally {
    await browser.close();
  }
});

test('mic check stays "good" through pauses in speech', async () => {
  const { browser, page } = await launch(fixture('tone-gaps.wav'));
  try {
    await enableAndWaitLevel(page, 'good');
    // The fixture loops 5 s of tone then 5 s of silence. Across a full cycle
    // the pill must never regress from "good" - pauses are not "too quiet".
    const levelsSeen = await page.evaluate(() => new Promise((resolve) => {
      const pill = document.getElementById('status-pill');
      const seen = new Set();
      const iv = setInterval(() => seen.add(pill.dataset.level), 200);
      setTimeout(() => { clearInterval(iv); resolve([...seen]); }, 11000);
    }));
    assert.deepEqual(levelsSeen, ['good'], `pill levels seen: ${levelsSeen}`);
  } finally {
    await browser.close();
  }
});

test('storage panel reports and deletes the stored recording', async () => {
  const { browser, page } = await launch(fixture('tone.wav'));
  try {
    await enableAndWaitLevel(page, 'good');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-record:not([hidden])');
    await page.waitForTimeout(2000);
    await page.click('#btn-stop');
    await page.waitForSelector('#screen-done:not([hidden])');

    await page.reload(); // leave an unsaved session behind
    await page.waitForSelector('#stored-row:not([hidden])');
    const detail = await page.textContent('#stored-detail');
    assert.match(detail, /not saved yet/);
    assert.match(detail, /KB|MB/);
    assert.match(await page.textContent('#storage-usage'), /in use/);

    await page.click('#btn-delete-stored'); // confirm auto-accepted
    await page.waitForSelector('#stored-row', { state: 'hidden' });
    assert.equal(await page.isHidden('#recovery-card'), true, 'recovery offer cleared too');

    await page.reload();
    await page.waitForSelector('#screen-setup:not([hidden])');
    await page.waitForTimeout(300);
    assert.equal(await page.isHidden('#stored-row'), true);
    assert.equal(await page.isHidden('#recovery-card'), true);
  } finally {
    await browser.close();
  }
});

test('FLAC save is byte-for-byte lossless against the WAV of the same take', async () => {
  const { browser, page } = await launch(fixture('tone.wav'));
  try {
    await enableAndWaitLevel(page, 'good');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-record:not([hidden])');
    await page.waitForTimeout(2500);
    await page.click('#btn-stop');
    await page.waitForSelector('#screen-done:not([hidden])');

    const [wavDl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-save-wav'),
    ]);
    const wavBytes = await readFile(await wavDl.path());

    const [flacDl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-save'),
    ]);
    assert.match(flacDl.suggestedFilename(), /\.flac$/);
    const flacBytes = await readFile(await flacDl.path());

    assert.equal(String.fromCharCode(...flacBytes.subarray(0, 4)), 'fLaC');
    assert.ok(flacBytes.length < wavBytes.length * 0.75,
      `FLAC should be smaller: ${flacBytes.length} vs ${wavBytes.length}`);

    const { pcm, stderr } = await ffmpegDecode(flacBytes);
    assert.equal(stderr, '', `reference decoder reported: ${stderr}`);
    assert.ok(pcm.equals(wavBytes.subarray(44)),
      'FLAC must decode to PCM byte-identical to the WAV of the same recording');
  } finally {
    await browser.close();
  }
});

test('confirmed picker save frees the browser copy automatically', async () => {
  const { browser, page } = await launch(fixture('tone.wav'), () => {
    window.__savedBytes = 0;
    window.__closed = false;
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async (chunk) => {
          if (!window.__head) window.__head = Array.from(chunk.slice(0, 4));
          window.__savedBytes += chunk.byteLength;
        },
        close: async () => { window.__closed = true; },
      }),
    });
  });
  try {
    await enableAndWaitLevel(page, 'good');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-record:not([hidden])');
    await page.waitForTimeout(2000);
    await page.click('#btn-stop');
    await page.waitForSelector('#screen-done:not([hidden])');

    await page.click('#btn-save');
    await page.waitForFunction(() => window.__closed === true);
    const { savedBytes, head } = await page.evaluate(() => ({ savedBytes: window.__savedBytes, head: window.__head }));
    assert.deepEqual(head, [0x66, 0x4C, 0x61, 0x43], 'streamed file starts with fLaC magic');
    assert.ok(savedBytes > 4000 && savedBytes < 150000,
      `compressed FLAC of ~2s tone streamed to disk, got ${savedBytes} bytes`);
    assert.match(await page.textContent('#done-note'), /freed automatically/);
    assert.match(await page.textContent('#btn-save'), /another copy/);
    assert.equal(await page.isHidden('#save-confirm'), true, 'no manual confirm needed');

    // The browser copy is gone for good.
    await page.reload();
    await page.waitForSelector('#screen-setup:not([hidden])');
    await page.waitForTimeout(400);
    assert.equal(await page.isHidden('#recovery-card'), true);
    assert.equal(await page.isHidden('#stored-row'), true);

    // Zero footprint at rest: existence checks must not recreate the
    // database, or the origin never returns to empty after cleanup.
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    assert.ok(!dbs.includes('mic2wav'), `database recreated by a read: ${dbs}`);
  } finally {
    await browser.close();
  }
});

test('fallback save offers human-confirmed cleanup', async () => {
  const { browser, page } = await launch(fixture('tone.wav'));
  try {
    await enableAndWaitLevel(page, 'good');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-record:not([hidden])');
    await page.waitForTimeout(1500);
    await page.click('#btn-stop');
    await page.waitForSelector('#screen-done:not([hidden])');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-save'),
    ]);
    await download.path();
    await page.waitForSelector('#save-confirm:not([hidden])');
    await page.click('#btn-free-space'); // confirm dialog auto-accepted
    await page.waitForSelector('#save-confirm', { state: 'hidden' });
    assert.match(await page.textContent('#done-note'), /freed/);

    await page.reload();
    await page.waitForSelector('#screen-setup:not([hidden])');
    await page.waitForTimeout(300);
    assert.equal(await page.isHidden('#recovery-card'), true);
    assert.equal(await page.isHidden('#stored-row'), true);
  } finally {
    await browser.close();
  }
});

test('delete works while an idle second tab holds a database connection', async () => {
  const { browser, page } = await launch(fixture('tone.wav'));
  try {
    const page2 = await page.context().newPage(); // idle tab, open DB connection
    await page2.goto(baseURL);
    await page2.waitForSelector('#screen-setup:not([hidden])');

    await enableAndWaitLevel(page, 'good');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-record:not([hidden])');
    await page.waitForTimeout(1500);
    await page.click('#btn-stop');
    await page.waitForSelector('#screen-done:not([hidden])');

    await page.reload();
    await page.waitForSelector('#stored-row:not([hidden])');
    // deleteDatabase would block forever on page2's connection if tabs didn't
    // release it on versionchange.
    await page.click('#btn-delete-stored');
    await page.waitForSelector('#stored-row', { state: 'hidden', timeout: 5000 });
    await page2.close();
  } finally {
    await browser.close();
  }
});

test('a second tab cannot disturb a live recording', async () => {
  const { browser, page } = await launch(fixture('tone.wav'));
  try {
    await enableAndWaitLevel(page, 'good');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-record:not([hidden])');
    await page.waitForTimeout(1000);

    const page2 = await page.context().newPage();
    page2.on('dialog', (d) => d.accept());
    await page2.goto(baseURL);
    await page2.waitForSelector('#recovery-card:not([hidden])');
    assert.match(await page2.textContent('#recovery-text'), /another tab/);
    assert.equal(await page2.isHidden('#btn-recover-save'), true);
    assert.equal(await page2.isHidden('#btn-recover-discard'), true);
    await page2.close();

    // Tab A is unaffected and can stop and save normally.
    await page.click('#btn-stop');
    await page.waitForSelector('#screen-done:not([hidden])');
    assert.equal(await page.isEnabled('#btn-save'), true);
  } finally {
    await browser.close();
  }
});

test('mic test records and plays back', async () => {
  const { browser, page } = await launch(fixture('tone.wav'));
  try {
    await enableAndWaitLevel(page, 'good');
    await page.click('#btn-test');
    await page.waitForFunction(
      () => document.getElementById('btn-test').textContent.startsWith('Playing back'),
      null,
      { timeout: 8000 },
    );
    await page.waitForFunction(
      () => document.getElementById('btn-test').textContent === 'Test my microphone',
      null,
      { timeout: 10000 },
    );
    assert.equal(await page.isEnabled('#btn-test'), true);
  } finally {
    await browser.close();
  }
});
