import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wavHeader, floatTo16BitPCM } from '../../js/wav.js';

const here = dirname(fileURLToPath(import.meta.url));
const RATE = 48000;
const SECONDS = 10;

function makeWav(sampleFn) {
  const n = RATE * SECONDS;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = sampleFn(i / RATE);
  const pcm = floatTo16BitPCM(f);
  return Buffer.concat([
    Buffer.from(wavHeader({ sampleRate: RATE, numSamples: n })),
    Buffer.from(pcm.buffer),
  ]);
}

await writeFile(join(here, 'tone.wav'), makeWav((t) => 0.3 * Math.sin(2 * Math.PI * 440 * t)));
// 5 s of tone then 5 s of silence (loops): simulates talking with pauses.
await writeFile(join(here, 'tone-gaps.wav'), makeWav((t) => (t % 10 < 5 ? 0.3 * Math.sin(2 * Math.PI * 440 * t) : 0)));
await writeFile(join(here, 'silence.wav'), makeWav(() => 0));
await writeFile(join(here, 'hot.wav'), makeWav((t) => Math.sign(Math.sin(2 * Math.PI * 220 * t))));
console.log('fixtures written');
