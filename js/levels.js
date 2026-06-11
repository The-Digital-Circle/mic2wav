export function peakOf(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > p) p = a;
  }
  return p;
}

export function toDb(peak) {
  return peak <= 0 ? -Infinity : 20 * Math.log10(peak);
}

export function countClipped(samples, threshold = 0.985) {
  let clipped = 0;
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) {
      run++;
    } else {
      if (run >= 3) clipped += run;
      run = 0;
    }
  }
  if (run >= 3) clipped += run;
  return clipped;
}

export class LevelWindow {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.entries = [];
  }

  push(peak, clipCount, timeMs) {
    this.entries.push({ peak, clipCount, timeMs });
    const cutoff = timeMs - this.windowMs;
    while (this.entries.length && this.entries[0].timeMs < cutoff) this.entries.shift();
  }

  classify() {
    if (!this.entries.length) return 'silent';
    let maxPeak = 0;
    let minPeak = Infinity;
    let clips = 0;
    for (const e of this.entries) {
      if (e.peak > maxPeak) maxPeak = e.peak;
      if (e.peak < minPeak) minPeak = e.peak;
      clips += e.clipCount;
    }
    if (clips > 0) return 'clipping';
    const db = toDb(maxPeak);
    if (db < -55) return 'silent';
    if (db < -28) {
      // Only call the quiet band "too quiet" when the signal moves like
      // speech: syllable peaks well above the gaps, and loud enough overall.
      // Steady room noise or a hum means "no one is talking", and saying
      // "move closer" then trains people to lean into the mic and clip.
      const spreadDb = db - toDb(Math.max(minPeak, 1e-7));
      return spreadDb >= 12 && db > -50 ? 'quiet' : 'silent';
    }
    return 'good';
  }
}

export class SilenceWatchdog {
  constructor({ thresholdDb = -55, durationMs = 15000 } = {}) {
    this.thresholdDb = thresholdDb;
    this.durationMs = durationMs;
    this.silentSince = null;
    this.fired = false;
  }

  push(peak, timeMs) {
    if (toDb(peak) >= this.thresholdDb) {
      this.silentSince = null;
      this.fired = false;
      return false;
    }
    if (this.silentSince === null) this.silentSince = timeMs;
    if (!this.fired && timeMs - this.silentSince >= this.durationMs) {
      this.fired = true;
      return true;
    }
    return false;
  }
}
