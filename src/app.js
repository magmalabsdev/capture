// Entry point: instantiate panels, wire state + render + timers.

import { state, subscribe } from './state.js';
import { refreshDevices } from './sources.js';
import { createToolbar } from './ui/toolbar.js';
import { createVideoStage } from './ui/videoStage.js';
import { createAudioBar } from './ui/audioBar.js';
import { createInspector } from './ui/inspector.js';
import { createExportPanel } from './ui/exportPanel.js';
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
    const { message, type } = s.notice;
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

function main() {
  if (!checkSupport()) return;

  const toolbar = createToolbar(document.getElementById('toolbar'));
  const stage = createVideoStage(document.getElementById('stage'));
  const audioBar = createAudioBar(document.getElementById('audiobar'));
  const inspector = createInspector(document.getElementById('inspector'));
  const exportPanel = createExportPanel(document.getElementById('export'));

  setupToast();
  initResizers();

  const renderAll = (s) => {
    toolbar.render(s);
    stage.render(s);
    audioBar.render(s);
    inspector.render(s);
    exportPanel.render(s);
  };
  subscribe(renderAll);
  renderAll(state);

  // Timers: text/status (cheap) every 250ms.
  setInterval(() => {
    stage.tick();
    audioBar.tick();
    inspector.tick();
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
