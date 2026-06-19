// Shared AudioContext + per-source level metering (no audio routed to output).

let audioCtx = null;

export function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

/** Wire an AnalyserNode for a source's stream so we can read its level. */
export function attachMeter(source) {
  try {
    if (!source.stream.getAudioTracks().length) return;
    const ctx = getAudioContext();
    const src = ctx.createMediaStreamSource(source.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser); // intentionally NOT connected to destination (no echo)
    source._meterSrc = src;
    source._analyser = analyser;
    source._meterData = new Uint8Array(analyser.fftSize);
  } catch {
    /* metering is best-effort */
  }
}

export function detachMeter(source) {
  try {
    source._meterSrc && source._meterSrc.disconnect();
  } catch {
    /* ignore */
  }
  source._meterSrc = null;
  source._analyser = null;
  source._meterData = null;
}

/** Current RMS level, 0..1 (scaled for display). */
export function readLevel(source) {
  const a = source._analyser;
  const d = source._meterData;
  if (!a || !d) return 0;
  a.getByteTimeDomainData(d);
  let sum = 0;
  for (let i = 0; i < d.length; i += 1) {
    const v = (d[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / d.length);
  return Math.min(1, rms * 3.2);
}
