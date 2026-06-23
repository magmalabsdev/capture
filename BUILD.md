# Building the Capture desktop app

Capture ships as a native desktop app via **Electron** (bundled Chromium, so
`getDisplayMedia`, `MediaRecorder`, the File System Access API, Web Workers and
`ffmpeg.wasm` all work identically to the browser). The app is **fully offline** —
all fonts and Font Awesome are vendored under `vendor/`, ffmpeg.wasm is local,
and the version number is baked in at build time (no network calls at runtime).

## Prerequisites
- Node.js 18+ and npm
- `npm install` (installs `electron` + `electron-builder`)

## Run in development
```bash
npm start          # generates the version, launches Electron
```

> If your shell exports `ELECTRON_RUN_AS_NODE=1`, unset it first
> (`unset ELECTRON_RUN_AS_NODE`) or Electron will run as plain Node.

## Build installers / executables
Each command writes artifacts to `dist/`:

```bash
npm run dist:mac     # → dist/*.dmg, *.zip            (run on macOS)
npm run dist:win     # → dist/*.exe (NSIS + portable)  (run on Windows)
npm run dist:linux   # → dist/*.AppImage, *.deb        (run on Linux)
npm run dist         # build for the current OS
```

electron-builder can only reliably build for the OS it runs on (Windows needs
Wine, Linux needs its toolchain). To produce **all three** at once, use the
included GitHub Actions workflow:

- `.github/workflows/desktop-build.yml` builds macOS, Windows and Linux on their
  native runners and uploads the executables as artifacts. Trigger it from the
  Actions tab ("Desktop builds" → Run workflow) or by pushing a `v*` tag.

## What's bundled (no web dependencies)
| Dependency        | Was                              | Now (local)                          |
|-------------------|----------------------------------|--------------------------------------|
| Font Awesome 6.5  | cdnjs                            | `vendor/fontawesome/`                |
| Space Mono        | Google Fonts                     | `vendor/fonts/spacemono/`            |
| Open Sauce Two    | jsdelivr (dead link)             | `vendor/fonts/opensauce/`            |
| ffmpeg.wasm       | already local                    | `vendor/ffmpeg/`                     |
| Version number    | GitHub REST API at runtime       | baked at build (`electron/build-version.json`) |

The renderer is served from a private `app://capture` origin by the Electron
main process (`electron/main.js`), giving ES modules, workers, WASM and a stable
storage origin without a local web server.

## Notes
- **Code signing:** builds are unsigned by default. On macOS users may need to
  right-click → Open the first time (Gatekeeper). Add an Apple Developer ID +
  `CSC_LINK`/`CSC_KEY_PASSWORD` (and notarization creds) to sign; on Windows add
  a code-signing cert. Camera/mic/screen entitlements are in
  `build/entitlements.mac.plist`.
- **Screen capture:** Electron uses the OS picker where available
  (`useSystemPicker`), otherwise falls back to the primary screen. On macOS the
  user must grant Screen Recording permission in System Settings → Privacy.
  System (loopback) audio capture is enabled on Windows/Linux; macOS doesn't
  expose it.
