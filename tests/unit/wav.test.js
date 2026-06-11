import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floatTo16BitPCM, wavHeader, buildFilename, ChunkBatcher } from '../../js/wav.js';

function str(view, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

test('floatTo16BitPCM scales, rounds and clamps', () => {
  const out = floatTo16BitPCM(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]));
  assert.deepEqual([...out], [0, 32767, -32767, 16384, -16383, 32767, -32767]);
});

test('wavHeader is a canonical 44-byte RIFF header (48kHz mono 16-bit)', () => {
  const buf = wavHeader({ sampleRate: 48000, numSamples: 480000 });
  const v = new DataView(buf);
  assert.equal(buf.byteLength, 44);
  assert.equal(str(v, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 960000);
  assert.equal(str(v, 8, 4), 'WAVE');
  assert.equal(str(v, 12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);       // fmt chunk size
  assert.equal(v.getUint16(20, true), 1);        // PCM
  assert.equal(v.getUint16(22, true), 1);        // mono
  assert.equal(v.getUint32(24, true), 48000);    // sample rate
  assert.equal(v.getUint32(28, true), 96000);    // byte rate
  assert.equal(v.getUint16(32, true), 2);        // block align
  assert.equal(v.getUint16(34, true), 16);       // bit depth
  assert.equal(str(v, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), 960000);   // data size
});

test('wavHeader respects other sample rates and odd lengths', () => {
  const v = new DataView(wavHeader({ sampleRate: 44100, numSamples: 12345 }));
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(28, true), 88200);
  assert.equal(v.getUint32(40, true), 24690);
  assert.equal(v.getUint32(4, true), 36 + 24690);
});

test('buildFilename slugs the name and stamps the date', () => {
  const d = new Date(2026, 5, 11, 14, 30); // 2026-06-11 14:30 local
  assert.equal(buildFilename('Alice Smith', d), 'alice-smith-recording-2026-06-11-1430.wav');
  assert.equal(buildFilename('', d), 'recording-2026-06-11-1430.wav');
  assert.equal(buildFilename('  Ünïcode! Guest  ', d), 'n-code-guest-recording-2026-06-11-1430.wav');
});

test('ChunkBatcher batches to the configured size and flushes the remainder', () => {
  const b = new ChunkBatcher(10);
  assert.equal(b.push(new Int16Array([1, 2, 3, 4])), null);
  assert.equal(b.push(new Int16Array([5, 6, 7, 8])), null);
  const chunk = b.push(new Int16Array([9, 10, 11]));
  assert.deepEqual([...chunk], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(b.flush(), null);                 // empty after emit
  b.push(new Int16Array([42]));
  assert.deepEqual([...b.flush()], [42]);
  assert.equal(b.flush(), null);
});
