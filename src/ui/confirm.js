// Lightweight confirmation modal for destructive actions.
//
// Usage:  if (await confirmAction({ title, message, confirmText })) { ... }
// Resolves true on confirm, false on cancel / Esc / backdrop click.

import { el } from '../util/dom.js';

export function confirmAction({
  title = 'Are you sure?',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus) {
        try { prevFocus.focus(); } catch { /* ignore */ }
      }
      resolve(val);
    };

    // Capture keys so a stream hotkey / typing can't leak past the dialog.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      e.stopPropagation();
    };

    const confirmBtn = el('button', {
      class: `btn ${danger ? 'danger' : 'primary'}`, text: confirmText,
      onClick: () => close(true),
    });
    const cancelBtn = el('button', { class: 'btn', text: cancelText, onClick: () => close(false) });

    const dialog = el('div', {
      class: 'confirm-dialog', role: 'alertdialog', 'aria-modal': 'true',
    }, [
      el('h3', { class: 'confirm-title', text: title }),
      message ? el('p', { class: 'confirm-msg', text: message }) : null,
      el('div', { class: 'confirm-actions' }, [cancelBtn, confirmBtn]),
    ]);

    const overlay = el('div', {
      class: 'confirm-overlay',
      onClick: (e) => { if (e.target === overlay) close(false); },
    }, [dialog]);

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    confirmBtn.focus();
  });
}

/** Confirm removing a capture source; notes when its recording is kept. */
export function confirmRemoveSource(source) {
  const recording = source.rec && source.rec.status !== 'idle' &&
    (source.rec.status === 'recording' || source.rec.status === 'paused');
  const kept = source.rec && source.rec.hasData;
  let message = `“${source.label}” will be removed from the session.`;
  if (recording) message = `“${source.label}” is still recording. Removing it stops the recording.`;
  if (kept) message += ' Its footage stays in Downloads until you delete it there.';
  return confirmAction({ title: 'Remove this stream?', message, confirmText: 'Remove' });
}
