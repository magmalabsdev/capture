// Durable recording storage in IndexedDB.
//
// MediaRecorder chunks are streamed here as they arrive so a long session
// survives in-memory/disk blob eviction (the usual cause of NotReadableError on
// export) and even a tab crash. No app-module imports → no circular deps.
//
// Schema (db "capture-db", v1):
//   chunks     : autoIncrement key; { sourceId, segment, data: Blob }
//                index "bySource" on sourceId  (insertion order = capture order)
//   recordings : keyPath sourceId; metadata for export + crash recovery

const DB_NAME = 'capture-db';
const DB_VERSION = 2;

let dbPromise = null;

export function idbAvailable() {
  return typeof indexedDB !== 'undefined';
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chunks')) {
        const chunks = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
        chunks.createIndex('bySource', 'sourceId', { unique: false });
      }
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'sourceId' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv'); // out-of-line keys (e.g. download dir handle)
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  }).catch((e) => {
    dbPromise = null; // allow retry
    throw e;
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function reqDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('tx aborted'));
  });
}

/** Append one captured chunk. Rejects on quota/IDB failure (caller handles). */
export async function addChunk(sourceId, segment, blob) {
  const db = await openDB();
  const t = tx(db, 'chunks', 'readwrite');
  t.objectStore('chunks').add({ sourceId, segment, data: blob });
  await txDone(t);
}

/** Upsert a recording's metadata. */
export async function putMeta(meta) {
  const db = await openDB();
  const t = tx(db, 'recordings', 'readwrite');
  t.objectStore('recordings').put({ ...meta, updatedAt: Date.now() });
  await txDone(t);
}

export async function getMeta(sourceId) {
  const db = await openDB();
  return reqDone(tx(db, 'recordings', 'readonly').objectStore('recordings').get(sourceId));
}

export async function listRecordings() {
  const db = await openDB();
  return reqDone(tx(db, 'recordings', 'readonly').objectStore('recordings').getAll());
}

/**
 * Read all chunks for a source grouped into ordered segments. Each chunk is
 * accessed in its own try block; an unreadable chunk is skipped and counted, so
 * a single corrupted chunk never fails the whole read.
 * @returns {Promise<{ segments: {seg:number, blobs:Blob[]}[], skipped: number }>}
 *   one entry per segment, sorted by segment number, blobs in capture order
 */
export async function getSegmentsBlobs(sourceId) {
  const db = await openDB();
  const store = tx(db, 'chunks', 'readonly').objectStore('chunks');
  const index = store.index('bySource');
  const segMap = new Map(); // segment -> Blob[]
  let skipped = 0;

  await new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(IDBKeyRange.only(sourceId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      try {
        const { segment, data } = cursor.value;
        if (data) {
          if (!segMap.has(segment)) segMap.set(segment, []);
          segMap.get(segment).push(data);
        }
      } catch {
        skipped += 1;
      }
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  const segments = [...segMap.keys()]
    .sort((a, b) => a - b)
    .map((seg) => ({ seg, blobs: segMap.get(seg) }));
  return { segments, skipped };
}

export async function deleteRecording(sourceId) {
  const db = await openDB();
  const t = tx(db, ['chunks', 'recordings'], 'readwrite');
  t.objectStore('recordings').delete(sourceId);
  const index = t.objectStore('chunks').index('bySource');
  await new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(IDBKeyRange.only(sourceId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  await txDone(t);
}

/* Generic key-value (used for the chosen download directory handle). */
export async function kvGet(key) {
  const db = await openDB();
  return reqDone(tx(db, 'kv', 'readonly').objectStore('kv').get(key));
}
export async function kvPut(key, value) {
  const db = await openDB();
  const t = tx(db, 'kv', 'readwrite');
  t.objectStore('kv').put(value, key);
  await txDone(t);
}
export async function kvDelete(key) {
  const db = await openDB();
  const t = tx(db, 'kv', 'readwrite');
  t.objectStore('kv').delete(key);
  await txDone(t);
}

/** Best-effort storage usage; returns null if unsupported. */
export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    }
  } catch {
    /* ignore */
  }
  return null;
}
