// Periodic auto-export: every N seconds, download a zip of a clip from each
// currently-recording track WITHOUT stopping the recording. Each clip covers
// ALL footage recorded since the previous auto-export — i.e. every segment
// finalized since the last tick (recordWatch also rolls segments every 5 min for
// durability, so "the current segment" is NOT the whole interval). Clips are
// non-overlapping, so concatenating them in order reproduces the full session.

import { state, update, notify } from './state.js';
import { rollSegment } from './recorder.js';
import { makeZip } from './util/zip.js';
import { safeName } from './util/format.js';
import { audioToMp3OrOriginal, exportableVideo, getRecordingBlobSince } from './export/exporters.js';
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

    let partialAny = false;
    for (const src of recording) {
      // Finalize the live segment (its data is now complete + durable) and keep
      // recording a fresh one; `rolled.seg` is the just-finalized segment number.
      const rolled = await rollSegment(src);
      if (!rolled) continue; // not recording / already rolling — catch it next tick

      const sinceSeg = src._periodicSeg || 0;
      // Prefer the rolled in-memory blob for its own segment (avoids the async IDB
      // tail race); older un-exported segments come from durable storage. Cap at
      // rolled.seg so the still-active new segment isn't half-exported.
      const override = rolled.blob && rolled.blob.size
        ? new Map([[rolled.seg, [rolled.blob]]])
        : undefined;

      let res;
      try {
        res = await getRecordingBlobSince(src, sinceSeg, { override, maxSeg: rolled.seg });
      } catch (e) {
        // Couldn't read this track's new footage — skip it (keep the watermark so
        // it's retried next tick) rather than failing the whole auto-export.
        notify(`Auto-export skipped ${src.label}: ${e.message || e}`, 'warn');
        continue;
      }
      if (!res || !res.blob.size) continue;
      partialAny = partialAny || res.partial;

      if (src.mediaKind === 'audio') {
        const a = await audioToMp3OrOriginal(res.blob, res.ext);
        files.push({ name: nameFor(src.label, a.ext), blob: a.blob });
      } else {
        const v = await exportableVideo({ blob: res.blob, ext: res.ext });
        files.push({ name: nameFor(src.label, v.ext), blob: v.blob });
      }
      src._periodicSeg = res.uptoSeg; // advance only after a successful read
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
      notify(
        `Auto-exported clip ${idx} (${files.length} track${files.length === 1 ? '' : 's'})${partialAny ? ' — some footage was unreadable and skipped' : ''}.`,
        partialAny ? 'warn' : 'info'
      );
    }
  } catch (e) {
    notify(`Auto-export failed: ${e.message || e}`, 'error');
  } finally {
    inProgress = false;
    scheduleNext();
  }
}
