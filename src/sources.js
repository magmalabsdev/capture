// Acquiring and managing capture sources (cameras, screens, mics, desktop audio).

import { state, update, notify } from './state.js';
import { uid } from './util/dom.js';
import { freshRec, stopRecording, continueRecording } from './recorder.js';
import { attachMeter, detachMeter, getAudioContext } from './audioMeter.js';
import { deleteRecording } from './util/idb.js';
import { getSourcePrefs } from './settings.js';

/* ------------------------------------------------------------------ */
/* Devices                                                            */
/* ------------------------------------------------------------------ */

export async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      cameras: devices.filter((d) => d.kind === 'videoinput'),
      mics: devices.filter((d) => d.kind === 'audioinput'),
    };
  } catch {
    return { cameras: [], mics: [] };
  }
}

export async function refreshDevices() {
  const devices = await listDevices();
  update((s) => {
    s.devices = devices;
  });
}

/* ------------------------------------------------------------------ */
/* Source registration                                                */
/* ------------------------------------------------------------------ */

function trackSettings(track) {
  return track && track.getSettings ? track.getSettings() : {};
}

/** Restore saved preferences (label/bitrate/mirror/targets/time-lapse) in-memory. */
function applyStoredPrefs(source) {
  const p = getSourcePrefs(source);
  if (!p) return;
  if (typeof p.label === 'string' && p.label) source.label = p.label;
  if (typeof p.bitrate === 'number') source.bitrate = p.bitrate;
  if (source.mediaKind === 'video') {
    if (typeof p.mirror === 'boolean') source.mirror = p.mirror;
    if (p.targetW) source.targetW = p.targetW;
    if (p.targetH) source.targetH = p.targetH;
    if (p.targetFps) source.targetFps = p.targetFps;
    if (p.timelapse) source.timelapse = { ...source.timelapse, ...p.timelapse };
    if (p.hotkey && typeof p.hotkey === 'object') source.hotkey = p.hotkey;
  }
}

/** Re-apply saved hardware constraints (resolution/fps, mic processing) async. */
function restoreHardware(source) {
  const p = getSourcePrefs(source);
  if (!p) return;
  if (source.mediaKind === 'video' && (p.targetW || p.targetFps)) {
    applyVideoConstraints(source, { width: p.targetW, height: p.targetH, frameRate: p.targetFps }).catch(() => {});
  } else if (source.mediaKind === 'audio' && p.audio) {
    const a = {};
    for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
      if (typeof p.audio[k] === 'boolean') a[k] = p.audio[k];
    }
    if (Object.keys(a).length) applyAudioConstraints(source, a).catch(() => {});
  }
}

/** Wire ended/mute/unmute listeners so drops and silences are surfaced. */
function attachTrackListeners(source, track) {
  if (!track) return;
  track.addEventListener('ended', () => onTrackEnded(source));
  track.addEventListener('mute', () => {
    source.muted = true;
    notify(`${source.label} muted — no signal is being captured.`, 'warn', { sound: true });
    update();
  });
  track.addEventListener('unmute', () => {
    source.muted = false;
    update();
  });
}

function registerVideoSource({ stream, kind, label, deviceId }) {
  const track = stream.getVideoTracks()[0];
  const source = {
    id: uid('vid'),
    mediaKind: 'video',
    kind, // 'camera' | 'display'
    label: label || (track && track.label) || (kind === 'camera' ? 'Camera' : 'Display'),
    stream,
    deviceId: deviceId || (trackSettings(track).deviceId ?? null),
    settings: trackSettings(track),
    bitrate: 0,
    mirror: kind === 'camera',
    // User-chosen targets (so the inspector reflects the choice, not the
    // browser's actual negotiated settings which often differ).
    targetW: 0,
    targetH: 0,
    targetFps: 0,
    // Per-stream time-lapse (applied at export):
    //  off | static (constant speed from from→to) | dynamic (fit to length)
    timelapse: {
      mode: 'off',
      fromVal: 1, fromUnit: 'hour',
      toVal: 1, toUnit: 'min',
      targetVal: 30, targetUnit: 'sec',
    },
    // Keyboard shortcut that jumps this stream into speaker view (null = none).
    hotkey: null,
    streamEnded: false,
    muted: false,
    stalled: false,
    rec: freshRec(),
  };
  applyStoredPrefs(source);
  attachTrackListeners(source, track);
  update((s) => {
    s.videoSources.push(source);
    if (!s.selectedId) s.selectedId = source.id;
    if (!s.speakerMainId) s.speakerMainId = source.id;
  });
  refreshDevices();
  restoreHardware(source);
  return source;
}

function registerAudioSource({ stream, kind, label, deviceId }) {
  const track = stream.getAudioTracks()[0];
  const source = {
    id: uid('aud'),
    mediaKind: 'audio',
    kind, // 'mic' | 'desktop'
    label: label || (track && track.label) || (kind === 'mic' ? 'Microphone' : 'Desktop audio'),
    stream,
    deviceId: deviceId || (trackSettings(track).deviceId ?? null),
    settings: trackSettings(track),
    bitrate: 0,
    streamEnded: false,
    muted: false,
    stalled: false,
    rec: freshRec(),
  };
  applyStoredPrefs(source);
  attachMeter(source);
  attachTrackListeners(source, track);
  update((s) => {
    s.audioSources.push(source);
    if (!s.selectedId) s.selectedId = source.id;
  });
  refreshDevices();
  restoreHardware(source);
  return source;
}

function onTrackEnded(source) {
  source.streamEnded = true;
  const wasActive = source.rec.status === 'recording' || source.rec.status === 'paused';
  source._droppedWhileRecording = wasActive;
  if (wasActive) stopRecording(source); // finalize & preserve what we have
  notify(
    `${source.label} stopped (source ended).${wasActive ? ' Footage preserved — use Re-capture to continue.' : ''}`,
    'warn',
    { sound: wasActive }
  );
  update();
}

/**
 * Re-acquire a dropped source (needs a user gesture for getDisplayMedia). Swaps
 * the new live stream into the SAME source; if it was recording when it dropped,
 * recording continues as a new segment so the export spans the gap.
 */
export async function recaptureSource(source) {
  let stream;
  if (source.mediaKind === 'video') {
    if (source.kind === 'display') {
      const cap = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      stream = new MediaStream(cap.getVideoTracks());
    } else {
      const video = { width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16 / 9 } };
      if (source.deviceId) video.deviceId = { exact: source.deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
  } else if (source.kind === 'desktop') {
    const cap = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = cap.getAudioTracks();
    cap.getVideoTracks().forEach((t) => t.stop());
    if (!audioTracks.length) throw new Error('No audio shared — tick "Share audio" in the picker.');
    stream = new MediaStream(audioTracks);
  } else {
    const audio = source.deviceId ? { deviceId: { exact: source.deviceId } } : true;
    stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  }

  detachMeter(source);
  source.stream.getTracks().forEach((t) => t.stop());
  source.stream = stream;
  source.streamEnded = false;
  source.muted = false;
  source.stalled = false;
  const track =
    source.mediaKind === 'video' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
  source.settings = trackSettings(track);
  if (source.mediaKind === 'audio') attachMeter(source);
  attachTrackListeners(source, track);

  if (source._droppedWhileRecording) {
    source._droppedWhileRecording = false;
    continueRecording(source); // resume into a new segment, same recording
  }
  update();
  return source;
}

/* ------------------------------------------------------------------ */
/* Add sources                                                        */
/* ------------------------------------------------------------------ */

export async function addCamera(deviceId) {
  // Bias toward a landscape capture so cameras don't default to a portrait mode.
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16 / 9 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  return registerVideoSource({ stream, kind: 'camera', deviceId });
}

/**
 * Register a single screen-capture session as a video source plus, when the
 * user enabled "Share audio", an independent desktop-audio track. Both come
 * from ONE getDisplayMedia call so they share a single capture session — this
 * avoids a second concurrent screen share, which on many systems tears down the
 * first capture (ending its track and stopping the recording).
 */
function registerDisplayCapture(captured, videoLabel) {
  const videoSource = registerVideoSource({
    stream: new MediaStream(captured.getVideoTracks()),
    kind: 'display',
    label: videoLabel,
  });
  const audioTracks = captured.getAudioTracks();
  if (audioTracks.length) {
    registerAudioSource({
      stream: new MediaStream(audioTracks),
      kind: 'desktop',
      label: 'Desktop audio',
    });
  } else {
    notify('Screen added. To also capture desktop audio, re-share and tick "Share audio".', 'warn');
  }
  return videoSource;
}

export async function addDisplay() {
  // Always request audio; it's added as a separate track only if actually shared.
  getAudioContext(); // unlock metering within the user gesture
  const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  return registerDisplayCapture(captured, 'Screen');
}

export async function addMicrophone(deviceId) {
  const audio = deviceId ? { deviceId: { exact: deviceId } } : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  return registerAudioSource({ stream, kind: 'mic', deviceId });
}

/** Default setup: main display (+ desktop audio if shared) + microphone. */
export async function quickStartDefault() {
  getAudioContext(); // unlock audio within the user gesture
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  registerDisplayCapture(display, 'Main display');
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    registerAudioSource({ stream: mic, kind: 'mic', label: 'Microphone' });
  } catch {
    notify('Microphone was not added (permission denied or unavailable).', 'warn');
  }
}

/* ------------------------------------------------------------------ */
/* Mutate / remove                                                    */
/* ------------------------------------------------------------------ */

export function removeSource(id) {
  update((s) => {
    for (const list of [s.videoSources, s.audioSources]) {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) continue;
      const src = list[i];
      try {
        if (src._mr && src._mr.state !== 'inactive') src._mr.stop();
      } catch {
        /* ignore */
      }
      detachMeter(src);
      src.stream.getTracks().forEach((t) => t.stop());
      deleteRecording(src.id).catch(() => {}); // drop durable data for this source
      list.splice(i, 1);
    }
    if (s.selectedId === id) {
      s.selectedId = (s.videoSources[0] || s.audioSources[0] || {}).id || null;
    }
    if (s.speakerMainId === id) {
      s.speakerMainId = (s.videoSources[0] || {}).id || null;
    }
    delete s.mergeAssignments[id];
    for (const k of Object.keys(s.mergeAssignments)) {
      s.mergeAssignments[k] = s.mergeAssignments[k].filter((a) => a !== id);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Live configuration (inspector)                                     */
/* ------------------------------------------------------------------ */

const busy = (source) =>
  source.rec.status === 'recording' || source.rec.status === 'paused';

export async function setVideoDevice(source, deviceId) {
  if (busy(source)) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
    audio: false,
  });
  source.stream.getTracks().forEach((t) => t.stop());
  source.stream = stream;
  source.deviceId = deviceId;
  source.settings = trackSettings(stream.getVideoTracks()[0]);
  stream.getVideoTracks()[0].addEventListener('ended', () => onTrackEnded(source));
  update();
}

export async function setAudioDevice(source, deviceId) {
  if (busy(source)) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId } },
    video: false,
  });
  detachMeter(source);
  source.stream.getTracks().forEach((t) => t.stop());
  source.stream = stream;
  source.deviceId = deviceId;
  source.settings = trackSettings(stream.getAudioTracks()[0]);
  attachMeter(source);
  stream.getAudioTracks()[0].addEventListener('ended', () => onTrackEnded(source));
  update();
}

export async function applyVideoConstraints(source, { width, height, frameRate }) {
  const track = source.stream.getVideoTracks()[0];
  if (!track) return;
  const c = {};
  if (width) c.width = { ideal: width };
  if (height) c.height = { ideal: height };
  if (frameRate) c.frameRate = { ideal: frameRate };
  // Cameras can pick a portrait sensor mode at high resolutions; pin a
  // landscape aspect ratio so they stay horizontal.
  if (source.kind === 'camera' && (width || height)) {
    c.aspectRatio = { ideal: width && height ? width / height : 16 / 9 };
  }
  try {
    await track.applyConstraints(c);
  } catch (e) {
    notify('Could not apply that resolution/frame rate.', 'warn');
  }
  source.settings = trackSettings(track);
  update();
}

export async function applyAudioConstraints(source, constraints) {
  if (busy(source)) return;
  // echoCancellation / noiseSuppression / autoGainControl cannot be toggled on a
  // live MediaStreamTrack — applyConstraints is a silent no-op in Chrome (a plain
  // boolean is ignored and `{ exact }` throws), so the checkbox would just snap
  // back. Re-acquire the mic with the new processing flags and swap the fresh
  // track into the stream instead.
  const cur = source.settings || {};
  const audio = {};
  for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
    const v = k in constraints ? constraints[k] : cur[k];
    if (typeof v === 'boolean') audio[k] = v;
  }
  if (source.deviceId) audio.deviceId = { exact: source.deviceId };

  // The old track must be released BEFORE re-acquiring: Chrome shares audio
  // processing across live captures of the same device, so a still-open track
  // would force the new one to inherit its old settings (the toggle wouldn't
  // take). setAudioDevice can acquire-then-stop because it switches devices.
  detachMeter(source);
  source.stream.getTracks().forEach((t) => t.stop());

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch {
    notify('Could not change that audio processing setting; the microphone was lost.', 'error', { sound: true });
    source.streamEnded = true;
    update();
    return;
  }

  source.stream = stream;
  const track = stream.getAudioTracks()[0];
  source.settings = trackSettings(track);
  attachMeter(source);
  track.addEventListener('ended', () => onTrackEnded(source));
  update();
}
