import { wavHeader } from './wav.js';

const DB_NAME = 'mic2wav';
const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

async function openDb(onForcedClose) {
  const r = indexedDB.open(DB_NAME, DB_VERSION);
  r.onupgradeneeded = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
  };
  const db = await req(r);
  // Another tab deleting the database fires versionchange here: release our
  // connection so its delete can proceed; we reconnect lazily on next use.
  db.onversionchange = () => {
    db.close();
    onForcedClose?.();
  };
  return db;
}

// Opening an IndexedDB database CREATES it, so existence checks must not
// open. Without this, every page load left an empty database behind and the
// origin never reached zero storage after cleanup.
async function dbExists() {
  if (indexedDB.databases) {
    try {
      return (await indexedDB.databases()).some((d) => d.name === DB_NAME);
    } catch { /* fall through */ }
  }
  return true; // can't tell without opening - assume it might exist
}

export class SessionStore {
  static async open() {
    const store = new SessionStore();
    // Fail fast where IndexedDB is unavailable - but only touch a database
    // that already exists, so a fresh visit leaves no storage behind.
    if (await dbExists()) await store.tx('meta', 'readonly');
    navigator.storage?.persist?.().catch(() => {});
    return store;
  }

  constructor() {
    this._db = null;
  }

  async tx(stores, mode) {
    for (let attempt = 0; ; attempt++) {
      if (!this._db) this._db = await openDb(() => { this._db = null; });
      try {
        return this._db.transaction(stores, mode);
      } catch (err) {
        // Connection was closed under us (another tab discarded) - reconnect once.
        this._db = null;
        if (attempt > 0) throw err;
      }
    }
  }

  // meta: {sampleRate, name, startedAt, saved, lastWriteAt}
  async startSession(meta) {
    await this.discard();
    const tx = await this.tx('meta', 'readwrite');
    tx.objectStore('meta').put(meta, 'session');
    await done(tx);
  }

  async appendChunk(seq, int16) {
    const tx = await this.tx('chunks', 'readwrite');
    tx.objectStore('chunks').put(new Blob([int16.buffer]), seq);
    await done(tx);
  }

  async findRecoverable() {
    // Peek before opening: a read must not conjure an empty database.
    if (!this._db && !(await dbExists())) return null;
    const tx = await this.tx('meta', 'readonly');
    const meta = await req(tx.objectStore('meta').get('session'));
    return meta ?? null;
  }

  async touch() {
    const meta = await this.findRecoverable();
    if (!meta) return;
    meta.lastWriteAt = Date.now();
    const tx = await this.tx('meta', 'readwrite');
    tx.objectStore('meta').put(meta, 'session');
    await done(tx);
  }

  async markSaved() {
    const meta = await this.findRecoverable();
    if (!meta) return;
    meta.saved = true;
    const tx = await this.tx('meta', 'readwrite');
    tx.objectStore('meta').put(meta, 'session');
    await done(tx);
  }

  async chunkBlobs() {
    const tx = await this.tx('chunks', 'readonly');
    return req(tx.objectStore('chunks').getAll()); // ascending key order
  }

  async info() {
    const meta = await this.findRecoverable();
    if (!meta) return null;
    const blobs = await this.chunkBlobs();
    const bytes = blobs.reduce((s, b) => s + b.size, 0);
    return { ...meta, numSamples: Math.floor(bytes / 2), bytes };
  }

  async finalize() {
    const meta = await this.findRecoverable();
    if (!meta) throw new Error('No session to finalize');
    const blobs = await this.chunkBlobs();
    const bytes = blobs.reduce((s, b) => s + b.size, 0);
    const numSamples = Math.floor(bytes / 2);
    const header = wavHeader({ sampleRate: meta.sampleRate, numSamples });
    return {
      blob: new Blob([header, ...blobs], { type: 'audio/wav' }),
      numSamples,
      sampleRate: meta.sampleRate,
      name: meta.name,
      startedAt: meta.startedAt,
    };
  }

  // Delete the whole database, not just the records: Firefox compacts cleared
  // object stores only during idle maintenance, leaving gigabytes "in use"
  // with no recording to show for it. Dropping the database releases the
  // underlying files immediately on every browser.
  async discard() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(DB_NAME);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
      // Another tab still holds a connection: its versionchange handler will
      // close it and the delete then completes - don't keep the UI waiting.
      r.onblocked = () => resolve();
    });
  }
}
