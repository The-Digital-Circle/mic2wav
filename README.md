# 🎙️ mic2wav — Podcast Guest Recorder

A single-page web app for recording podcast guests who can't install or
configure anything. Open the page, check your mic, hit record, save a
high-quality WAV — all locally in the browser. No uploads, no accounts,
no dependencies.

**▶ Try it: [record.thedigitalcircle.org](https://record.thedigitalcircle.org/)**

**Why:** remote-call audio (Zoom etc.) is compressed and gappy. The standard
fix is a "double-ender": each side records locally. This is the guest's side.

## Features

- **Lossless capture** — raw PCM via AudioWorklet at the device's native
  sample rate. No lossy codec anywhere in the pipeline.
- **FLAC by default** — saves losslessly compressed FLAC (~50-60% of WAV
  size for speech) via a built-in dependency-free encoder running in a
  Worker; "Save as WAV instead" is one tap away. Tests prove byte-exact
  losslessness against ffmpeg's reference decoder.
- **Mic check that prevents ruined takes** — input picker, live level meter,
  silent/too-quiet/good/clipping status with plain-language fixes, and a
  5-second test recording you can play back before committing to an interview.
- **3-hour recordings on old hardware** — audio streams to IndexedDB in 5 s
  chunks, so memory stays flat (~1 GB/3 h goes to disk, not RAM).
- **Crash-proof** — if the browser dies mid-interview, the page offers to
  save everything recorded so far on next load.
- **In-recording watchdogs** — clipping warnings, a "is your mic muted?"
  alert after 15 s of silence, storage-full graceful stop, screen wake lock.
- **Storage transparency** — a panel shows what's stored on the device
  (duration, size, saved status) with one-tap delete, plus live disk usage
  and how many hours of audio still fit.
- **Self-cleaning** — on Chrome/Edge the save dialog streams the WAV to disk
  and, once the write is verifiably complete, frees the browser copy
  automatically. Elsewhere (downloads give the page no completion signal) a
  one-tap "It saved — free up space" confirmation does the same.
- **Tiny** — ~22 KB gzipped of static files, no frameworks, no webfonts,
  works on slow connections.
- **Installable & offline-capable** — a web app manifest plus a
  network-first service worker: Chrome offers "Install app", and after one
  visit the recorder boots with no connection at all (recording is local
  anyway). Network-first means online users always get the latest deploy —
  no stale-version trap. Regenerate icons with `node tests/make-icons.js`.

## Hosting

It's just static files. For GitHub Pages: Settings → Pages → deploy from
`main` / root. Any static host over **HTTPS** works (microphone access
requires it).

## Browser support

Chrome/Edge 66+, Firefox 76+, Safari 14.1+ (iOS 14.5+). Older browsers get
a friendly unsupported message.

## Development

No build step. `npm install` once, then:

- `npm test` — unit tests (WAV/FLAC encoding incl. ffmpeg roundtrip proofs,
  level analysis, payload budget; requires `ffmpeg` on PATH)
- `npm run test:integration` — Playwright drives system Chrome with a fake
  microphone (tone/silence/clipping fixtures) through record, save, and
  crash-recovery flows, then validates the downloaded WAV byte-for-byte.

## Recording defaults

Echo cancellation, noise suppression and auto-gain are **off** for fidelity
(producers prefer raw audio). The "Boost quiet microphone" toggle re-enables
auto-gain for guests who are too quiet and can't adjust their OS input level.
