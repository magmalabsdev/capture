// Download destination management.
//
// With the File System Access API (Chromium) the user can pick a folder and we
// write exports straight into it. The handle is persisted so it survives reload
// (permission may need re-granting). The folder is watched: if it disappears
// (e.g. a removable drive is ejected) we warn and fall back to browser
// downloads so nothing is lost.

import { state, update, notify } from './state.js';
import { kvGet, kvPut, kvDelete } from './util/idb.js';

const KV_KEY = 'downloadDir';
const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

let dirHandle = null;
let watchTimer = null;

function setDL(patch) {
  update((s) => Object.assign(s.download, patch));
}

function browserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Restore a previously chosen folder (re-permission may be required). */
export async function initDownload() {
  setDL({ supported });
  if (!supported) return;
  try {
    const saved = await kvGet(KV_KEY);
    if (saved && saved.handle) {
      dirHandle = saved.handle;
      const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        setDL({ mode: 'folder', name: dirHandle.name, available: true, needsReconnect: false });
        startWatch();
      } else {
        setDL({ mode: 'folder', name: dirHandle.name, available: true, needsReconnect: true });
      }
    }
  } catch {
    /* ignore */
  }
}

export async function chooseDownloadDir() {
  if (!supported) return;
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'capture-downloads' });
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    notify('Folder permission denied.', 'warn');
    return;
  }
  dirHandle = handle;
  try {
    await kvPut(KV_KEY, { handle });
  } catch {
    /* ignore */
  }
  setDL({ mode: 'folder', name: handle.name, available: true, needsReconnect: false });
  startWatch();
  notify(`Saving downloads to “${handle.name}”.`, 'info');
}

export async function reconnectDownloadDir() {
  if (!dirHandle) return;
  const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
  if (perm === 'granted') {
    setDL({ needsReconnect: false, available: true });
    startWatch();
  } else {
    notify('Folder permission denied.', 'warn');
  }
}

export async function useBrowserDownloads() {
  stopWatch();
  dirHandle = null;
  try {
    await kvDelete(KV_KEY);
  } catch {
    /* ignore */
  }
  setDL({ mode: 'browser', name: '', available: true, needsReconnect: false });
}

/**
 * Save a file to the chosen folder, or fall back to a browser download. If the
 * folder write fails (volume removed mid-export), warns and still downloads.
 */
export async function saveFile(blob, filename) {
  const d = state.download;
  if (dirHandle && d.mode === 'folder' && !d.needsReconnect) {
    try {
      const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('permission');
      const fh = await dirHandle.getFileHandle(filename, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      if (!d.available) setDL({ available: true });
      return;
    } catch {
      setDL({ available: false });
      notify(`Couldn't save to “${d.name}” (drive removed?). Using browser downloads.`, 'warn', { sound: true });
      // fall through to browser download so the file isn't lost
    }
  }
  browserDownload(blob, filename);
}

/* ----------------------- removable-volume watch ---------------------- */

function startWatch() {
  stopWatch();
  if (dirHandle) watchTimer = setInterval(checkVolume, 5000);
}
function stopWatch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

async function checkVolume() {
  if (!dirHandle || state.download.needsReconnect) return;
  let ok = true;
  try {
    const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') ok = false;
    else {
      // Touch the volume — iterating throws if it has been unmounted.
      await dirHandle.values().next();
    }
  } catch {
    ok = false;
  }
  if (!ok && state.download.available) {
    setDL({ available: false });
    notify(`Download folder “${state.download.name}” is unavailable — was the drive removed?`, 'warn', { sound: true });
  } else if (ok && !state.download.available) {
    setDL({ available: true });
    notify(`Download folder “${state.download.name}” is back.`, 'info');
  }
}
