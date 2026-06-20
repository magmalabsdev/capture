// Per-source recording via MediaRecorder. Each source records independently.
// Chunks are streamed to IndexedDB as they arrive so long sessions survive blob
// eviction and tab crashes (see util/idb.js).

import { update, notify } from './state.js';
import { extFromMime } from './util/format.js';
import { addChunk, putMeta, deleteRecording, idbAvailable } from './util/idb.js';

// Identifies this page session (for crash-recovery housekeeping).
export const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Preference order: MP4 (H.264/AAC) where supported, else WebM.
const VIDEO_MIMES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.4d401f,mp4a.40.2',
  'video/mp4;codecs=h264',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const AUDIO_MIMES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];

export function pickMime(mediaKind) {
  const list = mediaKind === 'video' ? VIDEO_MIMES : AUDIO_MIMES;
  if (!('MediaRecorder' in window)) return '';
  for (const m of list) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return '';
}

export function freshRec() {
  return {
    status: 'idle', // idle | recording | paused | stopped
    baseMs: 0, // cumulative time from prior segments (periodic auto-export)
    accumulatedMs: 0,
    resumedAt: 0,
    durationMs: 0,
    blob: null,
    mimeType: '',
    ext: '',
    size: 0,
    hasData: false, // any captured data exists (durable in IDB)
    bytes: 0, // total captured bytes across segments
    segments: 0, // number of segments started
    errored: false, // a MediaRecorder error occurred (data preserved)
  };
}

/** Persist/refresh a source's recording metadata for export + crash recovery. */
function saveMeta(source, active) {
  if (!idbAvailable()) return;
  putMeta({
    sourceId: source.id,
    sessionId: SESSION_ID,
    label: source.label,
    mediaKind: source.mediaKind,
    kind: source.kind,
    mimeType: source.rec.mimeType,
    ext: source.rec.ext,
    segments: source.rec.segments,
    bytes: source.rec.bytes,
    active,
  }).catch(() => {});
}

/** Live elapsed recording time in ms (cumulative across rolled segments). */
export function elapsedMs(source) {
  const r = source.rec;
  if (r.status === 'recording') return r.baseMs + r.accumulatedMs + (performance.now() - r.resumedAt);
  if (r.status === 'paused') return r.baseMs + r.accumulatedMs;
  if (r.status === 'stopped') return r.durationMs;
  return 0;
}

// When IDB is unavailable or a write fails, finalized segments are kept here so
// export can still reassemble them from memory.
function pushMemSegment(source, seg, chunks) {
  if (!source._memSegments) source._memSegments = [];
  source._memSegments.push({ seg, blobs: chunks.slice() });
}

const usingMemoryFallback = (source) => !idbAvailable() || source._idbFailed;

/** Create a MediaRecorder and begin a fresh recording segment. */
function beginSegment(source, baseMs) {
  const mime = pickMime(source.mediaKind);
  const opts = {};
  if (mime) opts.mimeType = mime;
  if (source.bitrate) {
    if (source.mediaKind === 'video') opts.videoBitsPerSecond = source.bitrate;
    else opts.audioBitsPerSecond = source.bitrate;
  }

  let mr;
  try {
    mr = new MediaRecorder(source.stream, opts);
  } catch {
    try {
      mr = new MediaRecorder(source.stream);
    } catch (e) {
      console.error('MediaRecorder failed', e);
      return false;
    }
  }

  const seg = (source._seg || 0) + 1;
  source._seg = seg;
  const chunks = [];
  source._mr = mr;
  source._chunks = chunks;
  source.rec = freshRec();
  source.rec.baseMs = baseMs || 0;
  source.rec.segments = seg;
  source.rec.mimeType = mr.mimeType || mime || '';
  source.rec.ext = extFromMime(source.rec.mimeType);
  source.rec.status = 'recording';
  source.rec.resumedAt = performance.now();
  source._lastDataAt = performance.now();
  saveMeta(source, true);

  mr.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    chunks.push(e.data);
    source.rec.bytes += e.data.size;
    source.rec.hasData = true;
    source._lastDataAt = performance.now();
    source._stallProbed = false; // re-arm the stall watchdog's flush probe
    if (source.stalled) {
      source.stalled = false;
      update();
    }
    if (idbAvailable() && !source._idbFailed) {
      addChunk(source.id, seg, e.data).catch(() => {
        if (!source._idbFailed) {
          source._idbFailed = true;
          notify(`Storage write failed for ${source.label}; keeping this recording in memory.`, 'warn', { sound: true });
        }
      });
    }
  };
  mr.onstop = () => {
    const type = source.rec.mimeType || (chunks[0] && chunks[0].type) || '';
    source.rec.blob = new Blob(chunks, { type });
    source.rec.size = source.rec.blob.size;
    source.rec.status = 'stopped';
    if (usingMemoryFallback(source)) pushMemSegment(source, seg, chunks);
    saveMeta(source, false);
    if (source._onStop) {
      const cb = source._onStop;
      source._onStop = null;
      cb();
    }
    update();
  };
  mr.onerror = () => {
    source.rec.errored = true;
    notify(`Recording error on ${source.label}; footage up to here is preserved.`, 'error', { sound: true });
    try {
      if (source._mr && source._mr.state !== 'inactive') source._mr.stop();
    } catch {
      /* ignore */
    }
  };

  mr.start(1000); // gather data in 1s chunks
  return true;
}

export async function startRecording(source) {
  if (source.streamEnded) return;
  const st = source.rec.status;
  if (st === 'recording' || st === 'paused') return;
  // A new take overwrites any previous recording for this source.
  source._seg = 0;
  source._memSegments = [];
  source._idbFailed = false;
  if (idbAvailable()) {
    try {
      await deleteRecording(source.id);
    } catch {
      /* ignore */
    }
  }
  if (beginSegment(source, 0)) update();
}

/**
 * Resume recording into a NEW segment of the same source (same IDB sourceId,
 * preserved cumulative time) without clearing prior segments. Used after a
 * dropped source is re-captured, so the export spans before + after the gap.
 */
export function continueRecording(source) {
  if (source.streamEnded) return false;
  if (source.rec.status === 'recording' || source.rec.status === 'paused') return false;
  const base = source.rec.durationMs || source.rec.baseMs || 0;
  if (beginSegment(source, base)) {
    update();
    return true;
  }
  return false;
}

/**
 * Finalize the current segment into a playable clip and immediately continue
 * recording a new segment on the same live stream (periodic export + auto-roll).
 * Resolves { blob, ext } for the just-finalized clip, or null if not recording.
 */
export function rollSegment(source) {
  return new Promise((resolve) => {
    const r = source.rec;
    if (r.status !== 'recording' || source._rolling) {
      resolve(null);
      return;
    }
    source._rolling = true;
    const mr = source._mr;
    const chunks = source._chunks || [];
    const mime = r.mimeType;
    const ext = r.ext;
    const seg = source._seg;
    r.accumulatedMs += performance.now() - r.resumedAt;
    const newBase = r.baseMs + r.accumulatedMs;

    mr.onstop = () => {
      const blob = new Blob(chunks, { type: mime || (chunks[0] && chunks[0].type) || '' });
      if (usingMemoryFallback(source)) pushMemSegment(source, seg, chunks);
      beginSegment(source, newBase); // keep recording, preserving cumulative time
      source._rolling = false;
      update();
      resolve(blob && blob.size ? { blob, ext } : null);
    };
    try {
      mr.stop();
    } catch {
      source._rolling = false;
      resolve(null);
    }
  });
}

export function pauseRecording(source) {
  if (source.rec.status !== 'recording') return;
  try {
    source._mr.pause();
  } catch {
    /* ignore */
  }
  source.rec.accumulatedMs += performance.now() - source.rec.resumedAt;
  source.rec.status = 'paused';
  update();
}

export function resumeRecording(source) {
  if (source.rec.status !== 'paused') return;
  try {
    source._mr.resume();
  } catch {
    /* ignore */
  }
  source.rec.resumedAt = performance.now();
  source.rec.status = 'recording';
  update();
}

/** Stop and finalize. Resolves once the blob is ready. */
export function stopRecording(source) {
  return new Promise((resolve) => {
    const r = source.rec;
    if (r.status !== 'recording' && r.status !== 'paused') {
      resolve();
      return;
    }
    if (r.status === 'recording') r.accumulatedMs += performance.now() - r.resumedAt;
    r.durationMs = r.baseMs + r.accumulatedMs;
    source._onStop = resolve;
    try {
      source._mr.stop();
    } catch {
      resolve();
    }
  });
}

export function togglePause(source) {
  if (source.rec.status === 'recording') pauseRecording(source);
  else if (source.rec.status === 'paused') resumeRecording(source);
}
