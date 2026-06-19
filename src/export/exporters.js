// Export logic. Recordings are reassembled from IndexedDB (durable) with an
// in-memory fallback, multi-segment takes are concatenated losslessly with
// ffmpeg, and every export degrades gracefully: an unreadable track is skipped
// (with a precise warning) instead of failing the whole export.

import { state, update, notify } from '../state.js';
import { el } from '../util/dom.js';
import { safeName, extFromMime } from '../util/format.js';
import { makeZip } from '../util/zip.js';
import { getSegmentsBlobs, idbAvailable, deleteRecording } from '../util/idb.js';
import { getFFmpeg } from './ffmpeg.js';

const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const hasRecording = (s) => !!(s.rec && s.rec.hasData);

function setFF(patch) {
  update((s) => Object.assign(s.ffmpeg, patch));
}

let jobSeq = 0;

/* ------------------------------------------------------------------ */
/* Reassembly from durable storage                                    */
/* ------------------------------------------------------------------ */

/** Merge IDB segments + in-memory fallback + the live active segment by seg #. */
async function assembleSegments(source) {
  const map = new Map(); // seg -> Blob[]
  let partial = false;

  if (idbAvailable()) {
    try {
      const { segments, skipped } = await getSegmentsBlobs(source.id);
      for (const g of segments) map.set(g.seg, g.blobs);
      if (skipped) partial = true;
    } catch {
      partial = true;
    }
  }
  // Finalized segments held in memory (IDB unavailable / write failed) win.
  for (const g of source._memSegments || []) map.set(g.seg, g.blobs);
  // The current, not-yet-finalized segment (in-progress export) — overrides
  // IDB's partial copy of the same segment.
  if (source.rec.status === 'recording' && source._chunks && source._chunks.length) {
    map.set(source._seg, source._chunks.slice());
  }

  const segs = [...map.keys()].sort((a, b) => a - b).map((k) => map.get(k));
  return { segs, partial };
}

/** Concatenate per-segment blobs into one file (stream copy, lossless). */
async function concatSegments(segBlobs, ext, onProgress) {
  const ff = await getFFmpeg(onProgress);
  const job = `c${jobSeq++}`;
  const names = [];
  for (let i = 0; i < segBlobs.length; i += 1) {
    const n = `${job}_${i}.${ext}`;
    await ff.writeFile(n, await blobBytes(segBlobs[i]));
    names.push(n);
  }
  const listName = `${job}_list.txt`;
  await ff.writeFile(listName, new TextEncoder().encode(names.map((n) => `file '${n}'`).join('\n')));
  const out = `${job}_out.${ext}`;
  let data;
  try {
    await ff.exec(['-y', '-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', out]);
    data = await ff.readFile(out);
  } finally {
    for (const f of [...names, listName, out]) {
      try {
        await ff.deleteFile(f);
      } catch {
        /* ignore */
      }
    }
  }
  return new Blob([data], { type: segBlobs[0].type || '' });
}

/**
 * Reassemble a source's full recording into one Blob.
 * @returns {Promise<{ blob: Blob, ext: string, partial: boolean } | null>}
 */
export async function getRecordingBlob(source, onProgress) {
  const mime = source.rec.mimeType || '';
  const ext = source.rec.ext || extFromMime(mime);
  const { segs, partial } = await assembleSegments(source);

  const segBlobs = segs.map((blobs) => new Blob(blobs, { type: mime })).filter((b) => b.size > 0);
  if (!segBlobs.length) return null;
  if (segBlobs.length === 1) return { blob: segBlobs[0], ext, partial };

  const blob = await concatSegments(segBlobs, ext, onProgress);
  return { blob, ext, partial };
}

/** Resolve a recording; throws a clear error if nothing is readable. */
async function resolveRecording(source, onProgress) {
  let res;
  try {
    res = await getRecordingBlob(source, onProgress);
  } catch (e) {
    throw new Error(`${source.label}: ${e.message || 'could not be read'}`);
  }
  if (!res || !res.blob.size) throw new Error(`${source.label}: no readable data`);
  return res;
}

/* ------------------------------------------------------------------ */
/* Crash recovery — export/discard a recording left in IndexedDB       */
/* ------------------------------------------------------------------ */

/** Reassemble + download a recovered recording (from its IDB metadata). */
export async function exportRecovered(meta) {
  const pseudo = {
    id: meta.sourceId,
    mediaKind: meta.mediaKind,
    label: meta.label || 'recovered',
    rec: { status: 'stopped', mimeType: meta.mimeType, ext: meta.ext },
  };
  setFF({ status: 'running', progress: 0, message: `Recovering ${pseudo.label}…` });
  try {
    const res = await resolveRecording(pseudo, (p) => setFF({ progress: p }));
    downloadBlob(res.blob, `${safeName(pseudo.label)}-recovered.${res.ext}`);
    setFF({
      status: res.partial ? 'error' : 'ready',
      progress: 1,
      message: res.partial ? 'Recovered (some footage was unreadable).' : 'Recovered.',
    });
  } catch (e) {
    setFF({ status: 'error', message: e.message || String(e) });
    throw e;
  }
}

export async function discardRecovered(sourceId) {
  try {
    await deleteRecording(sourceId);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Export all — independent files (audio as MP3)                      */
/* ------------------------------------------------------------------ */

export async function exportAll() {
  const sources = [...state.videoSources, ...state.audioSources].filter(hasRecording);
  if (!sources.length) return { count: 0 };

  setFF({ status: 'running', progress: 0, message: 'Preparing export…' });
  const used = new Set();
  const files = [];
  const failed = [];
  let partialAny = false;
  const nameFor = (label, ext) => {
    const base = safeName(label);
    let name = `${base}.${ext}`;
    let n = 2;
    while (used.has(name)) name = `${base}-${n++}.${ext}`;
    used.add(name);
    return name;
  };

  try {
    for (let i = 0; i < sources.length; i += 1) {
      const src = sources[i];
      setFF({ progress: 0, message: `Preparing ${i + 1}/${sources.length}: ${src.label}…` });
      try {
        const res = await resolveRecording(src, (p) => setFF({ progress: p }));
        partialAny = partialAny || res.partial;
        if (src.mediaKind === 'audio') {
          const mp3 = await audioToMp3(res.blob, res.ext, (p) => setFF({ progress: p }));
          files.push({ name: nameFor(src.label, 'mp3'), blob: mp3 });
        } else {
          files.push({ name: nameFor(src.label, res.ext), blob: res.blob });
        }
      } catch (e) {
        failed.push(src.label);
      }
    }

    if (!files.length) throw new Error('No tracks could be read for export.');

    setFF({ status: 'running', progress: 1, message: 'Packaging zip…' });
    const zip = await makeZip(files);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(zip, `capture-${stamp}.zip`);

    finishNotice(`Exported ${files.length} track${files.length === 1 ? '' : 's'}`, failed, partialAny);
  } catch (e) {
    setFF({ status: 'error', message: e.message || String(e) });
    throw e;
  }
  return { count: files.length };
}

function finishNotice(base, failed, partialAny) {
  let msg = base;
  if (partialAny) msg += ' (some footage was unreadable and skipped)';
  if (failed.length) msg += `. Could not read: ${failed.join(', ')}`;
  setFF({ status: failed.length ? 'error' : 'ready', progress: 1, message: `${msg}.` });
  if (failed.length) notify(`Some tracks could not be exported: ${failed.join(', ')}.`, 'warn');
}

/* ------------------------------------------------------------------ */
/* Muxing one video with N audio tracks (resolved {blob, ext} inputs) */
/* ------------------------------------------------------------------ */

async function muxVideoWithAudios(videoRes, audioResList, onProgress) {
  const ff = await getFFmpeg(onProgress);
  const outExt = videoRes.ext === 'mp4' ? 'mp4' : 'webm';
  const audioCodec = outExt === 'mp4' ? 'aac' : 'libopus';
  const outMime = outExt === 'mp4' ? 'video/mp4' : 'video/webm';

  const job = `j${jobSeq++}`;
  const vName = `${job}_video.${videoRes.ext}`;
  await ff.writeFile(vName, await blobBytes(videoRes.blob));

  const aNames = [];
  for (let i = 0; i < audioResList.length; i += 1) {
    const n = `${job}_audio${i}.${audioResList[i].ext}`;
    await ff.writeFile(n, await blobBytes(audioResList[i].blob));
    aNames.push(n);
  }

  const out = `${job}_output.${outExt}`;
  const args = ['-y', '-i', vName];
  for (const n of aNames) args.push('-i', n);

  if (aNames.length === 0) {
    args.push('-c', 'copy', out);
  } else if (aNames.length === 1) {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', audioCodec, out);
  } else {
    const inputs = aNames.map((_, i) => `[${i + 1}:a]`).join('');
    args.push(
      '-filter_complex',
      `${inputs}amix=inputs=${aNames.length}:normalize=0[aout]`,
      '-map', '0:v:0',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', audioCodec,
      out
    );
  }

  let data;
  try {
    await ff.exec(args);
    data = await ff.readFile(out);
  } finally {
    for (const f of [vName, ...aNames, out]) {
      try {
        await ff.deleteFile(f);
      } catch {
        /* ignore */
      }
    }
  }
  return { blob: new Blob([data], { type: outMime }), ext: outExt };
}

/** Transcode an audio blob to MP3 (libmp3lame). */
export async function audioToMp3(blob, ext, onProgress) {
  const ff = await getFFmpeg(onProgress);
  const job = `j${jobSeq++}`;
  const inName = `${job}_in.${ext}`;
  const outName = `${job}_out.mp3`;
  await ff.writeFile(inName, await blobBytes(blob));
  let data;
  try {
    await ff.exec(['-y', '-i', inName, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', outName]);
    data = await ff.readFile(outName);
  } finally {
    for (const f of [inName, outName]) {
      try {
        await ff.deleteFile(f);
      } catch {
        /* ignore */
      }
    }
  }
  return new Blob([data], { type: 'audio/mpeg' });
}

/* ------------------------------------------------------------------ */
/* Single export — one video + all audio                              */
/* ------------------------------------------------------------------ */

export async function singleExport() {
  const videos = state.videoSources.filter(hasRecording);
  if (videos.length !== 1) throw new Error('Single export needs exactly one recorded video.');
  const video = videos[0];

  setFF({ status: 'running', progress: 0, message: 'Reassembling…' });
  try {
    const videoRes = await resolveRecording(video, (p) => setFF({ progress: p }));
    const audioResList = [];
    const failed = [];
    for (const a of state.audioSources.filter(hasRecording)) {
      try {
        audioResList.push(await resolveRecording(a, (p) => setFF({ progress: p })));
      } catch {
        failed.push(a.label);
      }
    }
    setFF({ progress: 0, message: 'Muxing video + audio…' });
    const out = await muxVideoWithAudios(videoRes, audioResList, (p) => setFF({ progress: p }));
    downloadBlob(out.blob, `${safeName(video.label)}-mixed.${out.ext}`);
    finishNotice('Exported combined file', failed, videoRes.partial);
  } catch (e) {
    setFF({ status: 'error', message: e.message || String(e) });
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Merge export — per-video manual audio assignment                   */
/* ------------------------------------------------------------------ */

export async function mergeExport() {
  const videos = state.videoSources.filter(hasRecording);
  if (!videos.length) throw new Error('No recorded video to merge.');

  setFF({ status: 'running', progress: 0, message: 'Starting merge…' });
  try {
    const used = new Set();
    const files = [];
    const failed = [];
    let partialAny = false;

    for (let i = 0; i < videos.length; i += 1) {
      const video = videos[i];
      setFF({ progress: 0, message: `Merging ${i + 1}/${videos.length}: ${video.label}…` });
      let videoRes;
      try {
        videoRes = await resolveRecording(video, (p) => setFF({ progress: p }));
      } catch {
        failed.push(video.label);
        continue;
      }
      partialAny = partialAny || videoRes.partial;

      const audioResList = [];
      const assigned = (state.mergeAssignments[video.id] || [])
        .map((id) => state.audioSources.find((a) => a.id === id))
        .filter((a) => a && hasRecording(a));
      for (const a of assigned) {
        try {
          audioResList.push(await resolveRecording(a, (p) => setFF({ progress: p })));
        } catch {
          failed.push(a.label);
        }
      }

      const out = await muxVideoWithAudios(videoRes, audioResList, (p) => setFF({ progress: p }));
      const base = safeName(video.label);
      let name = `${base}-merged.${out.ext}`;
      let n = 2;
      while (used.has(name)) name = `${base}-merged-${n++}.${out.ext}`;
      used.add(name);
      files.push({ name, blob: out.blob });
    }

    if (!files.length) throw new Error('No videos could be read for merge.');

    if (files.length === 1) {
      downloadBlob(files[0].blob, files[0].name);
    } else {
      setFF({ progress: 1, message: 'Packaging zip…' });
      const zip = await makeZip(files);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(zip, `capture-merged-${stamp}.zip`);
    }
    finishNotice(`Merged ${files.length} file${files.length === 1 ? '' : 's'}`, failed, partialAny);
  } catch (e) {
    setFF({ status: 'error', message: e.message || String(e) });
    throw e;
  }
}
