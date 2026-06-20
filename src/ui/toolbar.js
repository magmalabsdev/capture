// Top toolbar: add sources, quick-start, global record controls, view toggle.

import { state, update, notify } from '../state.js';
import { el, fa } from '../util/dom.js';
import {
  quickStartDefault,
  addCamera,
  addDisplay,
  addMicrophone,
} from '../sources.js';
import { startRecording, stopRecording, pauseRecording, resumeRecording } from '../recorder.js';

function closeMenus() {
  document.querySelectorAll('.menu-pop').forEach((m) => m.remove());
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-pop') && !e.target.closest('[data-menu-anchor]')) closeMenus();
});

function openMenu(anchor, items) {
  closeMenus();
  const rect = anchor.getBoundingClientRect();
  const pop = el(
    'div',
    { class: 'menu-pop', style: { top: `${rect.bottom + 4}px`, left: `${rect.left}px` } },
    items.map((it) =>
      el('button', {
        class: 'menu-item',
        text: it.label,
        onClick: () => {
          closeMenus();
          it.onSelect();
        },
      })
    )
  );
  document.body.appendChild(pop);
}

export function createToolbar(root) {
  async function guard(promise, label) {
    try {
      await promise;
    } catch (e) {
      if (e && e.name === 'NotAllowedError') notify(`${label} canceled or permission denied.`, 'warn');
      else notify(e.message || `${label} failed.`, 'error');
    }
  }

  function cameraMenu(e) {
    const cams = state.devices.cameras;
    const items = [{ label: 'Default camera', onSelect: () => guard(addCamera(), 'Add camera') }];
    cams.forEach((d, i) => {
      if (d.deviceId) {
        items.push({
          label: d.label || `Camera ${i + 1}`,
          onSelect: () => guard(addCamera(d.deviceId), 'Add camera'),
        });
      }
    });
    openMenu(e.currentTarget, items);
  }

  function micMenu(e) {
    const mics = state.devices.mics;
    const items = [{ label: 'Default microphone', onSelect: () => guard(addMicrophone(), 'Add microphone') }];
    mics.forEach((d, i) => {
      if (d.deviceId) {
        items.push({
          label: d.label || `Microphone ${i + 1}`,
          onSelect: () => guard(addMicrophone(d.deviceId), 'Add microphone'),
        });
      }
    });
    openMenu(e.currentTarget, items);
  }

  // Global record controls
  function allSources() {
    return [...state.videoSources, ...state.audioSources];
  }
  function recordAll() {
    allSources().forEach((s) => {
      if (s.rec.status === 'idle' || s.rec.status === 'stopped') startRecording(s);
    });
  }
  function pauseAll() {
    const anyRecording = allSources().some((s) => s.rec.status === 'recording');
    allSources().forEach((s) => {
      if (anyRecording && s.rec.status === 'recording') pauseRecording(s);
      else if (!anyRecording && s.rec.status === 'paused') resumeRecording(s);
    });
  }
  async function stopAll() {
    await Promise.all(allSources().map((s) => stopRecording(s)));
  }

  function render(s) {
    const anyActive = allSources().some(
      (x) => x.rec.status === 'recording' || x.rec.status === 'paused'
    );
    const anyRecording = allSources().some((x) => x.rec.status === 'recording');

    root.replaceChildren(
      el('div', { class: 'brand' }, [
        el('span', { class: 'brand-dot' }),
        el('span', { class: 'brand-name', text: 'Capture' }),
      ]),

      el('div', { class: 'tb-group' }, [
        el('button', {
          class: 'btn primary',
          html: `${fa('bolt')}<span>Quick start</span>`,
          title: 'Main display + desktop audio + microphone',
          onClick: () => guard(quickStartDefault(), 'Quick start'),
        }),
      ]),

      el('div', { class: 'tb-group' }, [
        el('button', {
          class: 'btn', dataset: { menuAnchor: '1' },
          html: `${fa('video')}<span>Camera</span>${fa('caret-down')}`, onClick: cameraMenu,
        }),
        el('button', {
          class: 'btn', html: `${fa('display')}<span>Screen</span>`,
          title: 'Capture a screen, window, or tab — desktop audio is included if you tick "Share audio"',
          onClick: () => guard(addDisplay(), 'Add screen'),
        }),
        el('button', {
          class: 'btn', dataset: { menuAnchor: '1' },
          html: `${fa('microphone')}<span>Mic</span>${fa('caret-down')}`, onClick: micMenu,
        }),
      ]),

      el('div', { class: 'tb-spacer' }),

      el('div', { class: 'tb-group' }, [
        el('button', {
          class: 'btn rec', disabled: !allSources().length,
          html: `${fa('circle')}<span>Record all</span>`, onClick: recordAll,
        }),
        el('button', {
          class: 'btn', disabled: !anyActive,
          html: anyRecording ? `${fa('pause')}<span>Pause all</span>` : `${fa('play')}<span>Resume all</span>`,
          onClick: pauseAll,
        }),
        el('button', {
          class: 'btn', disabled: !anyActive,
          html: `${fa('stop')}<span>Stop all</span>`, onClick: () => stopAll(),
        }),
      ]),

      el('div', { class: 'tb-group view-toggle' }, [
        el('button', {
          class: `seg ${s.view === 'grid' ? 'active' : ''}`,
          html: `${fa('table-cells-large')}<span>Grid</span>`, onClick: () => update((st) => { st.view = 'grid'; }),
        }),
        el('button', {
          class: `seg ${s.view === 'speaker' ? 'active' : ''}`,
          html: `${fa('user-large')}<span>Speaker</span>`, onClick: () => update((st) => { st.view = 'speaker'; }),
        }),
      ]),

      el('div', { class: 'tb-group' }, [
        el('button', {
          class: 'btn', title: 'Settings', html: fa('gear'),
          onClick: () => update((st) => { st.settingsOpen = true; }),
        }),
      ])
    );
  }

  return { render };
}
