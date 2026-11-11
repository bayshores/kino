// Footage time on the music: speed-ramp and beat-repeat. Both work on a video layer at a time the
// agent picks (a song drop, a beat, a footage impact: at takes "cue:<name>"); compose never deals them.
//
// speed-ramp: the clip runs at `before` for `over` seconds into the cue, changes to `after` on the
// cue (the change takes 2 frames, so the new speed lands on it) and, when `after` is not the clip's
// own speed, comes back to it `over` seconds later. Built on the layer's speed animation, so the
// picture, its sound and its beats all follow (engine/mediaTime.js). A slow stretch reads less of
// the file, so the footage after it runs later than before; land:"moment" moves the clip's
// mediaOffset so the file moment it showed on the cue still shows on the cue.
//
// beat-repeat: the same moment of the file (from, length) replayed on several times (at plus
// times, or count replays every `every` seconds, one beat by default). Each replay is a muted
// copy made by the move, so the restraint rule "reused" does not count it as a slip. A replay
// plays the moment the way the clip shows it at `at`: the same direction and speed.
import { createLayer } from "../../model.js";
import { speedAnimations } from "../../animation.js";
import { MAX_MEDIA_SPEED, MIN_MEDIA_SPEED, isReversed, speedAtClock } from "../../mediaTime.js";
import { mediaFrameState } from "../../playback.js";
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

// Whether the clip plays at scene time `time`: inside its Play range, which ends where the file
// ends (its length, offset and speed; playback.js effectiveMediaDuration), not only where a stored
// mediaDuration says.
const plays = (layer, time) => mediaFrameState(layer, time).playing;

export const speedRamp = {
  name: "speed-ramp",
  needsAt: true,
  deal: false,
  about: "a clip runs at one speed into a cue and another after it (slows into a hit and releases, or the reverse), on the clip's own speed so sound and beats follow; land:\"moment\" keeps the file moment on the cue",
  fits: "a hit on a drop, beat or impact",
  tags: ["speed-ramp"],
  length: 1.2,
  lasts: "not needed: before, after and over set it",
  fields: {
    layer: { kind: "layer", required: true, about: "the footage (a video layer) that changes speed" },
    before: { kind: "number", low: MIN_MEDIA_SPEED, high: MAX_MEDIA_SPEED, about: "speed into the cue (default 0.35: slow motion)" },
    after: { kind: "number", low: MIN_MEDIA_SPEED, high: MAX_MEDIA_SPEED, about: "speed from the cue (default the clip's own); swap with before to speed into it and slow after" },
    over: { kind: "number", low: 0.2, high: 3, about: "seconds at before ahead of the cue, and at after behind it (default 0.6)" },
    land: { kind: "choice", values: ["speed", "moment"], about: "speed (default): the footage after a slow stretch runs later than before; moment: mediaOffset moves so the file moment the clip showed on the cue still shows on it" },
  },
  example: { layer: "clip", at: 1.5, before: 0.35, after: 1.5 },
  setup: "clip, a full-frame video playing at the cue",
  build(ctx, input) {
    const layer = videoOf(ctx, input.layer);
    const t = ctx.start;
    const over = input.over ?? 0.6;
    const from = round(t - over);
    const easeIn = round(Math.min(EASE_IN, over / 2));
    // Another speed change on this clip around the ramp (an earlier ramp): its speed there is not
    // the clip's own, so a second ramp would start from the wrong speed and fight the first.
    const clash = speedAnimations(layer).find((animation) => (animation.start ?? 0) < t + over + easeIn - 1e-6 && (animation.start ?? 0) + (animation.duration ?? 0) > from + 1e-6);
    if (clash) throw new Error(`speed-ramp: ${layer.id} already changes speed from ${round(clash.start ?? 0)} s to ${round((clash.start ?? 0) + (clash.duration ?? 0))} s (${clash.name ?? clash.id}); give an at outside it, or remove that ramp first.`);
    if (!plays(layer, from) || !plays(layer, t)) throw new Error(`speed-ramp: ${layer.id} must play from ${from} s to the cue at ${t} s (its file ends or its Play range does); give a smaller over or another at.`);
    const own = ctx.stateAt(layer.id, from).speed ?? layer.mediaSpeed ?? 1;
    // Reduced motion: never faster than the clip's own speed; slow motion stays.
    const calm = (speed) => (ctx.reduced ? Math.min(speed, own) : speed);
    const before = calm(input.before ?? 0.35);
    const after = calm(input.after ?? own);
    if (Math.abs(before - own) < 1e-6 && Math.abs(after - own) < 1e-6) {
      ctx.note(`speed-ramp on ${layer.id}: none in reduced motion (it only sped the clip up)`);
      return { start: t, end: round(t + FRAME), tags: [] };
    }
    const made = [
      ["into", motion({ name: `Ramp to ${before}x`, start: from, duration: easeIn, easing: RAMP_CURVE, from: { speed: own }, to: { speed: before } })],
      // The change on the cue takes 2 frames and ends on it: the new speed lands on the cue.
      ["hit", motion({ name: `${after}x on the cue`, start: round(t - 2 * FRAME), duration: round(2 * FRAME), easing: CURVES.accelerate, from: { speed: before }, to: { speed: after } })],
    ];
    const back = round(t + over);
    if (Math.abs(after - own) > 1e-6) made.push(["back", motion({ name: `Back to ${own}x`, start: back, duration: easeIn, easing: RAMP_CURVE, from: { speed: after }, to: { speed: own } })]);
    let ramped = { ...layer, animations: [...(layer.animations ?? []), ...made.map(([, animation]) => animation)] };
    // How far the file moment on the cue moved: the slow stretch read less of the file.
    const late = round(mediaFrameState(layer, t).sourceTime - mediaFrameState(ramped, t).sourceTime, 3);
    if (input.land === "moment" && Math.abs(late) > 1e-3) {
      if (isReversed(layer)) throw new Error(`speed-ramp land:"moment": ${layer.id} plays backwards; leave land out or give mediaOffset yourself.`);
      const offset = round((layer.mediaOffset ?? 0) + late, 3);
      if (offset < 0) throw new Error(`speed-ramp land:"moment": ${layer.id} would need to start ${round(-offset, 3)} s before its file starts; give a later at or a smaller over.`);
      ctx.set(layer.id, { mediaOffset: offset });
      ramped = { ...ramped, mediaOffset: offset };
      if (!plays(ramped, t)) throw new Error(`speed-ramp land:"moment": ${layer.id} would end before the cue at ${t} s; leave land out or give a smaller over.`);
    }
    for (const [role, animation] of made) {
      if (role === "back" && !plays(ramped, back)) continue;
      ctx.animate(layer.id, role, animation, "layer");
    }
    const returns = made.length === 3 && plays(ramped, back);
    const shown = round(mediaFrameState(ramped, t).sourceTime, 3);
    const landed = input.land === "moment" ? `file ${shown} s on the cue as before (mediaOffset ${ramped.mediaOffset ?? 0})` : `file ${shown} s on the cue, ${late} s behind the unramped clip from then on`;
    ctx.note(`speed-ramp on ${layer.id}: ${own}x, ${before}x from ${from} s, ${after}x on ${t} s${returns ? `, ${own}x again from ${back} s` : ""}; ${landed}`);
    return { start: from, end: round(returns ? back + easeIn : t + FRAME), tags: ["speed-ramp"] };
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
    scaleStep: { kind: "number", low: 0, high: 0.3, knob: true, about: "each replay this much bigger than the one before (0.05 is 5%; default 0; none in reduced motion)" },
    flip: { kind: "choice", values: ["none", "alternate"], knob: true, about: "alternate mirrors every other replay (default none; none in reduced motion)" },
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
    // Every replay shows for at least a frame before the scene ends.
    if (times.at(-1) > ctx.sceneDuration - FRAME + 1e-6) throw new Error(`beat-repeat: the last replay at ${times.at(-1)} s leaves no frame before the scene's end (${ctx.sceneDuration} s).`);
    // The moment as the clip shows it at `at`: its file second (speed animations and a reversed
    // clip included) and its speed there; each replay plays it the same way.
    const state = mediaFrameState(layer, first);
    if (input.from === undefined && !state.playing) throw new Error(`beat-repeat: ${layer.id} does not play at ${first} s; give from (the file second of the moment).`);
    const fileSecond = input.from ?? round(state.sourceTime, 3);
    const speed = round(Math.min(MAX_MEDIA_SPEED, Math.max(MIN_MEDIA_SPEED, speedAtClock(layer, first))), 4);
    const backwards = isReversed(layer);
    const length = input.length ?? 0.3;
    const read = length * speed;
    if (!backwards && layer.mediaSourceDuration > 0 && fileSecond + read > layer.mediaSourceDuration + 1e-6)
      throw new Error(`beat-repeat: the moment ${fileSecond} s + ${length} s runs past the file's end (${layer.mediaSourceDuration} s); give an earlier from or a shorter length.`);
    if (backwards && fileSecond - read < -1e-6)
      throw new Error(`beat-repeat: the moment ${fileSecond} s back ${length} s runs past the file's start (the clip plays backwards); give a later from or a shorter length.`);
    const { id, name, animations, subjectBoxes, move, recipe, ...media } = layer;
    const sx = layer.scaleX ?? 1, sy = layer.scaleY ?? 1;
    times.forEach((time, index) => {
      const shows = round(Math.min(length, (times[index + 1] ?? Infinity) - time, ctx.sceneDuration - time), 3);
      // Reduced motion: the replays are cuts only, no growth and no mirroring.
      const grow = ctx.reduced ? 1 : 1 + index * (input.scaleStep ?? 0);
      const mirror = !ctx.reduced && input.flip === "alternate" && index % 2 === 1 ? -1 : 1;
      // A backwards clip reads its stretch from the end, so the stretch ends on the moment.
      const offset = backwards ? round(Math.max(0, fileSecond - shows * speed), 3) : fileSecond;
      const copy = ctx.add(`r${index + 1}`, createLayer("video", {
        ...media, mediaStart: time, mediaOffset: offset, mediaDuration: shows, mediaSpeed: speed, volume: 0,
        scaleX: round(sx * grow * mirror, 4), scaleY: round(sy * grow, 4),
      }), { above: layer.id });
      if (time > 0) ctx.animate(copy, "show", show(time));
      ctx.animate(copy, "hide", hide(round(time + shows, 3)));
    });
    const calm = ctx.reduced && (input.scaleStep || input.flip === "alternate") ? "; reduced motion: no growth or mirroring" : "";
    ctx.note(`beat-repeat on ${layer.id}: file ${fileSecond} s for ${length} s${backwards ? " backwards" : ""} at ${speed}x, at ${times.join(", ")} s (muted copies)${calm}`);
    return { start: first, end: round(times.at(-1) + Math.min(length, ctx.sceneDuration - times.at(-1)), 3), tags: ["beat-cut"] };
  },
};
