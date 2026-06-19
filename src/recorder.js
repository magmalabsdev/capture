// Per-source recording via MediaRecorder. Each source records independently.

import { update } from './state.js';
import { extFromMime } from './util/format.js';

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
    accumulatedMs: 0,
    resumedAt: 0,
    durationMs: 0,
    blob: null,
    mimeType: '',
    ext: '',
    size: 0,
  };
}

/** Live elapsed recording time in ms. */
export function elapsedMs(source) {
  const r = source.rec;
  if (r.status === 'recording') return r.accumulatedMs + (performance.now() - r.resumedAt);
  if (r.status === 'paused') return r.accumulatedMs;
  if (r.status === 'stopped') return r.durationMs;
  return 0;
}

export function startRecording(source) {
  if (source.streamEnded) return;
  const st = source.rec.status;
  if (st === 'recording' || st === 'paused') return;

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
      return;
    }
  }

  const chunks = [];
  source._mr = mr;
  source.rec = freshRec();
  source.rec.mimeType = mr.mimeType || mime || '';
  source.rec.ext = extFromMime(source.rec.mimeType);
  source.rec.status = 'recording';
  source.rec.resumedAt = performance.now();

  mr.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  mr.onstop = () => {
    const type = source.rec.mimeType || (chunks[0] && chunks[0].type) || '';
    source.rec.blob = new Blob(chunks, { type });
    source.rec.size = source.rec.blob.size;
    source.rec.status = 'stopped';
    if (source._onStop) {
      const cb = source._onStop;
      source._onStop = null;
      cb();
    }
    update();
  };
  mr.onerror = (e) => console.error('MediaRecorder error', e);

  mr.start(1000); // gather data in 1s chunks
  update();
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
    r.durationMs = r.accumulatedMs;
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
