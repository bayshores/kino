// Syncing two clips of the same moment by their sound (the edit op sync_clips).
//
// Two cameras, or a camera and a screen recording, hear the same things at the same moments:
// a beep from the phone, a word, a footstep, a door. Each file's sound becomes curves of how
// much new sound starts in each 10 ms frame ("onset envelopes"), and the curves of the two files
// are slid past each other: the shift where they line up best is the offset between the files.
//
// The steps, in order:
// 1. Onset envelopes (syncEnvelopes): a short spectrum every 10 ms, in 24 narrow bands from
//    150 Hz to 6 kHz (wind rumble and hiss are left out). For each band, how much louder it got
//    than the frame before, on a log scale, so a quiet far microphone and a loud near one give
//    the same rises. The slow part (anything steadier than half a second) is taken away and each
//    stretch of a few seconds is scaled to the same strength, so a loud passage cannot outweigh
//    the rest. The bands stay apart: a beep heard faintly in one band by a far phone is not
//    drowned by wind in the others.
// 2. Matching (matchEnvelopes): each band's correlation at every shift, found with an FFT and
//    divided by the strength of the parts that overlap at that shift (so a short clip inside a
//    long one scores fairly at every place), times the square root of the overlap (a long overlap
//    that agrees counts for more than a short one). A shift scores its best band. Shifts where
//    the clips overlap by less than half the shorter one (and 2 s) are not counted. The best
//    shift is refined between frames.
// 3. Confidence: how far the best shift stands out from the best other shift (one more than
//    0.25 s away): 1 - second / best. Repeating sounds (steady footsteps, a beat), two different
//    moments, or silence give no clear peak and a low confidence.
// On kino's first real test (a phone filming a walk with an app, beside the app's own screen
// recording) the right match scored 0.62 and five clips of other moments 0.16 or less.
//
// Pure: it takes samples and returns numbers, and applySyncClips places the layer.
// backend/clip-sync.mjs decodes the files with FFmpeg and keeps each file's envelopes beside it.
import { fft, movingAverage } from "./beatDetection.js";
import { changesSpeed, isReversed } from "./mediaTime.js";
import { effectiveMediaDuration, mediaPlaybackRange } from "./playback.js";
import { MAX_TIME } from "./schema.js";
import { MAX_CLIP_LINKS } from "./qualityFields.js";

export const SYNC_VERSION = 1;
/** Envelope frames per second (10 ms frames). */
export const SYNC_RATE = 100;
export const SYNC_SAMPLE_RATE = 16_000;
/** Below this confidence the clips are not matched: sync_clips refuses and changes nothing. */
export const SYNC_CONFIDENT = 0.4;

const FRAME = 512; // 32 ms window
const HOP = SYNC_SAMPLE_RATE / SYNC_RATE; // 160 samples, 10 ms
const BANDS = 24;
const LOW_HZ = 150;
const HIGH_HZ = 6000;
const SLOW = 25; // frames: the moving average taken away (0.5 s across)
const LEVEL = 150; // frames: the stretch each part is scaled against (3 s across)
const APART = 0.25; // seconds: the second-best shift is at least this far from the best

/** Step 1: onset envelopes of mono samples at SYNC_SAMPLE_RATE, SYNC_RATE values a second, one per band. */
export function syncEnvelopes(samples, sampleRate = SYNC_SAMPLE_RATE) {
  if (sampleRate !== SYNC_SAMPLE_RATE) throw new Error(`syncEnvelopes needs ${SYNC_SAMPLE_RATE} Hz samples.`);
  const count = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  // Band edges in FFT bins, evenly spaced on a log scale.
  const edges = [];
  for (let band = 0; band <= BANDS; band += 1) {
    const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (band / BANDS);
    edges.push(Math.max(1, Math.round((hz * FRAME) / sampleRate)));
  }
  const energy = new Float64Array(count * BANDS);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let frame = 0; frame < count; frame += 1) {
    const offset = frame * HOP;
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let band = 0; band < BANDS; band += 1) {
      let sum = 0;
      for (let bin = edges[band]; bin < Math.max(edges[band] + 1, edges[band + 1]); bin += 1) sum += re[bin] * re[bin] + im[bin] * im[bin];
      energy[frame * BANDS + band] = sum;
    }
  }
  // Each band's floor: its quietest tenth, so hiss below it makes no rises.
  const floors = new Float64Array(BANDS);
  for (let band = 0; band < BANDS; band += 1) {
    const values = [];
    for (let frame = 0; frame < count; frame += 4) values.push(energy[frame * BANDS + band]);
    values.sort((left, right) => left - right);
    floors[band] = Math.max(1e-10, values[Math.floor(values.length * 0.1)] ?? 0);
  }
  const envelopes = [];
  for (let band = 0; band < BANDS; band += 1) {
    const rises = new Float64Array(count);
    for (let frame = 1; frame < count; frame += 1) {
      const now = Math.log(floors[band] + energy[frame * BANDS + band]);
      const before = Math.log(floors[band] + energy[(frame - 1) * BANDS + band]);
      rises[frame] = Math.max(0, now - before);
    }
    envelopes.push(levelled(rises));
  }
  return envelopes;
}

// The quick part of a rise curve, each stretch scaled to the same strength, around zero.
function levelled(rises) {
  const slow = movingAverage(rises, SLOW);
  const fast = rises.map((value, i) => Math.max(0, value - slow[i]));
  const power = movingAverage(fast.map((value) => value * value), LEVEL);
  let mean = 0;
  for (const value of power) mean += value;
  mean = mean / (power.length || 1);
  const scaled = fast.map((value, i) => value / Math.sqrt(power[i] + mean * 0.05 + 1e-12));
  // Around zero everywhere (the local average taken away), so two unrelated stretches, or a
  // stretch of silence, score about 0.
  const local = movingAverage(scaled, SLOW);
  return Float32Array.from(scaled, (value, i) => value - local[i]);
}

function nextPowerOfTwo(value) {
  let size = 1;
  while (size < value) size <<= 1;
  return size;
}

// Prefix sums of squares, for the strength of the overlapping parts.
function squares(values) {
  const sums = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i += 1) sums[i + 1] = sums[i] + values[i] * values[i];
  return sums;
}

// The correlation of a[i + shift] with b[i] at every shift from -(b.length - 1) to a.length - 1,
// divided by the strength of the overlapping parts: index shift + b.length - 1.
function correlation(a, b) {
  const size = nextPowerOfTwo(a.length + b.length);
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(a);
  bRe.set(b);
  fft(aRe, aIm);
  fft(bRe, bIm);
  // A × conj(B), then the inverse FFT (conjugate, forward FFT; the answer is real).
  for (let i = 0; i < size; i += 1) {
    const re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    const im = aIm[i] * bRe[i] - aRe[i] * bIm[i];
    aRe[i] = re;
    aIm[i] = -im;
  }
  fft(aRe, aIm);
  const aSq = squares(a);
  const bSq = squares(b);
  const out = new Float64Array(a.length + b.length - 1);
  for (let shift = -(b.length - 1); shift < a.length; shift += 1) {
    const from = Math.max(0, -shift);
    const to = Math.min(b.length, a.length - shift);
    const strength = Math.sqrt((aSq[to + shift] - aSq[from + shift]) * (bSq[to] - bSq[from]));
    out[shift + b.length - 1] = strength > 1e-9 ? aRe[(shift + size) % size] / size / strength : 0;
  }
  return out;
}

/**
 * Steps 2 and 3. `a` and `b` are lists of envelopes (syncEnvelopes); the answer's `offset` is in
 * seconds: the moment at b's time T is a's time T + offset. `search` limits |offset - around|
 * (seconds; default every shift). Answers {offset, confidence, overlap} (overlap in seconds), or
 * {offset: null, reason} when no shift overlaps enough.
 */
export function matchEnvelopes(a, b, { search = Infinity, around = 0, rate = SYNC_RATE } = {}) {
  const aLength = a[0]?.length ?? 0;
  const bLength = b[0]?.length ?? 0;
  const shorter = Math.min(aLength, bLength);
  if (shorter < rate) return { offset: null, reason: "too short" };
  const minOverlap = Math.min(shorter, Math.max(2 * rate, Math.round(shorter / 2)));
  const curves = a.map((envelope, group) => correlation(envelope, b[group]));
  const lowest = Math.max(-(bLength - 1), Math.ceil((around - search) * rate));
  const highest = Math.min(aLength - 1, Math.floor((around + search) * rate));
  const scores = new Map();
  let best = null;
  for (let shift = lowest; shift <= highest; shift += 1) {
    const overlap = Math.min(bLength, aLength - shift) - Math.max(0, -shift);
    if (overlap < minOverlap) continue;
    const root = Math.sqrt(overlap);
    let score = -Infinity;
    for (const curve of curves) score = Math.max(score, curve[shift + bLength - 1] * root);
    scores.set(shift, score);
    if (!best || score > best.score) best = { shift, score, overlap };
  }
  if (!best) return { offset: null, reason: "no overlap" };
  let second = 0;
  for (const [shift, score] of scores) if (Math.abs(shift - best.shift) > APART * rate && score > second) second = score;
  // Between frames: the top of a parabola through the best score and its neighbors.
  const left = scores.get(best.shift - 1);
  const right = scores.get(best.shift + 1);
  let fine = best.shift;
  if (left !== undefined && right !== undefined) {
    const bend = left - 2 * best.score + right;
    if (bend < 0) fine += Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / bend));
  }
  const confidence = best.score > 0 ? Math.max(0, 1 - Math.max(0, second) / best.score) : 0;
  return { offset: fine / rate, confidence, overlap: best.overlap / rate };
}

// ---- the edit op -------------------------------------------------------------------------------

const SYNC_TYPES = new Set(["video", "audio"]);
const round = (seconds, places = 2) => Math.round(seconds * 10 ** places) / 10 ** places;
const fail = (message) => {
  throw new Error(`sync_clips: ${message}`);
};
// The constant part of a layer's file time at speed 1: file time = scene time + fileShift.
const fileShift = (layer) => Math.max(0, layer.mediaOffset ?? 0) - (layer.mediaStart ?? 0);

/** How the layer's file lines up with to's now: the layer's file time minus to's, at one scene time. */
export function currentLag(layer, to) {
  return fileShift(layer) - fileShift(to);
}

/** The scene, the layer and `to` of a sync_clips, checked; throws a plain reason. */
export function syncLayers(document, operation) {
  const scene = document.scenes.find((item) => item.id === operation.sceneId);
  if (!scene) fail(`scene ${operation.sceneId} was not found.`);
  const layer = scene.layers.find((item) => item.id === operation.layerId);
  const to = scene.layers.find((item) => item.id === operation.toId);
  if (!layer) fail(`layer ${operation.layerId} is not in this scene.`);
  if (!to) fail("to must name the other video or audio layer, in the same scene: the clip to play in step with.");
  if (layer.id === to.id) fail("layer and to are the same layer; give the other clip as to.");
  for (const item of [layer, to]) {
    if (!SYNC_TYPES.has(item.type) || !item.src) fail(`"${item.name}" is a ${item.type} layer; only video and audio layers can be synced.`);
    if (changesSpeed(item) || isReversed(item))
      fail(`"${item.name}" plays at another speed or backwards; sync clips at speed 1 (remove mediaSpeed, Speed animations and mediaReverse first).`);
  }
  return { scene, layer, to };
}

// What to do when the sound gives no answer (also used by the service for a file with no sound).
export const SYNC_FALLBACK =
  "Nothing was changed. Tell the person the clips could not be synced by sound and ask for a sync point (one moment seen or heard in both), or find one yourself with look {mode:\"source\", layer, t} on each clip (a tap, a screen change, a step), then send sync_clips with at: {layer: <seconds into its file>, to: <seconds into to's file>}.";

/**
 * Applies sync_clips {sceneId, layerId, toId, at? | match}: moves the layer's Play (mediaOffset,
 * and mediaStart when it must) so it plays in step with `to` wherever `to` sits. `match` is
 * matchEnvelopes' answer for the layer's sound against to's (the agent service puts it in); `at`
 * {layer, to} names one moment by its seconds into each file instead. Returns the receipt.
 */
export function applySyncClips(document, operation) {
  const { scene, layer, to } = syncLayers(document, operation);
  // lag: the layer's file time minus to's file time at the same moment.
  let lag;
  let how;
  if (operation.at !== undefined) {
    const at = operation.at;
    if (!at || typeof at !== "object" || !Number.isFinite(at.layer) || !Number.isFinite(at.to) || at.layer < 0 || at.to < 0)
      fail('at is {layer, to}: seconds into each clip\'s file that show the same moment, such as {"layer": 3.2, "to": 41.5}.');
    for (const [item, time] of [[layer, at.layer], [to, at.to]])
      if (item.mediaSourceDuration > 0 && time > item.mediaSourceDuration)
        fail(`at gives ${time} s for "${item.name}", but its file is ${round(item.mediaSourceDuration)} s long.`);
    lag = at.layer - at.to;
    how = { by: "at" };
  } else {
    const match = operation.match;
    const pair = `"${layer.name}" and "${to.name}"`;
    if (!match || !Number.isFinite(match.offset))
      fail(`${pair} overlap too little to be matched by sound (half of the shorter clip, and at least 2 s, must overlap). ${SYNC_FALLBACK}`);
    if (!(match.confidence >= SYNC_CONFIDENT)) {
      const guess = sameMoment(match.offset);
      fail(
        `${pair} could not be matched by sound: confidence ${round(match.confidence)}, needs ${SYNC_CONFIDENT}. The best guess (${guess.layer} s of "${layer.name}" = ${guess.to} s of "${to.name}") is barely better than other places, so they may not be the same moment. ${SYNC_FALLBACK}`,
      );
    }
    lag = match.offset;
    how = { by: "sound", confidence: round(match.confidence), overlap: round(match.overlap, 1) };
  }
  // In step: the layer's file time = to's file time + lag at every scene time.
  const shift = fileShift(to) + lag;
  const toRange = mediaPlaybackRange(to, scene.duration);
  if (!toRange) fail(`"${to.name}" does not play in this scene; check its mediaStart and mediaDuration.`);
  // Where the layer's file falls on the scene clock once in step, and where both play.
  const fileStart = -shift;
  const fileEnd = layer.mediaSourceDuration > 0 ? fileStart + layer.mediaSourceDuration : Infinity;
  const both = [Math.max(toRange.start, fileStart), Math.min(toRange.end, fileEnd)];
  if (!(both[1] > both[0]))
    fail(
      `in step, "${layer.name}" covers ${round(fileStart)}–${round(fileEnd)} s of the scene but "${to.name}" plays ${round(toRange.start)}–${round(toRange.end)} s, so they never play together. Lengthen or move "${to.name}", or lengthen the scene, then sync again.`,
    );
  const before = { mediaStart: layer.mediaStart ?? 0, mediaOffset: layer.mediaOffset ?? 0 };
  // Keep where the layer starts when its file has that moment; otherwise start where its file does.
  let start = before.mediaStart;
  if (start + shift < 0 || start >= fileEnd) start = Math.max(0, fileStart);
  if (start > MAX_TIME) fail(`in step, "${layer.name}" would start after ${MAX_TIME} s, past the longest scene.`);
  layer.mediaStart = round(start, 3);
  layer.mediaOffset = round(Math.max(0, start + shift), 3);
  const plays = effectiveMediaDuration(layer);
  const layerEnd = Number.isFinite(plays) ? layer.mediaStart + plays : scene.duration;
  const inStep = [round(Math.max(both[0], layer.mediaStart)), round(Math.min(both[1], layerEnd))];
  const moment = sameMoment(lag);
  const report = {
    layer: layer.name,
    to: to.name,
    ...how,
    same: `${moment.layer} s of "${layer.name}" = ${moment.to} s of "${to.name}"`,
    mediaStart: before.mediaStart === layer.mediaStart ? layer.mediaStart : `${before.mediaStart} → ${layer.mediaStart}`,
    mediaOffset: before.mediaOffset === layer.mediaOffset ? layer.mediaOffset : `${before.mediaOffset} → ${layer.mediaOffset}`,
  };
  if (inStep[1] > inStep[0]) report.inStep = `${inStep[0]}–${inStep[1]} s of the scene`;
  else report.note = `"${layer.name}" does not play while "${to.name}" does; give it a longer mediaDuration.`;
  // Kept by file, so every layer of either file (copies, later cuts) knows they were filmed together.
  recordClipLink(document, { a: to.src, b: layer.src, lag: round(lag, 3), ...(how.confidence !== undefined ? { confidence: how.confidence } : {}) });
  return report;
}

// ---- links between files ----------------------------------------------------------------------
//
// document.clipLinks [{a, b, lag, confidence?}]: files a and b (media src) were recorded together,
// and a at t seconds is the same moment as b at t + lag. sync_clips writes one; the out_of_sync
// check (engine/quality/rules/sync.js) reads them. engine/qualityFields.js validates the list.

/** Saves the link between two files, replacing an older one between the same two. */
export function recordClipLink(document, link) {
  if (!link.a || !link.b || link.a === link.b) return;
  const others = (document.clipLinks ?? []).filter((old) => !((old.a === link.a && old.b === link.b) || (old.a === link.b && old.b === link.a)));
  document.clipLinks = [...others, link].slice(-MAX_CLIP_LINKS);
}

/**
 * A file made from another with the same timing (isolate_voice, cut_out) gets every link of the
 * original, so out_of_sync keeps checking the new file against the files filmed with it.
 */
export function aliasClipLinks(document, fromSrc, toSrc) {
  if (!fromSrc || !toSrc || fromSrc === toSrc) return;
  for (const link of [...(document.clipLinks ?? [])]) {
    if (link.a === fromSrc && link.b !== toSrc) recordClipLink(document, { ...link, a: toSrc });
    else if (link.b === fromSrc && link.a !== toSrc) recordClipLink(document, { ...link, b: toSrc });
  }
}

/** The lag between files x and y (x at t = y at t + lag), or null when they are not linked. */
export function linkLag(links, x, y) {
  for (const link of links ?? []) {
    if (link.a === x && link.b === y) return link.lag;
    if (link.a === y && link.b === x) return -link.lag;
  }
  return null;
}

// One moment the two files share, as seconds into each: where they start to overlap.
function sameMoment(lag) {
  const to = Math.max(0, -lag);
  return { layer: round(to + lag), to: round(to) };
}
