// Always-on recording resilience: bound segment length (durable checkpoints +
// bounded memory) and surface tracks that silently stop producing data.

import { state, update, notify } from './state.js';
import { rollSegment } from './recorder.js';

const SEGMENT_MS = 5 * 60 * 1000; // auto-roll a fresh segment every 5 min
const STALL_MS = 12000; // no data for this long while "recording" → suspect stall

function segmentElapsed(source) {
  const r = source.rec;
  if (r.status !== 'recording') return 0;
  return r.accumulatedMs + (performance.now() - r.resumedAt);
}

const allSources = () => [...state.videoSources, ...state.audioSources];

function liveTrack(source) {
  const stream = source.stream;
  if (!stream) return null;
  const tracks = source.mediaKind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks();
  return tracks[0] || null;
}

export function startRecordWatch() {
  // Auto-roll long segments so no single MediaRecorder run / chunk array grows
  // unbounded; each roll leaves a finalized, durable segment in IndexedDB.
  setInterval(() => {
    for (const s of allSources()) {
      if (s.rec.status === 'recording' && !s._rolling && segmentElapsed(s) >= SEGMENT_MS) {
        rollSegment(s); // blob discarded — data is already persisted
      }
    }
  }, 5000);

  // A backgrounded tab legitimately delivers MediaRecorder data in delayed
  // bursts, so the time-based heuristic only runs while visible. Real drops are
  // caught accurately by the track 'mute'/'ended' handlers (sources.js)
  // regardless of visibility. On returning to the foreground, give a grace
  // period so the accumulated hidden gap isn't mistaken for a stall.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const now = performance.now();
      for (const s of allSources()) if (s.rec.status === 'recording') s._lastDataAt = now;
    }
  });

  // Stall watchdog — catches a track that silently stops producing data.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return; // delivery is bursty when hidden
    const now = performance.now();
    let changed = false;
    for (const s of allSources()) {
      if (s.rec.status !== 'recording' || s.stalled) continue;
      const since = now - (s._lastDataAt || now);
      if (since <= STALL_MS) continue;

      // First over-threshold sighting: force a flush and wait one more tick to
      // distinguish "buffered but delayed" from a genuine stall.
      if (!s._stallProbed) {
        s._stallProbed = true;
        try { s._mr && s._mr.requestData(); } catch { /* ignore */ }
        continue;
      }

      // Still no data — only flag if the track itself looks unhealthy.
      const track = liveTrack(s);
      const unhealthy = !track || track.muted || track.readyState !== 'live';
      if (unhealthy) {
        s.stalled = true;
        changed = true;
        notify(`${s.label} stopped producing data — it may be muted or disconnected.`, 'warn', { sound: true });
      }
    }
    if (changed) update();
  }, 2000);
}
