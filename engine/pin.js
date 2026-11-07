// Pins: a layer that follows a tracked object (the track and pin ops, backend/agent/track-operation.mjs).
//
// A scene keeps its tracks as scene.tracks: [{ name, layerId, src, at, samples }], where each
// sample is [t, cx, cy, w, h, c]: scene seconds, the object's center and size in scene pixels, and
// Apple Vision's confidence (0 to 1). A pinned layer keeps its own copy of the path it follows,
//   layer.pin = { track, offset: [dx, dy], scale, base: [w, h], path: [[t, cx, cy, w, h, c]] }
// in which frames under LOW_CONFIDENCE already hold the last good position (holdLowFrames), so
// the renderer only reads it: evaluateLayer (animation.js) moves the layer's center to the
// path's center plus offset at each time, and with scale the layer grows with the object
// (base is the object's size where the track was started). Preview, look and every export draw
// through evaluateLayer, so they match.

export const LOW_CONFIDENCE = 0.5;
export const MAX_PIN_SAMPLES = 3600;
export const MAX_TRACKS = 32;

/** The samples with each frame under LOW_CONFIDENCE moved to the last good one (the first good one before any). */
export function holdLowFrames(samples) {
  const firstGood = samples.find((sample) => sample[5] >= LOW_CONFIDENCE) ?? samples[0];
  let last = firstGood;
  return samples.map((sample) => {
    if (sample[5] >= LOW_CONFIDENCE) { last = sample; return sample; }
    return [sample[0], last[1], last[2], last[3], last[4], sample[5]];
  });
}

/** The path's [cx, cy, w, h] at scene time `t` (straight between samples, held past the ends). */
export function pathAt(path, t) {
  if (!path?.length) return null;
  if (t <= path[0][0]) return path[0].slice(1, 5);
  const last = path[path.length - 1];
  if (t >= last[0]) return last.slice(1, 5);
  let low = 0, high = path.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (path[middle][0] <= t) low = middle; else high = middle;
  }
  const a = path[low], b = path[high];
  const share = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
  return [1, 2, 3, 4].map((index) => a[index] + (b[index] - a[index]) * share);
}

/**
 * Moves `evaluated` (a layer's values at time `t`) so its center sits on the pin's path plus
 * offset. `layer` is the saved layer: the move is from its own center, so a Move or Scale
 * animation on the pinned layer still adds to it.
 */
export function applyPin(evaluated, layer, t) {
  const at = pathAt(layer.pin?.path, t);
  if (!at) return evaluated;
  const [dx, dy] = layer.pin.offset ?? [0, 0];
  evaluated.x += at[0] + dx - (layer.x + layer.width / 2);
  evaluated.y += at[1] + dy - (layer.y + layer.height / 2);
  const base = layer.pin.base;
  if (layer.pin.scale && base?.[0] > 0 && base?.[1] > 0) {
    const grow = Math.sqrt((at[2] / base[0]) * (at[3] / base[1]));
    if (Number.isFinite(grow) && grow > 0) {
      evaluated.scaleX = (evaluated.scaleX ?? 1) * grow;
      evaluated.scaleY = (evaluated.scaleY ?? 1) * grow;
    }
  }
  return evaluated;
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function checkSamples(samples, path) {
  if (!Array.isArray(samples) || !samples.length || samples.length > MAX_PIN_SAMPLES) fail(path, `must be a list of 1 to ${MAX_PIN_SAMPLES} samples`);
  for (const [index, sample] of samples.entries())
    if (!Array.isArray(sample) || sample.length !== 6 || !sample.every((value) => typeof value === "number" && Number.isFinite(value)))
      fail(`${path}[${index}]`, "must be [t, cx, cy, w, h, confidence]");
  return samples;
}

/** Checks a layer's pin (model.js). */
export function normalizePin(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be {track, offset, scale, base, path}");
  if (typeof value.track !== "string" || !value.track || value.track.length > 128) fail(`${path}.track`, "must be the track's name");
  const offset = value.offset ?? [0, 0];
  if (!Array.isArray(offset) || offset.length !== 2 || !offset.every(Number.isFinite)) fail(`${path}.offset`, "must be [dx, dy] in scene pixels");
  if (value.base != null && (!Array.isArray(value.base) || value.base.length !== 2 || !value.base.every(Number.isFinite))) fail(`${path}.base`, "must be [w, h]");
  return { track: value.track, offset, scale: value.scale === true, ...(value.base ? { base: value.base } : {}), path: checkSamples(value.path, `${path}.path`) };
}

/** Checks a scene's tracks (model.js). */
export function normalizeTracks(value, path) {
  if (!Array.isArray(value) || value.length > MAX_TRACKS) fail(path, `must be a list of at most ${MAX_TRACKS} tracks`);
  const names = new Set();
  return value.map((track, index) => {
    const label = `${path}[${index}]`;
    if (!track || typeof track !== "object" || typeof track.name !== "string" || !track.name) fail(label, "must be {name, layerId, src, at, samples}");
    if (names.has(track.name)) fail(`${label}.name`, `two tracks are named "${track.name}"`);
    names.add(track.name);
    checkSamples(track.samples, `${label}.samples`);
    return track;
  });
}

/** Runs of a pin's path under LOW_CONFIDENCE lasting over `seconds`: [{ start, end }]. */
export function lowRuns(path, seconds = 0.3) {
  const runs = [];
  let start = null, previous = null;
  for (const sample of path ?? []) {
    if (sample[5] < LOW_CONFIDENCE) { start ??= sample[0]; previous = sample[0]; continue; }
    if (start !== null && previous - start > seconds) runs.push({ start, end: previous });
    start = null;
  }
  if (start !== null && previous - start > seconds) runs.push({ start, end: previous });
  return runs;
}
