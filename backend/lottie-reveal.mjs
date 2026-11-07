import { normalizeReveal } from "../engine/reveal.js";
import { easingAt } from "../engine/easing.js";
import { easingPieces } from "../engine/counterSchedule.js";
import { enabledAnimations } from "../engine/animationEnabled.js";
import { resolveInitialAnimations } from "../engine/animation.js";

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));
const REVEAL_CROSSING_SIDE_EPSILON = 1e-7;

export function revealRectangle(width, height, revealValue) {
  const reveal = normalizeReveal(revealValue);
  const w = Math.max(0, finite(width));
  const h = Math.max(0, finite(height));
  const p = reveal.progress;
  switch (reveal.direction) {
    case "right": return { x: 0, y: 0, width: w * p, height: h };
    case "left": return { x: w * (1 - p), y: 0, width: w * p, height: h };
    case "down": return { x: 0, y: 0, width: w, height: h * p };
    case "up": return { x: 0, y: h * (1 - p), width: w, height: h * p };
    default: throw new TypeError("Reveal direction is invalid");
  }
}

function mapPoint(matrix, x, y) {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

function rectangleShape(rect, matrix) {
  const x = rect.x, y = rect.y;
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  const vertices = [
    mapPoint(matrix, x, y),
    mapPoint(matrix, right, y),
    mapPoint(matrix, right, bottom),
    mapPoint(matrix, x, bottom),
  ];
  return {
    c: true,
    v: vertices,
    i: vertices.map(() => [0, 0]),
    o: vertices.map(() => [0, 0]),
  };
}

function sameShape(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Keep the local mask continuous through the last frame before the endpoint, then switch to the
// composition-sized mask at the endpoint. A sub-frame boundary avoids holding the penultimate
// local rectangle for a whole frame while still preserving the exact integer samples.
const ENDPOINT_KEYFRAME_EPSILON = 1e-6;

function endpointEpsilon(current, next) {
  return Math.min(ENDPOINT_KEYFRAME_EPSILON, (next.frame - current.frame) / 2);
}

function addLocalEndpointSamples(samples) {
  if (samples.length < 2) return samples;
  const expanded = [samples[0]];
  for (let index = 0; index + 1 < samples.length; index += 1) {
    const current = samples[index];
    const next = samples[index + 1];
    if (!current.fullComposition && next.fullComposition) {
      expanded.push({
        ...next,
        frame: next.frame - endpointEpsilon(current, next),
        shape: next.localShape,
        fullComposition: false,
      });
    } else if (current.fullComposition && !next.fullComposition) {
      expanded.push({
        ...current,
        frame: current.frame + endpointEpsilon(current, next),
        shape: current.localShape,
        fullComposition: false,
      });
    }
    expanded.push(next);
  }
  return expanded;
}

function shapeProperty(samples) {
  const shapes = samples.map((sample) => sample.shape);
  if (shapes.every((shape) => sameShape(shape, shapes[0]))) {
    return { a: 0, k: shapes[0] };
  }
  const indexes = new Set([0, shapes.length - 1]);
  const heldTransitions = new Set();
  for (let index = 0; index + 1 < samples.length; index += 1) {
    const shapeChanged = !sameShape(shapes[index], shapes[index + 1]);
    const fullChanged = samples[index].fullComposition !== samples[index + 1].fullComposition;
    if (!shapeChanged && !fullChanged) continue;
    // Keep both samples around a path change. The preceding sample matters when a constant
    // run precedes a change: omitting it delays the linear transition until the later keyframe.
    indexes.add(index);
    indexes.add(index + 1);
    if (fullChanged) heldTransitions.add(index);
  }
  const keyframes = [...indexes].sort((a, b) => a - b).map((index) => {
    const shape = shapes[index];
    const next = samples[index + 1];
    const keyframe = { t: samples[index].frame, s: [shape] };
    if (heldTransitions.has(index)) keyframe.h = 1;
    else if (next) {
      keyframe.e = [next.shape];
      keyframe.i = { x: 1, y: 1 };
      keyframe.o = { x: 0, y: 0 };
    } else keyframe.h = 1;
    return keyframe;
  });
  return { a: 1, k: keyframes };
}

function resolveFramePositions(framePositions, sampleCount) {
  if (framePositions === null || framePositions === undefined) {
    return Array.from({ length: sampleCount }, (_, index) => index);
  }
  if (!Array.isArray(framePositions) || framePositions.length !== sampleCount) {
    throw new TypeError("Lottie reveal frame positions must match the sampled states");
  }
  if (!framePositions.every((frame, index) => Number.isFinite(frame) &&
      (index === 0 || frame > framePositions[index - 1]))) {
    throw new RangeError("Lottie reveal frame positions must be finite and strictly increasing");
  }
  return framePositions;
}

/** A native sampled alpha mask in the parent's coordinate system. */
export function lottieRevealMask(states, matrices, domain = null, framePositions = null) {
  if (!Array.isArray(states) || states.length === 0 || !Array.isArray(matrices) || matrices.length !== states.length) {
    throw new TypeError("Lottie reveal masks need matching sampled states and matrices");
  }
  const positions = resolveFramePositions(framePositions, states.length);
  const samples = states.map((state, index) => {
    const matrix = matrices[index];
    if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite)) {
      throw new TypeError(`Lottie reveal matrix ${index + 1} must contain six finite numbers`);
    }
    const reveal = normalizeReveal(state?.reveal);
    // The full endpoint covers the containing composition, so an outside stroke, filter, or
    // unbounded group child is not clipped back to the design box on the last frame.
    const fullComposition = reveal.progress >= 1 && domain;
    const localRect = revealRectangle(state?.width, state?.height, reveal);
    const localShape = rectangleShape(localRect, matrix);
    const rect = fullComposition
      ? { x: 0, y: 0, width: Math.max(0, finite(domain.width)), height: Math.max(0, finite(domain.height)) }
      : localRect;
    return {
      frame: positions[index],
      shape: fullComposition ? rectangleShape(rect, [1, 0, 0, 1, 0, 0]) : localShape,
      localShape,
      fullComposition: Boolean(fullComposition),
    };
  });
  return {
    inv: false,
    mode: "a",
    nm: "Animation reveal",
    pt: shapeProperty(addLocalEndpointSamples(samples)),
    o: { a: 0, k: 100 },
    x: { a: 0, k: 0 },
  };
}

export function hasSoftReveal(states) {
  return Array.isArray(states) && states.some((state) => {
    const reveal = normalizeReveal(state?.reveal);
    return reveal.progress > 0 && reveal.progress < 1 && reveal.softness > 0;
  });
}

const clampEasing = (easing, progress, intensity) =>
  clamp(easingAt(easing, progress, intensity), 0, 1);

function crossingProgress(easing, intensity, low, high, threshold) {
  const lowValue = clampEasing(easing, low, intensity);
  const highValue = clampEasing(easing, high, intensity);
  if (threshold < Math.min(lowValue, highValue) || threshold > Math.max(lowValue, highValue)) return null;
  if (highValue === lowValue) return null;
  const rising = highValue > lowValue;
  const atZero = threshold === 0;
  const atOne = threshold === 1;
  let before = low;
  let after = high;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const middle = (before + after) / 2;
    const value = clampEasing(easing, middle, intensity);
    const remainsBefore = rising
      ? atZero ? value <= 0 : value < threshold
      : atOne ? value >= 1 : value > threshold;
    if (remainsBefore) before = middle;
    else after = middle;
  }
  return after;
}

/**
 * Add event times where a layer's whole-box reveal starts, ends, or reaches a local/full endpoint.
 * `frameTimes` and the returned values are seconds; Lottie maps them to frame positions later.
 */
export function revealSampleTimes(layer, frameTimes) {
  if (!Array.isArray(frameTimes) || frameTimes.length === 0 || !frameTimes.every(Number.isFinite)) {
    throw new TypeError("Reveal sample times need a non-empty array of finite frame times");
  }
  const firstTime = Math.min(...frameTimes);
  const lastTime = Math.max(...frameTimes);
  const result = new Set(frameTimes);
  const addTime = (time) => {
    if (Number.isFinite(time) && time >= firstTime && time <= lastTime) result.add(time);
  };

  for (const window of layer?.playbackWindows ?? []) {
    addTime(window.start);
    addTime(window.end);
  }

  for (const animation of enabledAnimations(resolveInitialAnimations(layer ?? {}))) {
    const from = animation.from && typeof animation.from === "object" ? animation.from : {};
    const to = animation.to && typeof animation.to === "object" ? animation.to : {};
    if (!Object.hasOwn(from, "reveal") && !Object.hasOwn(to, "reveal")) continue;

    const start = Number.isFinite(animation.start) ? animation.start : 0;
    const duration = Math.max(0, Number.isFinite(animation.duration) ? animation.duration : 0);
    const end = start + duration;
    addTime(start);
    addTime(end);
    if (duration <= 0) continue;

    const designReveal = normalizeReveal(layer?.reveal);
    const fromReveal = Object.hasOwn(from, "reveal") ? normalizeReveal(from.reveal) : designReveal;
    const toReveal = Object.hasOwn(to, "reveal") ? normalizeReveal(to.reveal) : designReveal;
    const delta = toReveal.progress - fromReveal.progress;
    if (Math.abs(delta) < 1e-14) continue;
    const thresholds = [0, 1]
      .map((target) => (target - fromReveal.progress) / delta)
      .filter((threshold) => threshold >= 0 && threshold <= 1);
    if (thresholds.length === 0) continue;

    const easing = animation.easing ?? "linear";
    const intensity = animation.intensity ?? 50;
    const pieces = easingPieces(easing, intensity);
    const crossings = new Set();
    for (let index = 0; index + 1 < pieces.length; index += 1) {
      const low = pieces[index];
      const high = pieces[index + 1];
      if (!(high > low)) continue;
      // Include turns and endpoints even when an easing only touches a reveal boundary there.
      addTime(start + duration * low);
      addTime(start + duration * high);
      for (const threshold of thresholds) {
        const progress = crossingProgress(easing, intensity, low, high, threshold);
        if (progress !== null) crossings.add(start + duration * progress);
      }
    }
    const orderedCrossings = [...crossings].sort((left, right) => left - right);
    for (let index = 0; index < orderedCrossings.length; index += 1) {
      const time = orderedCrossings[index];
      const previous = orderedCrossings[index - 1];
      const next = orderedCrossings[index + 1];
      let epsilon = Math.min(REVEAL_CROSSING_SIDE_EPSILON, duration * 1e-4);
      if (previous !== undefined) epsilon = Math.min(epsilon, (time - previous) / 4);
      if (next !== undefined) epsilon = Math.min(epsilon, (next - time) / 4);
      if (epsilon > 0) addTime(time - epsilon);
      addTime(time);
      if (epsilon > 0) addTime(time + epsilon);
    }
  }

  return [...result].sort((left, right) => left - right);
}
