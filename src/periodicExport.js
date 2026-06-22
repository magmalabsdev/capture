// Periodic auto-export: every N seconds, download a zip of a clip from each
// currently-recording track WITHOUT stopping the recording. Each clip is the
// segment since the last auto-export (recorder rolls a fresh segment each time).

import { state, update, notify } from './state.js';
import { rollSegment } from './recorder.js';
import { makeZip } from './util/zip.js';
import { safeName } from './util/format.js';
import { audioToMp3OrOriginal, exportableVideo } from './export/exporters.js';
import { saveFile } from './download.js';

let timer = null;
let inProgress = false;

const MIN_INTERVAL = 10; // seconds

function scheduleNext() {
  update((s) => {
    s.periodic.nextAt = s.periodic.enabled
      ? Date.now() + Math.max(MIN_INTERVAL, s.periodic.intervalSec) * 1000
      : 0;
  });
}

function reschedule() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!state.periodic.enabled) {
    update((s) => { s.periodic.nextAt = 0; });
    return;
  }
  const ms = Math.max(MIN_INTERVAL, state.periodic.intervalSec) * 1000;
  scheduleNext();
  timer = setInterval(runTick, ms);
}

export function configurePeriodic({ enabled, intervalSec } = {}) {
  update((s) => {
    if (enabled !== undefined) s.periodic.enabled = enabled;
    if (intervalSec) s.periodic.intervalSec = intervalSec;
  });
  reschedule();
}

async function runTick() {
  if (inProgress) return; // never overlap a previous (possibly slow) run
  const recording = [...state.videoSources, ...state.audioSources].filter(
    (s) => s.rec.status === 'recording'
  );
  if (!recording.length) {
    scheduleNext();
    return;
  }

  inProgress = true;
  try {
    const used = new Set();
    const files = [];
    const nameFor = (label, ext) => {
      const base = safeName(label);
      let name = `${base}.${ext}`;
      let n = 2;
      while (used.has(name)) name = `${base}-${n++}.${ext}`;
      used.add(name);
      return name;
    };

    for (const src of recording) {
      const clip = await rollSegment(src);
      if (!clip || !clip.blob.size) continue;
      if (src.mediaKind === 'audio') {
        const a = await audioToMp3OrOriginal(clip.blob, clip.ext);
        files.push({ name: nameFor(src.label, a.ext), blob: a.blob });
      } else {
        const v = await exportableVideo({ blob: clip.blob, ext: clip.ext });
        files.push({ name: nameFor(src.label, v.ext), blob: v.blob });
      }
    }

    if (files.length) {
      const zip = await makeZip(files);
      const idx = state.periodic.count + 1;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      await saveFile(zip, `capture-clip-${String(idx).padStart(3, '0')}-${stamp}.zip`);
      update((s) => {
        s.periodic.count = idx;
        s.periodic.lastRunAt = Date.now();
      });
      notify(`Auto-exported clip ${idx} (${files.length} track${files.length === 1 ? '' : 's'}).`, 'info');
    }
  } catch (e) {
    notify(`Auto-export failed: ${e.message || e}`, 'error');
  } finally {
    inProgress = false;
    scheduleNext();
  }
}
