// Draggable gutters that resize the four bars (top toolbar, left inspector,
// right export, bottom audio bar). Sizes are persisted to localStorage and
// reset on double-click.

const STORE_KEY = 'capture.layout.v1';

const CSS_VAR = {
  top: '--top-h',
  left: '--left-w',
  right: '--right-w',
  bottom: '--bottom-h',
};

// [min, max] in px
const LIMITS = {
  top: [44, 280],
  left: [180, 680],
  right: [180, 680],
  bottom: [90, 520],
};

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));

function loadSizes() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSizes(sizes) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sizes));
  } catch {
    /* ignore (private mode, etc.) */
  }
}

export function initResizers() {
  const root = document.documentElement;
  const app = document.querySelector('.app');
  const main = document.querySelector('.main');
  if (!app || !main) return;

  const sizes = loadSizes();
  for (const [dir, px] of Object.entries(sizes)) {
    if (px && CSS_VAR[dir]) root.style.setProperty(CSS_VAR[dir], `${px}px`);
  }

  function sizeFor(dir, ev) {
    const ar = app.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    if (dir === 'left') return ev.clientX - mr.left;
    if (dir === 'right') return mr.right - ev.clientX;
    if (dir === 'top') return ev.clientY - ar.top;
    return ar.bottom - ev.clientY; // bottom
  }

  for (const gutter of document.querySelectorAll('.gutter[data-resize]')) {
    const dir = gutter.dataset.resize;
    if (!CSS_VAR[dir]) continue;

    gutter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      gutter.setPointerCapture(e.pointerId);
      gutter.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = dir === 'top' || dir === 'bottom' ? 'row-resize' : 'col-resize';

      const onMove = (ev) => {
        const px = Math.round(clamp(sizeFor(dir, ev), LIMITS[dir]));
        root.style.setProperty(CSS_VAR[dir], `${px}px`);
        sizes[dir] = px;
      };
      const onUp = () => {
        gutter.classList.remove('dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        gutter.removeEventListener('pointermove', onMove);
        gutter.removeEventListener('pointerup', onUp);
        gutter.removeEventListener('lostpointercapture', onUp);
        saveSizes(sizes);
      };

      gutter.addEventListener('pointermove', onMove);
      gutter.addEventListener('pointerup', onUp);
      gutter.addEventListener('lostpointercapture', onUp);
    });

    // Double-click resets this bar to its default.
    gutter.addEventListener('dblclick', () => {
      root.style.removeProperty(CSS_VAR[dir]);
      delete sizes[dir];
      saveSizes(sizes);
    });
  }
}
