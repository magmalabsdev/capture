// Persist session settings to localStorage so they survive a tab reload.
//
// Live streams can't be restored (they need a user gesture), but preferences
// can: global UI/export settings, and per-track config keyed by device so a
// re-added camera/mic/screen comes back configured the way you left it.

import { sameBinding } from './util/hotkey.js';

const KEY = 'capture.settings.v1';

let cache = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
})();
let lastWritten = JSON.stringify(cache);

function persist() {
  const json = JSON.stringify(cache);
  if (json === lastWritten) return; // avoid redundant writes
  lastWritten = json;
  try {
    localStorage.setItem(KEY, json);
  } catch {
    /* quota / private mode — ignore */
  }
}

/* ----------------------------- global ----------------------------- */

export function getGlobal() {
  return cache.global || {};
}

export function setGlobal(patch) {
  cache.global = { ...(cache.global || {}), ...patch };
  persist();
}

/* -------------------------- per-source ---------------------------- */

/** Stable identity for a source's preferences (devices keep prefs across reloads). */
export function sourceKey(source) {
  if (source.kind === 'camera') return `cam:${source.deviceId || 'default'}`;
  if (source.kind === 'mic') return `mic:${source.deviceId || 'default'}`;
  return source.kind; // 'display' | 'desktop' (ephemeral — one shared pref each)
}

export function getSourcePrefs(source) {
  return (cache.sources && cache.sources[sourceKey(source)]) || null;
}

function snapshot(source) {
  const p = { label: source.label, bitrate: source.bitrate };
  if (source.mediaKind === 'video') {
    p.mirror = source.mirror;
    p.targetW = source.targetW;
    p.targetH = source.targetH;
    p.targetFps = source.targetFps;
    p.timelapse = source.timelapse;
    p.hotkey = source.hotkey;
  } else if (source.kind === 'mic') {
    const s = source.settings || {};
    p.audio = {
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
    };
  }
  return p;
}

/** Save the current config of all live sources (merged by key). */
export function persistSources(sources) {
  cache.sources = cache.sources || {};
  for (const s of sources) cache.sources[sourceKey(s)] = snapshot(s);
  persist();
}

/**
 * Strip a speaker hotkey from every stored source pref except `exceptKey`, so a
 * chord is never restored onto a second stream (one keybind ↔ one stream).
 */
export function clearStoredHotkey(binding, exceptKey) {
  if (!binding || !cache.sources) return;
  let changed = false;
  for (const [k, p] of Object.entries(cache.sources)) {
    if (k !== exceptKey && p && sameBinding(p.hotkey, binding)) {
      delete p.hotkey;
      changed = true;
    }
  }
  if (changed) persist();
}
