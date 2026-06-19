// Export logic: export-all (raw downloads) + ffmpeg-muxed single/merge exports.

import { state, update } from '../state.js';
import { el } from '../util/dom.js';
import { safeName } from '../util/format.js';
import { makeZip } from '../util/zip.js';
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

export const hasRecording = (s) => !!(s.rec && s.rec.blob);

function setFF(patch) {
  update((s) => Object.assign(s.ffmpeg, patch));
}

/* ------------------------------------------------------------------ */
/* Export all — independent files, no muxing                          */
/* ------------------------------------------------------------------ */

export async function exportAll() {
  const videos = state.videoSources.filter(hasRecording);
  const audios = state.audioSources.filter(hasRecording);
  const recs = [...videos, ...audios];
  if (!recs.length) return { count: 0 };

  setFF({ status: 'running', progress: 0, message: 'Preparing export…' });
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

  try {
    // Videos: keep as recorded.
    for (const v of videos) {
      files.push({ name: nameFor(v.label, v.rec.ext), blob: v.rec.blob });
    }
    // Audio: transcode each to MP3.
    for (let i = 0; i < audios.length; i += 1) {
      const a = audios[i];
      setFF({ progress: 0, message: `Converting audio ${i + 1}/${audios.length} to MP3…` });
      const mp3 = await audioToMp3(a.rec.blob, a.rec.ext, (p) => setFF({ progress: p }));
      files.push({ name: nameFor(a.label, 'mp3'), blob: mp3 });
    }

    setFF({ status: 'running', progress: 1, message: 'Packaging zip…' });
    const zip = await makeZip(files);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(zip, `capture-${stamp}.zip`);
    setFF({ status: 'ready', progress: 1, message: `Exported ${recs.length} tracks.` });
  } catch (e) {
    setFF({ status: 'error', message: e.message || String(e) });
    throw e;
  }
  return { count: recs.length };
}

/* ------------------------------------------------------------------ */
/* Muxing one video with N audio tracks                               */
/* ------------------------------------------------------------------ */

/**
 * Mux a video blob with 0..N audio blobs into a single file.
 * Video is stream-copied (no re-encode). Multiple audios are mixed down to one
 * track; a single audio track is mapped 1:1. Output container follows the video
 * (mp4 if recorded as mp4, else webm).
 */
let jobSeq = 0;

async function muxVideoWithAudios(video, audios, onProgress) {
  const ff = await getFFmpeg(onProgress);

  const outExt = video.rec.ext === 'mp4' ? 'mp4' : 'webm';
  const audioCodec = outExt === 'mp4' ? 'aac' : 'libopus';
  const outMime = outExt === 'mp4' ? 'video/mp4' : 'video/webm';

  // Unique names per job so repeated runs never collide in the virtual FS.
  const job = `j${jobSeq++}`;
  const vName = `${job}_video.${video.rec.ext}`;
  await ff.writeFile(vName, await blobBytes(video.rec.blob));

  const aNames = [];
  for (let i = 0; i < audios.length; i += 1) {
    const n = `${job}_audio${i}.${audios[i].rec.ext}`;
    await ff.writeFile(n, await blobBytes(audios[i].rec.blob));
    aNames.push(n);
  }

  const out = `${job}_output.${outExt}`;
  const args = ['-y', '-i', vName];
  for (const n of aNames) args.push('-i', n);

  if (audios.length === 0) {
    args.push('-c', 'copy', out);
  } else if (audios.length === 1) {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', audioCodec, out);
  } else {
    const inputs = audios.map((_, i) => `[${i + 1}:a]`).join('');
    args.push(
      '-filter_complex',
      `${inputs}amix=inputs=${audios.length}:normalize=0[aout]`,
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

  return new Blob([data], { type: outMime });
}

/** Transcode a recorded audio blob to MP3 (libmp3lame). */
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
  if (videos.length !== 1) {
    throw new Error('Single export needs exactly one recorded video.');
  }
  const audios = state.audioSources.filter(hasRecording);
  const video = videos[0];

  setFF({ status: 'running', progress: 0, message: 'Muxing video + audio…' });
  try {
    const blob = await muxVideoWithAudios(video, audios, (p) =>
      setFF({ progress: p })
    );
    downloadBlob(blob, `${safeName(video.label)}-mixed.${video.rec.ext === 'mp4' ? 'mp4' : 'webm'}`);
    setFF({ status: 'ready', progress: 1, message: 'Done.' });
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
    for (let i = 0; i < videos.length; i += 1) {
      const video = videos[i];
      const assigned = (state.mergeAssignments[video.id] || [])
        .map((id) => state.audioSources.find((a) => a.id === id))
        .filter((a) => a && hasRecording(a));

      setFF({
        progress: 0,
        message: `Merging ${i + 1}/${videos.length}: ${video.label}…`,
      });

      const blob = await muxVideoWithAudios(video, assigned, (p) => setFF({ progress: p }));
      const ext = video.rec.ext === 'mp4' ? 'mp4' : 'webm';
      const base = safeName(video.label);
      let name = `${base}-merged.${ext}`;
      let n = 2;
      while (used.has(name)) name = `${base}-merged-${n++}.${ext}`;
      used.add(name);
      files.push({ name, blob });
    }

    if (files.length === 1) {
      downloadBlob(files[0].blob, files[0].name);
    } else {
      setFF({ status: 'running', progress: 1, message: 'Packaging zip…' });
      const zip = await makeZip(files);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadBlob(zip, `capture-merged-${stamp}.zip`);
    }
    setFF({ status: 'ready', progress: 1, message: 'Merge complete.' });
  } catch (e) {
    setFF({ status: 'error', message: e.message || String(e) });
    throw e;
  }
}
