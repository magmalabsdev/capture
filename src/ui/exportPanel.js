// Right panel: export settings — single / export all / merge.

import { state, update, notify } from '../state.js';
import { el, clear, fa } from '../util/dom.js';
import { formatBytes, safeName } from '../util/format.js';
import {
  exportAll,
  singleExport,
  mergeExport,
  downloadBlob,
  audioToMp3,
  hasRecording,
} from '../export/exporters.js';

export function createExportPanel(root) {
  function recordedVideos(s) {
    return s.videoSources.filter(hasRecording);
  }
  function recordedAudios(s) {
    return s.audioSources.filter(hasRecording);
  }

  function modeButton(s, mode, label, disabled) {
    return el('button', {
      class: `seg ${s.exportMode === mode ? 'active' : ''}`,
      disabled,
      title: disabled ? 'Not available for the current setup' : '',
      text: label,
      onClick: () => update((st) => { st.exportMode = mode; }),
    });
  }

  function ffStatus(s) {
    const f = s.ffmpeg;
    if (f.status === 'idle') return null;
    const wrap = el('div', { class: `ff-status ${f.status}` });
    wrap.appendChild(el('div', { class: 'ff-msg', text: f.message || f.status }));
    if (f.status === 'running' || f.status === 'loading') {
      const bar = el('div', { class: 'progress' }, [
        el('div', { class: 'progress-fill', style: { width: `${Math.round((f.progress || 0) * 100)}%` } }),
      ]);
      wrap.appendChild(bar);
    }
    return wrap;
  }

  async function runExport(fn) {
    try {
      await fn();
    } catch (e) {
      notify(e.message || 'Export failed.', 'error');
    }
  }

  async function downloadOne(src, btn) {
    try {
      if (src.mediaKind === 'audio') {
        if (btn) { btn.disabled = true; btn.textContent = 'Converting…'; }
        const mp3 = await audioToMp3(src.rec.blob, src.rec.ext);
        downloadBlob(mp3, `${safeName(src.label)}.mp3`);
      } else {
        downloadBlob(src.rec.blob, `${safeName(src.label)}.${src.rec.ext}`);
      }
    } catch (e) {
      notify(e.message || 'Download failed.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Download'; }
    }
  }

  function render(s) {
    clear(root);
    root.appendChild(el('h2', { class: 'panel-title', text: 'Export' }));

    const vids = recordedVideos(s);
    const auds = recordedAudios(s);
    const totalRec = vids.length + auds.length;

    const singleDisabled = state.videoSources.length !== 1;

    root.appendChild(
      el('div', { class: 'segmented' }, [
        modeButton(s, 'single', 'Single', singleDisabled),
        modeButton(s, 'all', 'Export all', false),
        modeButton(s, 'merge', 'Merge', false),
      ])
    );

    if (singleDisabled && s.exportMode === 'single') {
      // fall back so the user isn't stuck on a disabled mode
      update((st) => { st.exportMode = 'all'; });
      return;
    }

    const body = el('div', { class: 'export-body' });

    if (s.exportMode === 'single') body.appendChild(renderSingle(s, auds));
    else if (s.exportMode === 'all') body.appendChild(renderAll(s));
    else body.appendChild(renderMerge(s));

    root.appendChild(body);

    const ff = ffStatus(s);
    if (ff) root.appendChild(ff);

    root.appendChild(
      el('p', { class: 'muted tiny' }, [
        `${totalRec} recorded track${totalRec === 1 ? '' : 's'} ready. `,
        'Combined exports are muxed with ffmpeg.wasm (video stream-copied, audio mixed).',
      ])
    );
  }

  function renderSingle(s, auds) {
    const wrap = el('div', {});
    const video = s.videoSources[0];
    const ready = video && hasRecording(video);
    wrap.appendChild(
      el('p', { class: 'muted' },
        'Combines the single video with all recorded audio tracks into one file.')
    );
    wrap.appendChild(
      el('div', { class: 'summary' }, [
        el('div', {}, `Video: ${video ? video.label : '—'} ${ready ? '✓' : '(not recorded)'}`),
        el('div', {}, `Audio tracks: ${auds.length}`),
      ])
    );
    wrap.appendChild(
      el('button', {
        class: 'btn primary block',
        disabled: !ready,
        text: 'Export combined file',
        onClick: () => runExport(singleExport),
      })
    );
    return wrap;
  }

  function renderAll(s) {
    const wrap = el('div', {});
    const all = [...s.videoSources, ...s.audioSources];
    const recs = all.filter(hasRecording);

    if (!recs.length) {
      wrap.appendChild(el('p', { class: 'muted hint' }, 'Stop a recording to make it available for export.'));
      return wrap;
    }

    const list = el('div', { class: 'export-list' });
    for (const src of recs) {
      const isAudio = src.mediaKind === 'audio';
      const outExt = isAudio ? 'mp3' : src.rec.ext;
      list.appendChild(
        el('div', { class: 'export-item' }, [
          el('div', { class: 'ei-info' }, [
            el('span', { class: 'ei-name', text: src.label }),
            el('span', { class: 'ei-meta', text: `${outExt} · ${formatBytes(src.rec.size)}` }),
          ]),
          el('button', {
            class: 'btn small',
            text: 'Download',
            onClick: (e) => downloadOne(src, e.target),
          }),
        ])
      );
    }
    wrap.appendChild(list);
    wrap.appendChild(
      el('button', {
        class: 'btn primary block',
        text: `Download all (${recs.length}) as .zip`,
        onClick: () => runExport(exportAll),
      })
    );
    return wrap;
  }

  function renderMerge(s) {
    const wrap = el('div', {});
    const vids = recordedVideos(s);
    const auds = recordedAudios(s);

    wrap.appendChild(
      el('p', { class: 'muted' }, 'Assign one or more audio tracks to each video, then export each as its own file.')
    );

    if (!vids.length) {
      wrap.appendChild(el('p', { class: 'muted hint' }, 'No recorded video yet.'));
      return wrap;
    }

    for (const v of vids) {
      const assigned = state.mergeAssignments[v.id] || [];
      const block = el('div', { class: 'merge-block' });
      block.appendChild(
        el('div', { class: 'merge-video' }, [
          el('span', { class: 'mv-icon', html: fa('film') }),
          el('span', { text: v.label }),
        ])
      );
      if (!auds.length) {
        block.appendChild(el('div', { class: 'muted tiny' }, 'No recorded audio to assign.'));
      }
      for (const a of auds) {
        const cb = el('input', {
          type: 'checkbox',
          checked: assigned.includes(a.id),
          onChange: (e) =>
            update((st) => {
              const cur = new Set(st.mergeAssignments[v.id] || []);
              if (e.target.checked) cur.add(a.id);
              else cur.delete(a.id);
              st.mergeAssignments[v.id] = [...cur];
            }),
        });
        block.appendChild(
          el('label', { class: 'check-row tiny' }, [cb, el('span', { text: a.label })])
        );
      }
      wrap.appendChild(block);
    }

    wrap.appendChild(
      el('button', {
        class: 'btn primary block',
        text:
          vids.length === 1
            ? 'Export merged (1 file)'
            : `Export merged (${vids.length} files as .zip)`,
        onClick: () => runExport(mergeExport),
      })
    );
    return wrap;
  }

  return { render };
}
