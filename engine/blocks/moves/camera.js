// Two camera accents any layer can take at any time, no cue needed (impact-accent is the one that
// reads a measured hit; these are the agent's own call):
// - punch-in: the frame snaps closer on a point (a digital zoom on a hit or a line), holds, then
//   eases back, cuts back or stays. Built the way editors key it: a scale jump over 2 to 4 frames
//   with a strong ease-out, the point kept still (the layer moves so the point does not), and a
//   touch of zoom blur on the snap only.
// - shake: a handheld or impact shake, random (fractal noise wiggle, as motion tools key camera
//   shake with wiggle(frequency, amount)) and dying down over its length: the length is cut in
//   parts whose wiggle gets smaller each time, each part starting and ending at rest, so the shake
//   adds to the layer's own moves and never jumps.
// Reduced motion: a punch-in cuts in at half the scale with no blur; no shake (a note says so).
import { CURVES, boxOf, effect, motion, pointIn, round, scaledAbout } from "./kit.js";

const FRAME = 1 / 30;
const OUTS = ["back", "cut", "stay"];
const AXES = ["both", "x", "y"];
// From the layer's place now, then wherever its own moves go (fromCurrent): a shake adds to them.
const SNAP = Object.freeze([0, 1, 0, 1]);
const backTime = (snap) => Math.max(0.18, snap * 2.5);

function punchLength(input) {
  const snap = input.in ?? 0.1, hold = input.hold ?? 0.5, out = input.out ?? "back";
  return snap + hold + (out === "back" ? backTime(snap) : out === "cut" ? FRAME : 0);
}

export const punchIn = {
  name: "punch-in",
  needsAt: true,
  nested: ["layer"],
  about: "the frame snaps closer on a point in a few frames (a digital zoom), holds, then eases back, cuts back or stays; any picture, clip, text or group",
  fits: "a hit, a reaction, the line that lands; one punch per moment, not on every beat",
  tags: ["punch-in"],
  length: punchLength({}),
  lasts: "not needed: snap, hold and out",
  fields: {
    layer: { kind: "layer", required: true, about: "the layer the frame punches into (usually the full-frame clip)" },
    scale: { kind: "number", low: 1.02, high: 3, about: "how much closer, times its size now (default 1.2)" },
    point: { kind: "point", about: "[x, y] in % of the layer's box that stays still (default its center; give the face or the subject)" },
    in: { kind: "number", low: 0.03, high: 1, about: "seconds of the snap (default 0.1: 3 frames)" },
    hold: { kind: "number", low: 0, high: 10, about: "seconds it holds close (default 0.5)" },
    out: { kind: "choice", values: OUTS, about: "back (eases out, default), cut (jumps back) or stay (holds close to the layer's end)" },
    blur: { kind: "number", low: 0, high: 1, about: "zoom blur on the snap (default 0.12; 0 none)" },
  },
  example: { layer: "shot-a", scale: 1.25, point: [50, 40], at: 1 },
  setup: "shot-a, a full-frame picture",
  timing: (input) => ({ length: round(punchLength(input)) }),
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const t = ctx.start;
    const here = ctx.stateAt(layer.id, t);
    const scaleX = here.scaleX ?? layer.scaleX ?? 1, scaleY = here.scaleY ?? layer.scaleY ?? 1;
    const box = { ...boxOf(layer), x: here.x ?? layer.x, y: here.y ?? layer.y };
    const factor = ctx.reduced ? 1 + ((input.scale ?? 1.2) - 1) / 2 : input.scale ?? 1.2;
    const moved = scaledAbout(box, pointIn(box, input.point), factor);
    const rest = { x: round(box.x, 2), y: round(box.y, 2), scaleX: round(scaleX, 4), scaleY: round(scaleY, 4) };
    const close = { x: moved.x, y: moved.y, scaleX: round(scaleX * factor, 4), scaleY: round(scaleY * factor, 4) };
    const snap = ctx.reduced ? 0.001 : input.in ?? 0.1;
    const hold = input.hold ?? 0.5, out = input.out ?? "back";
    ctx.animate(layer.id, "in", motion({ name: `Punch in x${round(factor, 2)}`, start: t, duration: snap, easing: CURVES.settle, from: rest, to: close }));
    const blur = input.blur ?? 0.12;
    if (!ctx.reduced && blur > 0)
      ctx.animate(layer.id, "blur", effect({ name: "Punch blur", effect: "zoom-blur", start: t, duration: snap, easing: CURVES.settle, from: { amount: blur }, to: { amount: 0 }, keepStill: "off" }));
    let end = t + snap + hold;
    if (out !== "stay") {
      const back = out === "cut" ? 0.001 : backTime(snap);
      ctx.animate(layer.id, "out", motion({ name: out === "cut" ? "Punch cut back" : "Punch back", start: end, duration: back, easing: CURVES.fade, from: close, to: rest }));
      end += out === "cut" ? FRAME : back;
    }
    return { end: round(end), tags: punchIn.tags };
  },
};

export const shake = {
  name: "shake",
  needsAt: true,
  nested: ["layer"],
  about: "a random handheld or impact shake that dies down, on any layer at any time (no cue needed): strength, frequency, turn, axis, decay and seed",
  fits: "a hit, a blast, a bass drop, nervous energy; short (0.2 to 0.6 s) for a hit, long and soft for handheld",
  tags: ["shake"],
  length: 0.5,
  shortest: 0.1,
  fields: {
    layer: { kind: "layer", required: true, about: "the layer that shakes (usually the full-frame clip; scale it a little up first so no edge shows)" },
    strength: { kind: "number", low: 1, high: 200, about: "the largest offset in px at 1080p (default 18)" },
    frequency: { kind: "number", low: 1, high: 40, about: "shakes a second (default 14; 2 to 4 is handheld drift)" },
    rotation: { kind: "number", low: 0, high: 15, about: "the largest turn in degrees (default 0.8; 0 none)" },
    axis: { kind: "choice", values: AXES, about: "both (default), x (side to side) or y (up and down)" },
    decay: { kind: "number", low: 0, high: 1, about: "how much it dies down by the end (default 0.85; 0 keeps it even)" },
    seed: { kind: "number", low: 0, high: 100000, whole: true, about: "another number gives another shake (default seeded)" },
  },
  example: { layer: "shot-a", strength: 24, at: 1, dur: 0.5 },
  setup: "shot-a, a full-frame picture",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const t = ctx.start;
    if (ctx.reduced) { ctx.note("shake: none in reduced motion"); return { start: t, end: round(t + FRAME), tags: [] }; }
    const axis = input.axis ?? "both";
    const size = (input.strength ?? 18) * ctx.scale;
    const turn = input.rotation ?? 0.8;
    const decay = input.decay ?? 0.85;
    const seed = input.seed ?? ctx.rng.pick([5, 11, 23, 37, 61, 97]);
    const parts = decay > 0 ? 3 : 1;
    const each = ctx.duration / parts;
    for (let part = 0; part < parts; part += 1) {
      const level = (1 - decay * 0.999) ** (part / 2.5);
      const start = t + part * each;
      const here = ctx.stateAt(layer.id, start);
      const amount = {
        ...(axis !== "y" ? { x: round(size * level, 1) } : {}),
        ...(axis !== "x" ? { y: round(size * level, 1) } : {}),
        ...(turn > 0 ? { rotation: round(turn * level, 2) } : {}),
      };
      const rest = Object.fromEntries(Object.keys(amount).map((key) => [key, round(here[key] ?? layer[key] ?? 0, 2)]));
      ctx.animate(layer.id, parts > 1 ? `shake-${part + 1}` : "shake", { ...motion({ name: `Shake ${part + 1}`, start, duration: each, easing: SNAP, from: rest, to: {} }),
        fromCurrent: true, behavior: { wiggle: { amount, rate: input.frequency ?? 14, seed: seed + part } } });
    }
    return { end: round(t + ctx.duration), tags: shake.tags };
  },
};
