// Entry point: instantiate panels, wire state + render + timers.

import { state, subscribe, update } from './state.js';
import { refreshDevices } from './sources.js';
import { SESSION_ID } from './recorder.js';
import { startRecordWatch } from './recordWatch.js';
import { listRecordings } from './util/idb.js';
import { armAudio, playWarning } from './sound.js';
import { configurePeriodic } from './periodicExport.js';
import { getGlobal, setGlobal, persistSources } from './settings.js';
import { initDownload } from './download.js';
import { createToolbar } from './ui/toolbar.js';
import { createVideoStage } from './ui/videoStage.js';
import { createAudioBar } from './ui/audioBar.js';
import { createInspector } from './ui/inspector.js';
import { createExportPanel } from './ui/exportPanel.js';
import { createSettingsPanel } from './ui/settingsPanel.js';
import { initResizers } from './ui/resizers.js';

function checkSupport() {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || !md.getDisplayMedia || !('MediaRecorder' in window)) {
    document.querySelector('.app').innerHTML =
      '<div style="margin:auto;max-width:560px;padding:40px;text-align:center;color:#cdd3e0">' +
      '<h1>Unsupported browser</h1><p>This recorder needs getUserMedia, getDisplayMedia and ' +
      'MediaRecorder. Please use a recent Chrome, Edge or Firefox over http(s).</p></div>';
    return false;
  }
  if (location.protocol === 'file:') {
    console.warn('Serve over http(s) — capture APIs and ffmpeg.wasm will not work from file://');
  }
  return true;
}

function setupToast() {
  const toastEl = document.getElementById('toast');
  let hideTimer = null;
  subscribe((s) => {
    if (!s.notice) return;
    const { message, type, sound } = s.notice;
    if (sound) playWarning();
    toastEl.textContent = message;
    toastEl.className = `toast show ${type}`;
    toastEl.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      toastEl.hidden = true;
    }, 4200);
    s.notice = null; // consume
  });
}

function restoreGlobalSettings() {
  const g = getGlobal();
  if (g.view === 'grid' || g.view === 'speaker') state.view = g.view;
  if (['single', 'all', 'merge'].includes(g.exportMode)) state.exportMode = g.exportMode;
  if (g.periodicIntervalSec) state.periodic.intervalSec = g.periodicIntervalSec;
  if (g.periodicEnabled) state.periodic.enabled = true;
  if (g.theme === 'light' || g.theme === 'dark') state.theme = g.theme;
  if (g.contrast === 'high' || g.contrast === 'normal') state.contrast = g.contrast;
}

function applyAppearance(s) {
  const el = document.documentElement;
  const theme = s.theme === 'light' ? 'light' : 'dark';
  const contrast = s.contrast === 'high' ? 'high' : 'normal';
  if (el.dataset.theme !== theme) el.dataset.theme = theme;
  if (el.dataset.contrast !== contrast) el.dataset.contrast = contrast;
}

function main() {
  if (!checkSupport()) return;

  restoreGlobalSettings();
  applyAppearance(state);

  const toolbar = createToolbar(document.getElementById('toolbar'));
  const stage = createVideoStage(document.getElementById('stage'));
  const audioBar = createAudioBar(document.getElementById('audiobar'));
  const inspector = createInspector(document.getElementById('inspector'));
  const exportPanel = createExportPanel(document.getElementById('export'));
  const settingsPanel = createSettingsPanel(document.getElementById('settings'));

  setupToast();
  armAudio(); // enable warning sounds (unlocks on first interaction)
  initResizers();
  startRecordWatch();
  scanForRecovery();
  initDownload();

  const renderAll = (s) => {
    applyAppearance(s);
    toolbar.render(s);
    stage.render(s);
    audioBar.render(s);
    inspector.render(s);
    exportPanel.render(s);
    settingsPanel.render(s);
  };
  subscribe(renderAll);

  // Persist session settings on any change (writes are de-duped in settings.js).
  subscribe((s) => {
    setGlobal({
      view: s.view,
      exportMode: s.exportMode,
      periodicEnabled: s.periodic.enabled,
      periodicIntervalSec: s.periodic.intervalSec,
      theme: s.theme,
      contrast: s.contrast,
    });
    persistSources([...s.videoSources, ...s.audioSources]);
  });

  renderAll(state);

  // Resume auto-export timer if it was enabled last session.
  if (state.periodic.enabled) configurePeriodic({});

  // Timers: text/status (cheap) every 250ms.
  setInterval(() => {
    stage.tick();
    audioBar.tick();
    inspector.tick();
    exportPanel.tick();
  }, 250);

  // VU meters: every animation frame.
  function meterLoop() {
    audioBar.meter();
    inspector.meter();
    requestAnimationFrame(meterLoop);
  }
  requestAnimationFrame(meterLoop);

  // Device list (labels populate after first permission grant).
  refreshDevices();
  if (navigator.mediaDevices && 'ondevicechange' in navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }

  // Surface recordings left in storage by a previous/crashed session.
  async function scanForRecovery() {
    try {
      const all = await listRecordings();
      const leftovers = all.filter(
        (m) => m.sessionId !== SESSION_ID && (m.bytes > 0 || m.segments > 0)
      );
      if (leftovers.length) update((s) => { s.recovery = leftovers; });
    } catch {
      /* IDB unavailable — skip recovery */
    }
  }

  // Warn before leaving with an active recording.
  window.addEventListener('beforeunload', (e) => {
    const active = [...state.videoSources, ...state.audioSources].some(
      (s) => s.rec.status === 'recording' || s.rec.status === 'paused'
    );
    if (active) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

main();
