// The dashboard's playback clock. While a scene plays, the time on screen comes from the sound
// card when the scene has sound, so the picture follows what you hear, and from the computer's
// clock when it has none or the browser has not let the sound start yet.
//
// Data flow: Space → clock.play(from), inside the key press so the browser lets sound start →
// a frame loop in Dashboard.jsx reads clock.time() and puts it in a time store → the stage, the
// timeline playhead and the status line redraw. The sound is the scene's mix from
// GET /api/dashboard/mix (the export's own mix), decoded once (decodeSound) and looped in step
// with the scene. Nothing here knows about React.

// Every mix is 48 kHz (backend/export.mjs soundMixArgs).
const MIX_RATE = 48000;
// After play asks the browser to start the sound, this long passes before the page says the
// sound is blocked.
const START_GRACE_MS = 1500;

function defaultContext() {
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Context ? new Context({ latencyHint: "interactive" }) : null;
}

const defaultNow = () => performance.now() / 1000;

/** Decodes a mix (WAV bytes) into an AudioBuffer without starting any sound. */
export async function decodeSound(bytes) {
  const Offline = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error("This browser cannot play sound (no Web Audio).");
  return new Offline(2, 1, MIX_RATE).decodeAudioData(bytes);
}

/**
 * A clock for one scene at a time. `now` is the computer's clock in seconds (performance.now()
 * by default); `makeContext` makes the AudioContext, on the first play, so the browser counts it
 * as started by you. Both can be replaced in tests.
 */
export function createPlaybackClock({ now = defaultNow, makeContext = defaultContext, setTimer = setTimeout } = {}) {
  let duration = 1;
  let playing = false;
  let pausedAt = 0;
  // While playing: the scene time `base` (counted on past the end, not wrapped) when the run
  // started, and where: on the sound card (source, startedAt in context time) or the computer's
  // clock (startedAt from now()).
  let run = null;
  // The newest time handed out while playing (not wrapped), so the picture never steps back.
  let last = 0;
  let sound = null;
  let context;
  let starting = false;
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };

  const wrap = (time) => {
    const value = time % duration;
    return value < 0 ? value + duration : value;
  };

  // The context time of the sound that comes out of the speakers right now: the output
  // timestamp moved on to this moment, else the context's time less its output delay.
  function heardContextTime() {
    const stamp = context.getOutputTimestamp?.();
    if (stamp && stamp.contextTime > 0 && stamp.performanceTime > 0)
      return stamp.contextTime + Math.max(0, now() - stamp.performanceTime / 1000);
    return context.currentTime - (context.outputLatency || context.baseLatency || 0);
  }

  function elapsed() {
    if (run.source) return heardContextTime() - run.startedAt;
    return now() - run.startedAt;
  }

  // The time while playing, not wrapped.
  function unwrapped() {
    last = Math.max(last, run.base + elapsed());
    return last;
  }

  const soundRuns = () => Boolean(sound && context && context.state === "running");

  function stopSource() {
    if (!run?.source) return;
    try { run.source.stop(); } catch { /* it had not started */ }
    run.source.disconnect();
  }

  // Starts a run at scene time `at` (not wrapped): the sound from that point when it can play,
  // else the computer's clock.
  function startRun(at) {
    if (!soundRuns()) {
      run = { base: at, source: null, startedAt: now() };
      return;
    }
    const source = context.createBufferSource();
    source.buffer = sound;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = duration;
    source.connect(context.destination);
    const startedAt = context.currentTime;
    source.start(startedAt, wrap(at));
    run = { base: at, source, startedAt };
  }

  // Keeps playing from the same moment on a new footing (sound arrived, changed or stopped).
  function restart() {
    if (!playing) return;
    const at = unwrapped();
    stopSource();
    startRun(at);
    changed();
  }

  function ensureContext() {
    if (context !== undefined) return context;
    try { context = makeContext(); } catch { context = null; }
    context?.addEventListener?.("statechange", () => {
      if (context.state === "running") starting = false;
      // The sound card started (or stopped, for example when another app took it): the picture
      // keeps its time and moves onto the clock that runs now.
      if (playing && Boolean(run?.source) !== soundRuns()) restart();
      else changed();
    });
    return context;
  }

  // Asks the browser to let the sound play. Called from your key press or click.
  function resume() {
    if (!sound || !ensureContext() || context.state === "running") return;
    starting = true;
    changed();
    // A browser that wants a key press first leaves resume() waiting, so after a short wait the
    // page says the sound is blocked.
    const settle = () => { if (!starting) return; starting = false; changed(); };
    setTimer(settle, START_GRACE_MS);
    Promise.resolve(context.resume?.()).then(() => {
      if (playing && Boolean(run?.source) !== soundRuns()) restart();
      if (context?.state === "running") settle();
    }, settle);
  }

  return {
    get playing() { return playing; },
    get duration() { return duration; },

    /** The scene time to show now, from 0 up to (not including) the scene's length. */
    time() {
      return playing ? wrap(unwrapped()) : pausedAt;
    },

    /** Plays from `from` seconds (default: where it was paused). */
    play(from = pausedAt) {
      if (playing) return;
      if (sound) { ensureContext(); resume(); }
      playing = true;
      last = wrap(Math.max(0, from));
      startRun(last);
      changed();
    },

    /** Stops and returns the time it stopped at. */
    pause() {
      if (!playing) return pausedAt;
      pausedAt = wrap(unwrapped());
      stopSource();
      run = null;
      playing = false;
      changed();
      return pausedAt;
    },

    /** Goes to `time` seconds and keeps playing from there when playing. */
    seek(time) {
      const at = wrap(Math.max(0, Number(time) || 0));
      if (!playing) { pausedAt = at; changed(); return; }
      stopSource();
      last = at;
      startRun(at);
      changed();
    },

    /** The scene's length in seconds. Playing keeps its place (from 0 when past the new end). */
    setDuration(seconds) {
      const next = Math.max(1e-3, Number(seconds) || 1e-3);
      if (next === duration) return;
      if (!playing) {
        duration = next;
        pausedAt = pausedAt < next ? pausedAt : 0;
        return;
      }
      const shown = wrap(unwrapped());
      stopSource();
      duration = next;
      last = shown < next ? shown : 0;
      startRun(last);
      changed();
    },

    /**
     * The scene's sound: a decoded AudioBuffer of its mix, or null when it has none. Playing
     * switches to it at the same moment, so an edit's new mix comes in without a jump.
     */
    setSound(buffer) {
      if (buffer === sound) return;
      sound = buffer ?? null;
      if (sound && playing) { ensureContext(); resume(); }
      if (playing) restart();
      else changed();
    },

    /**
     * What you hear: "none" (no sound in the scene), "ready" (paused), "on", "starting" (the
     * browser is being asked), "blocked" (the browser has not let the sound start; play still
     * runs on the computer's clock), or "unavailable" (no Web Audio in this browser).
     */
    soundState() {
      if (!sound) return "none";
      if (context === null) return "unavailable";
      if (!playing) return "ready";
      if (soundRuns() && run?.source) return "on";
      return starting ? "starting" : "blocked";
    },

    /** Tries again to start the sound, from a key press or click (the browser needs one). */
    resume,

    /** Calls `listener` when the sound state or play state changes. Returns how to stop. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close() {
      stopSource();
      run = null;
      playing = false;
      listeners.clear();
      context?.close?.().catch?.(() => {});
      context = undefined;
    },
  };
}

/** A small store for the time on screen while playing; components read it with useSyncExternalStore. */
export function createTimeStore(initial = 0) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The start of the frame shown at `time`, at `fps` frames a second (a player shows each frame for its whole length). */
export function frameStart(time, fps) {
  return Math.floor(time * fps + 1e-6) / fps;
}
