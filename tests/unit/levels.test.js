import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peakOf, toDb, countClipped, LevelWindow, SilenceWatchdog } from '../../js/levels.js';

test('peakOf returns max absolute sample, 0 for empty', () => {
  assert.equal(peakOf(new Float32Array([0.1, -0.5, 0.25])), 0.5);
  assert.equal(peakOf(new Float32Array(0)), 0);
});

test('toDb converts linear peak to dBFS', () => {
  assert.equal(toDb(1), 0);
  assert.ok(Math.abs(toDb(0.1) - -20) < 0.01);
  assert.equal(toDb(0), -Infinity);
});

test('countClipped counts runs of >=3 consecutive near-full-scale samples', () => {
  assert.equal(countClipped(new Float32Array([0.99, 0.99, 0.99])), 3);
  assert.equal(countClipped(new Float32Array([0.99, 0.99, 0.1, 0.99, 0.99])), 0);
  assert.equal(countClipped(new Float32Array([-0.99, -1, -0.99, -0.99])), 4);
  assert.equal(countClipped(new Float32Array([0.5, 0.6, 0.7])), 0);
});

test('LevelWindow classifies silent/quiet/good/clipping over a rolling window', () => {
  const w = new LevelWindow(3000);
  assert.equal(w.classify(), 'silent');           // empty
  w.push(0.0005, 0, 0);                           // ~ -66 dBFS
  assert.equal(w.classify(), 'silent');
  w.push(0.02, 0, 100);                           // ~ -34 dBFS
  assert.equal(w.classify(), 'quiet');
  w.push(0.5, 0, 200);                            // ~ -6 dBFS
  assert.equal(w.classify(), 'good');
  w.push(0.999, 5, 300);                          // clipping wins
  assert.equal(w.classify(), 'clipping');
});

test('LevelWindow calls the quiet band "quiet" only for speech-like dynamics', () => {
  // Speech: syllable peaks ~-35 dBFS with near-silent gaps between words.
  const speech = new LevelWindow(3000);
  for (let t = 0; t < 2000; t += 100) speech.push(t % 400 < 200 ? 0.0178 : 0.0005, 0, t);
  assert.equal(speech.classify(), 'quiet');

  // Steady room noise / hum at -40 dBFS: nobody is talking - don't say "move closer".
  const hum = new LevelWindow(3000);
  for (let t = 0; t < 2000; t += 100) hum.push(0.01, 0, t);
  assert.equal(hum.classify(), 'silent');

  // Dynamics far below the absolute floor are not speech either.
  const rumble = new LevelWindow(3000);
  for (let t = 0; t < 2000; t += 100) rumble.push(t % 400 < 200 ? 0.002 : 0.0002, 0, t);
  assert.equal(rumble.classify(), 'silent');
});

test('LevelWindow expires entries outside the window', () => {
  const w = new LevelWindow(3000);
  w.push(0.5, 0, 0);
  w.push(0.0001, 0, 4000);                        // the good peak is now stale
  assert.equal(w.classify(), 'silent');
});

test('SilenceWatchdog fires once per sustained silent stretch', () => {
  const wd = new SilenceWatchdog({ thresholdDb: -55, durationMs: 15000 });
  assert.equal(wd.push(0.5, 0), false);            // loud
  assert.equal(wd.push(0.0001, 1000), false);      // silence starts
  assert.equal(wd.push(0.0001, 10000), false);     // not long enough
  assert.equal(wd.push(0.0001, 16000), true);      // fires
  assert.equal(wd.push(0.0001, 20000), false);     // only once
  assert.equal(wd.push(0.5, 21000), false);        // sound resets
  assert.equal(wd.push(0.0001, 22000), false);
  assert.equal(wd.push(0.0001, 37000), true);      // re-fires after reset
});
