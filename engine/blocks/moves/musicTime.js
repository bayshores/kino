// Footage time on the music: speed-ramp and beat-repeat. Both work on a video layer at a time the
// agent picks (a song drop, a beat, a footage impact: at takes "cue:<name>"); compose never deals them.
//
// speed-ramp: the clip runs at `before` for `over` seconds into the cue, changes to `after` on the
// cue (the change takes 2 frames, so the hit lands on it) and, when `after` is not the clip's own
// speed, comes back to it `over` seconds later. Built on the layer's speed animation, so the
// picture, its sound and its beats all follow (engine/mediaTime.js).
//
// beat-repeat: the same moment of the file (from, length) replayed on several times (at plus
// times, or count replays every `every` seconds, one beat by default). Each replay is a muted
// copy made by the move, so the restraint rule "reused" does not count it as a slip.
import { createLayer } from "../../model.js";
import { MAX_MEDIA_SPEED, MIN_MEDIA_SPEED } from "../../mediaTime.js";
import { CURVES, hide, motion, round, show } from "./kit.js";

const FRAME = 1 / 30;
// The speed eases into `before` over at most this long, so the slow-down reads as a ramp.
const EASE_IN = 0.2;
const RAMP_CURVE = [0.45, 0, 0.55, 1];

function videoOf(ctx, id) {
  const layer = ctx.layer(id, "layer");
  if (layer.type !== "video") throw new Error(`${ctx.move} layer: ${id} is ${layer.type === "image" ? "a picture" : `a ${layer.type} layer`}; give a video layer (footage).`);
  return layer;
}

// Whether the clip plays at scene time `time` (inside its Play range).
function plays(layer, time) {
  const begins = layer.mediaStart ?? 0;
  return time >= begins - 1e-6 && (!(layer.mediaDuration > 0) || time <= begins + layer.mediaDuration + 1e-6);
}

export const speedRamp = {
  name: "speed-ramp",
  needsAt: true,
  deal: false,
  about: "a clip runs at one speed into a cue and another after it (slows into a hit and releases, or the reverse), on the clip's own speed so sound and beats follow",
  fits: "a hit on a drop, beat or impact",
  tags: ["speed-ramp"],
  length: 1.2,
  lasts: "not needed: before, after and over set it",
  fields: {
    layer: { kind: "layer", required: true, about: "the footage (a video layer) that changes speed" },
    before: { kind: "number", low: MIN_MEDIA_SPEED, high: MAX_MEDIA_SPEED, about: "speed into the cue (default 0.35: slow motion)" },
    after: { kind: "number", low: MIN_MEDIA_SPEED, high: MAX_MEDIA_SPEED, about: "speed from the cue (default the clip's own); swap with before to speed into it and slow after" },
    over: { kind: "number", low: 0.2, high: 3, about: "seconds at before ahead of the cue, and at after behind it (default 0.6)" },
  },
  example: { layer: "clip", at: 1.5, before: 0.35, after: 1.5 },
  setup: "clip, a full-frame video playing at the cue",
  build(ctx, input) {
    const layer = videoOf(ctx, input.layer);
    const t = ctx.start;
    const over = input.over ?? 0.6;
    const from = round(t - over);
    if (!plays(layer, from) || !plays(layer, t)) throw new Error(`speed-ramp: ${layer.id} must play from ${from} s to the cue at ${t} s; give a smaller over or a later at.`);
    const own = ctx.stateAt(layer.id, from).speed ?? layer.mediaSpeed ?? 1;
    const before = input.before ?? 0.35;
    const after = input.after ?? own;
    const easeIn = round(Math.min(EASE_IN, over / 2));
    ctx.animate(layer.id, "into", motion({ name: `Ramp to ${before}x`, start: from, duration: easeIn, easing: RAMP_CURVE, from: { speed: own }, to: { speed: before } }), "layer");
    // The change on the cue takes 2 frames and ends on it: the hit lands at the new speed.
    ctx.animate(layer.id, "hit", motion({ name: `${after}x on the cue`, start: round(t - 2 * FRAME), duration: round(2 * FRAME), easing: CURVES.accelerate, from: { speed: before }, to: { speed: after } }), "layer");
    let end = t + FRAME;
    if (Math.abs(after - own) > 1e-6) {
      const back = round(t + over);
      if (plays(layer, back)) {
        ctx.animate(layer.id, "back", motion({ name: `Back to ${own}x`, start: back, duration: easeIn, easing: RAMP_CURVE, from: { speed: after }, to: { speed: own } }), "layer");
        end = back + easeIn;
      }
    }
    ctx.note(`speed-ramp on ${layer.id}: ${own}x, ${before}x from ${from} s, ${after}x on ${t} s${end > t + FRAME ? `, ${own}x again from ${round(t + over)} s` : ""}`);
    return { start: from, end: round(end), tags: ["speed-ramp"] };
  },
};

export const beatRepeat = {
  name: "beat-repeat",
  needsAt: true,
  deal: false,
  about: "one moment of a clip replayed on several beats or cues (a stutter), each replay a muted copy that can grow a step or flip",
  fits: "a moment worth seeing again on the beat",
  tags: ["beat-cut"],
  length: 1.5,
  lasts: "not needed: the times and length set it",
  fields: {
    layer: { kind: "layer", required: true, about: "the footage (a video layer) whose moment is replayed" },
    from: { kind: "number", low: 0, high: 36000, about: "file second the moment starts (default the second the clip shows at at)" },
    length: { kind: "number", low: 0.05, high: 2, about: "seconds of the moment each replay shows (default 0.3; never past the next replay)" },
    times: { kind: "times", most: 16, about: "more replays: scene seconds after at (at is the first)" },
    count: { kind: "number", low: 2, high: 16, whole: true, about: "or: this many replays, every `every` seconds from at" },
    every: { kind: "number", low: 0.1, high: 4, about: "with count: seconds between replays (default one beat of the song's tempo)" },
    scaleStep: { kind: "number", low: 0, high: 0.3, knob: true, about: "each replay this much bigger than the one before (0.05 is 5%; default 0)" },
    flip: { kind: "choice", values: ["none", "alternate"], knob: true, about: "alternate mirrors every other replay (default none)" },
  },
  example: { layer: "clip", at: 1, count: 4, every: 0.5, length: 0.3, scaleStep: 0.05 },
  setup: "clip, a full-frame video",
  build(ctx, input) {
    const layer = videoOf(ctx, input.layer);
    const first = ctx.start;
    if (input.times && input.count) throw new Error("beat-repeat: give times or count, not both.");
    let times;
    if (input.count) {
      const every = input.every ?? (ctx.bpm ? 60 / ctx.bpm : null);
      if (!every) throw new Error("beat-repeat count: give every (seconds between replays); this project has no tempo (detect_beats or fit_music sets one).");
      times = Array.from({ length: input.count }, (_, index) => round(first + index * every, 3));
    } else times = [first, ...(input.times ?? [])];
    if (times.length < 2) throw new Error("beat-repeat: give times (more replays after at) or count; one replay is a plain cut.");
    times.slice(1).forEach((time, index) => {
      if (time <= times[index] + 0.05) throw new Error(`beat-repeat times: ${time} s must come after ${times[index]} s.`);
    });
    if (times.at(-1) > ctx.sceneDuration) throw new Error(`beat-repeat: the last replay at ${times.at(-1)} s is past the scene's end (${ctx.sceneDuration} s).`);
    const fileSecond = input.from ?? (plays(layer, first) ? round((layer.mediaOffset ?? 0) + (first - (layer.mediaStart ?? 0)) * (layer.mediaSpeed ?? 1), 3) : null);
    if (fileSecond === null) throw new Error(`beat-repeat: ${layer.id} does not play at ${first} s; give from (the file second of the moment).`);
    const length = input.length ?? 0.3;
    if (layer.mediaSourceDuration > 0 && fileSecond + length * (layer.mediaSpeed ?? 1) > layer.mediaSourceDuration + 1e-6)
      throw new Error(`beat-repeat: the moment ${fileSecond} s + ${length} s runs past the file's end (${layer.mediaSourceDuration} s); give an earlier from or a shorter length.`);
    const { id, name, animations, subjectBoxes, move, recipe, ...media } = layer;
    const sx = layer.scaleX ?? 1, sy = layer.scaleY ?? 1;
    times.forEach((time, index) => {
      const shows = round(Math.min(length, (times[index + 1] ?? Infinity) - time, ctx.sceneDuration - time), 3);
      const grow = 1 + index * (input.scaleStep ?? 0);
      const mirror = input.flip === "alternate" && index % 2 === 1 ? -1 : 1;
      const copy = ctx.add(`r${index + 1}`, createLayer("video", {
        ...media, mediaStart: time, mediaOffset: fileSecond, mediaDuration: shows, volume: 0,
        scaleX: round(sx * grow * mirror, 4), scaleY: round(sy * grow, 4),
      }), { above: layer.id });
      if (time > 0) ctx.animate(copy, "show", show(time));
      ctx.animate(copy, "hide", hide(round(time + shows, 3)));
    });
    ctx.note(`beat-repeat on ${layer.id}: file ${fileSecond} s for ${length} s at ${times.join(", ")} s (muted copies)`);
    return { start: first, end: round(times.at(-1) + Math.min(length, ctx.sceneDuration - times.at(-1)), 3), tags: ["beat-cut"] };
  },
};
