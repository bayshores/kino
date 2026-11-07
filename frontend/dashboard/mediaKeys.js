// The keyboard's play/pause key (and the Mac's Now Playing controls) for the stage.
//
// macOS sends the media keys to the app that is "now playing", and Chromium (so Electron) only
// counts an app as playing while an <audio> or <video> element plays sound. The stage's sound is
// Web Audio (playbackClock.js), which does not count. So while the stage plays, a silent
// <audio> element plays alongside it, and the Media Session handlers turn the key into play or
// pause. The track is all zero samples: nothing is ever heard from it.

// Chromium treats media shorter than 5 s as a short alert that never takes the media keys.
const SILENT_SECONDS = 30;
const RATE = 8000;

/** A WAV file of `seconds` of silence: 8 kHz, mono, 8-bit (128 is silence for 8-bit WAV). */
export function silentWav(seconds = SILENT_SECONDS, rate = RATE) {
  const samples = Math.round(seconds * rate);
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at, words) => { for (let i = 0; i < words.length; i += 1) bytes[at + i] = words.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, "data"); view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return bytes;
}

/**
 * Media keys for one player. `onPlay` and `onPause` run when the key (or Now Playing) asks.
 * Call `set(playing, title)` whenever the stage starts or stops; `close()` when done.
 * Does nothing where the browser has no Media Session.
 */
export function createMediaKeys({ onPlay, onPause, session = globalThis.navigator?.mediaSession, makeAudio = () => new Audio() } = {}) {
  if (!session || typeof session.setActionHandler !== "function") return { set() {}, close() {} };
  let audio = null;
  let url = null;
  const handle = (action, run) => { try { session.setActionHandler(action, run); } catch { /* not supported here */ } };
  handle("play", () => onPlay?.());
  handle("pause", () => onPause?.());
  handle("stop", () => onPause?.());
  return {
    set(playing, title = "kino") {
      if (playing) {
        if (!audio) {
          url = URL.createObjectURL(new Blob([silentWav()], { type: "audio/wav" }));
          audio = makeAudio();
          audio.loop = true;
          audio.src = url;
        }
        audio.play().catch(() => {});
        if (globalThis.MediaMetadata) session.metadata = new globalThis.MediaMetadata({ title, artist: "kino" });
      } else {
        audio?.pause();
      }
      session.playbackState = playing ? "playing" : "paused";
    },
    close() {
      for (const action of ["play", "pause", "stop"]) handle(action, null);
      audio?.pause();
      if (url) URL.revokeObjectURL(url);
      audio = null;
      url = null;
    },
  };
}
