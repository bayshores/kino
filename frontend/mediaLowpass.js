// The low-pass filter (lowpass.js) for a preview that plays its own sound with <audio> and <video>
// elements (ScenePreview audio "own", as in a view link). An element is routed through a Web Audio
// BiquadFilterNode the first time its layer has a cutoff, and stays routed. The dashboard does not
// need this: it plays the export's own mix (GET /api/dashboard/mix), filtered by FFmpeg.

// Web Audio's lowpass Q is in dB: -3.01 dB is a Q of 0.707, FFmpeg's default (a Butterworth filter).
const BUTTERWORTH_Q_DB = -3.0103;
const routes = new WeakMap();
let context = null;

/** Sets the filter on `media` to `cutoff` Hz, or opens it fully for 0. */
export function applyMediaLowpass(media, cutoff) {
  let route = routes.get(media);
  if (!route) {
    // An element that was never filtered plays as before, without Web Audio.
    if (!(cutoff > 0)) return;
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) return;
    try {
      context ??= new Context();
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = BUTTERWORTH_Q_DB;
      context.createMediaElementSource(media).connect(filter).connect(context.destination);
      route = { filter };
      routes.set(media, route);
    } catch {
      return;
    }
  }
  if (context.state === "suspended") context.resume().catch(() => {});
  // Open is the highest frequency the context can play, where the filter passes everything.
  const hz = cutoff > 0 ? Math.min(cutoff, context.sampleRate / 2) : context.sampleRate / 2;
  route.filter.frequency.setTargetAtTime(hz, context.currentTime, 0.01);
}
