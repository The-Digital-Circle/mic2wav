import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlacEncoder } from '../../js/flac.js';
import { ffmpegDecode } from '../flacref.js';

function encodeAll(int16, sampleRate, blockSize) {
  const enc = new FlacEncoder({ sampleRate, totalSamples: int16.length, ...(blockSize ? { blockSize } : {}) });
  const parts = [enc.header(), enc.feed(int16), enc.finish()];
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

function pcmBytes(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
}

async function assertLossless(int16, sampleRate = 48000) {
  const flac = encodeAll(int16, sampleRate);
  const { pcm, stderr } = await ffmpegDecode(flac);
  assert.equal(stderr, '', `reference decoder reported: ${stderr}`);
  assert.equal(pcm.length, int16.length * 2, 'decoded sample count');
  assert.ok(pcm.equals(pcmBytes(int16)), 'decoded PCM must be byte-identical to the source');
  return flac;
}

function sine(n, freq = 440, amp = 0.3, rate = 48000) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

test('header: fLaC magic and STREAMINFO fields', () => {
  const enc = new FlacEncoder({ sampleRate: 48000, totalSamples: 123456 });
  const h = enc.header();
  assert.equal(h.length, 42);
  assert.equal(String.fromCharCode(h[0], h[1], h[2], h[3]), 'fLaC');
  assert.equal(h[4], 0x80); // last-metadata-block flag + type 0 (STREAMINFO)
  assert.equal((h[5] << 16) | (h[6] << 8) | h[7], 34); // STREAMINFO length
  assert.equal((h[8] << 8) | h[9], 4096);   // min block size
  assert.equal((h[10] << 8) | h[11], 4096); // max block size
  // sample rate: 20 bits starting at byte 18
  assert.equal((h[18] << 12) | (h[19] << 4) | (h[20] >> 4), 48000);
  // channels-1 (3 bits) = 000, bps-1 (5 bits) = 01111
  assert.equal(h[20] & 0x0F, 0b0000); // channels (000) + MSB of bps-1 (0)
  assert.equal(h[21] >> 4, 0b1111);   // remaining 4 bits of bps-1
  // total samples: 36 bits, low 32 in bytes 22-25 with top 4 in h[21]
  assert.equal(((h[21] & 0x0F) * 2 ** 32) + ((h[22] << 24 >>> 0) + (h[23] << 16) + (h[24] << 8) + h[25]), 123456);
});

test('lossless: 1.7s sine (partial last frame)', async () => {
  const x = sine(81600);
  const flac = await assertLossless(x);
  assert.ok(flac.length < x.length * 2 * 0.6, `sine should compress well, got ${flac.length}/${x.length * 2}`);
});

test('lossless: digital silence compresses to almost nothing', async () => {
  const x = new Int16Array(24000);
  const flac = await assertLossless(x);
  assert.ok(flac.length < 600, `silence should be tiny, got ${flac.length} bytes`);
});

test('lossless: full-scale seeded noise (worst case stays bounded)', async () => {
  const x = new Int16Array(10000);
  let s = 0x12345678;
  for (let i = 0; i < x.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    x[i] = (s & 0xFFFF) - 32768;
  }
  const flac = await assertLossless(x);
  assert.ok(flac.length < x.length * 2 * 1.1, `noise must not blow up, got ${flac.length}/${x.length * 2}`);
});

test('lossless: extreme values incl. -32768, length 4097', async () => {
  const x = new Int16Array(4097);
  for (let i = 0; i < x.length; i++) {
    x[i] = i % 3 === 0 ? 32767 : i % 3 === 1 ? -32768 : (i * 7919) % 65536 - 32768;
  }
  await assertLossless(x);
});

test('lossless: exactly one full block', async () => {
  await assertLossless(sine(4096));
});

test('lossless: 44.1kHz stream', async () => {
  await assertLossless(sine(22050, 440, 0.3, 44100), 44100);
});

test('feeding in odd-sized pieces produces identical output to one feed', () => {
  const x = sine(20000);
  const whole = encodeAll(x, 48000);
  const enc = new FlacEncoder({ sampleRate: 48000, totalSamples: x.length });
  const parts = [enc.header()];
  for (let off = 0; off < x.length; off += 1000) {
    parts.push(enc.feed(x.subarray(off, Math.min(off + 1000, x.length))));
  }
  parts.push(enc.finish());
  const pieces = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  assert.ok(whole.equals(pieces), 'encoder must be deterministic across feed boundaries');
});
