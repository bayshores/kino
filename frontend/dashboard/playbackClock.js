// The dashboard's playback clock. While a scene plays, the time on screen comes from the sound
// card when the scene has sound, so the picture follows what you hear, and from the computer's
// clock when it has none or the browser has not let the sound start yet.
//
// Data flow: Space → clock.play(from), inside the key press so the browser lets sound start →
// a frame loop in Dashboard.jsx reads clock.time(), moves it on by the time the frame takes to
// reach the screen (createPictureClock) and puts it in a time store → the stage, the
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

// A picture drawn in one display frame reaches the screen a while later: the browser finishes the
// frame, then the compositor shows it on a later screen refresh (about two refreshes, 33 ms at
// 60 Hz, measured in Chromium), and later still when drawing the stage took long. Before, the
// stage drew the time heard when its frame began, so the picture showed that much after the
// sound (about 55 ms in a headless Chromium, more on a slow stage).
// With no display frames measured yet, the lead is two 60 Hz refreshes.
const DEFAULT_LEAD = 2 / 60;
// A gap longer than this between display frames (a hidden window, a stall) is not measured.
const MAX_FRAME_GAP = 0.25;
// The lead never goes past this, so one slow frame cannot throw the picture far ahead.
const MAX_LEAD = 0.2;
// How quickly the lead follows the frame time (part of each new frame's gap).
const LEAD_SMOOTHING = 0.1;
// The shortest gap of the last this many frames is the screen's refresh.
const REFRESH_WINDOW = 60;
// A smaller step back than this is the lead shrinking: the picture holds instead (a seek or the
// scene looping moves further).
const HOLD_BACK = 0.1;

/**
 * The time to draw while playing, so the picture is on screen with the sound: once a display
 * frame, `next(heard, frameMs)` takes the scene time you hear now and the display frame's time
 * (requestAnimationFrame's, in ms) and returns the time that will be heard when this frame shows
 * (wrapped at the scene's `duration`). The lead is the measured time between display frames (the
 * time a frame takes) plus one refresh, at most MAX_LEAD. The time never steps back by less than
 * HOLD_BACK, and when drawing is slow it moves on by more than a frame: frames are dropped, the
 * picture never falls behind the sound. `reset()` on play and seek.
 */
export function createPictureClock() {
  let lastFrame = null;
  let gaps = [];
  let smooth = null;
  let shown = null;
  const lead = () => {
    if (smooth == null || !gaps.length) return DEFAULT_LEAD;
    return Math.min(MAX_LEAD, smooth + Math.min(...gaps));
  };
  return {
    lead,
    reset() { lastFrame = null; gaps = []; smooth = null; shown = null; },
    next(heard, frameMs, duration = Infinity) {
      if (lastFrame != null) {
        const gap = (frameMs - lastFrame) / 1000;
        if (gap > 0.002 && gap <= MAX_FRAME_GAP) {
          gaps.push(gap);
          if (gaps.length > REFRESH_WINDOW) gaps.shift();
          smooth = smooth == null ? gap : smooth + (gap - smooth) * LEAD_SMOOTHING;
        }
      }
      lastFrame = frameMs;
      let time = heard + lead();
      if (Number.isFinite(duration) && duration > 0) time %= duration;
      if (shown != null && time < shown && shown - time < HOLD_BACK) time = shown;
      shown = time;
      return time;
    },
  };
}

/** The start of the frame shown at `time`, at `fps` frames a second (a player shows each frame for its whole length). */
export function frameStart(time, fps) {
  return Math.floor(time * fps + 1e-6) / fps;
}
