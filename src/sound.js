// Warning sound for critical recording degradation.
//
// Browsers block audio playback until a user gesture (autoplay policy). There is
// no "audio output permission" API, so we "request" playback by unlocking on the
// first interaction with the page and priming the element.

const SOUND_URL = 'media/sounds/warning.mp3';

let audio = null;
let unlocked = false;
let armed = false;

function getAudio() {
  if (!audio) {
    audio = new Audio(SOUND_URL);
    audio.preload = 'auto';
  }
  return audio;
}

/** Try to unlock playback (call from within a user gesture). */
function unlock() {
  const a = getAudio();
  if (unlocked) return;
  const wasMuted = a.muted;
  a.muted = true;
  const p = a.play();
  if (p && p.then) {
    p.then(() => {
      a.pause();
      a.currentTime = 0;
      a.muted = wasMuted;
      unlocked = true;
    }).catch(() => {
      a.muted = wasMuted;
    });
  } else {
    a.muted = wasMuted;
  }
}

/**
 * Arm audio on page open: attempt an immediate unlock (works where allowed) and
 * otherwise unlock on the first user interaction so warning sounds can play.
 */
export function armAudio() {
  if (armed) return;
  armed = true;
  getAudio();
  unlock(); // best-effort immediate
  const onGesture = () => {
    unlock();
    document.removeEventListener('pointerdown', onGesture);
    document.removeEventListener('keydown', onGesture);
    document.removeEventListener('touchstart', onGesture);
  };
  document.addEventListener('pointerdown', onGesture);
  document.addEventListener('keydown', onGesture);
  document.addEventListener('touchstart', onGesture);
}

/** Play the warning sound (best-effort). */
export function playWarning() {
  try {
    const a = getAudio();
    a.currentTime = 0;
    a.muted = false;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch {
    /* ignore */
  }
}
