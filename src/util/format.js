// Formatting helpers.

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** ms -> "M:SS" or "H:MM:SS" */
export function formatDuration(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatRes(w, h) {
  if (!w || !h) return '—';
  return `${w}×${h}`;
}

/** Pick a file extension from a MIME type. */
export function extFromMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('x-matroska')) return 'mkv';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/** Make a label safe for a filename. */
export function safeName(s) {
  return (
    (s || 'track')
      .replace(/[^\w.\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'track'
  );
}
