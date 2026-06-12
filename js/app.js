import { isSupported, AudioEngine, listInputs } from './audio.js';
import { floatTo16BitPCM, buildFilename, ChunkBatcher } from './wav.js';
import { LevelWindow, SilenceWatchdog, toDb } from './levels.js';
import { SessionStore } from './store.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHUNK_SECONDS = 5;
const TEST_SECONDS = 5;
const LOCK_NAME = 'mic2wav-session';
const HEARTBEAT_MS = 5000;
const LIVE_THRESHOLD_MS = 30000;

const LEVEL_TEXT = {
  silent: 'We can’t hear anything yet — say a few words, or pick a different microphone above.',
  quiet: 'A bit quiet — try moving closer to your microphone, or tick “Boost” below.',
  good: 'Sounding good!',
  clipping: 'Too loud — move back a little from the microphone.',
};

const state = {
  screen: 'setup',
  engine: null,
  store: null,
  deviceId: null,
  ready: false,
  checkPassed: false,
  monitorPeak: 0,
  levelWindow: new LevelWindow(3000),
  recording: false,
  paused: false,
  batcher: null,
  seq: 0,
  totalSamples: 0,
  sampleRate: 48000,
  startedAt: 0,
  writeQueue: Promise.resolve(),
  writeError: null,
  watchdog: null,
  wakeLock: null,
  lastClipWarn: 0,
  bannerTimer: 0,
  heartbeatTimer: 0,
  streamDead: false,
  testing: false,
  testFrames: [],
  result: null,
  saved: false,
};

// ---------- helpers ----------

function showScreen(name) {
  state.screen = name;
  for (const s of ['unsupported', 'setup', 'record', 'done']) {
    $(`screen-${s}`).hidden = s !== name;
  }
  if (name === 'setup' && state.store) refreshStoragePanel();
}

function formatTime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

function showDoneNote(text, ok = false) {
  const note = $('done-note');
  note.hidden = false;
  note.textContent = text;
  note.classList.toggle('ok', ok);
}

function showRecBanner(text, ms = 6000) {
  const banner = $('rec-banner');
  banner.textContent = text;
  banner.hidden = false;
  clearTimeout(state.bannerTimer);
  state.bannerTimer = setTimeout(() => { banner.hidden = true; }, ms);
}

function beforeUnloadGuard(e) {
  e.preventDefault();
  e.returnValue = '';
}

// ---------- single-writer guard (multi-tab safety) ----------
// A second tab must never discard or "recover" a session that another tab is
// still writing. Tabs holding an active session keep a Web Lock for the page's
// lifetime; browsers without Web Locks fall back to a heartbeat timestamp.

let releaseSessionLock = null;

function acquireSessionLock() {
  if (!navigator.locks) return Promise.resolve(true);
  if (releaseSessionLock) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      return new Promise((release) => { releaseSessionLock = release; });
    }).catch(() => resolve(true));
  });
}

function dropSessionLock() {
  if (releaseSessionLock) {
    releaseSessionLock();
    releaseSessionLock = null;
  }
}

async function sessionLooksLive(meta) {
  if (releaseSessionLock) return false; // it's ours
  if (navigator.locks) {
    try {
      const { held } = await navigator.locks.query();
      return (held || []).some((l) => l.name === LOCK_NAME);
    } catch { /* fall back to heartbeat */ }
  }
  return Boolean(meta.lastWriteAt && Date.now() - meta.lastWriteAt < LIVE_THRESHOLD_MS);
}

// ---------- audio frames ----------

function onFrame(frame, peak, clipCount) {
  if (peak > state.monitorPeak) state.monitorPeak = peak;
  state.levelWindow.push(peak, clipCount, performance.now());

  if (state.testing) state.testFrames.push(frame);

  if (state.recording && !state.paused) {
    const now = performance.now();
    if (state.watchdog.push(peak, now)) {
      showRecBanner('We haven’t heard anything for a while — is your microphone muted?', 10000);
    }
    if (clipCount > 0 && now - state.lastClipWarn > 5000) {
      state.lastClipWarn = now;
      showRecBanner('Too loud — your audio is clipping. Move back a little.');
    }
    const chunk = state.batcher.push(floatTo16BitPCM(frame));
    state.totalSamples += frame.length;
    if (chunk) queueWrite(chunk);
  }
}

function queueWrite(int16) {
  const seq = state.seq++;
  state.writeQueue = state.writeQueue
    .then(() => state.store.appendChunk(seq, int16))
    .catch((err) => {
      if (!state.writeError) {
        state.writeError = err;
        stopRecording('This device ran out of storage space — we kept everything recorded up to this point.');
      }
    });
}

// ---------- rendering ----------

function renderLoop() {
  const db = toDb(state.monitorPeak);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const fill = state.screen === 'record' ? $('meter-rec-fill') : $('meter-setup-fill');
  fill.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  fill.classList.toggle('hot', db > -6);
  state.monitorPeak *= 0.9;
  if (state.screen === 'record') {
    $('timer').textContent = formatTime(state.totalSamples / state.sampleRate);
    $('rec-size').textContent = formatBytes(state.totalSamples * 2);
  }
  requestAnimationFrame(renderLoop);
}

function updateStatusPill() {
  if (state.screen !== 'setup' || !state.engine || $('setup-controls').hidden) return;
  const level = state.levelWindow.classify();
  if (level !== 'silent' && !state.ready) {
    state.ready = true;
    $('btn-start').disabled = false;
  }
  if (level === 'good') state.checkPassed = true;
  // Once the check has passed, going quiet just means they stopped talking.
  // Don't regress to "move closer" - only clipping breaks back through.
  const display = state.checkPassed && (level === 'quiet' || level === 'silent') ? 'good' : level;
  const pill = $('status-pill');
  pill.dataset.level = display;
  pill.textContent = LEVEL_TEXT[display];
}

function resetReadiness() {
  state.ready = false;
  state.checkPassed = false;
  state.levelWindow = new LevelWindow(3000);
  $('btn-start').disabled = true;
  $('status-pill').dataset.level = 'silent';
  $('status-pill').textContent = 'Say a few words to check your level…';
}

// ---------- setup ----------

async function enableMic() {
  const btn = $('btn-enable');
  btn.disabled = true;
  try {
    $('mic-error').hidden = true;
    if (!state.engine) {
      state.engine = new AudioEngine();
      state.engine.onFrame = onFrame;
      state.engine.onTrackEnded = onTrackEnded;
    }
    await state.engine.acquire({ deviceId: state.deviceId, boost: $('boost-toggle').checked });
    state.streamDead = false;
    state.sampleRate = state.engine.context.sampleRate;
    state.engine.context.onstatechange = onContextStateChange;
    await populateDevices();
    btn.hidden = true;
    $('setup-controls').hidden = false;
  } catch (err) {
    showMicError(err);
  } finally {
    btn.disabled = false;
  }
}

// iOS sets a non-standard 'interrupted' state during calls/Siri; treat every
// non-running state the same: try to resume, and pause rather than silently
// drop frames if the context won't run.
async function onContextStateChange() {
  const ctx = state.engine.context;
  if (ctx.state === 'running' || ctx.state === 'closed') return;
  await Promise.race([ctx.resume().catch(() => {}), sleep(1500)]);
  if (ctx.state !== 'running' && state.recording && !state.paused) {
    togglePause();
    showRecBanner('Audio was interrupted — recording is paused. Press Resume when you’re ready.', 15000);
  }
}

function showSetupError(text) {
  const el = $('mic-error');
  el.hidden = false;
  el.textContent = text;
}

function showMicError(err) {
  showSetupError(err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
    ? 'Microphone access was blocked. Click the camera/microphone icon in your browser’s address bar, allow the microphone, then try again.'
    : `Couldn’t open the microphone (${err?.name || 'unknown error'}). Close other apps using it and try again.`);
}

async function populateDevices() {
  const inputs = await listInputs();
  const select = $('device-select');
  select.innerHTML = '';
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${select.length + 1}`;
    select.appendChild(opt);
  }
  const current = state.engine.currentDeviceId();
  if (current) {
    select.value = current;
    state.deviceId = current;
  }
}

async function changeDevice() {
  const select = $('device-select');
  const boost = $('boost-toggle');
  select.disabled = true;
  boost.disabled = true;
  state.deviceId = select.value;
  resetReadiness();
  try {
    await state.engine.acquire({ deviceId: state.deviceId, boost: boost.checked });
    state.streamDead = false;
  } catch (err) {
    showMicError(err);
  } finally {
    select.disabled = false;
    boost.disabled = false;
  }
}

// Re-open the mic after a disconnect: try the previous device, fall back to
// the system default if it's still gone.
async function reacquire() {
  const boost = $('boost-toggle').checked;
  try {
    await state.engine.acquire({ deviceId: state.deviceId, boost });
  } catch {
    await state.engine.acquire({ boost });
    state.deviceId = state.engine.currentDeviceId();
  }
  state.streamDead = false;
}

async function testMic() {
  const btn = $('btn-test');
  state.testFrames = [];
  state.testing = true;
  btn.disabled = true;
  for (let s = TEST_SECONDS; s > 0; s--) {
    btn.textContent = `Recording… ${s}`;
    await sleep(1000);
  }
  state.testing = false;
  btn.textContent = 'Playing back…';
  await state.engine.playBack(state.testFrames);
  state.testFrames = [];
  btn.textContent = 'Test my microphone';
  btn.disabled = false;
}

// ---------- storage panel ----------

async function refreshStoragePanel() {
  if (!state.store) return;
  const info = await state.store.info().catch(() => null);
  const hasStored = Boolean(info && info.numSamples > 0);
  $('stored-row').hidden = !hasStored;
  if (hasStored) {
    $('stored-title').textContent = info.name ? `${info.name}’s recording` : 'Stored recording';
    if (await sessionLooksLive(info)) {
      $('stored-detail').textContent = 'Recording in progress in another tab…';
      $('btn-delete-stored').hidden = true;
    } else {
      $('stored-detail').textContent =
        `${formatTime(info.numSamples / info.sampleRate)} · ${formatBytes(info.bytes)} · ${info.saved ? 'saved ✓' : 'not saved yet'}`;
      $('btn-delete-stored').hidden = false;
    }
  }

  let usageText = '';
  let low = false;
  let explain = false;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    const hoursLeft = (quota - usage) / (state.sampleRate * 2 * 3600);
    const room = hoursLeft >= 24 ? '24+ hours'
      : hoursLeft >= 2 ? `about ${Math.round(hoursLeft)} hours`
      : `about ${Math.max(0, hoursLeft).toFixed(1)} hours`;
    low = hoursLeft < 4;
    usageText = `${formatBytes(usage)} of browser storage in use · room for ${room} more audio`;
    // Scale with what we actually store: small leftovers (uncompacted
    // tombstones after cleanup) deserve the explainer as much as gigabytes.
    explain = usage > (hasStored ? info.bytes : 0) * 1.5 + 1e6;
  } catch { /* estimate unsupported - hide the line */ }
  $('storage-usage').textContent = usageText;
  $('storage-usage').classList.toggle('low', low);
  $('storage-explain').hidden = !explain;

  $('storage-panel').hidden = !hasStored && !usageText;
}

async function deleteStored() {
  const info = await state.store.info().catch(() => null);
  if (!info || info.numSamples === 0) return;
  if (await sessionLooksLive(info)) {
    refreshStoragePanel();
    return;
  }
  const what = info.saved
    ? 'the stored copy of your last recording'
    : 'your UNSAVED recording';
  if (!confirm(`Delete ${what} from this device? This can’t be undone.`)) return;
  await state.store.discard();
  dropSessionLock();
  $('recovery-card').hidden = true;
  refreshStoragePanel();
}

// ---------- recording ----------

async function startRecording() {
  const startBtn = $('btn-start');
  startBtn.disabled = true; // re-enabled only on the early-return paths below
  const abort = (message) => {
    if (message) showSetupError(message);
    startBtn.disabled = false;
  };
  const existing = await state.store.findRecoverable();
  if (existing && await sessionLooksLive(existing)) {
    abort('A recording seems to be in progress in another tab on this device — close this tab and use that one.');
    return;
  }
  if (existing && !existing.saved) {
    const info = await state.store.info();
    if (info && info.numSamples > 0 &&
        !confirm('You still have an unsaved earlier recording. Starting a new one deletes it. Continue?')) {
      abort();
      return;
    }
  }
  if (!(await acquireSessionLock())) {
    abort('A recording is already in progress in another tab on this device.');
    return;
  }
  state.batcher = new ChunkBatcher(state.sampleRate * CHUNK_SECONDS);
  state.seq = 0;
  state.totalSamples = 0;
  state.writeError = null;
  state.writeQueue = Promise.resolve();
  state.watchdog = new SilenceWatchdog();
  state.lastClipWarn = 0;
  state.startedAt = Date.now();
  try {
    await state.store.startSession({
      sampleRate: state.sampleRate,
      name: $('name-input').value.trim(),
      startedAt: state.startedAt,
      saved: false,
      lastWriteAt: Date.now(),
    });
  } catch (err) {
    abort(`Couldn’t prepare local storage (${err?.name || 'unknown error'}). Try reloading the page.`);
    return;
  }
  $('recovery-card').hidden = true;
  $('mic-error').hidden = true;
  state.heartbeatTimer = setInterval(() => state.store.touch().catch(() => {}), HEARTBEAT_MS);
  state.recording = true;
  state.paused = false;
  $('btn-pause').textContent = 'Pause';
  $('rec-state-label').textContent = 'Recording';
  $('rec-indicator').classList.remove('paused');
  $('rec-banner').hidden = true;
  showScreen('record');
  requestWakeLock();
  window.addEventListener('beforeunload', beforeUnloadGuard);
}

async function togglePause() {
  if (state.paused && state.streamDead) {
    const btn = $('btn-pause');
    btn.disabled = true;
    try {
      await reacquire();
    } catch {
      showRecBanner('Couldn’t reconnect a microphone — plug one in and press Resume again, or stop and save.', 8000);
      return;
    } finally {
      btn.disabled = false;
    }
  }
  state.paused = !state.paused;
  $('btn-pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('rec-state-label').textContent = state.paused ? 'Paused' : 'Recording';
  $('rec-indicator').classList.toggle('paused', state.paused);
}

function onTrackEnded() {
  state.streamDead = true;
  if (state.recording && !state.paused) {
    togglePause();
    showRecBanner('Your microphone was disconnected — recording is paused. Reconnect it, then press Resume.', 15000);
  }
}

async function stopRecording(failureMessage) {
  if (!state.recording) return;
  state.recording = false;
  state.paused = false;
  clearInterval(state.heartbeatTimer);
  const last = state.batcher.flush();
  if (last) queueWrite(last);
  await state.writeQueue;
  if (state.writeError && !failureMessage) {
    failureMessage = 'This device ran out of storage space — the very end may be missing, but everything else was kept.';
  }
  releaseWakeLock();
  state.engine.releaseStream(); // turn the browser's mic indicator off
  window.removeEventListener('beforeunload', beforeUnloadGuard);
  try {
    state.result = await state.store.finalize();
  } catch (err) {
    failureMessage = `Something went wrong assembling the file (${err?.message}). Reload this page to recover your audio.`;
    state.result = null;
  }
  state.saved = false;
  showScreen('done');
  $('done-stats').hidden = !state.result;
  $('done-duration').textContent = state.result ? formatTime(state.result.numSamples / state.result.sampleRate) : '';
  $('done-size').textContent = state.result ? formatBytes(state.result.blob.size) : '';
  $('btn-save').disabled = !state.result;
  $('btn-save').textContent = 'Save recording';
  $('save-confirm').hidden = true;
  $('done-note').hidden = true;
  if (failureMessage) showDoneNote(failureMessage);
}

// ---------- wake lock ----------

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    state.wakeLock = null;
  }
  if (!state.wakeLock && matchMedia('(pointer: coarse)').matches) {
    showRecBanner('Keep your screen on while recording.', 8000);
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.recording) requestWakeLock();
});

// ---------- save / new ----------

let lastDownloadUrl = null;

function triggerDownload(result, ext = 'wav') {
  // Keep at most one object URL pinned, or repeated save/record cycles would
  // hold every past recording's data alive for the rest of the session.
  if (lastDownloadUrl) URL.revokeObjectURL(lastDownloadUrl);
  const a = document.createElement('a');
  const url = URL.createObjectURL(result.blob);
  lastDownloadUrl = url;
  a.href = url;
  a.download = buildFilename(result.name, new Date(result.startedAt), ext);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // A multi-GB download can take minutes; only revoke once the page goes away.
  window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
}

// Losslessly compress the result's PCM (the WAV blob minus its 44-byte
// header) to FLAC in a Worker. Output accumulates as ~16 MB Blob slices so a
// 3-hour encode never holds the whole file in memory; the final Blob is a
// lazy composite.
function encodeToFlac(result, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./flacworker.js', import.meta.url), { type: 'module' });
    const pcm = result.blob.slice(44);
    const blobs = [];
    let group = [];
    let groupSize = 0;
    let sent = 0;
    const flush = () => {
      if (groupSize > 0) {
        blobs.push(new Blob(group));
        group = [];
        groupSize = 0;
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'FLAC encoding failed'));
    };
    worker.onmessage = async ({ data }) => {
      if (data.bytes?.byteLength) {
        group.push(data.bytes);
        groupSize += data.bytes.byteLength;
        if (groupSize >= 16e6) flush();
      }
      if (data.type === 'done') {
        flush();
        worker.terminate();
        resolve(new Blob(blobs, { type: 'audio/flac' }));
        return;
      }
      try {
        if (sent < pcm.size) {
          const slice = pcm.slice(sent, Math.min(sent + 4e6, pcm.size));
          sent += slice.size;
          const buffer = await slice.arrayBuffer();
          worker.postMessage({ type: 'chunk', buffer }, [buffer]);
          onProgress?.(sent / pcm.size);
        } else {
          worker.postMessage({ type: 'finish' });
        }
      } catch (err) {
        worker.terminate();
        reject(err);
      }
    };
    worker.postMessage({ type: 'start', sampleRate: result.sampleRate, totalSamples: result.numSamples });
  });
}

const FORMATS = {
  flac: { ext: 'flac', mime: 'audio/flac', description: 'FLAC audio' },
  wav: { ext: 'wav', mime: 'audio/wav', description: 'WAV audio' },
};

// Get the recording onto the user's disk in the requested format.
// 'confirmed': written via the File System Access API and close() resolved -
//   the file is verifiably on disk, so the browser copy is safe to free.
// 'triggered': anchor download started - the page gets no completion signal
//   for those, so cleanup needs the human to confirm.
// 'cancelled': user closed the picker - keep everything, change nothing.
async function deliverFile({ name, startedAt, getResult, btn, format = 'flac' }) {
  const fmt = FORMATS[format];
  const label = btn?.textContent;
  if (btn) btn.disabled = true;
  try {
    const produce = async () => {
      const result = await getResult();
      if (format !== 'flac') return result;
      const blob = await encodeToFlac(result, (p) => {
        if (btn) btn.textContent = `Compressing… ${Math.round(p * 100)}%`;
      });
      return { ...result, blob };
    };
    if (!window.showSaveFilePicker) {
      triggerDownload(await produce(), fmt.ext);
      return 'triggered';
    }
    let handle;
    try {
      // Pick the destination first, while the click gesture is still fresh -
      // preparing a 3-hour file can outlive the transient activation window.
      handle = await window.showSaveFilePicker({
        suggestedName: buildFilename(name, new Date(startedAt), fmt.ext),
        types: [{ description: fmt.description, accept: { [fmt.mime]: ['.' + fmt.ext] } }],
      });
    } catch {
      return 'cancelled';
    }
    const result = await produce();
    const writable = await handle.createWritable();
    const reader = result.blob.stream().getReader();
    let written = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
      if (btn) btn.textContent = `Saving… ${Math.round((written / result.blob.size) * 100)}%`;
    }
    await writable.close();
    return 'confirmed';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

async function saveRecording(format, btn) {
  if (!state.result) return;
  try {
    const outcome = await deliverFile({
      name: state.result.name,
      startedAt: state.result.startedAt,
      getResult: async () => state.result,
      btn,
      format,
    });
    if (outcome === 'cancelled') return;
    state.saved = true;
    if (outcome === 'confirmed') {
      const freed = state.result.blob.size;
      await state.store.discard();
      dropSessionLock();
      showDoneNote(`Saved ✓ — ${formatBytes(freed)} of browser storage freed automatically.`, true);
      $('btn-save').textContent = 'Save another copy';
      $('save-confirm').hidden = true;
    } else {
      state.store.markSaved().catch(() => {});
      $('btn-save').textContent = 'Saved ✓ — save again';
      $('save-confirm').hidden = false;
    }
  } catch (err) {
    showDoneNote(`Saving failed (${err?.name || 'error'}) — your recording is still safe in this browser. Try again.`);
  }
}

async function freeSpace() {
  if (!confirm('Make sure the .wav file is fully downloaded and plays. Delete the copy stored in this browser?')) return;
  const freed = state.result?.blob.size ?? 0;
  await state.store.discard();
  dropSessionLock();
  $('save-confirm').hidden = true;
  showDoneNote(`${formatBytes(freed)} of browser storage freed.`, true);
}

async function newRecording() {
  if (!state.saved && state.result && !confirm('Delete this recording without saving it?')) return;
  await state.store.discard();
  dropSessionLock();
  state.result = null;
  $('btn-save').textContent = 'Save recording';
  $('recovery-card').hidden = true;
  resetReadiness();
  showScreen('setup');
  try {
    await state.engine.acquire({ deviceId: state.deviceId, boost: $('boost-toggle').checked });
    state.streamDead = false;
  } catch (err) {
    showMicError(err);
  }
}

// ---------- recovery ----------

async function maybeOfferRecovery() {
  const meta = await state.store.findRecoverable();
  if (!meta) return;
  if (await sessionLooksLive(meta)) {
    $('recovery-text').textContent =
      'A recording seems to be in progress in another tab on this device — close this tab and keep using that one.';
    $('btn-recover-save').hidden = true;
    $('btn-recover-discard').hidden = true;
    $('recovery-card').hidden = false;
    return;
  }
  const info = await state.store.info();
  if (!info || info.numSamples === 0) {
    await state.store.discard();
    return;
  }
  const minutes = info.numSamples / info.sampleRate / 60;
  const length = minutes < 1 ? 'under a minute' : `${Math.round(minutes)} min`;
  // A "saved" session stays recoverable: marking happens when the download is
  // triggered, and a cancelled save dialog must not cost anyone an interview.
  $('recovery-text').textContent = meta.saved
    ? `Your last recording (${length}) was already saved. Need it again?`
    : `We found an unsaved recording from earlier (${length}). Save it?`;
  $('btn-recover-save').textContent = meta.saved ? 'Download again' : 'Save it';
  $('btn-recover-save').hidden = false;
  $('btn-recover-discard').hidden = false;
  $('recovery-card').hidden = false;
  $('btn-recover-save').addEventListener('click', recoverSave);
  $('btn-recover-discard').addEventListener('click', recoverDiscard);
}

async function recoverSave() {
  try {
    const meta = await state.store.findRecoverable();
    if (!meta) {
      $('recovery-card').hidden = true;
      return;
    }
    const outcome = await deliverFile({
      name: meta.name,
      startedAt: meta.startedAt,
      getResult: () => state.store.finalize(),
      btn: $('btn-recover-save'),
      format: 'flac',
    });
    if (outcome === 'cancelled') return;
    if (outcome === 'confirmed') {
      await state.store.discard();
      dropSessionLock();
    } else {
      await state.store.markSaved();
    }
    $('recovery-card').hidden = true;
  } catch (err) {
    $('recovery-text').textContent = `Couldn’t rebuild that recording (${err?.message || 'unknown error'}).`;
    $('btn-recover-save').hidden = true;
  }
  refreshStoragePanel();
}

async function recoverDiscard() {
  if (!confirm('Delete this earlier recording?')) return;
  await state.store.discard();
  $('recovery-card').hidden = true;
  refreshStoragePanel();
}

// ---------- boot ----------

async function boot() {
  if (!isSupported()) {
    showScreen('unsupported');
    return;
  }
  try {
    state.store = await SessionStore.open();
  } catch {
    showScreen('unsupported');
    return;
  }
  showScreen('setup');
  await maybeOfferRecovery();
  // No session left? Drop the (empty) database so the browser releases its
  // files - cleared stores otherwise stay on disk until idle maintenance.
  if (!(await state.store.findRecoverable())) await state.store.discard();
  refreshStoragePanel();

  $('btn-delete-stored').addEventListener('click', deleteStored);
  $('btn-enable').addEventListener('click', enableMic);
  $('device-select').addEventListener('change', changeDevice);
  $('boost-toggle').addEventListener('change', changeDevice);
  $('btn-test').addEventListener('click', testMic);
  $('btn-start').addEventListener('click', startRecording);
  $('btn-pause').addEventListener('click', togglePause);
  $('btn-stop').addEventListener('click', () => stopRecording());
  $('btn-save').addEventListener('click', () => saveRecording('flac', $('btn-save')));
  $('btn-save-wav').addEventListener('click', () => saveRecording('wav', $('btn-save-wav')));
  $('btn-free-space').addEventListener('click', freeSpace);
  $('btn-new').addEventListener('click', newRecording);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (state.engine?.stream) populateDevices();
  });

  requestAnimationFrame(renderLoop);
  setInterval(updateStatusPill, 250);

  // Offline support; the worker is network-first, so it never staleness-locks
  // online users to an old deploy.
  navigator.serviceWorker?.register('./sw.js').catch(() => {});
}

boot();
