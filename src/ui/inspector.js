// Left panel: detailed config + live stats for the selected track.

import { state, update, findSource, notify } from '../state.js';
import { el, clear, select, fa } from '../util/dom.js';
import { formatDuration, formatBytes, formatRes } from '../util/format.js';
import { elapsedMs } from '../recorder.js';
import { readLevel } from '../audioMeter.js';
import { timelapseSpeed } from '../export/exporters.js';
import {
  setVideoDevice,
  setAudioDevice,
  applyVideoConstraints,
  applyAudioConstraints,
  recaptureSource,
  removeSource,
  assignHotkey,
} from '../sources.js';
import { bindingFromEvent, hotkeyLabel, sameBinding } from '../util/hotkey.js';
import { confirmAction, confirmRemoveSource } from './confirm.js';

/** Human-readable status including drop/mute/stall/error flags. */
export function statusText(source) {
  if (source.streamEnded) return 'ended';
  if (source.rec.errored) return 'error';
  if (source.stalled) return 'stalled';
  if (source.muted) return 'muted';
  return source.rec.status;
}

const RES_PRESETS = [
  { value: '', label: 'Auto' },
  { value: '3840x2160', label: '2160p (4K)' },
  { value: '2560x1440', label: '1440p' },
  { value: '1920x1080', label: '1080p' },
  { value: '1280x720', label: '720p' },
  { value: '854x480', label: '480p' },
];
const FPS_PRESETS = [
  { value: '', label: 'Auto' },
  { value: '240', label: '240 fps' },
  { value: '120', label: '120 fps' },
  { value: '60', label: '60 fps' },
  { value: '30', label: '30 fps' },
  { value: '24', label: '24 fps' },
];
const VBITRATE = [
  { value: '0', label: 'Auto' },
  { value: '40000000', label: '40 Mbps' },
  { value: '20000000', label: '20 Mbps' },
  { value: '12000000', label: '12 Mbps' },
  { value: '8000000', label: '8 Mbps' },
  { value: '5000000', label: '5 Mbps' },
  { value: '2500000', label: '2.5 Mbps' },
  { value: '1000000', label: '1 Mbps' },
];
const TL_UNITS = [
  { value: 'hour', label: 'hours' },
  { value: 'min', label: 'minutes' },
  { value: 'sec', label: 'seconds' },
];
const ABITRATE = [
  { value: '0', label: 'Auto' },
  { value: '320000', label: '320 kbps' },
  { value: '192000', label: '192 kbps' },
  { value: '128000', label: '128 kbps' },
  { value: '96000', label: '96 kbps' },
];

export function createInspector(root) {
  let liveRefs = {}; // { source, resStat, timeStat, sizeStat, statusStat, levelFill }

  function field(label, control) {
    return el('div', { class: 'field' }, [el('label', { text: label }), control]);
  }

  function statRow(label, value, ref) {
    const v = el('span', { class: 'stat-value', text: value });
    if (ref) liveRefs[ref] = v;
    return el('div', { class: 'stat-row' }, [el('span', { class: 'stat-key', text: label }), v]);
  }

  function busy(source) {
    return source.rec.status === 'recording' || source.rec.status === 'paused';
  }

  function render(s) {
    liveRefs = {};
    clear(root);

    const source = findSource(s.selectedId);
    root.appendChild(el('h2', { class: 'panel-title', text: 'Inspector' }));

    if (!source) {
      root.appendChild(
        el('p', { class: 'muted hint' }, 'Click a video or audio track to inspect and configure it.')
      );
      return;
    }

    const locked = busy(source);

    // Name
    const nameInput = el('input', {
      type: 'text', class: 'text-input', value: source.label,
      onChange: (e) => update(() => { source.label = e.target.value || source.label; }),
    });
    root.appendChild(field('Name', nameInput));

    root.appendChild(
      el('div', { class: 'kind-chip' }, `${source.mediaKind} · ${source.kind}`)
    );

    if (source.mediaKind === 'video') renderVideo(source, locked);
    else renderAudio(source, locked);

    // Live stats
    const stats = el('div', { class: 'stats' });
    if (source.mediaKind === 'video') {
      const st = source.settings || {};
      stats.appendChild(
        statRow('Resolution', st.width ? formatRes(st.width, st.height) : '—', 'resStat')
      );
      stats.appendChild(
        statRow('Frame rate', st.frameRate ? `${Math.round(st.frameRate)} fps` : '—')
      );
    } else {
      stats.appendChild(statRow('Sample rate', source.settings.sampleRate ? `${source.settings.sampleRate} Hz` : '—'));
      const levelFill = el('div', { class: 'meter-fill' });
      liveRefs.levelFill = levelFill;
      stats.appendChild(
        el('div', { class: 'stat-row' }, [
          el('span', { class: 'stat-key', text: 'Level' }),
          el('div', { class: 'meter meter-sm' }, [levelFill]),
        ])
      );
    }
    stats.appendChild(statRow('Status', statusText(source), 'statusStat'));
    stats.appendChild(statRow('Elapsed', formatDuration(elapsedMs(source)), 'timeStat'));
    stats.appendChild(
      statRow('Recorded', source.rec.hasData ? formatBytes(source.rec.bytes) : '—', 'sizeStat')
    );
    stats.appendChild(statRow('Codec', source.rec.mimeType || '—'));
    root.appendChild(el('h3', { class: 'sub-title', text: 'Live stats' }));
    root.appendChild(stats);

    if (source.streamEnded) {
      root.appendChild(
        el('button', {
          class: 'btn primary block',
          html: `${fa('rotate-right')}<span>Re-capture source</span>`,
          onClick: (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            recaptureSource(source)
              .catch((err) => notify(err.message || 'Re-capture failed.', 'error'))
              .finally(() => { btn.disabled = false; });
          },
        })
      );
    }

    root.appendChild(
      el('button', {
        class: 'btn danger block', text: 'Remove this track',
        onClick: async () => { if (await confirmRemoveSource(source)) removeSource(source.id); },
      })
    );

    liveRefs.source = source;
  }

  function renderVideo(source, locked) {
    // Device (cameras only)
    if (source.kind === 'camera') {
      const cams = state.devices.cameras;
      const opts = cams.length
        ? cams.map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` }))
        : [{ value: source.deviceId || '', label: source.label }];
      const sel = select(
        {
          class: 'select', disabled: locked,
          onChange: (e) => setVideoDevice(source, e.target.value).catch(() => {}),
        },
        opts,
        source.deviceId
      );
      root.appendChild(field('Camera device', sel));
    }

    // Pre-select from the user's chosen target, not the negotiated settings.
    const resVal = source.targetW && source.targetH ? `${source.targetW}x${source.targetH}` : '';
    const resSel = select(
      {
        class: 'select', disabled: locked,
        onChange: (e) => {
          const [w, h] = e.target.value.split('x').map(Number);
          source.targetW = w || 0;
          source.targetH = h || 0;
          applyVideoConstraints(source, { width: w, height: h });
        },
      },
      RES_PRESETS,
      RES_PRESETS.find((p) => p.value === resVal) ? resVal : ''
    );
    root.appendChild(field('Target resolution', resSel));

    const fpsSel = select(
      {
        class: 'select', disabled: locked,
        onChange: (e) => {
          source.targetFps = Number(e.target.value) || 0;
          applyVideoConstraints(source, { frameRate: source.targetFps });
        },
      },
      FPS_PRESETS,
      String(source.targetFps || '')
    );
    root.appendChild(field('Frame rate', fpsSel));

    if (source.targetFps >= 120) {
      const tall = (source.settings.height || 0) > 1080 || (source.targetH || 0) > 1080;
      root.appendChild(
        el('p', { class: 'muted tiny' },
          `High frame rates (up to 240 fps) need a resolution of 1080p or lower${tall ? ' — lower the resolution.' : ' and a capable device.'}`)
      );
    }

    const brSel = select(
      {
        class: 'select', disabled: locked,
        onChange: (e) => update(() => { source.bitrate = Number(e.target.value); }),
      },
      VBITRATE,
      String(source.bitrate || 0)
    );
    root.appendChild(field('Recording bitrate', brSel));

    const mirror = el('input', {
      type: 'checkbox', checked: !!source.mirror,
      onChange: (e) => update(() => { source.mirror = e.target.checked; }),
    });
    root.appendChild(
      el('label', { class: 'check-row' }, [mirror, el('span', { text: 'Mirror preview' })])
    );

    renderHotkey(source);
    renderTimelapse(source);
  }

  // Speaker-view hotkey: a button that captures the next chord, plus a clear (×).
  function renderHotkey(source) {
    const btn = el('button', { type: 'button', class: 'btn small hotkey-btn' });
    const setIdle = () => {
      btn.classList.remove('listening');
      btn.textContent = source.hotkey ? hotkeyLabel(source.hotkey) : 'Set hotkey…';
    };

    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { stop(); return; }
      const binding = bindingFromEvent(e);
      if (!binding) return; // wait for a non-modifier key
      stop();
      // Confirm before stealing a chord that another stream already uses.
      const owner = state.videoSources.find((v) => v !== source && sameBinding(v.hotkey, binding));
      if (owner) {
        const ok = await confirmAction({
          title: 'Reassign hotkey?',
          message: `${hotkeyLabel(binding)} is already assigned to “${owner.label}”. Reassign it to “${source.label}”?`,
          confirmText: 'Reassign',
        });
        if (!ok) return;
      }
      assignHotkey(source, binding); // one chord ↔ one stream (clears any other)
    };
    const stop = () => {
      document.body.removeAttribute('data-hotkey-capture');
      document.removeEventListener('keydown', onKey, true);
      setIdle();
    };
    btn.onclick = () => {
      if (btn.classList.contains('listening')) { stop(); return; }
      btn.classList.add('listening');
      btn.textContent = 'Press a key…';
      document.body.dataset.hotkeyCapture = '1';
      document.addEventListener('keydown', onKey, true);
    };
    setIdle();

    const row = el('div', { class: 'hotkey-row' }, [btn]);
    if (source.hotkey) {
      row.appendChild(
        el('button', {
          type: 'button', class: 'btn small ghost hotkey-clear', title: 'Clear hotkey',
          html: fa('xmark'),
          onClick: () => assignHotkey(source, null),
        })
      );
    }
    root.appendChild(field('Speaker hotkey', row));
    root.appendChild(
      el('p', { class: 'muted tiny' }, 'Press this key anywhere to jump this stream into speaker view.')
    );
  }

  function renderTimelapse(source) {
    const tl = source.timelapse;
    root.appendChild(el('h3', { class: 'sub-title', text: 'Time-lapse' }));

    const modeSel = select(
      {
        class: 'select',
        onChange: (e) => update(() => { source.timelapse.mode = e.target.value; }),
      },
      [
        { value: 'off', label: 'Off' },
        { value: 'static', label: 'Static (constant speed)' },
        { value: 'dynamic', label: 'Fit to length' },
      ],
      tl.mode
    );
    root.appendChild(field('Mode', modeSel));

    const numInput = (val, onCommit) =>
      el('input', {
        type: 'number', class: 'input-num', min: '0', step: 'any', value: String(val),
        onChange: (e) => update(() => onCommit(parseFloat(e.target.value) || 0)),
      });
    const unitSel = (val, onCommit) =>
      select({ class: 'select sel-inline', onChange: (e) => update(() => onCommit(e.target.value)) }, TL_UNITS, val);

    if (tl.mode === 'static') {
      root.appendChild(
        el('div', { class: 'field' }, [
          el('label', { text: 'Compress' }),
          el('div', { class: 'tl-row' }, [
            numInput(tl.fromVal, (v) => { source.timelapse.fromVal = v; }),
            unitSel(tl.fromUnit, (v) => { source.timelapse.fromUnit = v; }),
            el('span', { class: 'tl-arrow', text: '→' }),
            numInput(tl.toVal, (v) => { source.timelapse.toVal = v; }),
            unitSel(tl.toUnit, (v) => { source.timelapse.toUnit = v; }),
          ]),
        ])
      );
    } else if (tl.mode === 'dynamic') {
      root.appendChild(
        el('div', { class: 'field' }, [
          el('label', { text: 'Target length' }),
          el('div', { class: 'tl-row' }, [
            numInput(tl.targetVal, (v) => { source.timelapse.targetVal = v; }),
            unitSel(tl.targetUnit, (v) => { source.timelapse.targetUnit = v; }),
          ]),
        ])
      );
    }

    if (tl.mode !== 'off') {
      const speed = timelapseSpeed(source, elapsedMs(source));
      const speedTxt = speed > 1 ? `≈ ${speed >= 10 ? Math.round(speed) : speed.toFixed(1)}× faster` : speed < 1 ? `≈ ${(1 / speed).toFixed(1)}× slower` : '—';
      const note =
        tl.mode === 'dynamic' && source.rec.status !== 'stopped'
          ? 'Speed is computed from the final recorded length at export.'
          : `${speedTxt} · audio sped to match · re-encoded on export (slower).`;
      root.appendChild(el('p', { class: 'muted tiny', text: note }));
    }
  }

  function renderAudio(source, locked) {
    if (source.kind === 'mic') {
      const mics = state.devices.mics;
      const opts = mics.length
        ? mics.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
        : [{ value: source.deviceId || '', label: source.label }];
      const sel = select(
        {
          class: 'select', disabled: locked,
          onChange: (e) => setAudioDevice(source, e.target.value).catch(() => {}),
        },
        opts,
        source.deviceId
      );
      root.appendChild(field('Microphone device', sel));
    }

    // Echo cancellation / noise suppression / AGC are mic-only processing —
    // desktop audio comes from getDisplayMedia, not a getUserMedia device, so
    // it can't be re-acquired with different processing flags.
    if (source.kind === 'mic') {
      const st = source.settings || {};
      const toggles = [
        ['echoCancellation', 'Echo cancellation'],
        ['noiseSuppression', 'Noise suppression'],
        ['autoGainControl', 'Auto gain control'],
      ];
      for (const [key, label] of toggles) {
        const cb = el('input', {
          type: 'checkbox', checked: !!st[key], disabled: locked,
          onChange: (e) => applyAudioConstraints(source, { [key]: e.target.checked }),
        });
        root.appendChild(el('label', { class: 'check-row' }, [cb, el('span', { text: label })]));
      }
    }

    const brSel = select(
      {
        class: 'select', disabled: locked,
        onChange: (e) => update(() => { source.bitrate = Number(e.target.value); }),
      },
      ABITRATE,
      String(source.bitrate || 0)
    );
    root.appendChild(field('Recording bitrate', brSel));
  }

  // Live numeric/meter updates without rebuilding the form.
  function tick() {
    const s = liveRefs.source;
    if (!s) return;
    if (liveRefs.timeStat) liveRefs.timeStat.textContent = formatDuration(elapsedMs(s));
    if (liveRefs.statusStat) liveRefs.statusStat.textContent = statusText(s);
    if (liveRefs.sizeStat && s.rec.hasData) liveRefs.sizeStat.textContent = formatBytes(s.rec.bytes);
    if (liveRefs.resStat && s.settings && s.settings.width) {
      liveRefs.resStat.textContent = formatRes(s.settings.width, s.settings.height);
    }
  }

  function meter() {
    const s = liveRefs.source;
    if (s && s.mediaKind === 'audio' && liveRefs.levelFill) {
      liveRefs.levelFill.style.width = `${Math.round(readLevel(s) * 100)}%`;
    }
  }

  return { render, tick, meter };
}
