// Right panel: export settings — single / export all / merge.

import { state, update, notify } from '../state.js';
import { el, clear, fa } from '../util/dom.js';
import { formatBytes, safeName } from '../util/format.js';
import { configurePeriodic } from '../periodicExport.js';
import {
  exportAll,
  singleExport,
  mergeExport,
  audioToMp3OrOriginal,
  exportableVideo,
  hasRecording,
  getRecordingBlob,
  exportRecovered,
  discardRecovered,
} from '../export/exporters.js';
import {
  saveFile,
  chooseDownloadDir,
  useBrowserDownloads,
  reconnectDownloadDir,
} from '../download.js';
import { confirmAction } from './confirm.js';

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

  // Like runExport but ignores the picker being cancelled.
  async function safeAction(fn) {
    try {
      await fn();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      notify(e.message || 'Action failed.', 'error');
    }
  }

  async function downloadOne(src, btn) {
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
      const res = await getRecordingBlob(src); // reassembles all segments from storage
      if (!res || !res.blob.size) throw new Error('No readable data for this track.');
      if (src.mediaKind === 'audio') {
        if (btn) btn.textContent = 'Converting…';
        const a = await audioToMp3OrOriginal(res.blob, res.ext);
        await saveFile(a.blob, `${safeName(src.label)}.${a.ext}`);
      } else {
        if (btn) btn.textContent = 'Repackaging…';
        const v = await exportableVideo(res);
        await saveFile(v.blob, `${safeName(src.label)}.${v.ext}`);
      }
      if (res.partial) notify(`${src.label}: some footage was unreadable and skipped.`, 'warn');
    } catch (e) {
      notify(e.message || 'Download failed.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Download'; }
    }
  }

  function render(s) {
    clear(root);
    root.appendChild(el('h2', { class: 'panel-title', text: 'Export' }));

    if (s.recovery && s.recovery.length) root.appendChild(renderRecovery(s));
    if (s.removed && s.removed.length) root.appendChild(renderRemoved(s));

    root.appendChild(renderDownloadLocation(s));

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

    root.appendChild(renderPeriodic(s));
  }

  function renderRecovery(s) {
    const wrap = el('div', { class: 'recovery' });
    wrap.appendChild(
      el('div', { class: 'recovery-head' }, [
        el('span', { html: fa('triangle-exclamation') }),
        el('strong', { text: `Recovered ${s.recovery.length} unfinished recording${s.recovery.length === 1 ? '' : 's'}` }),
      ])
    );
    wrap.appendChild(
      el('p', { class: 'muted tiny' }, 'From a previous session that ended unexpectedly.')
    );
    for (const meta of s.recovery) {
      wrap.appendChild(
        el('div', { class: 'export-item' }, [
          el('div', { class: 'ei-info' }, [
            el('span', { class: 'ei-name', text: meta.label || 'recording' }),
            el('span', { class: 'ei-meta', text: `${meta.ext || '?'} · ${formatBytes(meta.bytes || 0)}` }),
          ]),
          el('div', { class: 'recovery-actions' }, [
            el('button', {
              class: 'btn small', text: 'Export',
              onClick: () => runExport(() => exportRecovered(meta)),
            }),
            el('button', {
              class: 'btn small danger', text: 'Discard',
              onClick: async () => {
                const ok = await confirmAction({
                  title: 'Discard recording?',
                  message: `Permanently delete the recovered “${meta.label || 'recording'}”? This can’t be undone.`,
                  confirmText: 'Discard',
                });
                if (!ok) return;
                await discardRecovered(meta.sourceId);
                update((st) => { st.recovery = st.recovery.filter((m) => m.sourceId !== meta.sourceId); });
              },
            }),
          ]),
        ])
      );
    }
    return wrap;
  }

  // Recordings whose source stream was deleted — kept (and highlighted) here so
  // the footage can still be downloaded, until the user deletes it explicitly.
  function renderRemoved(s) {
    const wrap = el('div', { class: 'removed-tracks' });
    wrap.appendChild(
      el('div', { class: 'removed-head' }, [
        el('span', { html: fa('trash-can-arrow-up') }),
        el('strong', { text: `${s.removed.length} removed track${s.removed.length === 1 ? '' : 's'} kept for download` }),
      ])
    );
    wrap.appendChild(
      el('p', { class: 'muted tiny' }, 'These streams were deleted, but their recordings stay here until you delete them.')
    );
    for (const src of s.removed) {
      const outExt = src.mediaKind === 'audio' ? 'mp3' : src.rec.ext;
      wrap.appendChild(
        el('div', { class: 'export-item removed' }, [
          el('div', { class: 'ei-info' }, [
            el('span', { class: 'ei-name' }, [
              src.label,
              el('span', { class: 'removed-badge', text: 'removed' }),
            ]),
            el('span', { class: 'ei-meta', text: `${outExt} · ${formatBytes(src.rec.bytes || src.rec.size)}` }),
          ]),
          el('div', { class: 'recovery-actions' }, [
            el('button', {
              class: 'btn small', text: 'Download',
              onClick: (e) => downloadOne(src, e.target),
            }),
            el('button', {
              class: 'btn small danger', text: 'Delete',
              onClick: async () => {
                const ok = await confirmAction({
                  title: 'Delete recording?',
                  message: `Permanently delete “${src.label}”? This can’t be undone.`,
                  confirmText: 'Delete',
                });
                if (!ok) return;
                await discardRecovered(src.id); // drop durable data for this id
                update((st) => { st.removed = st.removed.filter((r) => r.id !== src.id); });
              },
            }),
          ]),
        ])
      );
    }
    return wrap;
  }

  function renderDownloadLocation(s) {
    const d = s.download;
    const wrap = el('div', { class: 'download-loc' });
    wrap.appendChild(el('h3', { class: 'sub-title', text: 'Download location' }));

    if (!d.supported) {
      wrap.appendChild(
        el('p', { class: 'muted tiny' },
          'Choosing a folder needs Chrome or Edge — files go to your browser’s Downloads.')
      );
      return wrap;
    }

    wrap.appendChild(
      el('div', { class: 'dl-row' }, [
        el('span', { class: 'dl-icon', html: fa(d.mode === 'folder' ? 'folder' : 'download') }),
        el('span', { class: 'dl-name', text: d.mode === 'folder' ? d.name : 'Browser downloads' }),
      ])
    );

    if (d.mode === 'folder' && d.needsReconnect) {
      wrap.appendChild(
        el('button', {
          class: 'btn small', html: `${fa('rotate-right')}<span>Reconnect folder</span>`,
          onClick: () => safeAction(reconnectDownloadDir),
        })
      );
    }
    if (d.mode === 'folder' && !d.available) {
      wrap.appendChild(
        el('p', { class: 'dl-warn' }, [
          el('span', { html: fa('triangle-exclamation') }),
          el('span', { text: ` “${d.name}” is unavailable — drive removed? Exports fall back to browser downloads.` }),
        ])
      );
    }

    const actions = el('div', { class: 'dl-actions' }, [
      el('button', {
        class: 'btn small',
        html: `${fa('folder-open')}<span>${d.mode === 'folder' ? 'Change folder' : 'Choose folder'}</span>`,
        onClick: () => safeAction(chooseDownloadDir),
      }),
    ]);
    if (d.mode === 'folder') {
      actions.appendChild(
        el('button', { class: 'btn small', text: 'Use browser downloads', onClick: () => safeAction(useBrowserDownloads) })
      );
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function renderPeriodic(s) {
    const p = s.periodic;
    const wrap = el('div', { class: 'auto-export' });
    wrap.appendChild(el('h3', { class: 'sub-title', text: 'Auto-export' }));

    const enable = el('input', {
      type: 'checkbox',
      checked: p.enabled,
      onChange: (e) => configurePeriodic({ enabled: e.target.checked }),
    });
    wrap.appendChild(
      el('label', { class: 'check-row' }, [
        enable,
        el('span', { html: `${fa('clock-rotate-left')} <span>Export a clip periodically</span>` }),
      ])
    );

    // Interval + live status only exist while enabled — keeping them out of the
    // DOM when off avoids the ticker fighting a re-render over the same element.
    if (p.enabled) {
      const minutes = el('input', {
        type: 'number',
        class: 'input-num',
        min: '0.5',
        step: '0.5',
        value: String(+(p.intervalSec / 60).toFixed(2)),
        title: 'Minutes between auto-exports',
        onChange: (e) => {
          const mins = parseFloat(e.target.value);
          if (!mins || mins <= 0) configurePeriodic({ enabled: false });
          else configurePeriodic({ enabled: true, intervalSec: Math.round(mins * 60) });
        },
      });
      wrap.appendChild(
        el('div', { class: 'auto-export-row' }, [
          el('span', { class: 'auto-export-label', text: 'Every' }),
          minutes,
          el('span', { class: 'auto-export-unit', text: 'min' }),
        ])
      );

      const status = el('p', { class: 'muted tiny', dataset: { next: '1' } });
      wrap.appendChild(status);
    }

    wrap.appendChild(
      el('p', { class: 'muted tiny' },
        'Keeps recording running and downloads a zip clip each interval (audio as MP3). Final footage is in the next manual export.')
    );
    return wrap;
  }

  // Live countdown + clip count (updated by the app ticker). The status element
  // is only present while auto-export is enabled.
  function tick() {
    const el2 = root.querySelector('[data-next]');
    if (!el2) return;
    const p = state.periodic;
    const secs = Math.max(0, Math.round((p.nextAt - Date.now()) / 1000));
    const recording = [...state.videoSources, ...state.audioSources].some(
      (x) => x.rec.status === 'recording'
    );
    const left = recording ? `next clip in ${secs}s` : 'waiting for a recording to start';
    el2.textContent = `${p.count} clip${p.count === 1 ? '' : 's'} exported · ${left}.`;
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
            el('span', { class: 'ei-meta', text: `${outExt} · ${formatBytes(src.rec.bytes || src.rec.size)}` }),
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

  return { render, tick };
}
