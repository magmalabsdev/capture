// Bottom bar: all audio tracks in a single line, each with a live VU meter.

import { state, update } from '../state.js';
import { el, clear } from '../util/dom.js';
import { formatDuration } from '../util/format.js';
import { startRecording, stopRecording, togglePause, elapsedMs } from '../recorder.js';
import { removeSource } from '../sources.js';
import { readLevel } from '../audioMeter.js';

export function createAudioBar(root) {
  const tiles = new Map(); // id -> { wrapper, els }
  let lastKey = '';

  function buildTile(source) {
    const recDot = el('span', { class: 'rec-dot' });
    const name = el('span', { class: 'aud-name', text: source.label });
    const kind = el('span', { class: 'aud-kind', text: source.kind });
    const time = el('span', { class: 'aud-time', text: '0:00' });

    const meterFill = el('div', { class: 'meter-fill' });
    const meter = el('div', { class: 'meter' }, [meterFill]);

    const btnStart = el('button', {
      class: 'tbtn start', title: 'Start', html: '&#9679;',
      onClick: () => startRecording(source),
    });
    const btnPause = el('button', {
      class: 'tbtn pause', title: 'Pause / resume', html: '&#10073;&#10073;',
      onClick: () => togglePause(source),
    });
    const btnStop = el('button', {
      class: 'tbtn stop', title: 'Finish', html: '&#9632;',
      onClick: () => stopRecording(source),
    });
    const btnRemove = el('button', {
      class: 'tbtn remove', title: 'Remove', html: '&times;',
      onClick: () => removeSource(source.id),
    });
    const controls = el('div', { class: 'aud-controls' }, [
      btnStart, btnPause, btnStop, btnRemove,
    ]);

    const wrapper = el(
      'div',
      {
        class: 'aud-tile',
        dataset: { id: source.id },
        onClick: (e) => {
          if (e.target.closest('.tbtn')) return;
          update((s) => { s.selectedId = source.id; });
        },
      },
      [
        el('div', { class: 'aud-head' }, [
          el('div', { class: 'aud-titles' }, [recDot, name, kind]),
          time,
        ]),
        meter,
        controls,
      ]
    );

    return { wrapper, els: { name, kind, time, meterFill, btnStart, btnPause, btnStop } };
  }

  function updateTile(source) {
    const t = tiles.get(source.id);
    if (!t) return;
    const { els, wrapper } = t;
    const r = source.rec;
    els.name.textContent = source.label;
    els.kind.textContent = source.streamEnded ? 'ended' : source.kind;
    els.time.textContent = formatDuration(elapsedMs(source));

    wrapper.classList.toggle('is-recording', r.status === 'recording');
    wrapper.classList.toggle('is-paused', r.status === 'paused');
    wrapper.classList.toggle('is-stopped', r.status === 'stopped');
    wrapper.classList.toggle('is-selected', state.selectedId === source.id);
    wrapper.classList.toggle('stream-ended', !!source.streamEnded);

    els.btnStart.disabled = source.streamEnded || r.status === 'recording' || r.status === 'paused';
    els.btnPause.disabled = !(r.status === 'recording' || r.status === 'paused');
    els.btnPause.innerHTML = r.status === 'paused' ? '&#9654;' : '&#10073;&#10073;';
    els.btnStop.disabled = !(r.status === 'recording' || r.status === 'paused');
  }

  function render(s) {
    for (const id of [...tiles.keys()]) {
      if (!s.audioSources.find((a) => a.id === id)) {
        tiles.get(id).wrapper.remove();
        tiles.delete(id);
      }
    }

    if (!s.audioSources.length) {
      lastKey = '';
      clear(root);
      root.appendChild(
        el('div', { class: 'audiobar-empty muted' }, 'No audio tracks. Add a microphone or desktop audio.')
      );
      return;
    }

    for (const a of s.audioSources) {
      let t = tiles.get(a.id);
      if (!t) {
        t = buildTile(a);
        tiles.set(a.id, t);
      }
      updateTile(a);
    }

    const key = s.audioSources.map((a) => a.id).join(',');
    if (key !== lastKey) {
      clear(root);
      const lane = el('div', { class: 'audio-lane' });
      for (const a of s.audioSources) lane.appendChild(tiles.get(a.id).wrapper);
      root.appendChild(lane);
      lastKey = key;
    }
  }

  function tick() {
    for (const a of state.audioSources) {
      const t = tiles.get(a.id);
      if (t) t.els.time.textContent = formatDuration(elapsedMs(a));
    }
  }

  // Called on every animation frame for smooth VU meters.
  function meter() {
    for (const a of state.audioSources) {
      const t = tiles.get(a.id);
      if (!t) continue;
      const level = readLevel(a);
      t.els.meterFill.style.width = `${Math.round(level * 100)}%`;
      t.els.meterFill.classList.toggle('hot', level > 0.85);
    }
  }

  return { render, tick, meter };
}
