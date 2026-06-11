export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = Math.round(s * 32767);
  }
  return out;
}

export function wavHeader({ sampleRate, numSamples, channels = 1, bitDepth = 16 }) {
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = numSamples * blockAlign;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
  return buf;
}

export function buildFilename(name, date) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const slug = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug ? slug + '-' : ''}recording-${stamp}.wav`;
}

export class ChunkBatcher {
  constructor(samplesPerChunk) {
    this.samplesPerChunk = samplesPerChunk;
    this.parts = [];
    this.count = 0;
  }

  push(int16) {
    this.parts.push(int16);
    this.count += int16.length;
    return this.count >= this.samplesPerChunk ? this.flush() : null;
  }

  flush() {
    if (this.count === 0) return null;
    const out = new Int16Array(this.count);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    this.parts = [];
    this.count = 0;
    return out;
  }
}
