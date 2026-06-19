// Lazy loader for the locally-vendored ffmpeg.wasm (single-thread core).
//
// The single-thread @ffmpeg/core does NOT require SharedArrayBuffer, so this
// works on any plain static host (no COOP/COEP headers needed) — it just must
// be served over http(s), not file://.
//
// We load the UMD build via <script> tags from the same origin so webpack's
// automatic publicPath resolves the worker chunk (814.ffmpeg.js) correctly.

let ff = null;
let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-ff="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else existing.addEventListener('load', () => resolve());
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.ff = src;
    s.addEventListener('load', () => {
      s.dataset.loaded = '1';
      resolve();
    });
    s.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
    document.head.appendChild(s);
  });
}

/**
 * Resolve (loading if needed) the FFmpeg instance.
 * @param {(p:number)=>void} [onProgress] receives 0..1 during exec()
 */
export async function getFFmpeg(onProgress) {
  if (ff) {
    ff.__onProgress = onProgress || null;
    return ff;
  }
  if (loading) {
    if (onProgress) loading.then((f) => (f.__onProgress = onProgress));
    return loading;
  }

  loading = (async () => {
    const base = new URL('./vendor/ffmpeg/', document.baseURI).href;
    await loadScript(`${base}ffmpeg.js`);

    if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
      throw new Error('ffmpeg.wasm failed to load (vendor/ffmpeg).');
    }
    const { FFmpeg } = window.FFmpegWASM;
    const instance = new FFmpeg();
    instance.__onProgress = onProgress || null;
    instance.on('progress', ({ progress }) => {
      if (instance.__onProgress) {
        instance.__onProgress(Math.max(0, Math.min(1, progress)));
      }
    });
    // instance.on('log', ({ message }) => console.debug('[ffmpeg]', message));

    await instance.load({
      coreURL: `${base}core/ffmpeg-core.js`,
      wasmURL: `${base}core/ffmpeg-core.wasm`,
    });
    ff = instance;
    return ff;
  })();

  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

export function isFFmpegLoaded() {
  return !!ff;
}
