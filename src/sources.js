// Acquiring and managing capture sources (cameras, screens, mics, desktop audio).

import { state, update, notify } from './state.js';
import { uid } from './util/dom.js';
import { freshRec, stopRecording } from './recorder.js';
import { attachMeter, detachMeter, getAudioContext } from './audioMeter.js';

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
    streamEnded: false,
    rec: freshRec(),
  };
  if (track) track.addEventListener('ended', () => onTrackEnded(source));
  update((s) => {
    s.videoSources.push(source);
    if (!s.selectedId) s.selectedId = source.id;
    if (!s.speakerMainId) s.speakerMainId = source.id;
  });
  refreshDevices();
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
    rec: freshRec(),
  };
  attachMeter(source);
  if (track) track.addEventListener('ended', () => onTrackEnded(source));
  update((s) => {
    s.audioSources.push(source);
    if (!s.selectedId) s.selectedId = source.id;
  });
  refreshDevices();
  return source;
}

function onTrackEnded(source) {
  source.streamEnded = true;
  if (source.rec.status === 'recording' || source.rec.status === 'paused') {
    stopRecording(source);
  }
  notify(`${source.label} stopped (source ended).`, 'warn');
  update();
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

export async function addDisplay() {
  const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  return registerVideoSource({
    stream: new MediaStream(captured.getVideoTracks()),
    kind: 'display',
  });
}

export async function addMicrophone(deviceId) {
  const audio = deviceId ? { deviceId: { exact: deviceId } } : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  return registerAudioSource({ stream, kind: 'mic', deviceId });
}

export async function addDesktopAudio() {
  // System audio can only be captured alongside a display capture.
  const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const audioTracks = captured.getAudioTracks();
  captured.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
  if (!audioTracks.length) {
    throw new Error(
      'No audio was shared. In the picker choose a Tab or "Entire screen" and enable "Share tab/system audio".'
    );
  }
  return registerAudioSource({
    stream: new MediaStream(audioTracks),
    kind: 'desktop',
    label: 'Desktop audio',
  });
}

/** Default setup: main display + desktop audio + microphone. */
export async function quickStartDefault() {
  getAudioContext(); // unlock audio within the user gesture
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  registerVideoSource({
    stream: new MediaStream(display.getVideoTracks()),
    kind: 'display',
    label: 'Main display',
  });
  if (display.getAudioTracks().length) {
    registerAudioSource({
      stream: new MediaStream(display.getAudioTracks()),
      kind: 'desktop',
      label: 'Desktop audio',
    });
  } else {
    notify('Tip: enable "Share audio" in the picker to capture desktop audio.', 'warn');
  }
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
  const track = source.stream.getAudioTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints(constraints);
  } catch {
    /* not all browsers honor these */
  }
  source.settings = trackSettings(track);
  update();
}
