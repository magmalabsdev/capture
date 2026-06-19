// Always-on recording resilience: bound segment length (durable checkpoints +
// bounded memory) and surface tracks that silently stop producing data.

import { state, update, notify } from './state.js';
import { rollSegment } from './recorder.js';

const SEGMENT_MS = 5 * 60 * 1000; // auto-roll a fresh segment every 5 min
const STALL_MS = 8000; // no data for this long while "recording" → stalled

function segmentElapsed(source) {
  const r = source.rec;
  if (r.status !== 'recording') return 0;
  return r.accumulatedMs + (performance.now() - r.resumedAt);
}

const allSources = () => [...state.videoSources, ...state.audioSources];

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

  // Stall watchdog — catches the "desktop audio silently died" case.
  setInterval(() => {
    const now = performance.now();
    let changed = false;
    for (const s of allSources()) {
      if (s.rec.status !== 'recording') continue;
      const since = now - (s._lastDataAt || now);
      if (since > STALL_MS && !s.stalled) {
        s.stalled = true;
        changed = true;
        notify(`${s.label} stopped producing data — it may be muted or disconnected.`, 'warn', { sound: true });
      }
    }
    if (changed) update();
  }, 2000);
}
