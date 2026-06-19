// Center stage: video tiles in a Zoom-style grid or speaker layout.
// Video elements are created once per source and re-parented (never recreated)
// so live playback never drops.

import { state, update } from '../state.js';
import { el, clear, fa } from '../util/dom.js';
import { formatDuration, formatRes } from '../util/format.js';
import {
  startRecording,
  stopRecording,
  togglePause,
  elapsedMs,
} from '../recorder.js';
import { removeSource } from '../sources.js';

export function createVideoStage(root) {
  const tiles = new Map(); // id -> { wrapper, video, els }
  let lastLayoutKey = '';

  function buildTile(source) {
    const video = el('video', {
      autoplay: true,
      muted: true,
      playsInline: true,
      class: 'tile-video',
    });
    video.srcObject = source.stream;

    const recDot = el('span', { class: 'rec-dot' });
    const statusLabel = el('span', { class: 'tile-status' });
    const nameLabel = el('span', { class: 'tile-name' });
    const resLabel = el('span', { class: 'tile-res' });
    const timeLabel = el('span', { class: 'tile-time', text: '0:00' });

    const btnStart = el('button', {
      class: 'tbtn start', title: 'Start recording', html: fa('circle'),
      onClick: () => startRecording(source),
    });
    const btnPause = el('button', {
      class: 'tbtn pause', title: 'Pause / resume', html: fa('pause'),
      onClick: () => togglePause(source),
    });
    const btnStop = el('button', {
      class: 'tbtn stop', title: 'Finish', html: fa('stop'),
      onClick: () => stopRecording(source),
    });
    const btnMain = el('button', {
      class: 'tbtn main', title: 'Set as main (speaker view)', html: fa('expand'),
      onClick: () => update((s) => { s.speakerMainId = source.id; }),
    });
    const btnRemove = el('button', {
      class: 'tbtn remove', title: 'Remove source', html: fa('xmark'),
      onClick: () => removeSource(source.id),
    });

    const controls = el('div', { class: 'tile-controls' }, [
      btnStart, btnPause, btnStop, btnMain, btnRemove,
    ]);
    const top = el('div', { class: 'tile-top' }, [
      el('div', { class: 'tile-badges' }, [recDot, statusLabel]),
      nameLabel,
    ]);
    const bottom = el('div', { class: 'tile-bottom' }, [resLabel, timeLabel]);
    const overlay = el('div', { class: 'tile-overlay' }, [
      el('span', { class: 'overlay-text', text: 'PAUSED' }),
    ]);

    const wrapper = el(
      'div',
      {
        class: 'tile',
        dataset: { id: source.id },
        onClick: (e) => {
          if (e.target.closest('.tbtn')) return;
          update((s) => { s.selectedId = source.id; });
        },
      },
      [video, overlay, top, controls, bottom]
    );

    return {
      wrapper,
      video,
      els: { recDot, statusLabel, nameLabel, resLabel, timeLabel, btnStart, btnPause, btnStop },
    };
  }

  function ensureTile(source) {
    let t = tiles.get(source.id);
    if (!t) {
      t = buildTile(source);
      tiles.set(source.id, t);
    }
    if (t.video.srcObject !== source.stream) t.video.srcObject = source.stream;
    return t;
  }

  function updateTile(source) {
    const t = tiles.get(source.id);
    if (!t) return;
    const { els, wrapper, video } = t;
    const r = source.rec;
    const st = source.settings || {};

    els.nameLabel.textContent = source.label;
    els.statusLabel.textContent = source.streamEnded ? 'ended' : r.status;
    els.resLabel.textContent =
      st.width && st.height
        ? formatRes(st.width, st.height) +
          (st.frameRate ? ` · ${Math.round(st.frameRate)}fps` : '')
        : '—';
    els.timeLabel.textContent = formatDuration(elapsedMs(source));

    wrapper.classList.toggle('is-recording', r.status === 'recording');
    wrapper.classList.toggle('is-paused', r.status === 'paused');
    wrapper.classList.toggle('is-stopped', r.status === 'stopped');
    wrapper.classList.toggle('is-selected', state.selectedId === source.id);
    wrapper.classList.toggle('is-main', state.speakerMainId === source.id);
    wrapper.classList.toggle('stream-ended', !!source.streamEnded);

    video.style.transform = source.mirror ? 'scaleX(-1)' : '';

    els.btnStart.disabled = source.streamEnded || r.status === 'recording' || r.status === 'paused';
    els.btnPause.disabled = !(r.status === 'recording' || r.status === 'paused');
    els.btnPause.innerHTML = r.status === 'paused' ? fa('play') : fa('pause');
    els.btnStop.disabled = !(r.status === 'recording' || r.status === 'paused');
  }

  function layoutKey(s) {
    return [
      s.view,
      s.view === 'speaker' ? s.speakerMainId : '',
      s.videoSources.map((v) => v.id).join(','),
    ].join('|');
  }

  function relayout(s) {
    clear(root);
    if (s.view === 'grid') {
      const grid = el('div', { class: 'video-grid' });
      grid.dataset.count = s.videoSources.length;
      for (const v of s.videoSources) {
        const t = tiles.get(v.id);
        t.wrapper.classList.remove('main-tile', 'strip-tile');
        grid.appendChild(t.wrapper);
      }
      root.appendChild(grid);
    } else {
      const mainId =
        s.speakerMainId && s.videoSources.find((v) => v.id === s.speakerMainId)
          ? s.speakerMainId
          : s.videoSources[0].id;
      const mainWrap = el('div', { class: 'speaker-main' });
      const strip = el('div', { class: 'speaker-strip' });
      for (const v of s.videoSources) {
        const t = tiles.get(v.id);
        if (v.id === mainId) {
          t.wrapper.classList.add('main-tile');
          t.wrapper.classList.remove('strip-tile');
          mainWrap.appendChild(t.wrapper);
        } else {
          t.wrapper.classList.add('strip-tile');
          t.wrapper.classList.remove('main-tile');
          strip.appendChild(t.wrapper);
        }
      }
      root.appendChild(el('div', { class: 'speaker-view' }, [mainWrap, strip]));
    }
  }

  function render(s) {
    // drop removed tiles
    for (const id of [...tiles.keys()]) {
      if (!s.videoSources.find((v) => v.id === id)) {
        tiles.get(id).wrapper.remove();
        tiles.delete(id);
      }
    }

    if (!s.videoSources.length) {
      lastLayoutKey = '';
      clear(root);
      root.appendChild(
        el('div', { class: 'empty-stage' }, [
          el('div', { class: 'empty-emoji', html: fa('clapperboard') }),
          el('div', { class: 'empty-title', text: 'No video sources yet' }),
          el('div', {
            class: 'muted',
            text: 'Use Quick start, or add a camera / screen capture from the top bar.',
          }),
        ])
      );
      return;
    }

    for (const v of s.videoSources) {
      ensureTile(v);
      updateTile(v);
    }

    const key = layoutKey(s);
    if (key !== lastLayoutKey) {
      relayout(s);
      lastLayoutKey = key;
    }
  }

  function tick() {
    for (const v of state.videoSources) {
      const t = tiles.get(v.id);
      if (t) t.els.timeLabel.textContent = formatDuration(elapsedMs(v));
    }
  }

  return { render, tick };
}
