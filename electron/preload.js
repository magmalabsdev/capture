// Minimal, safe bridge. Exposes the build-time version so the renderer never
// has to hit the network to compute it (keeps the desktop app fully offline).

const { contextBridge } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--capture-version='));
const version = arg ? arg.slice('--capture-version='.length) : '';

try {
  contextBridge.exposeInMainWorld('__CAPTURE_VERSION__', version);
} catch {
  /* contextIsolation disabled — ignore */
}
