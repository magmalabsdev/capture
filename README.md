# Capture — multi-stream screen & audio recorder

A zero-build **static site** that records **multiple video streams and multiple
audio streams independently and simultaneously**, all in the browser. Each
source is its own recorder; nothing is uploaded anywhere.

## Run it

Capture needs an `http(s)` origin — the browser blocks camera/screen capture and
ffmpeg.wasm from `file://`. Use the bundled dev server:

```bash
python3 serve.py            # http://localhost:8000
```

Then open <http://localhost:8000> in a recent **Chrome or Edge** (best support
for screen + system-audio capture). Firefox works for camera/mic/screen;
Safari has limited screen/system-audio support. The root page is the landing
page; the recorder itself lives at <http://localhost:8000/app/>.

Any static host works too (GitHub Pages, Netlify, S3, …) — just serve the folder
over HTTPS.

## What it can record

| Video                         | How                                              |
| ----------------------------- | ------------------------------------------------ |
| Webcam / external camera      | **＋ Camera** (pick device from the ▾ menu)       |
| Laptop screen / monitor / tab | **＋ Screen** (choose in the OS picker)           |
| Connected phone               | Use it as a webcam (Continuity Camera / USB),    |
|                               | then **＋ Camera**                                |

| Audio                         | How                                              |
| ----------------------------- | ------------------------------------------------ |
| Laptop / external microphone  | **＋ Mic** (pick device from the ▾ menu)          |
| Laptop / desktop audio        | Included automatically with **＋ Screen** as a    |
|                               | *separate track* when you tick "Share audio" in  |
|                               | the picker (Chrome/Edge only)                    |

**Quick start** sets up the default configuration in one click: **main display +
desktop audio + microphone** (each as an independent track).

## Layout

- **Center** — all video tracks in a Zoom-style **Grid** or **Speaker** view
  (toggle top-right). Each tile shows resolution, fps, elapsed time and
  recording state, with start / pause-resume / finish controls in the corner.
  A paused track turns **red**. In speaker view one video is enlarged; click ⛶
  on any tile (or use **Set as main**) to promote it.
- **Bottom bar** — every audio track in a single line, each with a live level
  meter and its own record controls.
- **Left** — inspector for the selected track (click any track to select):
  device, resolution / frame-rate, mic processing, bitrate, mirror, live stats.
- **Right** — export settings.

## Recording

Each track records on its own `MediaRecorder`, so streams are fully independent
— start/pause/finish any track at any time, or use **Record all / Pause all /
Stop all** in the toolbar. Output is **MP4 (H.264/AAC) where the browser
supports it**, otherwise **WebM (VP9/Opus)**.

### Reliability (long sessions)

- **Durable storage** — chunks stream to **IndexedDB** as they're captured, so a
  long session survives memory/disk-blob eviction (the usual cause of "could not
  be read" on export) and even a tab crash.
- **Crash recovery** — if a session ends unexpectedly, the next load shows a
  recovery banner in the Export panel to download or discard the leftover
  recordings.
- **Auto-segmenting** — recordings are checkpointed into 5-minute segments and
  losslessly concatenated at export, so no single corrupt/evicted chunk can sink
  a whole take.
- **Drop detection + recovery** — a muted/ended track or a stalled recorder is
  surfaced immediately (and footage preserved); use **Re-capture** in the
  inspector to resume a dropped screen/desktop-audio source into the same take.
- **Graceful export** — if one track is unreadable, the others still export with
  a precise warning about what was skipped.

## Export modes

- **Single** — only when exactly one video source exists: combines that video
  with **all** recorded audio tracks into one file (audio mixed down).
- **Export all** — downloads every recorded video and audio independently.
- **Merge** — manually assign one or more audio tracks to each video, then
  export each video as its own combined file.

Combined exports are muxed with **ffmpeg.wasm**: the video stream is
**copied** (no re-encode / no quality loss) and audio is mixed and encoded
(AAC for MP4, Opus for WebM). The output container follows the recorded video
(MP4 → MP4, WebM → WebM).

## Project layout

```
index.html              landing page (hero animation, features, comparison)
app/index.html          recorder app shell + mount points
styles/main.css         dark UI theme
serve.py                static dev server (correct MIME types)
vendor/ffmpeg/          vendored ffmpeg.wasm (single-thread core, ~32 MB)
src/
  app.js                entry: wiring, render loop, timers
  state.js              observable store
  sources.js            getUserMedia / getDisplayMedia, device handling
  recorder.js           per-source MediaRecorder (MIME, pause/resume, timing)
  audioMeter.js         shared AudioContext + level metering
  export/
    ffmpeg.js           lazy ffmpeg.wasm loader
    exporters.js        single / all / merge export + muxing
  ui/
    toolbar.js          add sources, quick start, global controls, view toggle
    videoStage.js       grid + speaker layouts
    audioBar.js         audio lane + VU meters
    inspector.js        left config panel
    exportPanel.js      right export panel
  util/{dom,format}.js  helpers
```

ffmpeg.wasm is vendored under `vendor/ffmpeg/` and loaded lazily on the first
combined export, so the recorder works fully offline.

## Browser notes

- **System / desktop audio** capture works in Chromium browsers; in the share
  picker pick a **Tab** or **Entire screen** and tick **Share audio**.
- Screen, monitor and individual-tab selection all happen in the browser's
  native picker — Capture can't pre-select which one for you.
- Keep the recorder tab in the foreground; some browsers throttle background
  tabs.
