// impact-accent: one flash, shake, impact frame, dip or strobe on a shot, and only where a measured
// cue motivates it. The kind must match what the cue is:
//   flash         light in the shot (a footage light event), a song seam (song-drop, song-return,
//                 song-switch ...) or a top accent from detect_beats (rank 1 or weight 0.6 and up)
//   shake         an impact in the footage (a contact: something hits)
//   impact-frame  an impact in the footage that has no impact frame of its own
//   dip           a rest in the song (song-break, song-dropout): darker until the next seam
//   strobe        a drum fill measured just before the cue (4 or more even onsets), resolving on it
// Raw seconds, after:/with:/auto and beat or onset numbers are refused, with the nearest cue
// that would motivate the kind. Footage events (backend/footage/events.mjs) reach the move in
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
import { parseAt } from "../timing.js";
import { CURVES, effect, motion, round } from "./kit.js";

const FRAME = 1 / 30;
// An event this close to the cue is at the cue (the impact may come up to 2 frames early).
const NEAR = 2.5 * FRAME;
const EARLY = 2 * FRAME + 1e-6;
export const IMPACT_KINDS = Object.freeze(["flash", "shake", "impact-frame", "dip", "strobe"]);
const NEEDS = Object.freeze({ flash: ["light", "seam", "accent"], shake: ["impact"], "impact-frame": ["impact"], dip: ["dropout"], strobe: ["fill"] });
const SAYS = { light: "light in the shot", seam: "a song seam", accent: "a top accent", impact: "an impact in the footage", dropout: "a rest in the song", fill: "a drum fill before it" };
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

/** The cue the move was given and the reason it gives for `kind`, or throws a refusal that names a better cue. */
export function motiveFor(kind, facts, time) {
  const raw = facts?.at;
  let at;
  try { at = raw === undefined ? null : parseAt(raw); } catch { at = null; }
  if (!at || at.kind !== "cue") throw refuse(kind, `at ${JSON.stringify(raw ?? time)} is a time, not a reason`, facts, time);
  const cues = facts.cues ?? [];
  const cue = cues.find((entry) => entry.name === at.whole) ?? cues.find((entry) => entry.name === at.target);
  if (!cue) throw refuse(kind, `there is no cue "${at.whole}"`, facts, time);
  const offset = cue.name === at.whole ? 0 : at.offset;
  if (offset > 1e-6 || offset < -EARLY) throw refuse(kind, `the picture may come up to 2 frames (${round(EARLY, 3)} s) early, never late; ${at.whole} is off by ${round(offset)} s`, facts, time);
  const motives = cueMotives(cue, facts);
  if ((cue.kind === "beat" || cue.kind === "onset") && !(kind === "strobe" && motives.some((entry) => entry.motive === "fill")))
    throw refuse(kind, `cue:${cue.name} is a beat number, not a reason`, facts, time);
  const motive = motives.filter((entry) => NEEDS[kind].includes(entry.motive)).sort((a, b) => b.weight - a.weight)[0];
  if (!motive) {
    if (/^song-/.test(cue.name) && cue.fitted !== true && !motives.length)
      throw refuse(kind, `cue:${cue.name} was set by hand, not measured: song seams and rests come from fit_music`, facts, time);
    const has = motives.length ? `cue:${cue.name} is ${[...new Set(motives.map((entry) => SAYS[entry.motive]))].join(" and ")}` : `cue:${cue.name} has nothing measured at it`;
    throw refuse(kind, `${has}; ${kind} needs ${NEEDS[kind].map((entry) => SAYS[entry]).join(" or ")}`, facts, time);
  }
  return { cue, at: cue.time + offset, motive: { ...motive, weight: clamp(motive.weight ?? 0.5, 0.2, 1) } };
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
  shake(ctx, shot, { motive }, t) {
    if (ctx.reduced) { ctx.note("impact-accent shake: none in reduced motion"); return { start: t, end: t + FRAME, tags: [] }; }
    const dir = motive.dir ?? "right";
    const axes = [/left|right/.test(dir) ? "x" : null, /up|down/.test(dir) ? "y" : null].filter(Boolean);
    const size = ctx.frame.width * (0.01 + 0.01 * motive.weight) / (axes.length > 1 ? Math.SQRT2 : 1);
    // A cosine wave (phase a quarter) 0.1 s a cycle, decaying 14 a second: full on the cue's frame,
    // under 30% by the 4th frame; it ends at 0.125 s, where the wave is at rest, so nothing is held.
    const length = 0.125;
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
    const shake = { ...motion({ name: `Shake (impact ${round(motive.weight, 2)} ${dir})`, start: t, duration: length, easing: SNAP, from: rest, to: {} }),
      fromCurrent: true, behavior: { oscillate: { amount, period: 0.1, phase: 0.25, wave: "sine", decay: 14 } } };
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
};

export const impactAccent = {
  name: "impact-accent",
  needsAt: true,
  // Its at must be a cue that motivates it (ctx.cueFacts); the deck never deals it.
  needsCue: true,
  deal: false,
  nested: ["layer"],
  about: "one flash, shake, impact frame, dip or strobe on a shot, only at a cue that motivates it (light, an impact, a seam, a rest, a fill), sized by the cue's weight",
  fits: "a measured hit, light, seam, rest or fill; most moments need none",
  tags: ["flash", "shake"],
  length: 0.2,
  fields: {
    kind: { kind: "choice", values: IMPACT_KINDS, required: true, about: "flash (light, a seam or a top accent), shake or impact-frame (an impact in the footage), dip (a rest), strobe (a drum fill before the cue)" },
    layer: { kind: "layer", about: "the shot (default the clip the impact or light is in, else the top shot on screen)" },
    color: { kind: "text", max: 7, about: "impact-frame: the silhouette's ink, hex (default near black)" },
  },
  example: { kind: "flash", at: "cue:song-drop-1" },
  setup: "a clip on screen; song-drop-1, a cue fit_music writes",
  build(ctx, input) {
    const facts = ctx.cueFacts ?? { at: ctx.start, cues: [], events: [] };
    const found = motiveFor(input.kind, facts, ctx.start);
    // The accent sits on its cue: align and dur would move it off (early or late).
    if (ctx.dur !== null || Math.abs(ctx.start - found.at) > 1e-3)
      throw new Error(`impact-accent ${input.kind}: it starts on its cue (at most 2 frames early, never late), so it takes no align or dur; send at "cue:${found.cue.name}" alone.`);
    const shot = shotOf(ctx, input, found.motive);
    if (input.color !== undefined && !/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error("impact-accent color is a hex color such as \"#0A0A0C\".");
    const made = build[input.kind](ctx, shot, found, ctx.start, facts);
    ctx.note(`impact-accent ${input.kind} on ${shot.id}: cue:${found.cue.name} (${SAYS[found.motive.motive]}, weight ${round(found.motive.weight, 2)})`);
    return { start: round(made.start), end: round(made.end), tags: made.tags };
  },
};
