// Settings modal: appearance (light/dark) + high-contrast toggle.

import { state, update } from '../state.js';
import { el, clear, fa } from '../util/dom.js';

export function createSettingsPanel(root) {
  function close() {
    update((s) => { s.settingsOpen = false; });
  }

  function themeSeg(s) {
    const btn = (label, value, icon) =>
      el('button', {
        class: `seg ${s.theme === value ? 'active' : ''}`,
        html: `${fa(icon)}<span>${label}</span>`,
        onClick: () => update((st) => { st.theme = value; }),
      });
    return el('div', { class: 'segmented' }, [
      btn('Light', 'light', 'sun'),
      btn('Dark', 'dark', 'moon'),
    ]);
  }

  function render(s) {
    clear(root);
    if (!s.settingsOpen) return;

    const overlay = el('div', {
      class: 'modal-overlay',
      onClick: (e) => { if (e.target === overlay) close(); },
    });

    const hc = el('input', {
      type: 'checkbox',
      checked: s.contrast === 'high',
      onChange: (e) => update((st) => { st.contrast = e.target.checked ? 'high' : 'normal'; }),
    });

    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'modal-head' }, [
        el('h2', { class: 'panel-title', text: 'Settings' }),
        el('button', { class: 'btn small', title: 'Close', html: fa('xmark'), onClick: close }),
      ]),
      el('div', { class: 'modal-body' }, [
        el('div', { class: 'field' }, [el('label', { text: 'Appearance' }), themeSeg(s)]),
        el('label', { class: 'check-row' }, [
          hc,
          el('span', { text: 'High contrast (invert buttons & inputs)' }),
        ]),
        el('p', { class: 'muted tiny' }, 'High contrast flips controls to your text color for maximum separation from the background.'),
      ]),
    ]);

    overlay.appendChild(modal);
    root.appendChild(overlay);
  }

  // Close on Escape while open.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.settingsOpen) close();
  });

  return { render };
}
