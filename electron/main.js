// Electron entry point. Serves the existing static app over a private `app://`
// origin (so ES modules, workers, WASM, IndexedDB and the File System Access
// API all behave exactly as in a browser) inside a bundled Chromium — no system
// webview, no network dependency.

const { app, BrowserWindow, session, protocol, desktopCapturer, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

// Project root inside both dev and the packaged asar (electron/ sits at root).
const APP_ROOT = path.join(__dirname, '..');
const ORIGIN = 'app://capture';
const START_URL = `${ORIGIN}/app/index.html`;

let buildVersion = '';
try { buildVersion = require('./build-version.json').version || ''; } catch { /* dev */ }

// Register `app://` as a standard, secure, fetch-capable origin BEFORE app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon',
  '.map': 'application/json', '.txt': 'text/plain',
};

function serveFromAppRoot() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      // Map the URL path onto APP_ROOT and refuse anything that escapes it.
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const filePath = path.normalize(path.join(APP_ROOT, rel));
      if (!filePath.startsWith(APP_ROOT)) return new Response('Forbidden', { status: 403 });
      const data = await fs.readFile(filePath);
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

function wireSession() {
  const ses = session.defaultSession;

  // Grant the in-app capture permissions (camera / mic / screen).
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'display-capture', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  ses.setPermissionCheckHandler(() => true);

  // navigator.mediaDevices.getDisplayMedia(): use the OS picker where available,
  // else fall back to the primary screen (+ loopback audio off macOS).
  const handler = (request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      if (!sources.length) return callback({});
      const audio = process.platform === 'darwin' ? undefined : 'loopback';
      callback({ video: sources[0], audio });
    }).catch(() => callback({}));
  };
  try {
    ses.setDisplayMediaRequestHandler(handler, { useSystemPicker: true });
  } catch {
    ses.setDisplayMediaRequestHandler(handler);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0d0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      additionalArguments: [`--capture-version=${buildVersion}`],
    },
  });

  // External links (GitHub, Magma Labs) open in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  win.loadURL(START_URL);
  return win;
}

app.whenReady().then(() => {
  serveFromAppRoot();
  wireSession();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
