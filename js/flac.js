// Minimal FLAC encoder: mono, 16-bit, subset streams (fixed predictors 0-4,
// Rice coding, single partition). Pure module - no browser APIs - so it runs
// in Workers and in Node tests, where ffmpeg verifies byte-exact losslessness.

const BLOCK_SIZE_CODES = new Map([
  [192, 1], [576, 2], [1152, 3], [2304, 4], [4608, 5],
  [256, 8], [512, 9], [1024, 10], [2048, 11], [4096, 12],
  [8192, 13], [16384, 14], [32768, 15],
]);

const SAMPLE_RATE_CODES = new Map([
  [88200, 1], [176400, 2], [192000, 3], [8000, 4], [16000, 5], [22050, 6],
  [24000, 7], [32000, 8], [44100, 9], [48000, 10], [96000, 11],
]);

const CRC8_TABLE = new Uint8Array(256);
const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c8 = i;
  let c16 = i << 8;
  for (let b = 0; b < 8; b++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xFF : (c8 << 1) & 0xFF;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xFFFF : (c16 << 1) & 0xFFFF;
  }
  CRC8_TABLE[i] = c8;
  CRC16_TABLE[i] = c16;
}

class BitWriter {
  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
    this.len = 0;
    this.acc = 0;
    this.nacc = 0;
  }

  grow(need) {
    if (this.len + need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  writeBits(value, n) {
    while (n > 0) {
      const take = Math.min(8 - this.nacc, n);
      const shift = n - take;
      const bits = (shift >= 32 ? 0 : value >>> shift) & ((1 << take) - 1);
      this.acc = ((this.acc << take) | bits) & 0xFF;
      this.nacc += take;
      n -= take;
      if (this.nacc === 8) {
        this.grow(1);
        this.buf[this.len++] = this.acc;
        this.acc = 0;
        this.nacc = 0;
      }
    }
  }

  writeUnary(q) {
    while (q >= 24) {
      this.writeBits(0, 24);
      q -= 24;
    }
    this.writeBits(1, q + 1); // q zero bits followed by a one
  }

  align() {
    if (this.nacc) this.writeBits(0, 8 - this.nacc);
  }

  crc8(from) {
    let crc = 0;
    for (let i = from; i < this.len; i++) crc = CRC8_TABLE[crc ^ this.buf[i]];
    return crc;
  }

  crc16(from) {
    let crc = 0;
    for (let i = from; i < this.len; i++) {
      crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ this.buf[i]) & 0xFF]) & 0xFFFF;
    }
    return crc;
  }

  take() {
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    return out;
  }
}

function writeUtf8Number(bw, val) {
  if (val < 0x80) {
    bw.writeBits(val, 8);
    return;
  }
  let bytes = 2;
  while (bytes < 6 && val >= 1 << (bytes * 5 + 1)) bytes++; // payload bits: 6,11,16,21,26
  bw.writeBits((0xFF << (8 - bytes)) & 0xFF | (val >>> ((bytes - 1) * 6)), 8);
  for (let i = bytes - 2; i >= 0; i--) {
    bw.writeBits(0b10000000 | ((val >>> (i * 6)) & 0x3F), 8);
  }
}

export class FlacEncoder {
  constructor({ sampleRate, totalSamples = 0, blockSize = 4096 }) {
    this.sampleRate = sampleRate;
    this.totalSamples = totalSamples;
    this.blockSize = blockSize;
    this.frameIndex = 0;
    this.pending = new Int16Array(blockSize);
    this.npending = 0;
    this.bw = new BitWriter(1 << 17);
    // Reusable residual buffers for fixed predictor orders 1-4 (order 0 is
    // the samples themselves).
    this.res = [null, new Int32Array(blockSize), new Int32Array(blockSize),
      new Int32Array(blockSize), new Int32Array(blockSize)];
  }

  header() {
    const bw = new BitWriter(64);
    for (const c of 'fLaC') bw.writeBits(c.charCodeAt(0), 8);
    bw.writeBits(1, 1);  // last metadata block
    bw.writeBits(0, 7);  // STREAMINFO
    bw.writeBits(34, 24);
    bw.writeBits(this.blockSize, 16); // min block size
    bw.writeBits(this.blockSize, 16); // max block size
    bw.writeBits(0, 24); // min frame size (unknown)
    bw.writeBits(0, 24); // max frame size (unknown)
    bw.writeBits(this.sampleRate, 20);
    bw.writeBits(0, 3);  // channels - 1
    bw.writeBits(15, 5); // bits per sample - 1
    bw.writeBits(0, 4);  // total samples, top 4 of 36 bits (always < 2^32 here)
    bw.writeBits(this.totalSamples, 32);
    for (let i = 0; i < 4; i++) bw.writeBits(0, 32); // MD5 unset (spec-legal)
    return bw.take();
  }

  feed(int16) {
    let off = 0;
    while (off < int16.length) {
      const take = Math.min(this.blockSize - this.npending, int16.length - off);
      this.pending.set(int16.subarray(off, off + take), this.npending);
      this.npending += take;
      off += take;
      if (this.npending === this.blockSize) {
        this.encodeFrame(this.pending, this.blockSize);
        this.npending = 0;
      }
    }
    return this.bw.take();
  }

  finish() {
    if (this.npending > 0) {
      this.encodeFrame(this.pending.subarray(0, this.npending), this.npending);
      this.npending = 0;
    }
    return this.bw.take();
  }

  encodeFrame(x, n) {
    const bw = this.bw;
    bw.grow(n * 2 + 64); // verbatim worst case
    const start = bw.len;

    bw.writeBits(0b11111111111110, 14); // sync
    bw.writeBits(0, 1);                 // reserved
    bw.writeBits(0, 1);                 // fixed block size stream
    const bsCode = n === this.blockSize ? BLOCK_SIZE_CODES.get(n) : undefined;
    bw.writeBits(bsCode ?? 0b0111, 4);  // 0111: 16-bit block size at header end
    bw.writeBits(SAMPLE_RATE_CODES.get(this.sampleRate) ?? 0, 4); // 0: STREAMINFO
    bw.writeBits(0, 4);                 // channel assignment: mono
    bw.writeBits(0b100, 3);             // 16 bits per sample
    bw.writeBits(0, 1);                 // reserved
    writeUtf8Number(bw, this.frameIndex++);
    if (bsCode === undefined) bw.writeBits(n - 1, 16);
    bw.writeBits(bw.crc8(start), 8);

    this.encodeSubframe(x, n);

    bw.align();
    bw.writeBits(bw.crc16(start), 16);
  }

  encodeSubframe(x, n) {
    const bw = this.bw;

    let constant = true;
    for (let i = 1; i < n; i++) {
      if (x[i] !== x[0]) {
        constant = false;
        break;
      }
    }
    if (constant) {
      bw.writeBits(0, 8); // pad + type 000000 (constant) + no wasted bits
      bw.writeBits(x[0] & 0xFFFF, 16);
      return;
    }

    // Fixed predictors: successive differencing yields each order's residual.
    const sums = new Array(5).fill(0);
    for (let i = 0; i < n; i++) sums[0] += Math.abs(x[i]);
    let prev = x;
    const maxOrder = Math.min(4, n - 1);
    for (let ord = 1; ord <= maxOrder; ord++) {
      const r = this.res[ord];
      let sum = 0;
      for (let i = ord; i < n; i++) {
        const v = prev[i] - prev[i - 1];
        r[i] = v;
        sum += Math.abs(v);
      }
      sums[ord] = sum;
      prev = r;
    }
    let order = 0;
    for (let ord = 1; ord <= maxOrder; ord++) {
      if (sums[ord] < sums[order]) order = ord;
    }
    const residual = order === 0 ? x : this.res[order];
    const nres = n - order;

    // Rice parameter: estimate from the mean, then check the neighbourhood.
    let sumU = 0;
    for (let i = order; i < n; i++) {
      const r = residual[i];
      sumU += r < 0 ? -2 * r - 1 : 2 * r;
    }
    const mean = sumU / nres;
    let kEst = 0;
    while (kEst < 14 && (1 << (kEst + 1)) < mean + 1) kEst++;
    let k = 0;
    let best = Infinity;
    for (let cand = Math.max(0, kEst - 1); cand <= Math.min(14, kEst + 1); cand++) {
      let cost = nres * (cand + 1);
      for (let i = order; i < n; i++) {
        const r = residual[i];
        const u = r < 0 ? -2 * r - 1 : 2 * r;
        cost += u >>> cand;
      }
      if (cost < best) {
        best = cost;
        k = cand;
      }
    }

    const fixedBits = 8 + 16 * order + 2 + 4 + 4 + best;
    if (fixedBits >= 8 + 16 * n) {
      bw.writeBits(0, 1);
      bw.writeBits(0b000001, 6); // verbatim
      bw.writeBits(0, 1);
      for (let i = 0; i < n; i++) bw.writeBits(x[i] & 0xFFFF, 16);
      return;
    }

    bw.writeBits(0, 1);
    bw.writeBits(0b001000 | order, 6); // fixed predictor
    bw.writeBits(0, 1);
    for (let i = 0; i < order; i++) bw.writeBits(x[i] & 0xFFFF, 16);
    bw.writeBits(0, 2); // residual method: 4-bit Rice
    bw.writeBits(0, 4); // partition order 0
    bw.writeBits(k, 4);
    for (let i = order; i < n; i++) {
      const r = residual[i];
      const u = r < 0 ? -2 * r - 1 : 2 * r;
      bw.writeUnary(u >>> k);
      if (k) bw.writeBits(u & ((1 << k) - 1), k);
    }
  }
}
