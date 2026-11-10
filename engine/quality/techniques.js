// Finds which techniques (engine/techniques.js) a video uses, from the quality model (model.js):
// techniquesUsed(model) answers { tag: [{ at, itemId? }] }, every place each tag is used, by time.
//
// It reads only the document, never the pixels, so it finds what kino itself drew: a dissolve is
// two full-frame pictures whose opacities cross, a slow push is a slow scale of a large picture,
// type-words is a text entrance by words with a stagger. What it cannot see honestly it leaves
// out instead of guessing (techniques.js marks those detect:false):
//   match-cut (needs the shapes in the picture), speed-lines (no effect for it yet),
//   and the set pieces with no mark in the document (clip-field, device-in-scene). Set pieces built
//   by moves are read from the scene's move records (scene.moves, with their tags).
// A dissolve is found two ways: full-frame pictures that cross (transitions), and floating clips
// that fade one into the other in the same place (crossfades).
// The set pieces it finds itself: split-screen (two clips side by side), screen-zoom (a video,
// or a group holding one, pushed in 2x or more so one detail fills the frame) and type-behind
// (readable text between a clip and the cut-out of that clip, cutoutOf, over it).
import { PARTICLE_LOOKS } from "../effects/particles.js";
import { coversFrame, cuts, drawnSize, entrances, maxOpacity, motions, readingTexts, scaleOf, sec, speechTimed, speedAt } from "./analysis.js";
import { area, boxAt, chainOf, intersection, itemById, overlapArea } from "./model.js";

// ---------------------------------------------------------------- shared measures

const memo = (model, key, make) => {
  model._memo ??= new Map();
  if (!model._memo.has(key)) model._memo.set(key, make());
  return model._memo.get(key);
};

const FRAME = (model) => ({ x0: 0, y0: 0, x1: model.width, y1: model.height });
const round2 = (value) => Math.round(value * 100) / 100;
/** The share of the frame (0 to 1) the item's box covers at a sample, inside the frame. */
const frameShare = (model, item, index) => area(intersection(boxAt(item, index), FRAME(model))) / (model.width * model.height);
const indexOf = (model, time) => Math.max(0, Math.min(model.times.length - 1, Math.round(time * model.fps)));
const SCALE_KEYS = new Set(["scaleX", "scaleY"]);
const PLACE_KEYS = new Set(["x", "y"]);
const presetOf = (motion) => motion.tweens.find((tween) => tween.preset)?.preset ?? null;
const keysOf = (motion) => new Set(motion.tweens.flatMap((tween) => tween.keys));
const PARTICLE_KEYS = new Set(Object.keys(PARTICLE_LOOKS).filter((key) => key !== "light-leaks"));
const LIGHT_KEYS = new Set(["light-leaks", "light-rays", "lens-flare"]);
const MOTION_BLUR_KEYS = new Set(["directional-blur", "zoom-blur", "spin-blur"]);

/**
 * The ID base of the motion blur keys judder's auto fix adds to a layer for the stretch that
 * starts at `start` s (backend/agent/quality.mjs numbers them .1, .2 ...). That blur only makes a
 * pan read at 30 fps, as a camera shutter would: it is no technique of the video's style.
 */
export const judderBlurId = (layerId, start) => `${layerId}.motion-blur-${Math.round(start * 100)}`;
const JUDDER_BLUR_ID = /\.motion-blur-\d+\.\d+(-\d+)?$/;
const isJudderBlur = (effect) => JUDDER_BLUR_ID.test(effect.animationId ?? "");

/**
 * Plates: the pictures that fill the frame (a video, an image, an opaque full-frame shape). The
 * top plate at a time is the picture the viewer sees as "the shot". The scene's own background is
 * not a plate: it is what shows when no plate does (a fade through black, a text card).
 */
export function plates(model) {
  return memo(model, "plates", () => model.items.filter((item) => !item.isMask && item.kind !== "text" && item.kind !== "group" && !item.source?.sceneBackground
    && (item.kind === "video" || item.kind === "image" || item.opaque) && coversFrame(model, item)));
}

/** The scene background's brightness (0 to 1) at a sample; 0 when there is none (it renders dark). */
export function backgroundLuma(model, index) {
  const background = model.items.find((item) => item.source?.sceneBackground);
  const luma = background?.samples.luma[index];
  return Number.isFinite(luma) && background.samples.opacity[index] > 0.05 ? luma : 0;
}

/** True when an opaque full-frame picture above the item hides it at a sample. */
export function coveredAt(model, item, index) {
  return plates(model).some((plate) => plate.z > item.z && plate.samples.opacity[index] * (plate.paintAlpha ?? 1) >= 0.9 && !chainOf(model, item).includes(plate));
}

// The top plate fully shown (opacity 0.9 or more) at a sample, or null.
function topPlate(model, index) {
  let top = null;
  for (const item of plates(model)) if (item.samples.opacity[index] >= 0.9 && (!top || item.z > top.z)) top = item;
  return top;
}

/**
 * Shot changes: the times the top plate changes (one full-frame picture gives way to another), as
 * [{ index, at, from, to }] with the plates' item IDs. Changes within 0.3 s are one change.
 */
export function plateChanges(model) {
  return memo(model, "plateChanges", () => {
    const found = [];
    let previous = topPlate(model, 0);
    for (let index = 1; index < model.times.length; index += 1) {
      const current = topPlate(model, index);
      if (current?.id === previous?.id) continue;
      if (current && previous) {
        const last = found.at(-1);
        if (last && model.times[index] - last.at < 0.3) last.to = current.id;
        else found.push({ index, at: model.times[index], from: previous.id, to: current.id });
      }
      if (current) previous = current;
    }
    return found;
  });
}

// A window of sample indexes around a time: [from, to], inclusive.
const windowAround = (model, time, before, after) => [indexOf(model, time - before), indexOf(model, time + after)];

// The largest scale ratio an item reaches in the window over where it started (or, `falling`, how
// much larger it starts than it ends): a zoom through it. A landing from larger is already
// shrinking as the window starts; one that grows first and shrinks later (a picture pushed in,
// then shrunk into a tile ring half a second after the change) is not a landing.
function scaleChange(item, [from, to], falling = false) {
  const { scale, opacity } = item.samples;
  const shown = [];
  for (let index = from; index <= to; index += 1) if (opacity[index] > 0.05) shown.push(scale[index]);
  if (shown.length < 2) return 1;
  if (!falling) return Math.max(...shown) / Math.max(1e-6, shown[0]);
  // The run of samples from the start in which it does not grow.
  let end = 1;
  while (end < shown.length && shown[end] <= shown[end - 1] + 1e-4) end += 1;
  return shown[0] / Math.max(1e-6, Math.min(...shown.slice(0, end)));
}

const fastestSpeed = (model, item, [from, to]) => {
  let fastest = 0;
  for (let index = from; index <= to; index += 1) if (item.samples.opacity[index] > 0.05) fastest = Math.max(fastest, speedAt(model, item, index));
  return fastest;
};

// The direction (-1, 0 or 1) an item's center travels across the window, along x.
function travelX(item, [from, to]) {
  const { x0, x1 } = item.samples;
  const moved = (x0[to] + x1[to] - x0[from] - x1[from]) / 2;
  return Math.abs(moved) < 1 ? 0 : Math.sign(moved);
}

// The motions of an item and every group it is inside that overlap a window of time.
function motionsNear(model, item, start, end) {
  const ids = new Set(chainOf(model, item).map((entry) => entry.id));
  return motions(model).filter((motion) => ids.has(motion.itemId) && motion.start <= end && motion.end >= start);
}

const effectsNear = (model, ids, start, end, keys) => (model.effects ?? []).filter((effect) => ids.has(effect.itemId) && keys.has(effect.effect) && effect.start <= end && effect.end >= start && !isJudderBlur(effect));

// ---------------------------------------------------------------- transitions

/**
 * What each shot change is: [{ at, tag, itemId }], tag one of the transition tags (cut,
 * dissolve, fade-black, blur-through, zoom-through, whip-pan, mask-wipe, glitch-hit, flash,
 * push-transition), or null when the change is neither instant nor one of them.
 */
export function transitions(model) {
  return memo(model, "transitions", () => plateChanges(model).map((change) => ({ at: change.at, tag: transitionAt(model, change), itemId: change.to, from: change.from })));
}

function transitionAt(model, change) {
  const a = itemById(model, change.from);
  const b = itemById(model, change.to);
  const s = scaleOf(model);
  const near = windowAround(model, change.at, 0.8, 0.8);
  const before = windowAround(model, change.at, 0.8, 0);
  const after = windowAround(model, change.at, 0, 0.8);
  const ids = new Set([...chainOf(model, a), ...chainOf(model, b)].map((item) => item.id));
  const nearMotions = [...motionsNear(model, a, change.at - 0.8, change.at + 0.1), ...motionsNear(model, b, change.at - 0.1, change.at + 0.8)];

  // A glitch on either picture at the change.
  if (nearMotions.some((motion) => presetOf(motion) === "glitch")) return "glitch-hit";
  // A large fast zoom: the old picture grows 25% or more into the change, or the new one lands from 25% larger.
  if (scaleChange(a, before) >= 1.25 || scaleChange(b, after, true) >= 1.25) return "zoom-through";
  // A slide of whole pictures (speeds in frame widths a second). Both travel the same way: a push,
  // or a whip when a directional blur smears it. One alone: a whip when it is blurred or very fast.
  const fastA = fastestSpeed(model, a, before);
  const fastB = fastestSpeed(model, b, after);
  const blurred = effectsNear(model, ids, change.at - 0.6, change.at + 0.6, new Set(["directional-blur"])).length > 0;
  if (fastA >= 0.3 && fastB >= 0.3 && travelX(a, before) !== 0 && travelX(a, before) === travelX(b, after)) return blurred ? "whip-pan" : "push-transition";
  if (Math.max(fastA, fastB) >= 1 && (blurred || Math.max(fastA, fastB) >= 2.5)) return "whip-pan";
  // A wipe or a mask reveals the new picture: a wipe preset, a reveal, or a mask over it that moves.
  if (nearMotions.some((motion) => ["wipe", "mask"].includes(presetOf(motion)) || keysOf(motion).has("reveal"))) return "mask-wipe";
  const masks = (b.clipIds ?? []).map((id) => itemById(model, id)).filter((clip) => clip?.isMask);
  if (masks.some((mask) => motionsNear(model, mask, change.at - 0.3, change.at + 0.8).length)) return "mask-wipe";
  // A blur out of the old picture or into the new one.
  const blurAt = (item, index) => Math.max(item.samples.blur[index] ?? 0, item.blur ?? 0);
  const peakBlur = (item, [from, to]) => { let best = 0; for (let index = from; index <= to; index += 1) if (item.samples.opacity[index] > 0.05) best = Math.max(best, blurAt(item, index)); return best; };
  const restBlur = Math.max(blurAt(a, before[0]), blurAt(b, after[1]));
  if (Math.max(peakBlur(a, before), peakBlur(b, after)) >= Math.max(6 * s, restBlur + 6 * s)) return "blur-through";
  // A gradual change: opacities in between for 0.15 s or more.
  let between = 0;
  let overlap = 0;
  for (let index = near[0]; index <= near[1]; index += 1) {
    const oa = a.samples.opacity[index];
    const ob = b.samples.opacity[index];
    const changing = (oa > 0.05 && oa < 0.95) || (ob > 0.05 && ob < 0.95);
    if (!changing) continue;
    between += 1;
    if (oa > 0.05 && ob > 0.05) overlap += 1;
  }
  if (between >= 0.15 * model.fps) {
    if (overlap >= 0.1 * model.fps) return "dissolve";
    return darkUnder(model, change) ? "fade-black" : null;
  }
  // A short bright frame between them.
  if (flashNear(model, change.at)) return "flash";
  return "cut";
}

/**
 * Dissolves between pictures that do not fill the frame (floating clips, screen recordings in a
 * frame): one fades out while another fades in over the same place, as [{ at, itemId }].
 */
export function crossfades(model) {
  return memo(model, "crossfades", () => {
    const pictures = new Set(model.items.filter((item) => !item.isMask && (item.kind === "video" || item.kind === "image") && !plates(model).includes(item)).map((item) => item.id));
    const fades = motions(model).filter((motion) => pictures.has(motion.itemId) && motion.duration >= 0.15 && keysOf(motion).has("opacity")).map((motion) => {
      const item = itemById(model, motion.itemId);
      const [from, to] = [indexOf(model, motion.start), indexOf(model, motion.end)];
      return { motion, item, from, to, rising: item.samples.opacity[to] > item.samples.opacity[from] + 0.3, falling: item.samples.opacity[from] > item.samples.opacity[to] + 0.3 };
    });
    const found = [];
    for (const fadeIn of fades.filter((fade) => fade.rising)) {
      const partner = fades.find((fade) => fade.falling && fade.item.id !== fadeIn.item.id
        && Math.min(fade.motion.end, fadeIn.motion.end) - Math.max(fade.motion.start, fadeIn.motion.start) >= 0.1
        && overlapArea(boxAt(fade.item, fade.from), boxAt(fadeIn.item, fadeIn.to)) >= 0.5 * Math.min(area(boxAt(fade.item, fade.from)), area(boxAt(fadeIn.item, fadeIn.to))));
      if (partner && frameShare(model, fadeIn.item, fadeIn.to) >= 0.15) found.push({ at: fadeIn.motion.start, itemId: fadeIn.item.id });
    }
    return found;
  });
}

// True when what shows under the fading pictures is dark: the scene background or a plate below.
function darkUnder(model, change) {
  const a = itemById(model, change.from);
  const b = itemById(model, change.to);
  const lowest = Math.min(a.z, b.z);
  const index = indexOf(model, change.at);
  const under = plates(model).filter((item) => item.z < lowest && item.samples.opacity[index] >= 0.5).sort((x, y) => y.z - x.z)[0];
  if (under) return Number.isFinite(under.samples.luma[index]) && under.samples.luma[index] <= 0.15;
  return backgroundLuma(model, index) <= 0.15;
}

function flashNear(model, time) {
  return plates(model).some((item) => {
    const [from, to] = windowAround(model, time, 0.3, 0.3);
    for (let index = from; index <= to; index += 1) {
      if (!(item.samples.opacity[index] >= 0.5 && item.samples.luma[index] >= 0.85)) continue;
      let length = 0;
      for (let next = index; next < model.times.length && item.samples.opacity[next] >= 0.5; next += 1) length += 1;
      return length / model.fps <= 0.35;
    }
    return false;
  });
}

// ---------------------------------------------------------------- pulses (beat kicks)

/**
 * Small scale pulses: something already on screen grows 1% to 10% within 0.2 s and is back
 * (within a third of the pulse) about 0.4 s after it began to grow, as [{ at, amount, itemId }]
 * (amount 0.04 = 4%). A layer that lands from larger as it appears, or shrinks over a whole bar,
 * is not a pulse. Pulses at the same time (a group and the layers in it) are one pulse.
 */
export function pulses(model) {
  return memo(model, "pulses", () => {
    const found = [];
    const rise = Math.max(1, Math.round(0.2 * model.fps));
    const whole = Math.max(2, Math.round(0.45 * model.fps));
    const last = model.times.length - 1;
    for (const item of model.items) {
      if (item.isMask || maxOpacity(item) < 0.3) continue;
      const { scale, opacity } = item.samples;
      for (let index = 1; index < last; index += 1) {
        // A peak: shown, and shown before, larger than the sample before, not smaller than the next.
        if (opacity[index] < 0.5 || opacity[index - 1] < 0.5 || !(scale[index] > scale[index - 1] + 1e-4) || scale[index] < scale[index + 1] - 1e-4) continue;
        // Where it grew from: the smallest it was, shown, in the 0.2 s before the peak.
        let from = index - 1;
        for (let back = index - 1; back >= Math.max(0, index - rise) && opacity[back] >= 0.5; back -= 1) if (scale[back] < scale[from]) from = back;
        const rest = scale[from];
        const amount = scale[index] / Math.max(1e-6, rest) - 1;
        if (amount < 0.01 || amount > 0.105) continue;
        // Back within a third of the pulse, shown all the while, about 0.4 s after it began.
        let back = -1;
        for (let next = index + 1; next <= Math.min(last, from + whole) && opacity[next] >= 0.5; next += 1)
          if (scale[next] / rest - 1 <= amount / 3) { back = next; break; }
        if (back < 0) continue;
        found.push({ at: model.times[index], amount: Math.round(amount * 100) / 100, itemId: item.id, z: item.z });
      }
    }
    found.sort((x, y) => x.at - y.at || x.z - y.z);
    // One pulse per moment: the outermost layer that pulses (the group) speaks for the rest.
    const merged = [];
    for (const pulse of found) {
      const previous = merged.at(-1);
      if (previous && pulse.at - previous.at <= 1.5 / model.fps) continue;
      merged.push({ at: pulse.at, amount: pulse.amount, itemId: pulse.itemId });
    }
    return merged;
  });
}

/**
 * Zoom punches for effect_fit: every scale pulse of something on screen, of any size, one at a
 * time (a kick run is not needed), as [{ at, peak, amount, itemId, animationIds }]. `at` is where
 * the rise starts (a punch that rises over frames from its cue is on the cue), `peak` its top.
 */
export function punches(model) {
  return memo(model, "punches", () => {
    const found = [];
    const rise = Math.max(1, Math.round(0.2 * model.fps));
    const whole = Math.max(2, Math.round(0.45 * model.fps));
    const last = model.times.length - 1;
    for (const item of model.items) {
      if (item.isMask || maxOpacity(item) < 0.3) continue;
      const { scale, opacity } = item.samples;
      for (let index = 1; index < last; index += 1) {
        if (opacity[index] < 0.5 || opacity[index - 1] < 0.5 || !(scale[index] > scale[index - 1] + 1e-4) || scale[index] < scale[index + 1] - 1e-4) continue;
        let from = index - 1;
        for (let back = index - 1; back >= Math.max(0, index - rise) && opacity[back] >= 0.5; back -= 1) if (scale[back] < scale[from]) from = back;
        const amount = scale[index] / Math.max(1e-6, scale[from]) - 1;
        if (amount < 0.01) continue;
        let back = -1;
        for (let next = index + 1; next <= Math.min(last, from + whole) && opacity[next] >= 0.5; next += 1) if (scale[next] / scale[from] - 1 <= amount / 3) { back = next; break; }
        if (back < 0) continue;
        // The short scale animations that make it (they start between its rise and its peak).
        const [start, peak] = [model.times[from], model.times[index]];
        const chain = new Set(chainOf(model, item).map((entry) => entry.id));
        const own = model.tweens.filter((tween) => chain.has(tween.itemId) && tween.keys.some((key) => SCALE_KEYS.has(key)) && tween.duration <= 0.5
          && tween.start >= start - 0.05 && tween.start <= peak + 0.05);
        const animationIds = [...new Set(own.map((tween) => tween.source?.animationId).filter(Boolean))];
        // It starts where its first animation does, else at the last sample before it grew.
        const at = own.length ? Math.max(start, Math.min(...own.map((tween) => tween.start))) : start;
        found.push({ at, peak, amount: Math.round(amount * 100) / 100, itemId: item.id, z: item.z, animationIds });
      }
    }
    found.sort((x, y) => x.peak - y.peak || x.z - y.z);
    return found.filter((pulse, index) => !index || pulse.peak - found[index - 1].peak > 1.5 / model.fps).map(({ z, ...pulse }) => pulse);
  });
}

// The longest a hand-made exposure lift may rise, and a hard grade may hold, to read as a hit.
const LIFT_RISE = 0.2;
const HIT_FRAMES = 4;

/**
 * Loud accents made by hand that no move record names: an exposure lift and fall (color-grade
 * stops up then down) is a flash, a short wiggle or oscillate of the layer's place is a shake, a
 * threshold-color of 4 frames or less is an impact frame (a flash). The animations a move that
 * names its cue made (impact-accent, move.trigger) are left to its record. [{ tag, at, itemId, extra }].
 */
function handAccents(model) {
  const triggered = (model.moves ?? []).filter((move) => move.trigger).map((move) => `${move.id}.`);
  const ownAccent = (entry) => Boolean(entry.animationId) && triggered.some((prefix) => entry.animationId.startsWith(prefix));
  const stops = (values) => (Number.isFinite(values?.stops) ? values.stops : 0);
  const found = [];
  const effects = (model.effects ?? []).filter((effect) => !ownAccent(effect));
  for (const up of effects.filter((effect) => effect.effect === "color-grade")) {
    const lift = stops(up.to) - stops(up.from);
    if (lift < 0.4 || up.end - up.start > LIFT_RISE + 1e-3) continue;
    const down = effects.find((effect) => effect !== up && effect.itemId === up.itemId && effect.effect === "color-grade" && Math.abs(effect.start - up.end) <= 0.05
      && stops(effect.to) <= stops(up.from) + lift / 3 && effect.end - up.start <= 0.6);
    if (!down) continue;
    found.push({ tag: "flash", at: up.end, itemId: up.itemId, animationIds: [up.animationId, down.animationId], extra: { strength: round2(Math.min(1, stops(up.to) / 2)), frames: Math.max(1, Math.round((down.end - up.start) * 30)), shape: "decay" } });
  }
  for (const hit of effects.filter((effect) => effect.effect === "threshold-color" && effect.end - effect.start <= HIT_FRAMES / 30 + 0.006))
    found.push({ tag: "flash", at: hit.start, itemId: hit.itemId, animationIds: [hit.animationId], extra: { strength: 1, frames: Math.max(1, Math.round((hit.end - hit.start) * 30)), shape: "frame" } });
  for (const shake of (model.behaviors ?? []).filter((entry) => !ownAccent(entry) && entry.end - entry.start <= 0.5)) {
    found.push({ tag: "shake", at: shake.start, itemId: shake.itemId, animationIds: [shake.animationId], extra: { strength: round2(Math.min(1.5, shake.amount / (0.02 * model.width))),
      frames: Math.max(1, Math.round((shake.end - shake.start) * 30)), shape: shake.decay >= 6 ? "decay" : "steady", rate: round2(shake.rate) } });
  }
  return found.map((entry) => ({ ...entry, extra: { ...entry.extra, animationIds: entry.animationIds.filter(Boolean) } }));
}

// ---------------------------------------------------------------- screen zoom

// The share of the frame (0 to 1) an item shows at a sample: its box inside the frame and inside
// every group or mask that clips it (a screen recording masked to a drawn phone's screen).
function visibleShare(model, item, index) {
  let box = intersection(boxAt(item, index), FRAME(model));
  for (const clipId of item.clipIds ?? []) {
    const clip = itemById(model, clipId);
    if (clip) box = intersection(box, boxAt(clip, index));
  }
  return area(box) / (model.width * model.height);
}

/**
 * Zooms into a screen: a video (alone, or in a group such as a drawn phone) is scaled up 2x or
 * more within about 1 s, from under half the frame to most of it, so one detail fills the frame,
 * and then holds or pulls back (it does not keep growing). [{ at, itemId }], itemId the layer
 * that is scaled.
 */
export function screenZooms(model) {
  return memo(model, "screenZooms", () => {
    const found = [];
    const last = model.times.length - 1;
    const videos = model.items.filter((item) => item.kind === "video" && !item.isMask);
    for (const motion of motions(model)) {
      if (motion.duration > 1.2 || ![...keysOf(motion)].some((key) => SCALE_KEYS.has(key))) continue;
      const scaled = itemById(model, motion.itemId);
      // The samples just before it starts and just after it ends (a long scene is sampled 15 times a second).
      const from = Math.max(0, Math.floor(motion.start * model.fps));
      const to = Math.min(last, Math.ceil(motion.end * model.fps));
      const after = Math.min(last, to + Math.round(0.4 * model.fps));
      const zoomed = videos.find((video) => {
        if (!chainOf(model, video).includes(scaled) || video.samples.opacity[to] < 0.5) return false;
        const { scale } = video.samples;
        if (scale[to] < 2 * scale[from]) return false;
        for (let index = to; index <= after; index += 1) if (scale[index] > 1.15 * scale[to]) return false;
        return visibleShare(model, video, from) < 0.5 && visibleShare(model, video, to) >= 0.5;
      });
      if (zoomed && !found.some((entry) => Math.abs(entry.at - motion.start) < 0.5)) found.push({ at: motion.start, itemId: scaled.id });
    }
    return found;
  });
}

// ---------------------------------------------------------------- beat kicks

// A beat-kick is a habit, not one hit: the pulses of a layer that pulses at least KICK_RUN times,
// each within KICK_GAP seconds of the one before (a scale hit once is not a kick).
const KICK_RUN = 3;
const KICK_GAP = 2.5;
function kicks(model) {
  const byItem = new Map();
  for (const pulse of pulses(model)) byItem.set(pulse.itemId, [...(byItem.get(pulse.itemId) ?? []), pulse]);
  const found = [];
  for (const list of byItem.values()) {
    let run = [list[0]];
    for (const pulse of [...list.slice(1), null]) {
      if (pulse && pulse.at - run.at(-1).at <= KICK_GAP) { run.push(pulse); continue; }
      if (run.length >= KICK_RUN) found.push(...run);
      if (pulse) run = [pulse];
    }
  }
  return found.sort((x, y) => x.at - y.at);
}

// ---------------------------------------------------------------- type

export const TEXT_PRESET_TAGS = { fade: "type-fade", appear: "type-cut", slide: "type-slide", grow: "type-pop", mask: "type-mask-rise", wipe: "type-mask-rise", blur: "type-blur-in", "blur-slide": "type-blur-in" };
const byUnit = (tween, units) => units.includes(tween.unit) && (tween.stagger ?? 0) > 0;

/**
 * How each reading text comes on screen: [{ itemId, at, tag }], tag one of the type-* entrance
 * tags (type-cut, type-fade, type-slide, type-pop, type-words, type-letters, type-mask-rise,
 * type-blur-in), or null for an entrance it cannot name (a glitch, a color change).
 */
export function textEntrances(model) {
  return memo(model, "textEntrances", () => {
    const timed = speechTimed(model);
    const all = readingTexts(model).flatMap((item) => {
      const first = item.samples.opacity.findIndex((value) => value > 0.05);
      if (first < 0) return [];
      const at = model.times[first];
      const step = 1 / model.fps;
      const own = entrances(model).find((motion) => motion.itemId === item.id);
      const starting = motionsNear(model, item, at - step, at + step).filter((motion) => Math.abs(motion.start - at) <= 1.5 * step || motion === own);
      return [{ itemId: item.id, at, tag: entranceTag(model, item, starting, first), move: timed.has(item.id) ? "voice captions" : item.move }];
    });
    // The texts one move made with one entrance (caption-words makes a layer per word group) are
    // one entrance, at the first of them, so a move's captions count once; so are the voice's
    // captions (add_captions), each phrase shown as it is said.
    const seen = new Set();
    return [...all].sort((a, b) => a.at - b.at).filter((entry) => {
      if (!entry.move) return true;
      const key = `${entry.move}\n${entry.tag}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(({ move, ...entry }) => entry);
  });
}

function entranceTag(model, item, starting, first) {
  const tweens = starting.flatMap((motion) => motion.tweens);
  if (tweens.some((tween) => byUnit(tween, ["words", "word"]))) return "type-words";
  if (tweens.some((tween) => byUnit(tween, ["letters", "letter", "characters"]))) return "type-letters";
  const presets = starting.map(presetOf).filter(Boolean);
  for (const preset of presets) if (TEXT_PRESET_TAGS[preset]) return TEXT_PRESET_TAGS[preset];
  if (presets.includes("glitch")) return null;
  // Lines sliding up out of a text clip (headline-reveal "lines") are a mask rise.
  if (tweens.some((tween) => tween.textClip)) return "type-mask-rise";
  const keys = new Set(tweens.flatMap((tween) => tween.keys));
  if (keys.has("reveal")) return "type-mask-rise";
  if (keys.has("y") && item.clipIds?.length) return "type-mask-rise";
  if (keys.has("blur")) return "type-blur-in";
  if ([...keys].some((key) => SCALE_KEYS.has(key))) return "type-pop";
  if ([...keys].some((key) => PLACE_KEYS.has(key))) return "type-slide";
  if (keys.size && [...keys].every((key) => key === "opacity" || key === "visible")) {
    // A fade that takes one sample or less is a cut.
    return starting.some((motion) => motion.duration > 1.5 / model.fps && keysOf(motion).has("opacity")) ? "type-fade" : "type-cut";
  }
  // Nothing animates it in: it is fully there at its first sample, or close to it.
  const { opacity } = item.samples;
  const settled = opacity[Math.min(opacity.length - 1, first + 1)] >= 0.9 * maxOpacity(item);
  return settled ? "type-cut" : null;
}

// ---------------------------------------------------------------- the finder

/**
 * Every technique the model shows, as { tag: [{ at, itemId? }] } (seconds, by time). Tags with no
 * use are left out. With a rhythm, cuts on the beat are also beat-cut and cuts clearly between
 * beats are syncopated.
 */
export function techniquesUsed(model) {
  return memo(model, "techniquesUsed", () => {
    const found = {};
    // `extra` describes a loud accent: strength (0 to 1 of the most it should be), frames (at 30 fps)
    // and shape (decay, steady, pulse), so effect_fit can size it against what triggers it.
    const add = (tag, at, itemId, extra = null) => { (found[tag] ??= []).push({ at: sec(at), ...(itemId ? { itemId } : {}), ...(extra ?? {}) }); };
    const s = scaleOf(model);
    const step = 1 / model.fps;

    // Transitions at each shot change. A glitch anywhere (an icon's entrance) is a glitch hit too.
    const changes = transitions(model);
    for (const change of changes) if (change.tag) add(change.tag, change.at, change.itemId);
    for (const fade of crossfades(model)) if (!found.dissolve?.some((entry) => Math.abs(entry.at - fade.at) < 0.3)) add("dissolve", fade.at, fade.itemId);
    const glitchTimes = new Set(changes.filter((change) => change.tag === "glitch-hit").map((change) => sec(change.at)));
    for (const motion of motions(model)) if (presetOf(motion) === "glitch" && !glitchTimes.has(sec(motion.start))) { glitchTimes.add(sec(motion.start)); add("glitch-hit", motion.start, motion.itemId); }
    // A flash that is not at a shot change: a light full-frame shape shown 0.35 s or less, or a
    // shape of any color that comes up within 2 frames and is gone within 0.15 s (a red frame).
    for (const item of plates(model)) {
      const { opacity, luma } = item.samples;
      const card = item.kind !== "video" && item.kind !== "image";
      for (let index = 0; index < model.times.length; index += 1) {
        const light = luma[index] >= 0.85;
        const spike = card && (index < 2 || opacity[index - 2] < 0.1);
        if (!(opacity[index] >= 0.5 && (light || spike)) || (index && opacity[index - 1] >= 0.5)) continue;
        let length = 0;
        let peak = 0;
        while (index + length < model.times.length && opacity[index + length] >= 0.5) { peak = Math.max(peak, opacity[index + length] * (light ? luma[index + length] ?? 0 : 1)); length += 1; }
        if (length / model.fps <= (light ? 0.35 : 0.15) && !found.flash?.some((entry) => Math.abs(entry.at - model.times[index]) < 0.4))
          add("flash", model.times[index], item.id, { strength: round2(peak), frames: Math.max(1, Math.round((length / model.fps) * 30)), shape: "card" });
      }
    }

    // The cuts the shot changes do not cover: most of what was on screen gone at once.
    const cutTimes = changes.filter((change) => change.tag === "cut").map((change) => change.at);
    const allCuts = [...cutTimes];
    for (const time of contentCuts(model)) if (!changes.some((change) => Math.abs(change.at - time) < 0.3)) { add("cut", time); allCuts.push(time); }
    if (model.rhythm?.bpm > 0) {
      const beat = 60 / model.rhythm.bpm;
      for (const time of allCuts) {
        const off = Math.abs(((time - (model.rhythm.offset ?? 0)) / beat) - Math.round((time - (model.rhythm.offset ?? 0)) / beat)) * beat;
        if (off <= step + 0.001) add("beat-cut", time);
        else if (off >= 0.2 * beat) add("syncopated", time);
      }
    }

    // Camera: slow scales and moves of large pictures (40% of the frame or more), and parallax:
    // two layers of 15% or more moving slowly at clearly different speeds at the same time.
    const slowMoves = [];
    for (const motion of motions(model)) {
      const item = itemById(model, motion.itemId);
      if (!item || item.kind === "text" || item.isMask || motion.duration < 1.2) continue;
      const from = indexOf(model, motion.start);
      const to = indexOf(model, motion.end);
      const share = Math.max(frameShare(model, item, from), frameShare(model, item, to));
      if (to <= from || share < 0.15) continue;
      const camera = share >= 0.4;
      const keys = keysOf(motion);
      const seconds = model.times[to] - model.times[from];
      const growth = item.samples.scale[to] / Math.max(1e-6, item.samples.scale[from]);
      const center = (index) => [(item.samples.x0[index] + item.samples.x1[index]) / 2, (item.samples.y0[index] + item.samples.y1[index]) / 2];
      const [ax, ay] = center(from);
      const [bx, by] = center(to);
      const travel = Math.hypot(bx - ax, by - ay) / model.width;
      if ([...keys].some((key) => SCALE_KEYS.has(key)) && Math.abs(growth - 1) >= 0.02 && Math.abs(growth - 1) / seconds <= 0.15) {
        if (camera) add("slow-push", motion.start, item.id);
        slowMoves.push({ motion, item, speed: Math.abs(growth - 1) / seconds + travel / seconds });
      } else if ([...keys].some((key) => PLACE_KEYS.has(key)) && travel >= 0.01 && travel / seconds <= 0.08) {
        if (camera) add("drift", motion.start, item.id);
        slowMoves.push({ motion, item, speed: travel / seconds });
      }
    }
    for (const [position, first] of slowMoves.entries()) {
      const other = slowMoves.slice(position + 1).find((second) => second.item.id !== first.item.id
        && !chainOf(model, second.item).includes(first.item) && !chainOf(model, first.item).includes(second.item)
        && Math.min(first.motion.end, second.motion.end) - Math.max(first.motion.start, second.motion.start) >= 0.5 * Math.min(first.motion.duration, second.motion.duration)
        && Math.max(first.speed, second.speed) >= 1.5 * Math.min(first.speed, second.speed));
      if (other && !found.parallax?.some((entry) => Math.abs(entry.at - Math.max(first.motion.start, other.motion.start)) < 0.5)) add("parallax", Math.max(first.motion.start, other.motion.start), first.item.id);
    }
    for (const zoom of screenZooms(model)) add("screen-zoom", zoom.at, zoom.itemId);
    // A clip that speeds up or slows down (a ramp back to normal speed is part of the same ramp),
    // or stops. Clips ramped together (a picture in picture) are one ramp.
    for (const retime of model.retimes ?? []) {
      const tag = retime.to === 0 ? "freeze-frame" : retime.to !== 1 ? "speed-ramp" : null;
      if (tag && !found[tag]?.some((entry) => Math.abs(entry.at - retime.start) < 0.1)) add(tag, retime.start, retime.itemId);
    }

    // Effects: 3D turns, shakes, particles, light, color split, grain, vignette and motion blur.
    const transitionBlurs = new Set(changes.filter((change) => ["zoom-through", "whip-pan"].includes(change.tag)).map((change) => sec(change.at)));
    // Blur keys that follow on from the layer's last one (judder's motion blur fix) are one use.
    const blurEnds = new Map();
    const blurGoesOn = (effect) => {
      const goesOn = MOTION_BLUR_KEYS.has(effect.effect) && Math.abs((blurEnds.get(effect.itemId) ?? -1) - effect.start) < 0.05;
      if (MOTION_BLUR_KEYS.has(effect.effect)) blurEnds.set(effect.itemId, effect.end);
      return goesOn;
    };
    for (const effect of model.effects ?? []) {
      if (isJudderBlur(effect) || blurGoesOn(effect)) continue;
      if (effect.effect === "3d-orbit" || effect.effect === "card-flip") add("orbit-3d", effect.start, effect.itemId);
      // A wiggle shakes the same all through (steady): strength 1 is 2% of the frame width.
      else if (effect.effect === "wiggle") add("shake", effect.start, effect.itemId, { strength: round2(Math.min(1.5, Math.max(effect.to?.wiggleX ?? 3, effect.to?.wiggleY ?? 3) / (0.02 * model.width))),
        frames: Math.max(1, Math.round((effect.end - effect.start) * 30)), shape: "steady", rate: effect.to?.speed ?? 3 });
      else if (PARTICLE_KEYS.has(effect.effect)) add("particles", effect.start, effect.itemId);
      else if (LIGHT_KEYS.has(effect.effect)) add("light-sweep", effect.start, effect.itemId);
      else if (effect.effect === "rgb-shift") add("rgb-split", effect.start, effect.itemId);
      else if (effect.effect === "grain" || effect.effect === "vignette") add(effect.effect, effect.start, effect.itemId);
      else if (MOTION_BLUR_KEYS.has(effect.effect) && ![...transitionBlurs].some((time) => Math.abs(time - effect.start) <= 0.8)) add("motion-blur", effect.start, effect.itemId);
    }
    for (const accent of handAccents(model)) if (!found[accent.tag]?.some((entry) => Math.abs(entry.at - accent.at) < 1.5 * step)) add(accent.tag, accent.at, accent.itemId, accent.extra);

    // Type: how each text enters, and what it does after.
    for (const entry of textEntrances(model)) if (entry.tag) add(entry.tag, entry.at, entry.itemId);
    for (const item of readingTexts(model)) {
      const first = model.times[item.samples.opacity.findIndex((value) => value > 0.05)] ?? 0;
      if (item.counter) add("type-counter", first, item.id);
      if ((item.texts?.length ?? 0) >= 2) add("type-swap", first, item.id);
      if (drawnSize(model, item) >= 0.2 * Math.min(model.width, model.height)) add("type-giant", first, item.id);
      const kinetic = motions(model).find((motion) => motion.itemId === item.id && motion.kind === "custom" && motion.duration >= 0.4 && motion.start >= first + 0.3
        && [...keysOf(motion)].some((key) => SCALE_KEYS.has(key) || PLACE_KEYS.has(key) || key === "rotation"));
      if (kinetic) add("type-kinetic", kinetic.start, item.id);
    }

    // Depth blur: a blurred picture filling most of the frame behind something sharp.
    for (const back of model.items.filter((item) => (item.kind === "video" || item.kind === "image") && !item.isMask)) {
      for (let index = 0; index < model.times.length; index += 1) {
        const blur = Math.max(back.samples.blur[index] ?? 0, back.blur ?? 0);
        if (back.samples.opacity[index] < 0.5 || blur < 6 * s || frameShare(model, back, index) < 0.6 || coveredAt(model, back, index)) continue;
        const sharp = model.items.find((front) => front.z > back.z && !front.isMask && front.kind !== "group" && front.samples.opacity[index] >= 0.5
          && (front.samples.blur[index] ?? 0) <= 2 * s && (front.kind === "text" ? readingTexts(model).includes(front) : frameShare(model, front, index) >= 0.03));
        if (sharp) { add("depth-blur", model.times[index], back.id); break; }
      }
    }

    // Split screen: two clips, each a sixth to two thirds of the frame, side by side for 1 s.
    const clips = model.items.filter((item) => (item.kind === "video" || item.kind === "image") && !item.isMask);
    const sideBySide = (a, b, index) => {
      const shares = [frameShare(model, a, index), frameShare(model, b, index)];
      if (shares.some((share) => share < 0.15 || share > 0.67) || a.samples.opacity[index] < 0.9 || b.samples.opacity[index] < 0.9) return false;
      if (coveredAt(model, a, index) || coveredAt(model, b, index)) return false;
      const shared = overlapArea(boxAt(a, index), boxAt(b, index));
      return shared <= 0.2 * Math.min(area(boxAt(a, index)), area(boxAt(b, index)));
    };
    for (let first = 0; first < clips.length; first += 1) for (let second = first + 1; second < clips.length; second += 1) {
      let run = 0;
      for (let index = 0; index < model.times.length; index += 1) {
        run = sideBySide(clips[first], clips[second], index) ? run + 1 : 0;
        if (run === Math.round(model.fps)) { add("split-screen", model.times[index - run + 1], clips[first].id); break; }
      }
    }

    // Type behind a subject: a readable text above a clip and under the cut-out of that clip
    // (cut_out marks it cutoutOf), shown over the cut-out at once. One use per text, when it shows.
    const cutouts = model.items.filter((item) => item.cutoutOf && !item.isMask);
    if (cutouts.length) for (const word of readingTexts(model)) {
      const shown = cutouts.filter((cut) => { const clip = itemById(model, cut.cutoutOf); return clip && clip.z < word.z && word.z < cut.z; })
        .map((cut) => model.times.findIndex((time, at) => word.samples.opacity[at] >= 0.5 && cut.samples.opacity[at] >= 0.5 && overlapArea(boxAt(word, at), boxAt(cut, at)) > 0))
        .filter((index) => index >= 0);
      if (shown.length) add("type-behind", model.times[Math.min(...shown)], word.id);
    }

    // Rhythm: pulses, and long holds where nothing at all changes.
    for (const pulse of kicks(model)) add("beat-kick", pulse.at, pulse.itemId, { strength: round2(Math.min(1, pulse.amount / 0.1)), frames: Math.round(0.4 * 30), shape: "pulse" });
    const bounds = [0, ...changes.map((change) => change.at), ...allCuts, model.duration].sort((x, y) => x - y);
    for (let position = 0; position + 1 < bounds.length; position += 1) {
      const [start, end] = [bounds[position], bounds[position + 1]];
      if (end - start < 3) continue;
      const busy = motions(model).some((motion) => motion.start < end && motion.end > start && itemById(model, motion.itemId)?.samples.opacity[indexOf(model, Math.max(start, motion.start))] > 0.05)
        || model.items.some((item) => (item.kind === "video" || item.samples.moving?.[indexOf(model, (start + end) / 2)]) && item.samples.opacity[indexOf(model, (start + end) / 2)] > 0.05);
      if (!busy) add("hold", start);
    }

    // Set pieces built by moves (engine/blocks/moves): the scene's record names their techniques, so
    // tile-ring, swipe-cards, logo-match-move and status-line are found too. A tag already found
    // while the move plays is not counted twice.
    // An accent move that names its cue (impact-accent: move.trigger) is sized by the cue's weight
    // and decays; it keeps the cue's name so effect_fit reads its reason.
    for (const move of model.moves ?? []) {
      for (const tag of move.tags) {
        if (found[tag]?.some((entry) => entry.at >= move.start - 0.3 && entry.at <= move.end + 0.3)) continue;
        const trigger = move.trigger;
        add(tag, trigger ? (trigger.at ?? move.start) : move.start, null, trigger ? { strength: round2(trigger.weight ?? 0.5), frames: Math.max(1, Math.round((move.end - move.start) * 30)), shape: "decay", move: move.id, cue: trigger.cue } : null);
      }
    }

    for (const list of Object.values(found)) list.sort((x, y) => x.at - y.at);
    return found;
  });
}

// Cuts of content that is not a full-frame picture: most of the readable or shown things gone in
// one step (analysis.js cuts), the start left out.
const contentCuts = (model) => cuts(model).filter((time) => time > 0);

/** { tag: count } of a found set, most used first, e.g. { cut: 12, "type-pop": 5 }. */
export function techniqueCounts(found) {
  return Object.fromEntries(Object.entries(found).map(([tag, list]) => [tag, list.length]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** "cut 12, type-pop 5, slow-push 2" (at most `limit` tags, then "+3 more"). */
export function techniquesLine(counts, limit = 12) {
  const entries = Object.entries(counts);
  if (!entries.length) return "none found";
  const shown = entries.slice(0, limit).map(([tag, count]) => `${tag} ${count}`).join(", ");
  return entries.length > limit ? `${shown}, +${entries.length - limit} more` : shown;
}
