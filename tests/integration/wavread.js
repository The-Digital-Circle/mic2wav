import { readFile } from 'node:fs/promises';

export async function readWav(path) {
  const buf = await readFile(path);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const str = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(off + i));
    return s;
  };
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('not a WAV file');
  if (str(12, 4) !== 'fmt ' || str(36, 4) !== 'data') throw new Error('unexpected chunk layout');
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bitDepth = v.getUint16(34, true);
  const dataSize = v.getUint32(40, true);
  const samples = new Int16Array(
    buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + 44 + dataSize),
  );
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]) / 32767;
    if (a > peak) peak = a;
  }
  return {
    channels,
    sampleRate,
    bitDepth,
    dataSize,
    fileSize: buf.byteLength,
    numSamples: samples.length,
    durationSeconds: samples.length / sampleRate,
    peak,
    samples,
  };
}
