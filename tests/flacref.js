// Reference FLAC decoding via ffmpeg, for proving our encoder is lossless.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);

// Returns the decoded 16-bit little-endian PCM and ffmpeg's error output
// (which must be empty for a clean, spec-conforming stream).
export async function ffmpegDecode(flacBytes) {
  const dir = await mkdtemp(join(tmpdir(), 'mic2wav-flac-'));
  try {
    const inPath = join(dir, 'in.flac');
    const outPath = join(dir, 'out.pcm');
    await writeFile(inPath, flacBytes);
    const { stderr } = await exec('ffmpeg', [
      '-v', 'error',
      '-i', inPath,
      '-f', 's16le', '-acodec', 'pcm_s16le',
      outPath,
    ]);
    return { pcm: await readFile(outPath), stderr: stderr.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
