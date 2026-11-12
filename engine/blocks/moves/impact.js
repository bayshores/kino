// impact-accent: one flash, shake, impact frame, dip or strobe on a shot, and only where a measured
// cue motivates it. The kind must match what the cue is:
//   flash         light in the shot (a footage light event), a song seam (song-drop, song-return,
//                 song-switch ...) or a top accent from detect_beats (rank 1 or weight 0.6 and up)
//   shake         an impact in the footage (a contact: something hits), a song seam or a top accent
//                 (the same reasons effect_fit accepts); a footage hit on the cue wins and gives the
//                 direction, without one it shakes up and down
//   impact-frame  an impact in the footage that has no impact frame of its own
//   dip           a rest in the song (song-break, song-dropout): darker until the next seam
//   strobe        a drum fill measured just before the cue (4 or more even onsets), resolving on it
// A time in seconds takes the reason measured within 3 frames of it (and sits on it), else it is a
// small accent whose receipt gives the distance to the nearest reason. after:/with:/auto and beat
// or onset numbers are refused, with the nearest cue that would motivate the kind. Footage events (backend/footage/events.mjs) reach the move in
// scene seconds (ctx.cueFacts.events); the move matches them to the cue's time within 2.5 frames.
//
// Size follows the cue's weight (0 to 1) and the shot:
//   flash   the shot's own exposure lifts 0.6 to 2 stops (its colors carry the flash, so a dark red
//           grade flashes red, never a white card), up 1 frame (light: 1 to 3 frames, as the light
//           rises in the shot), back in 3 to 8 frames
//   shake   1 to 2% of the frame, along the hit's direction, a decaying wave: full on the cue's
//           frame, under 30% by the 4th frame, still at 0.125 s
//   impact  the shot turns to a hard black and white silhouette for 1 to 3 frames
//   dip     the shot darkens 1 to 3 stops over 2 frames and comes back on the next seam's frame
//   strobe  one frame of light on onsets of the fill at least 0.34 s apart (3 flashes a second at
//           most, the seizure-safety limit), the last on the cue
//   shake   adds to the shot's own place: a pan before it or a drift through it keeps going
// Reduced motion: no shake and no strobe (a note says so); flashes and dips are half as strong.
// The accent starts on its cue, so align and dur are refused; song seams and rests count only
// when fit_music wrote them (fitted), never a song-* cue set by hand.
//
// hit: several of these parts one frame apart (light, blur, a recolor in the shot's hue, particles
// off the subject, a shake), as many and as strong as the cue's weight. It takes any cue or time:
// a weak accent, a beat number, a marker on a clip or a raw time builds a small hit (weight 0.3)
// instead of a refusal, and a time without a cue is left to effect_fit's untriggered. See build.hit.
import { IMPACT_KINDS } from "../../blockFields.js";
import { createLayer } from "../../model.js";
import { PARTICLE_LOOKS } from "../../effects/particles.js";
import { toLinear, toSrgb } from "../../effects/colorUtility.js";
import { easingAt } from "../../easing.js";
import { parseAt } from "../timing.js";
import { hslToHex, shotHue, shotTint } from "./backdrop.js";
import { subjectIn } from "./composite.js";
import { CURVES, boxOf, effect, hide, motion, round, show } from "./kit.js";

const FRAME = 1 / 30;
// An event this close to the cue is at the cue (the impact may come up to 2 frames early).
const NEAR = 2.5 * FRAME;
const EARLY = 2 * FRAME + 1e-6;
export { IMPACT_KINDS };
const NEEDS = Object.freeze({ flash: ["light", "seam", "accent"], shake: ["impact", "seam", "accent"], "impact-frame": ["impact"], dip: ["dropout"], strobe: ["fill"] });
const SAYS = { light: "light in the shot", seam: "a song seam", accent: "a top accent", impact: "an impact in the footage", dropout: "a rest in the song", fill: "a drum fill before it",
  beat: "a weak accent or beat", footage: "a marked moment in a clip", cue: "a cue with nothing measured", time: "a time with no cue" };
// Song seams (fit_music cues song-<kind>-<n>) by how hard the picture may answer them.
const SEAMS = { drop: 1, return: 0.9, switch: 0.8, "vocal-in": 0.6, build: 0.6, intro: 0.5, outro: 0.5 };
const RESTS = { break: 0.7, dropout: 0.9 };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// The shake's way from the shot's place at the cue to its place now: there at once, so a shot
// that drifts through the cue keeps drifting under the shake.
const SNAP = Object.freeze([0, 1, 0, 1]);
// The least time between two strobe flashes: 3 a second at most.
export const STROBE_GAP = 0.34;

/** A fill before `time`: the last run of 4 or more onsets, evenly spaced at most 0.22 s apart, ending just before it. */
export function fillBefore(time, cues) {
  const onsets = cues.filter((cue) => cue.kind === "onset" && cue.time < time - 0.02 && cue.time > time - 1.5).map((cue) => cue.time).sort((a, b) => a - b);
  if (!onsets.length || time - onsets.at(-1) > 0.25) return null;
  const run = [onsets.at(-1)];
  for (let index = onsets.length - 2; index >= 0 && run[0] - onsets[index] <= 0.22; index -= 1) run.unshift(onsets[index]);
  if (run.length < 4) return null;
  const gaps = run.slice(1).map((at, index) => at - run[index]);
  return Math.max(...gaps) <= 1.6 * Math.min(...gaps) ? run : null;
}

/**
 * What a cue is, as reasons for an accent: [{motive, weight, ...}]. `events` are footage events in
 * scene seconds ({kind, at, confidence, how, dir, frames, from, layer}); `cues` the document's cues.
 */
export function cueMotives(cue, { cues = [], events = [] } = {}) {
  const found = [];
  // A song seam or rest counts only when fit_music measured it (fitted); one set by hand is a time.
  const song = /^song-([a-z]+(?:-[a-z]+)?)-\d+$/.exec(cue.name);
  if (song && cue.kind === "marker" && cue.fitted === true) {
    if (SEAMS[song[1]] !== undefined) found.push({ motive: "seam", weight: SEAMS[song[1]] });
    if (RESTS[song[1]] !== undefined) found.push({ motive: "dropout", weight: RESTS[song[1]] });
  }
  if (cue.kind === "accent" && (cue.rank === 1 || (cue.weight ?? 0) >= 0.6)) found.push({ motive: "accent", weight: cue.weight ?? 0.6 });
  for (const event of events) {
    if (Math.abs(event.at - cue.time) > NEAR) continue;
    if (event.kind === "impact") found.push({ motive: "impact", weight: event.confidence, how: event.how, dir: event.dir, frames: event.frames, layer: event.layer });
    if (event.kind === "light") found.push({ motive: "light", weight: event.confidence, from: event.from, layer: event.layer });
  }
  const fill = fillBefore(cue.time, cues);
  if (fill) found.push({ motive: "fill", weight: 0.7, onsets: fill });
  return found;
}

// The refusal: why, and the nearest cue that would motivate this kind (or how to pin one).
function refuse(kind, why, facts, time) {
  const fitting = (facts?.cues ?? []).filter((cue) => cueMotives(cue, facts).some((entry) => NEEDS[kind].includes(entry.motive)))
    .sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time));
  const needs = NEEDS[kind].map((motive) => SAYS[motive]).join(" or ");
  if (fitting.length) return new Error(`impact-accent ${kind}: ${why}. An accent needs a cue that motivates it (${needs}): try at "cue:${fitting[0].name}".`);
  const event = (facts?.events ?? []).filter((entry) => NEEDS[kind].includes(entry.kind) && entry.media !== undefined).sort((a, b) => Math.abs(a.at - time) - Math.abs(b.at - time))[0];
  const pin = event ? ` The clip ${event.layer} has ${event.kind === "light" ? "light" : "an impact"} at ${round(event.at)} s: set_cues {cues:[{name:"hit-1", layer:"${event.layer}", media:${event.media}}]}, then at "cue:hit-1".` : " None in this edit: leave this moment plain.";
  return new Error(`impact-accent ${kind}: ${why}. An accent needs a cue that motivates it (${needs}).${pin}`);
}

// A time given in seconds (or a frame) takes the measured reason this close to it.
export const SNAP_FRAMES = 3;

// The reasons for `kind` measured near `time`, nearest first: the document's cues that motivate it
// and the footage events (light, an impact) that do, each {cue (null for an event), time, motive}.
function reasonsNear(kind, facts, time) {
  const fits = (motives) => motives.filter((entry) => NEEDS[kind].includes(entry.motive)).sort((a, b) => b.weight - a.weight)[0];
  const found = [];
  for (const cue of facts?.cues ?? []) {
    if (cue.kind === "beat" || cue.kind === "onset") continue;
    const motive = fits(cueMotives(cue, facts));
    if (motive) found.push({ cue, time: cue.time, motive });
  }
  for (const event of facts?.events ?? []) {
    const motive = fits(cueMotives({ name: "", kind: "event", time: event.at }, { ...facts, cues: [], events: [event] }));
    if (motive) found.push({ cue: null, time: event.at, motive });
  }
  return found.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time));
}

// at in seconds: the reason measured within SNAP_FRAMES of it (the accent moves onto it, and the
// receipt says from where), else the time itself as a small accent (weight 0.3) whose receipt says
// how far the nearest measured reason is. A dip or strobe still needs its rest or fill.
function timeMotive(kind, facts, time, raw) {
  const said = `at ${round(time, 3)} s`;
  const reasons = reasonsNear(kind, facts, time);
  const close = (entry) => Math.abs(entry.time - time) <= SNAP_FRAMES * FRAME + 1e-6;
  // A cue within reach wins over a bare footage event: effect_fit reads the cue as the accent's reason.
  const near = reasons.find((entry) => close(entry) && entry.cue) ?? reasons[0];
  const name = (entry) => (entry.cue ? `cue:${entry.cue.name}` : `${entry.motive.motive === "light" ? "light" : "an impact"} in ${entry.motive.layer ?? "the footage"}`);
  if (near && close(near)) {
    const gap = round(Math.abs(near.time - time), 3);
    const way = near.time < time ? "earlier" : "later";
    return { cue: near.cue, at: near.time, motive: { ...near.motive, weight: clamp(near.motive.weight ?? 0.5, 0.2, 1) }, snapped: true,
      note: `${said} → ${name(near)} at ${round(near.time, 3)} s (${gap ? `${gap} s ${way}` : "the same frame"}, ${SAYS[near.motive.motive]})` };
  }
  if (kind === "dip" || kind === "strobe") throw refuse(kind, `at ${JSON.stringify(raw ?? time)} is a time, not a reason`, facts, time);
  const far = near ? `the nearest ${kind} reason, ${name(near)} (${SAYS[near.motive.motive]}), is ${round(Math.abs(near.time - time), 3)} s ${near.time < time ? "earlier" : "later"}` : `nothing in this edit measures ${NEEDS[kind].map((motive) => SAYS[motive]).join(" or ")}`;
  return { cue: null, at: time, motive: { motive: "time", weight: WEAK }, snapped: true, note: `${said}: no measured reason within ${SNAP_FRAMES} frames, a small ${kind} (weight ${WEAK}); ${far}` };
}

/** The cue the move was given and the reason it gives for `kind`, or throws a refusal that names a better cue. */
export function motiveFor(kind, facts, time) {
  const raw = facts?.at;
  let at;
  try { at = raw === undefined ? null : parseAt(raw); } catch { at = null; }
  if (at && (at.kind === "seconds" || at.kind === "frame")) return timeMotive(kind, facts, time, raw);
  if (!at || at.kind !== "cue") throw refuse(kind, `at ${JSON.stringify(raw ?? time)} is a time, not a reason`, facts, time);
  const cues = facts.cues ?? [];
  const cue = cues.find((entry) => entry.name === at.whole) ?? cues.find((entry) => entry.name === at.target);
  if (!cue) throw refuse(kind, `there is no cue "${at.whole}"`, facts, time);
  const offset = cue.name === at.whole ? 0 : at.offset;
  if (offset > 1e-6 || offset < -EARLY) throw refuse(kind, `the picture may come up to 2 frames (${round(EARLY, 3)} s) early, never late; ${at.whole} is off by ${round(offset)} s`, facts, time);
  const motives = cueMotives(cue, facts);
  if ((cue.kind === "beat" || cue.kind === "onset") && !(kind === "strobe" && motives.some((entry) => entry.motive === "fill")))
    throw refuse(kind, `cue:${cue.name} is a beat number, not a reason`, facts, time);
  // A shake on a cue that is also a footage hit follows the hit (its direction), whatever the seam weighs.
  const first = (entry) => (kind === "shake" && entry.motive === "impact" ? 1 : 0);
  const motive = motives.filter((entry) => NEEDS[kind].includes(entry.motive)).sort((a, b) => first(b) - first(a) || b.weight - a.weight)[0];
  if (!motive) {
    if (/^song-/.test(cue.name) && cue.fitted !== true && !motives.length)
      throw refuse(kind, `cue:${cue.name} was set by hand, not measured: song seams and rests come from fit_music`, facts, time);
    const has = motives.length ? `cue:${cue.name} is ${[...new Set(motives.map((entry) => SAYS[entry.motive]))].join(" and ")}` : `cue:${cue.name} has nothing measured at it`;
    throw refuse(kind, `${has}; ${kind} needs ${NEEDS[kind].map((entry) => SAYS[entry]).join(" or ")}`, facts, time);
  }
  return { cue, at: cue.time + offset, motive: { ...motive, weight: clamp(motive.weight ?? 0.5, 0.2, 1) } };
}

// A hit on a moment kino measured nothing at (a beat number, a bare marker, a raw time) is small:
// weight 0.3 builds 2 parts (a guess; a studied reference answered a phrase end with 1 small sparkle burst).
const WEAK = 0.3;

/**
 * The reason under a hit: the cue's motives (cueMotives) plus two read only here, a weak accent
 * (below rank 1 and under 0.6: "beat") and a marker pinned to a clip (set_cues layer + media:
 * "footage", 0.6 as effect_fit reads it). A beat or onset number, a cue with nothing measured or a
 * raw time weighs WEAK. input.weight replaces the weight (both are printed). A rest (dropout)
 * answers with a dip; a fill before the cue makes the strobe take light's place.
 * Returns {cue (null for a raw time), at, motive: {motive, weight, ...}, measured, fill, rest, note}.
 */
export function hitMotive(facts, time, input = {}) {
  const raw = facts?.at;
  let at;
  try { at = raw === undefined ? null : parseAt(raw); } catch { at = null; }
  const given = Number.isFinite(input.weight) ? clamp(input.weight, 0.1, 1) : null;
  const weighed = (motive, measured) => ({ ...motive, weight: clamp(given ?? measured, 0.2, 1) });
  if (!at || at.kind !== "cue") {
    const note = `at ${JSON.stringify(raw ?? time)} is a time with no cue, so effect_fit will ask for one: pin it with set_cues {cues:[{name:"hit-1", time:${round(time)}}]} (or layer + media for a clip's moment), then at "cue:hit-1"`;
    return { cue: null, at: time, motive: weighed({ motive: "time" }, WEAK), measured: WEAK, fill: null, rest: null, note };
  }
  const cues = facts.cues ?? [];
  const cue = cues.find((entry) => entry.name === at.whole) ?? cues.find((entry) => entry.name === at.target);
  if (!cue) throw new Error(`impact-accent hit: there is no cue "${at.whole}"; give one of the document's cues, or a time.`);
  const offset = cue.name === at.whole ? 0 : at.offset;
  if (offset > 1e-6 || offset < -EARLY) throw new Error(`impact-accent hit: the picture may come up to 2 frames (${round(EARLY, 3)} s) early, never late; ${at.whole} is off by ${round(offset)} s.`);
  const motives = cueMotives(cue, facts);
  if (cue.kind === "accent" && !motives.some((entry) => entry.motive === "accent")) motives.push({ motive: "beat", weight: cue.weight ?? WEAK });
  if (cue.kind === "marker" && cue.layer && cue.media !== undefined && !/^song-/.test(cue.name)) motives.push({ motive: "footage", weight: Number.isFinite(cue.weight) ? cue.weight : 0.6 });
  const rest = motives.find((entry) => entry.motive === "dropout") ?? null;
  const fill = motives.find((entry) => entry.motive === "fill") ?? null;
  const reasons = motives.filter((entry) => entry.motive !== "dropout" && entry.motive !== "fill").sort((a, b) => b.weight - a.weight);
  let best = reasons[0] ?? rest ?? fill;
  let note = null;
  if (!best) {
    best = { motive: cue.kind === "beat" || cue.kind === "onset" ? "beat" : "cue", weight: WEAK };
    // effect_fit reads a beat number a move names as its cue (effectFit.js loudEffects), so a hit
    // on beat-8 stays (it came back untriggered before, and its auto fix took it off).
    note = `cue:${cue.name} has nothing measured at it: a small hit (weight ${WEAK}); weight:<0.1 to 1> sizes a moment kino did not measure`;
  }
  const measured = clamp(best.weight ?? 0.5, 0.2, 1);
  return { cue, at: cue.time + offset, motive: weighed(best, measured), measured, fill, rest: best === rest ? rest : null, note };
}

// The shot to accent: the layer given, else the clip the impact or light is in, else the top
// picture or clip on screen at the cue.
function shotOf(ctx, input, motive) {
  if (input.layer) return ctx.layer(input.layer, "layer");
  const pictures = ctx.sceneLayers().filter((layer) => (layer.type === "video" || layer.type === "image") && !layer.parentId);
  const own = motive.layer && pictures.find((layer) => layer.id === motive.layer);
  const shown = own ?? pictures.filter((layer) => ctx.shownAt(layer.id, ctx.start)).at(-1);
  if (!shown) throw new Error("impact-accent: no picture or clip is on screen at the cue; give layer.");
  return ctx.layer(shown.id, "layer");
}

// The two halves of a lift of the shot's exposure: up to `peak` stops by `at`, back by `at + down`.
function exposure(ctx, shot, name, { from, at, down, peak, label }) {
  ctx.animate(shot.id, `${name}-up`, effect({ name: `${label} up`, effect: "color-grade", start: from, duration: Math.max(0.001, at - from), easing: CURVES.accelerate, from: { stops: 0 }, to: { stops: peak }, keepStill: "off" }), "impact");
  ctx.animate(shot.id, `${name}-down`, effect({ name: `${label} down`, effect: "color-grade", start: at, duration: down, easing: CURVES.settle, from: { stops: peak }, to: { stops: 0 }, keepStill: "off" }), "impact");
}

const build = {
  flash(ctx, shot, { motive }, t) {
    const weight = motive.weight * (ctx.reduced ? 0.5 : 1);
    // Light in the shot rises 1 to 3 frames before its peak; a seam or accent comes up 1 frame early.
    const lead = motive.motive === "light" && motive.from !== undefined ? clamp(t - motive.from, FRAME, 3 * FRAME) : FRAME;
    const from = Math.max(0, t - lead);
    const down = (3 + 5 * motive.weight) * FRAME;
    exposure(ctx, shot, "flash", { from, at: t, down, peak: round(0.6 + 1.4 * weight, 2), label: `Flash (${motive.motive} ${round(motive.weight, 2)})` });
    return { start: from, end: t + down, tags: ["flash"] };
  },
  shake(ctx, shot, { motive, still = false }, t) {
    if (ctx.reduced) { ctx.note("impact-accent shake: none in reduced motion"); return { start: t, end: t + FRAME, tags: [] }; }
    // A footage hit shakes along its own direction; a song seam or accent has none, so it bumps down.
    const dir = motive.dir ?? (motive.motive === "impact" ? "right" : "down");
    const axes = [/left|right/.test(dir) ? "x" : null, /up|down/.test(dir) ? "y" : null].filter(Boolean);
    const size = ctx.frame.width * (0.01 + 0.01 * motive.weight) / (axes.length > 1 ? Math.SQRT2 : 1);
    // A cosine wave (phase a quarter) 0.1 s a cycle, decaying 14 a second: full on the cue's frame,
    // under 30% by the 4th frame; it ends at 0.125 s, where the wave is at rest, so nothing is held.
    // `still` (a hit's shake): a sine (phase 0) that is at the shot's place on the cue's frame and
    // swings from the next one (54% of the size there, then -34%, then 0 at 0.1 s, where it ends),
    // so the cue's frame does not jump: the full-size first step of the cosine (38.4 px at weight 1
    // in 1080p) was a jump off any cut (measured on a run's copy and a promo, hit-accent review).
    const length = still ? 0.1 : 0.125;
    // A move of the same axis that starts inside the shake would cut it short.
    const cut = (shot.animations ?? []).find((animation) => animation.kind !== "effect" && (animation.start ?? 0) > t + 1e-6 && (animation.start ?? 0) < t + length
      && axes.some((axis) => [...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})].includes(axis)));
    if (cut) throw new Error(`impact-accent shake: ${shot.id} starts a move of ${axes.join(" and ")} at ${round(cut.start)} s, inside the shake (${round(t)} to ${round(t + length)} s); shake on another hit, or give it a flash.`);
    const sign = /left|up/.test(dir) ? -1 : 1;
    const amount = Object.fromEntries(axes.map((axis) => [axis, round(sign * size, 1)]));
    // The shake adds to wherever the shot is: it starts from the shot's place at the cue
    // (fromCurrent) and has no end of its own, so it ends wherever the shot's own moves (a pan
    // before it, a drift through it) put it at each moment, and nothing is pinned after it.
    const here = ctx.stateAt(shot.id, t);
    const rest = Object.fromEntries(axes.map((axis) => [axis, round(here[axis] ?? shot[axis], 2)]));
    const shake = { ...motion({ name: `Shake (${motive.motive} ${round(motive.weight, 2)} ${dir})`, start: t, duration: length, easing: SNAP, from: rest, to: {} }),
      fromCurrent: true, behavior: { oscillate: { amount, period: 0.1, phase: still ? 0 : 0.25, wave: "sine", decay: 14 } } };
    ctx.animate(shot.id, "shake", shake, "impact");
    return { start: t, end: t + length, tags: ["shake"] };
  },
  "impact-frame"(ctx, shot, { motive }, t) {
    if (motive.how === "frame") throw new Error(`impact-accent impact-frame: the clip already cuts to its own impact frame here (${motive.frames ?? 1} frames); add nothing, or shake on a contact.`);
    const frames = clamp(Math.round(1 + 2 * motive.weight), 1, 3);
    const length = frames * FRAME;
    const hard = { saturation: 0, contrast: 3, stops: 0.5 };
    ctx.animate(shot.id, "frame-grade", effect({ name: `Impact frame (impact ${round(motive.weight, 2)})`, effect: "color-grade", start: t, duration: length, easing: CURVES.fade, from: hard, to: hard, keepStill: "off" }), "impact");
    const ink = { contrast: 2, colorThreshold: 0.5, softness: 0, defaultColor: ctx.color("color", "#0A0A0C"), invertLuma: false };
    ctx.animate(shot.id, "frame-ink", effect({ name: "Impact frame ink", effect: "threshold-color", start: t, duration: length, easing: CURVES.fade, from: ink, to: ink, keepStill: "off" }), "impact");
    return { start: t, end: t + length, tags: ["flash"] };
  },
  dip(ctx, shot, { cue, motive }, t, facts) {
    const next = (facts.cues ?? []).filter((entry) => entry.time > t + 0.1 && /^song-/.test(entry.name)).sort((a, b) => a.time - b.time)[0];
    const back = Math.min(next ? next.time : t + 1, ctx.sceneDuration, t + 8);
    const depth = round(-(1 + 2 * motive.weight) * (ctx.reduced ? 0.5 : 1), 2);
    ctx.animate(shot.id, "dip-down", effect({ name: `Dip (${cue.name})`, effect: "color-grade", start: t, duration: 2 * FRAME, easing: CURVES.settle, from: { stops: 0 }, to: { stops: depth }, keepStill: "off" }), "impact");
    // Held until the return's frame, then the picture restarts on it.
    ctx.animate(shot.id, "dip-hold", effect({ name: "Dip hold", effect: "color-grade", start: t + 2 * FRAME, duration: Math.max(0.001, back - t - 2 * FRAME), easing: CURVES.fade, from: { stops: depth }, to: { stops: depth }, keepStill: "off" }), "impact");
    return { start: t, end: back, tags: [] };
  },
  strobe(ctx, shot, { motive }, t) {
    if (ctx.reduced) { ctx.note("impact-accent strobe: none in reduced motion"); return { start: t, end: t + FRAME, tags: [] }; }
    // At most 3 flashes a second (the flashing gate, WCAG 2.3.1): counting back from the cue,
    // light only onsets at least STROBE_GAP after the next one lit.
    const hits = [t];
    for (const at of [...motive.onsets].reverse()) if (hits[0] - at >= STROBE_GAP - 1e-6) hits.unshift(at);
    hits.forEach((at, index) => {
      // Each onset gets one frame of light; the last, on the cue, is the strongest.
      const peak = round(index === hits.length - 1 ? 1.6 : 0.6 + 0.6 * (index / hits.length), 2);
      exposure(ctx, shot, `strobe-${index + 1}`, { from: Math.max(0, at - 0.001), at, down: FRAME, peak, label: "Strobe" });
    });
    return { start: hits[0], end: t + FRAME, tags: ["flash"] };
  },
  hit(ctx, shot, found, t, facts, input) {
    // A rest asks for less, not more: the dip alone.
    if (found.rest) return { ...build.dip(ctx, shot, found, t, facts), said: ["dip (a rest in the song)"], count: 1 };
    const w = found.motive.weight;
    const order = [...(input.parts ?? HIT_ORDER[found.motive.motive] ?? HIT_ORDER.other)];
    if (!input.parts && found.fill) order[order.indexOf("light")] = "strobe";
    const count = input.parts ? order.length : hitCount(w);
    const hue = shotHue(ctx, shot);
    const subject = subjectAt(ctx, shot, t);
    const said = [], skipped = [], tags = new Set();
    // The light part writes its lift here, so the recolor after it splits the lifted picture.
    const lit = {};
    let start = t, end = t + FRAME;
    for (const part of order) {
      if (said.length >= count) break;
      const at = t + said.length * FRAME;
      const why = part === "recolor" && !hue ? `no hue measured on ${shot.id}`
        : part === "particles" && !subject ? `no subject found in ${shot.id} (mark_subject marks one)`
        : (part === "shake" || part === "strobe" || part === "blur") && ctx.reduced ? "reduced motion"
        : part === "strobe" && !found.fill ? "no fill measured before the cue" : null;
      if (why) { skipped.push(`${part} (${why})`); continue; }
      let made;
      try { made = HIT_PARTS[part](ctx, shot, { ...found, hue, subject, input, lit, cueAt: t }, at, w); } catch (error) { skipped.push(`${part} (${error.message.replace(/^impact-accent [a-z-]+: /, "")})`); continue; }
      said.push(made.said);
      for (const tag of made.tags ?? []) tags.add(tag);
      start = Math.min(start, made.start ?? at);
      end = Math.max(end, made.end);
    }
    if (skipped.length) ctx.note(`skipped: ${skipped.join(", ")}`);
    return { start, end, tags: [...tags], said, count: said.length };
  },
};

// hit: the parts in the order each reason asks for them (a guess from two studied reference edits:
// one song drop goes blur shake, tinted frame, flat frame, shard burst, a frame apart; one gunshot
// goes white flash, negative, trail, 2.5 frames apart). A contact moves the camera first; light lights first.
const HIT_ORDER = Object.freeze({
  impact: Object.freeze(["shake", "blur", "light", "particles", "recolor"]),
  light: Object.freeze(["light", "recolor", "particles", "blur", "shake"]),
  other: Object.freeze(["light", "blur", "recolor", "particles", "shake"]),
});
export const HIT_PART_NAMES = Object.freeze(["light", "blur", "recolor", "particles", "shake", "strobe"]);
export const HIT_LOOKS = Object.freeze(["sparks", "dust", "embers", "snow", "bokeh"]);
/** How many parts a hit of `weight` gets: floor(1 + 4w), 1 to 5 (0.3 gives 2, 0.5 3, 0.75 4, 1 5). The ladder is a guess. */
export const hitCount = (weight) => clamp(Math.floor(1 + 4 * weight + 1e-9), 1, 5);
// The recolor's split when the shot's brightness was not measured (the live preview, a file that
// cannot be read): the first guess, kept. It put a dark screenshot almost all in the shadow tone
// and a flat drawn face in one tone (hit-accent review), which recolorSplit fixes where it can measure.
const GUESSED_SPLIT = Object.freeze({ threshold1: 0.18, threshold2: 0.48, softness: 0.5, contrast: 1.1 });
// The least blend at a split: one level of 255.
const LEAST_SOFTNESS = 0.004;

/**
 * The tritone split for a shot whose luma was measured (`tones` {at: [low, high], gaps: [g1, g2]},
 * sRGB luma 0 to 1: the boundaries nearest its darkest and lightest thirds, each in the middle of
 * an empty luma range g wide, backend/agent/shot-color.mjs lumaSplit), seen through an exposure
 * lift of `stops` (the hit's light, the same sRGB to linear gain and back as color-grade, applied
 * to the luma as a guess for each channel): {threshold1, threshold2, softness, contrast}, or null
 * without a measurement. Contrast 1, so the splits are the picture's own lumas. The blend fits
 * inside the narrower empty range (and half the distance between the splits), so no flat area of
 * the picture is blended across two tones; a picture with no empty range at either split (footage)
 * blends across the whole distance between the splits.
 */
export function recolorSplit(tones, stops = 0) {
  const at = tones?.at, gaps = tones?.gaps ?? [0, 0];
  if (!Array.isArray(at) || at.length < 2 || ![...at, ...gaps].every(Number.isFinite)) return null;
  const gain = 2 ** stops;
  const lift = (value) => clamp(toSrgb(Math.min(1, gain * toLinear(clamp(value, 0, 1)))), 0, 1);
  // Each split and its empty range, through the lift.
  const [one, two] = [0, 1].map((index) => ({ at: lift(at[index]), gap: lift(at[index] + gaps[index] / 2) - lift(at[index] - gaps[index] / 2) })).sort((a, b) => a.at - b.at);
  // Continuous tone at both splits (footage: no empty range wider than 2 levels of 255) has no flat
  // area to protect, so the tones blend across the whole distance between the splits, as the guessed
  // split does; a near-hard split there turned a soft glow into hard bands (hit-accent review).
  const continuous = Math.max(...gaps) <= 0.009;
  const softness = continuous ? two.at - one.at : Math.max(LEAST_SOFTNESS, Math.min(one.gap, two.gap, (two.at - one.at) / 2));
  return { threshold1: round(one.at, 3), threshold2: round(two.at, 3), softness: round(softness, 3), contrast: 1 };
}
// The burst's count falls fast: 96% gone by the window's middle (a cubic-bezier, worked out by hand).
const BURST = Object.freeze([0.3, 1, 0.3, 1]);

// Where the shot's subject is at scene time `t`, as fractions of the frame: the marked or
// measured subject of its file (composite.js subjectIn), never the frame's center. null when none.
function subjectAt(ctx, shot, t) {
  const second = (shot.mediaOffset ?? 0) + (t - (shot.mediaStart ?? 0)) * (shot.mediaSpeed ?? 1);
  const found = subjectIn(shot, ctx.samples(shot.id), second - 0.5, second + 0.5);
  if (!found) return null;
  const box = boxOf(shot);
  return { on: found.on, inShot: found.center,
    center: [round((box.x + found.center[0] * box.width) / ctx.frame.width, 3), round((box.y + found.center[1] * box.height) / ctx.frame.height, 3)] };
}

// Each part of a hit at `t`, sized by the weight w (0.2 to 1). Every size here is a guess aimed at
// the references above; all of them follow w.
const HIT_PARTS = {
  light(ctx, shot, found, t, w) {
    const made = build.flash(ctx, shot, { motive: { ...found.motive, weight: w } }, t);
    const peak = round(0.6 + 1.4 * w * (ctx.reduced ? 0.5 : 1), 2);
    Object.assign(found.lit, { at: t, down: made.end - t, peak });
    return { ...made, said: `light ${peak} stops` };
  },
  strobe(ctx, shot, found, t) {
    // Its last light, on the cue, is 1.6 stops back down in one frame (build.strobe).
    Object.assign(found.lit, { at: t, down: FRAME, peak: 1.6 });
    return { ...build.strobe(ctx, shot, { motive: found.fill }, t), said: `strobe on the fill (${found.fill.onsets.length} onsets)` };
  },
  // The shake starts on the cue's frame whatever its place in the order (a camera hit is felt on
  // the beat; 4 frames late it was off any cut), from the shot's place (still), so it never jumps.
  shake(ctx, shot, found, t, w) {
    const made = build.shake(ctx, shot, { motive: { ...found.motive, weight: w }, still: true }, found.cueAt);
    const dir = found.motive.dir ?? (found.motive.motive === "impact" ? "right" : "down");
    return { ...made, said: `shake ${round(100 * (0.01 + 0.01 * w), 1)}% ${dir} from the cue's frame` };
  },
  // A blur that falls off over 2 to 5 frames: along an impact's direction, else a zoom out of the
  // subject (the frame's middle without one).
  blur(ctx, shot, found, t, w) {
    const frames = Math.round(2 + 3 * w);
    const length = frames * FRAME;
    if (found.motive.motive === "impact" && found.motive.dir) {
      const px = Math.round((20 + 60 * w) * ctx.scale);
      const angle = /up|down/.test(found.motive.dir) ? 90 : 0;
      ctx.animate(shot.id, "hit-blur", effect({ name: `Hit blur ${found.motive.dir}`, effect: "directional-blur", start: t, duration: length, easing: CURVES.settle, from: { length: px, angle }, to: { length: 0, angle } }), "impact");
      return { start: t, end: t + length, said: `directional blur ${px} px ${found.motive.dir} (${frames} frames)` };
    }
    const [centerX, centerY] = found.subject?.inShot ?? [0.5, 0.5];
    const amount = round(0.15 + 0.5 * w, 2);
    ctx.animate(shot.id, "hit-blur", effect({ name: "Hit zoom blur", effect: "zoom-blur", start: t, duration: length, easing: CURVES.settle, from: { amount, centerX, centerY }, to: { amount: 0, centerX, centerY } }), "impact");
    return { start: t, end: t + length, said: `zoom blur ${amount} (${frames} frames${found.subject ? `, from the ${found.subject.on}` : ""})` };
  },
  // The shot in three tones of its own hue for 1 to 4 frames: backdrop-flash's tone "field" turns
  // (shadow +30°, midtone -26°, highlight -44°, backdrop.js), here from the shot's hue (a guess).
  // Where the tones split follows the shot's own brightness (recolorSplit): about its darkest third
  // goes to the shadow, its middle to the midtone, its lightest third to the highlight.
  recolor(ctx, shot, found, t, w) {
    const frames = Math.round(1 + 3 * w);
    const h = found.hue.hue;
    // The light part before it is still coming down here: the split reads the picture as lifted
    // at the recolor's middle frame.
    const middle = t + ((frames - 1) / 2) * FRAME;
    const lift = found.lit.peak ? found.lit.peak * (1 - easingAt(CURVES.settle, clamp((middle - found.lit.at) / Math.max(1e-6, found.lit.down), 0, 1))) : 0;
    const split = recolorSplit(ctx.shotColor(shot.id)?.tones, lift);
    const to = { shadowColor: hslToHex({ h: h + 30, s: 0.44, l: 0.07 }), midtoneColor: hslToHex({ h: h - 26, s: 0.49, l: 0.52 }), highlightColor: hslToHex({ h: h - 44, s: 0.99, l: 0.86 }),
      ...(split ?? GUESSED_SPLIT), normalize: false };
    ctx.animate(shot.id, "hit-recolor", effect({ name: "Hit recolor", effect: "tritone", start: t, duration: frames * FRAME, easing: [0, 0, 1, 1], to, keepStill: "off" }), "impact");
    const where = split ? `tones split at luma ${to.threshold1} and ${to.threshold2}, nearest the thirds of ${shot.id}'s picture${lift > 0.05 ? ` lifted ${round(lift, 2)} stops by the light` : ""}` : `no brightness measured on ${shot.id}: tones split at luma 0.18 and 0.48`;
    return { start: t, end: t + frames * FRAME, said: `recolor tritone ${to.midtoneColor} (${frames} frames, ${shot.id}'s hue from ${found.hue.from}; ${where})` };
  },
  // A burst out of the subject: count, speed and size by w, in the shot's hue (shotTint at
  // lightness 0.75). Each particle lives half the window; the count falls to 0 by about the
  // middle (BURST curve: 4% left there), so most are born in the first frames and none again.
  // Measured with particlesAt: a linear fall over the whole window with life = window drew 21 of
  // 313 at 0.05 s and 90 at 0.5 s (a trickle, not a burst). Size x(1 + w) is a guess for
  // reading at 1080p (sparks are 3 px by default).
  particles(ctx, shot, found, t, w) {
    const look = found.input.particles ?? ctx.rng.pick(["sparks", "dust", "embers"]);
    const window = round(0.4 + 0.6 * w, 3);
    const count = Math.round(60 + 340 * w);
    const speed = Math.round((400 + 600 * w) * ctx.scale * (ctx.reduced ? 0.5 : 1));
    const size = round(PARTICLE_LOOKS[look].defaults.size * (1 + w) * ctx.scale, 1);
    const tint = shotTint(ctx, shot, { saturation: 0.6, lightness: 0.75 }).color;
    const [originX, originY] = found.subject.center;
    const layer = ctx.add("hit-particles", createLayer("rectangle", { name: "Hit particles", x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fillEnabled: false, strokeWidth: 0, blendMode: "add", role: "decor", allowOverlap: true }), { above: shot.id });
    ctx.animate(layer, "show", show(t));
    ctx.animate(layer, "burst", effect({ name: `Hit ${look}`, effect: look, start: t, duration: window, easing: BURST, keepStill: "off", from: { count },
      to: { count: 0, size, speed, spread: 360, direction: 0, lifetime: round(window / 2, 3), emitter: "point", originX, originY, prewarm: false, seed: ctx.rng.pick([3, 7, 11, 19]), loop: 0, ...(tint ? { color: tint, color2: "#FFFFFF" } : {}) } }));
    ctx.animate(layer, "fade", motion({ name: "Burst fades", start: t + window * 0.6, duration: window * 0.4, easing: CURVES.settle, from: { opacity: 1 }, to: { opacity: 0 } }));
    ctx.animate(layer, "hide", hide(t + window));
    return { start: t, end: t + window, said: `${look} ${count} from the ${found.subject.on} at [${found.subject.center.join(", ")}]` };
  },
};

export const impactAccent = {
  name: "impact-accent",
  needsAt: true,
  // Its at must be a cue that motivates it (ctx.cueFacts); the deck never deals it.
  needsCue: true,
  deal: false,
  nested: ["layer"],
  about: "one flash, shake, impact frame, dip or strobe on a shot, only at a cue that motivates it (light, an impact, a seam, a rest, a fill), sized by the cue's weight; hit: several parts one frame apart (light, blur, recolor, particles, shake), as many and as strong as the cue's weight",
  fits: "a measured hit, light, seam, rest or fill; most moments need none",
  tags: ["flash", "shake"],
  length: 0.2,
  fields: {
    kind: { kind: "choice", values: IMPACT_KINDS, required: true, about: "flash (light, a seam or a top accent), shake (an impact in the footage, a seam or a top accent), impact-frame (an impact in the footage), dip (a rest), strobe (a drum fill before the cue), hit: several parts one frame apart, as many and as strong as the cue's weight (any cue or time; a weak one gets 2 small parts)" },
    layer: { kind: "layer", about: "the shot (default the clip the impact or light is in, else the top shot on screen)" },
    color: { kind: "text", max: 7, about: "impact-frame: the silhouette's ink, hex (default near black)" },
    weight: { kind: "number", low: 0.1, high: 1, about: "hit: how strong the moment is, for one kino did not measure (default the cue's weight; 0.3 without one)" },
    parts: { kind: "choices", values: HIT_PART_NAMES, most: 6, about: "hit: these parts in this order (default by the cue: as many as its weight asks, each needs something in the shot)" },
    particles: { kind: "choice", values: HIT_LOOKS, about: "hit: the particle look (default sparks, dust or embers by seed)" },
  },
  example: { kind: "flash", at: "cue:song-drop-1" },
  setup: "a clip on screen; song-drop-1, a cue fit_music writes",
  build(ctx, input) {
    const facts = ctx.cueFacts ?? { at: ctx.start, cues: [], events: [] };
    const hit = input.kind === "hit";
    const found = hit ? hitMotive(facts, ctx.start, input) : motiveFor(input.kind, facts, ctx.start);
    // The accent sits on its cue: align and dur would move it off (early or late).
    // A time in seconds sits on the reason found near it (found.snapped): its time, not the one sent.
    if (ctx.dur !== null || (!found.snapped && Math.abs(ctx.start - found.at) > 1e-3))
      throw new Error(`impact-accent ${input.kind}: it starts on its cue (at most 2 frames early, never late), so it takes no align or dur; send at ${found.cue ? `"cue:${found.cue.name}"` : "the time"} alone.`);
    const shot = shotOf(ctx, input, found.motive);
    if (input.color !== undefined && !/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error("impact-accent color is a hex color such as \"#0A0A0C\".");
    const made = build[input.kind](ctx, shot, found, found.snapped ? found.at : ctx.start, facts, input);
    const where = found.cue ? `cue:${found.cue.name}` : `${round(found.at)} s`;
    const sized = hit && found.motive.weight !== found.measured ? `weight ${round(found.motive.weight, 2)} given, ${round(found.measured, 2)} measured` : `weight ${round(found.motive.weight, 2)}`;
    if (!hit) ctx.note(`impact-accent ${input.kind} on ${shot.id}: ${where} (${SAYS[found.motive.motive]}, ${sized})${found.note ? `; ${found.note}` : ""}`);
    else {
      ctx.note(`impact-accent hit on ${shot.id}: ${where} (${SAYS[found.motive.motive]}, ${sized}): ${made.count} part${made.count === 1 ? "" : "s"}${made.count > 1 ? ", one frame apart" : ""}: ${made.said.join(", ")}. parts:[...] picks them, weight sets the size; a flat frame is the move flash {frames:1} at the same cue`);
      if (found.note) ctx.note(found.note);
    }
    return { start: round(made.start), end: round(made.end), tags: made.tags,
      ...(found.cue ? { trigger: { cue: found.cue.name, at: round(found.at, 3), motive: found.motive.motive, weight: round(found.motive.weight, 2), kind: input.kind } } : {}) };
  },
};
