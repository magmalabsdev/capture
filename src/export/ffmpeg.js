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

// Hard ceilings so a wedged worker or a stalled wasm fetch can never leave an
// export "Converting…" forever — they become a bounded, catchable failure
// instead (callers fall back to the original recording).
const LOAD_TIMEOUT_MS = 90 * 1000; // generous: the core wasm is ~32 MB
const EXEC_TIMEOUT_MS = 5 * 60 * 1000; // any single ffmpeg run

function withTimeout(promise, ms, message) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

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
    // Resolve the vendor dir relative to THIS module (…/src/export/ffmpeg.js),
    // not document.baseURI — the app is served from /app/ but vendor/ lives at
    // the site root, so a baseURI-relative path 404s ("Failed to load ffmpeg").
    const base = new URL('../../vendor/ffmpeg/', import.meta.url).href;
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

    await withTimeout(
      instance.load({
        coreURL: `${base}core/ffmpeg-core.js`,
        wasmURL: `${base}core/ffmpeg-core.wasm`,
      }),
      LOAD_TIMEOUT_MS,
      'ffmpeg.wasm took too long to load (slow or blocked network?).'
    );
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

/**
 * Run one ffmpeg command, bounded by a watchdog. If it hangs (a wedged worker),
 * the instance is torn down so the next call starts fresh, and the caller gets a
 * rejection instead of a promise that never settles.
 */
export async function runExec(instance, args, timeoutMs = EXEC_TIMEOUT_MS) {
  try {
    return await withTimeout(
      instance.exec(args),
      timeoutMs,
      'ffmpeg timed out (the conversion did not finish).'
    );
  } catch (e) {
    if (/timed out/.test(e.message || '')) resetFFmpeg();
    throw e;
  }
}

/** Tear down the (possibly wedged) ffmpeg worker so the next op reloads clean. */
export function resetFFmpeg() {
  const inst = ff;
  ff = null;
  loading = null;
  if (inst) {
    try {
      inst.terminate();
    } catch {
      /* ignore */
    }
  }
}

export function isFFmpegLoaded() {
  return !!ff;
}
