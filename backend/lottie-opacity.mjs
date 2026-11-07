import { evaluateLayer, operationStagger } from "../engine/animation.js";
import { enabledAnimations } from "../engine/animationEnabled.js";
import { easingAt } from "../engine/easing.js";
import { easingPieces } from "../engine/counterSchedule.js";
import { isVisibilityOperation, VISIBILITY_TIME_TOLERANCE } from "../engine/visibilityOps.js";
import { effectiveMediaDuration, hasMediaPlay, MEDIA_SAMPLE_TOLERANCE, PLAY_END_TOLERANCE } from "../engine/playback.js";
import { lottieFramePosition } from "./lottie-frame-time.mjs";

const clamp = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
const switchCache = new Map();

// Locate every phase boundary on each monotonic part of the easing. A frame scan can miss
// several short blinks between frames, including the small late arcs of Bounce.
export function blinkSwitchProgress(animation) {
  if (animation.discrete?.type !== "blink") return [];
  const easing = animation.easing ?? "linear";
  const intensity = animation.intensity ?? 50;
  const phases = 2 * animation.discrete.count + 1;
  const key = JSON.stringify([easing, intensity, phases]);
  if (switchCache.has(key)) return switchCache.get(key);
  const pieces = easingPieces(easing, intensity);
  const result = new Set();
  for (let piece = 0; piece + 1 < pieces.length; piece += 1) {
    const low = pieces[piece], high = pieces[piece + 1];
    const from = clamp(easingAt(easing, low, intensity));
    const to = clamp(easingAt(easing, high, intensity));
    if (Math.abs(to - from) < 1e-14) continue;
    const rising = to > from;
    for (let phase = 1; phase <= phases; phase += 1) {
      const threshold = (phase - 1e-12) / phases;
      if (threshold < Math.min(from, to) || threshold > Math.max(from, to)) continue;
      let before = low, after = high;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const middle = (before + after) / 2;
        const value = clamp(easingAt(easing, middle, intensity));
        if (rising ? value < threshold : value >= threshold) before = middle;
        else after = middle;
      }
      result.add((before + after) / 2);
    }
  }
  const points = [...result].sort((a, b) => a - b);
  if (switchCache.size >= 256) switchCache.delete(switchCache.keys().next().value);
  switchCache.set(key, points);
  return points;
}

// A loop (behavior.js) plays its switches again on every pass until `until`, backwards on a
// pingpong's odd passes.
const MAX_PASSES = 10000;

function switchTimes(layer, options, until = -Infinity) {
  const times = new Set();
  for (const animation of enabledAnimations(layer.animations)) {
    if (isVisibilityOperation(animation)) {
      times.add(animation.start - VISIBILITY_TIME_TOLERANCE);
      continue;
    }
    const start = (animation.start ?? 0) + operationStagger(animation, options);
    const duration = Math.max(0, animation.duration ?? 0);
    const blinks = blinkSwitchProgress(animation);
    const mode = animation.behavior?.loop?.mode;
    const passes = mode && duration > 0 ? Math.min(MAX_PASSES, Math.ceil((until - start) / duration)) : 1;
    for (let pass = 0; pass < Math.max(1, passes); pass += 1) {
      const base = start + pass * duration;
      const backwards = mode === "pingpong" && pass % 2 === 1;
      // A later ordinary opacity track, Hide/Show, or Play can take over a discrete track.
      times.add(base);
      times.add(base + duration);
      for (const progress of blinks) times.add(base + duration * (backwards ? 1 - progress : progress));
    }
  }
  if (hasMediaPlay(layer)) {
    // Play counts as started MEDIA_SAMPLE_TOLERANCE early (mediaFrameState).
    times.add((layer.mediaStart ?? 0) - MEDIA_SAMPLE_TOLERANCE);
    times.add((layer.mediaStart ?? 0) + effectiveMediaDuration(layer) + PLAY_END_TOLERANCE);
  }
  for (const window of layer.playbackWindows ?? []) {
    times.add(window.start);
    times.add(window.end);
  }
  return [...times].filter(Number.isFinite).sort((a, b) => a - b);
}

/** Fractional hold keys for discrete opacity; continuous tracks retain their sampled values. */
export function discreteOpacityProperty(layer, times, options = {}, stateAt = null) {
  if (!enabledAnimations(layer.animations).some((animation) => animation.discrete)) return null;
  const timing = { unitIndex: 0, unitCount: 1, unit: "layer", ...options };
  const evaluate = stateAt ?? ((time) => evaluateLayer(layer, time, timing));
  const opacityAt = (time) => {
    const state = evaluate(time);
    return state.visible === false ? 0 : clamp(state.opacity) * 100;
  };
  const points = new Map(times.map((time, frame) => [frame, { t: frame, value: opacityAt(time) }]));
  const lastTime = times.at(-1);
  const step = times[1] - times[0];
  for (const time of switchTimes(layer, timing, lastTime)) {
    if (time <= times[0] || time > lastTime) continue;
    const epsilon = Math.min(step * 1e-7, time / 4);
    const before = opacityAt(time - epsilon);
    const after = opacityAt(time + epsilon);
    if (Math.abs(before - after) < 1e-5) continue;
    let frame = lottieFramePosition(times, time);
    if (Math.abs(frame - Math.round(frame)) < 1e-10) frame = Math.round(frame);
    // Mapping a bisected second back to frames can land a few ulps after the evaluated
    // switch. Round toward the earlier side at 1e-10 frame precision so that exact
    // boundary samples use the new value (less than a nanosecond early).
    frame = Math.floor(frame * 1e10) / 1e10;
    // The tiny pre-boundary key preserves a continuous fade that may precede this jump.
    // A hold then switches at the real fractional frame, never the next integer sample.
    const justBefore = Math.max(0, frame - 1e-7);
    points.set(justBefore, { t: justBefore, value: before, hold: true });
    points.set(frame, { t: frame, value: after });
  }
  const ordered = [...points.values()].sort((a, b) => a.t - b.t);
  if (ordered.every((point) => Math.abs(point.value - ordered[0].value) < 1e-7))
    return { a: 0, k: ordered[0].value };
  return { a: 1, k: ordered.map((point, index) => {
    const next = ordered[index + 1];
    return point.hold || !next
      ? { t: point.t, s: [point.value], h: 1 }
      : { t: point.t, s: [point.value], e: [next.value], i: { x: 1, y: 1 }, o: { x: 0, y: 0 } };
  }) };
}
