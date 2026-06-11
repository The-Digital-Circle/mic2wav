import { peakOf, countClipped } from './levels.js';

export function isSupported() {
  return Boolean(
    navigator.mediaDevices?.getUserMedia &&
    window.AudioContext &&
    window.AudioWorkletNode &&
    window.indexedDB,
  );
}

export async function listInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

export class AudioEngine {
  constructor() {
    this.context = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.onFrame = null;       // (float32Frame, peak, clipCount) => void
    this.onTrackEnded = null;  // () => void
  }

  async acquire({ deviceId, boost = false } = {}) {
    this.releaseStream();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: boost,
      },
    });
    if (!this.context) {
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
      this.worklet = new AudioWorkletNode(this.context, 'capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.worklet.port.onmessage = (e) => {
        const frame = e.data;
        this.onFrame?.(frame, peakOf(frame), countClipped(frame));
      };
      // The worklet outputs silence; route through a muted gain so the graph
      // reaches the destination and is guaranteed to be processed everywhere.
      const mute = this.context.createGain();
      mute.gain.value = 0;
      this.worklet.connect(mute).connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.source.connect(this.worklet);
    const track = this.stream.getAudioTracks()[0];
    track.addEventListener('ended', () => this.onTrackEnded?.());
    return this.stream;
  }

  currentDeviceId() {
    return this.stream?.getAudioTracks()[0]?.getSettings().deviceId ?? null;
  }

  releaseStream() {
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  playBack(frames) {
    return new Promise((resolve) => {
      const total = frames.reduce((sum, f) => sum + f.length, 0);
      if (total === 0) {
        resolve();
        return;
      }
      const buf = this.context.createBuffer(1, total, this.context.sampleRate);
      const ch = buf.getChannelData(0);
      let off = 0;
      for (const f of frames) {
        ch.set(f, off);
        off += f.length;
      }
      const src = this.context.createBufferSource();
      src.buffer = buf;
      src.connect(this.context.destination);
      src.onended = resolve;
      src.start();
    });
  }
}
