// Clip speed and time remapping: which moment of a video, audio or GIF file plays at each
// moment of the scene.
//
// A layer's Play range starts at mediaStart (scene seconds) and reads its file from
// mediaOffset (seconds into the file). At speed 1, one second of the scene plays one second of
// the file. These optional layer fields change that:
//   mediaSpeed        a constant speed from 0.05 to 16 (2 plays twice as fast, 0.5 at half speed);
//   Speed animations  {from: {speed}, to: {speed}} change the speed over time (0 to 16);
//   mediaReverse      true plays the same stretch of the file backwards;
//   mediaFrameRate    shows a new picture only this many times a second, for a choppy look.
//
// The file moves on by the area under the speed curve: in the first u seconds of Play it reads
// P(u) = ∫ speed seconds of the file. A constant speed has an exact answer (speed × u). While a
// Speed animation runs, the area is added up in fixed steps of 1 ms with Simpson's rule, the
// same steps everywhere, so the preview, every export and the dashboard read the same moment
// of the file. playback.js turns this into the file time of each frame (mediaFrameState) and the
// length of Play (effectiveMediaDuration); export.mjs, mediaPlay.js and beatCues.js use those.
import { speedAnimations, speedSampler } from "./animation.js";

export const MIN_MEDIA_SPEED = 0.05;
// A sound's volume goes from 0 (silent) through 1 (the file as recorded) to 4 (+12 dB, the clip
// gain video editors commonly allow), so a quiet recording can be raised without a louder copy of the file.
export const MAX_VOLUME = 4;
export const MAX_MEDIA_SPEED = 16;
export const MIN_MEDIA_FRAME_RATE = 1;
export const MAX_MEDIA_FRAME_RATE = 120;
// How a video shows a moment between two of its frames: the frame on screen at that moment
// ("nearest"), a cross-fade of the two frames ("blend"), or new in-between frames made by
// FFmpeg's motion interpolation ("flow", export only; backend/media-remap.mjs).
export const MEDIA_INTERPOLATIONS = Object.freeze(["nearest", "blend", "flow"]);
// How a sped-up or slowed-down sound is played: at its own pitch ("keep", FFmpeg atempo) or
// higher when faster and lower when slower, like a tape ("follow").
export const MEDIA_PITCHES = Object.freeze(["keep", "follow"]);
// Each of these optional layer fields and the layer types that have it (an image plays as a GIF).
// model.js checks them; agents set them with add_layer and update_layer(s).
export const MEDIA_TIMING_TYPES = Object.freeze({
  mediaSpeed: Object.freeze(["video", "audio", "image"]),
  mediaReverse: Object.freeze(["video", "audio", "image"]),
  mediaFrameRate: Object.freeze(["video", "image"]),
  mediaInterpolation: Object.freeze(["video"]),
  mediaPitch: Object.freeze(["video", "audio"]),
});

// The step in which a Speed animation is added up, in seconds.
const STEP = 1 / 1000;
// At most this many steps per animated stretch (a 120 s animation at 1 ms steps). A ramp as long
// as the longest scene (600 s) gets 5 ms steps; for every easing its file times stay within
// 0.002 ms of a sum in 0.5 ms steps (COMPATIBILITY.md "Ten-minute scenes").
const MAX_STEPS = 120_000;
// Speed maps kept for reuse; the newest are kept.
const CACHE_LIMIT = 64;
const cache = new Map();

const finiteNumber = (value, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** The layer's constant speed (mediaSpeed), or 1 when it has none. */
export function constantSpeed(layer) {
  const speed = layer?.mediaSpeed;
  return typeof speed === "number" && Number.isFinite(speed) && speed > 0 ? speed : 1;
}

/** The layer's mediaFrameRate, or 0 when it shows every frame. */
export function mediaFrameRateOf(layer) {
  const rate = layer?.mediaFrameRate;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/** True when the layer plays its file at a speed other than 1 (mediaSpeed or a Speed animation). */
export function changesSpeed(layer) {
  return constantSpeed(layer) !== 1 || speedAnimations(layer).length > 0;
}

/** True when the layer plays its file backwards. */
export function isReversed(layer) {
  return layer?.mediaReverse === true;
}

/** True when the file does not simply play one second per scene second from mediaOffset. */
export function isRemapped(layer) {
  return changesSpeed(layer) || isReversed(layer) || mediaFrameRateOf(layer) > 0;
}

/** "nearest", "blend" or "flow" (mediaInterpolation; videos only). */
export function mediaInterpolationOf(layer) {
  return layer?.type === "video" && MEDIA_INTERPOLATIONS.includes(layer.mediaInterpolation) ? layer.mediaInterpolation : "nearest";
}

/** "keep" or "follow" (mediaPitch). */
export function mediaPitchOf(layer) {
  return layer?.mediaPitch === "follow" ? "follow" : "keep";
}

/**
 * The speed map of a layer with Speed animations: the stretches of its clock between the starts
 * and ends of those animations, each with the file seconds read before it (`before`). A stretch
 * where no Speed animation runs has one `speed`; one where an animation runs has a table of the
 * file seconds read after each step (`sums`) and the speed at each step edge (`speeds`).
 */
function speedMap(layer) {
  const animations = speedAnimations(layer);
  const start = finiteNumber(layer.mediaStart);
  const key = JSON.stringify([layer.type, start, layer.mediaSpeed ?? null, animations]);
  const known = cache.get(key);
  if (known) {
    cache.delete(key);
    cache.set(key, known);
    return known;
  }
  const sample = speedSampler(layer);
  const edges = new Set([start]);
  const spans = animations.map((animation) => {
    const from = finiteNumber(animation.start);
    return { from, to: from + Math.max(0, finiteNumber(animation.duration)) };
  });
  for (const span of spans)
    for (const time of [span.from, span.to]) if (time > start) edges.add(time);
  const times = [...edges].sort((left, right) => left - right);
  const pieces = [];
  let before = 0;
  for (let index = 0; index < times.length; index += 1) {
    const from = times[index];
    const to = index + 1 < times.length ? times[index + 1] : Infinity;
    const middle = Number.isFinite(to) ? (from + to) / 2 : from + 1;
    const ramping = Number.isFinite(to) && spans.some((span) => span.to > span.from && span.from < middle && span.to > middle);
    if (!ramping) {
      const speed = sample(middle);
      pieces.push({ from, to, before, speed });
      if (Number.isFinite(to)) before += speed * (to - from);
      continue;
    }
    const count = Math.min(MAX_STEPS, Math.max(1, Math.ceil((to - from) / STEP - 1e-9)));
    const step = (to - from) / count;
    const speeds = new Float64Array(count + 1);
    for (let edge = 0; edge <= count; edge += 1) speeds[edge] = sample(edge === count ? to : from + edge * step);
    const sums = new Float64Array(count + 1);
    for (let edge = 0; edge < count; edge += 1)
      sums[edge + 1] = sums[edge] + (step / 6) * (speeds[edge] + 4 * sample(from + (edge + 0.5) * step) + speeds[edge + 1]);
    pieces.push({ from, to, before, step, speeds, sums });
    before += sums[count];
  }
  const map = { start, pieces, sample };
  cache.set(key, map);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return map;
}

function pieceAt(map, clock) {
  let found = map.pieces[0];
  for (const piece of map.pieces) {
    if (piece.from > clock) break;
    found = piece;
  }
  return found;
}

// File seconds read from the start of Play until `clock` (on the layer's clock).
function readUntil(map, clock) {
  if (!(clock > map.start)) return 0;
  const piece = pieceAt(map, clock);
  if (piece.speed !== undefined) return piece.before + piece.speed * (clock - piece.from);
  const last = piece.sums.length - 1;
  if (clock >= piece.to) return piece.before + piece.sums[last];
  const edge = Math.min(last - 1, Math.floor((clock - piece.from) / piece.step));
  const from = piece.from + edge * piece.step;
  const width = clock - from;
  if (!(width > 0)) return piece.before + piece.sums[edge];
  return piece.before + piece.sums[edge] +
    (width / 6) * (piece.speeds[edge] + 4 * map.sample(from + width / 2) + map.sample(clock));
}

// The earliest clock time at which Play has read `amount` file seconds; Infinity when the speed
// drops to 0 for good before that.
function clockFor(map, amount) {
  if (!(amount > 0)) return map.start;
  for (const piece of map.pieces) {
    if (piece.speed !== undefined) {
      const after = Number.isFinite(piece.to) ? piece.before + piece.speed * (piece.to - piece.from) : (piece.speed > 0 ? Infinity : piece.before);
      if (amount > after) continue;
      return piece.speed > 0 ? piece.from + (amount - piece.before) / piece.speed : piece.from;
    }
    const last = piece.sums.length - 1;
    if (amount > piece.before + piece.sums[last]) continue;
    // The step it falls in, then halving inside that step.
    let low = 0;
    let high = last;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (piece.before + piece.sums[middle] >= amount) high = middle;
      else low = middle;
    }
    let early = piece.from + low * piece.step;
    let late = high === last ? piece.to : piece.from + high * piece.step;
    for (let round = 0; round < 48 && late - early > 1e-12; round += 1) {
      const middle = (early + late) / 2;
      if (readUntil(map, middle) >= amount) late = middle;
      else early = middle;
    }
    return late;
  }
  return Infinity;
}

/**
 * Seconds of the file that Play reads in its first `local` seconds (before mediaReverse turns
 * them around): speed × local for a constant speed, the area under the speed curve otherwise.
 */
export function fileSecondsPlayed(layer, local) {
  if (!(local > 0)) return 0;
  if (!speedAnimations(layer).length) return constantSpeed(layer) * local;
  const map = speedMap(layer);
  return readUntil(map, map.start + local);
}

/**
 * Seconds of Play needed to read `amount` seconds of the file: the inverse of fileSecondsPlayed.
 * Infinity when the speed drops to 0 and stays there before that much is read.
 */
export function playSecondsFor(layer, amount) {
  if (!(amount > 0)) return 0;
  if (!Number.isFinite(amount)) return Infinity;
  if (!speedAnimations(layer).length) return amount / constantSpeed(layer);
  const map = speedMap(layer);
  return clockFor(map, amount) - map.start;
}

/** The clip's speed at `clock` seconds on the layer's own clock (mediaSpeed with Speed animations). */
export function speedAtClock(layer, clock) {
  if (!speedAnimations(layer).length) return constantSpeed(layer);
  return speedMap(layer).sample(clock);
}

/**
 * The Play time a new picture of a choppy clip (mediaFrameRate) starts at: `local` rounded down
 * to a whole step of 1/rate s. `tolerance` lets a time that is a hair early (export frame times
 * are rounded) still count as the step it belongs to.
 */
export function steppedPlayTime(layer, local, tolerance = 0) {
  const rate = mediaFrameRateOf(layer);
  if (!(rate > 0) || !Number.isFinite(local)) return local;
  return Math.max(0, Math.floor((local + tolerance) * rate) / rate);
}
