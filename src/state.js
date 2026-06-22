// Central observable state store. Vanilla pub/sub.
//
// A "source" object (video or audio) carries:
//   id, mediaKind ('video'|'audio'), kind ('camera'|'display'|'mic'|'desktop'),
//   label, stream (MediaStream), deviceId, settings (track settings),
//   bitrate, mirror (video), streamEnded, rec (recording state),
//   and a few private fields prefixed with "_" (MediaRecorder, analyser, ...).

export const state = {
  videoSources: [],
  audioSources: [],

  view: 'grid', // 'grid' | 'speaker'
  speakerMainId: null,
  selectedId: null,

  // Appearance
  theme: 'dark', // 'dark' | 'light'
  contrast: 'normal', // 'normal' | 'high'
  settingsOpen: false,

  exportMode: 'all', // 'single' | 'all' | 'merge'
  mergeAssignments: {}, // videoId -> [audioId, ...]

  devices: { cameras: [], mics: [] },

  ffmpeg: { status: 'idle', progress: 0, message: '' }, // idle|loading|ready|running|error

  // Periodic auto-export (rolling clip backups while recording continues).
  periodic: { enabled: false, intervalSec: 120, nextAt: 0, count: 0, lastRunAt: 0 },

  // Recordings left in IndexedDB by a previous/crashed session (crash recovery).
  recovery: [],

  // Download destination (File System Access API where supported).
  download: { supported: false, mode: 'browser', name: '', available: true, needsReconnect: false },

  notice: null, // { message, type, ts }

  // App version (YY.MM.COMMIT), computed from the repo's commit history.
  version: '',
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(state);
}

/** Apply a mutation (optional) and notify subscribers. */
export function update(mutator) {
  if (typeof mutator === 'function') mutator(state);
  emit();
}

export function allSources() {
  return [...state.videoSources, ...state.audioSources];
}

export function findSource(id) {
  return allSources().find((s) => s.id === id) || null;
}

/** Transient notice (rendered as a toast). Pass { sound: true } to also play
 *  the warning sound (used for critical recording degradation). */
export function notify(message, type = 'info', opts = {}) {
  update((s) => {
    s.notice = { message, type, ts: Date.now(), sound: !!opts.sound };
  });
}
