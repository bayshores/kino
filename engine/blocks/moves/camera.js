// Two camera accents any layer can take (impact-accent is the one that reads a measured hit; these
// are the agent's own call). In a music edit check wants each loud accent on a cue, so put a shake
// at "cue:<name>" there; a punch-in is a zoom and needs none.
// - punch-in: the frame snaps closer on a point (a digital zoom on a hit or a line), holds, then
//   eases back, cuts back or stays. Built the way editors key it: a scale jump over 2 to 4 frames
//   with a strong ease-out, the point kept still (the layer moves so the point does not), and a
//   touch of zoom blur on the snap only. It starts from the layer's place and size at that moment
//   and returns to them.
// - shake: a handheld or impact shake, random (fractal noise wiggle, as motion tools key camera
//   shake with wiggle(frequency, amount)) and dying down over its length: one wiggle animation with
//   a decay. On a layer that fills the frame it also scales the layer up a little while it shakes,
//   so no edge shows.
// Both hold the keys they move (place, size, turn) for their whole length, so a layer that moves
// those keys itself during one is refused with the window to use instead (a custom animation
// replaces the value of the keys it names while it plays).
// Reduced motion: a punch-in cuts in at half the scale with no blur; no shake (a note says so).
import { enabledAnimations } from "../../animationEnabled.js";
import { CURVES, boxOf, coversFrameAt, effect, motion, pointIn, round, scaledAbout } from "./kit.js";

const FRAME = 1 / 30;
const OUTS = ["back", "cut", "stay"];
const AXES = ["both", "x", "y"];
// Jumps to the end value at once (the move's own easing shapes a ramp or a wiggle).
const SNAP = Object.freeze([0, 1, 0, 1]);
const backTime = (snap) => Math.max(0.18, snap * 2.5);

/** The layer's own move of one of `keys` that plays inside [from, to] seconds, or undefined. */
function movesInside(layer, keys, from, to) {
  return enabledAnimations(layer.animations ?? []).find((animation) => animation && ["in", "out", "custom"].includes(animation.kind) && (!animation.unit || animation.unit === "layer")
    && [...Object.keys(animation.from ?? {}), ...Object.keys(animation.to ?? {})].some((key) => keys.includes(key))
    && (animation.start ?? 0) < to - 1e-6 && (animation.start ?? 0) + (animation.duration ?? 0) > from + 1e-6);
}
function refuseOwnMove(move, layer, keys, from, to) {
  const own = movesInside(layer, keys, from, to);
  if (own) throw new Error(`${move}: ${layer.id} already moves its place or size from ${round(own.start ?? 0)} to ${round((own.start ?? 0) + (own.duration ?? 0))} s, inside the ${move} (${round(from)} to ${round(to)} s); put the ${move} before or after that move, or on another layer.`);
}

function punchLength(input) {
  const snap = input.in ?? 0.1, hold = input.hold ?? 0.5, out = input.out ?? "back";
  return snap + hold + (out === "back" ? backTime(snap) : out === "cut" ? FRAME : 0);
}

export const punchIn = {
  name: "punch-in",
  needsAt: true,
  nested: ["layer"],
  about: "the frame snaps closer on a point in a few frames (a digital zoom), holds, then eases back, cuts back or stays; any picture, clip, text or group",
  fits: "a hit, a reaction, a line that lands; one per moment",
  tags: ["punch-in"],
  length: punchLength({}),
  lasts: "not needed: snap, hold and out",
  fields: {
    layer: { kind: "layer", required: true, about: "the layer the frame punches into (usually the full-frame clip; it must not move its own place or size meanwhile)" },
    scale: { kind: "number", low: 1.02, high: 3, about: "how much closer, times its size now (default 1.2)" },
    point: { kind: "point", about: "[x, y] in % of the layer's box that stays still (default its center; give the face or the subject)" },
    in: { kind: "number", low: 0.03, high: 1, about: "seconds of the snap (default 0.1: 3 frames)" },
    hold: { kind: "number", low: 0, high: 10, about: "seconds it holds close (default 0.5)" },
    out: { kind: "choice", values: OUTS, about: "back (eases out, default), cut (jumps back) or stay (holds close to the layer's end)" },
    blur: { kind: "number", low: 0, high: 1, about: "zoom blur on the snap (default 0.12; 0 none)" },
  },
  example: { layer: "shot-a", scale: 1.1, point: [50, 40], at: 1 },
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
    const close = { x: round(moved.x, 2), y: round(moved.y, 2), scaleX: round(scaleX * factor, 4), scaleY: round(scaleY * factor, 4) };
    const snap = ctx.reduced ? 0.001 : input.in ?? 0.1;
    const hold = input.hold ?? 0.5, out = input.out ?? "back";
    const back = out === "cut" ? 0.001 : backTime(snap);
    refuseOwnMove("punch-in", layer, Object.keys(rest), t, t + snap + hold + (out === "stay" ? 0 : back));
    ctx.animate(layer.id, "in", motion({ name: `Punch in x${round(factor, 2)}`, start: t, duration: snap, easing: CURVES.settle, from: rest, to: close }));
    const blur = input.blur ?? 0.12;
    if (!ctx.reduced && blur > 0)
      ctx.animate(layer.id, "blur", effect({ name: "Punch blur", effect: "zoom-blur", start: t, duration: snap, easing: CURVES.settle, from: { amount: blur }, to: { amount: 0 } }));
    let end = t + snap + hold;
    if (out !== "stay") {
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
  about: "a random handheld or impact shake that dies down: strength, frequency, turn, axis and decay; in a music edit put it on a cue (at \"cue:<name>\"), elsewhere any time",
  fits: "a hit, a blast, a bass drop; 0.2 to 0.6 s, or long and soft for handheld",
  tags: ["shake"],
  length: 0.5,
  shortest: 0.1,
  fields: {
    layer: { kind: "layer", required: true, about: "the layer that shakes (usually the full-frame clip; one that fills the frame is scaled up a little meanwhile so no edge shows; it must not move its own place or size meanwhile)" },
    strength: { kind: "number", low: 1, high: 200, about: "the largest offset in px at 1080p (default 18)" },
    frequency: { kind: "number", low: 1, high: 30, about: "shakes a second (default 8; 2 to 4 is handheld drift; above 10 reads as jitter at 30 fps)" },
    rotation: { kind: "number", low: 0, high: 15, about: "the largest turn in degrees (default 0.8; 0 none)" },
    axis: { kind: "choice", values: AXES, about: "both (default), x (side to side) or y (up and down)" },
    decay: { kind: "number", low: 0, high: 1, about: "how much it dies down by the end (default 0.85; 0 keeps it even)" },
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
    const length = ctx.duration;
    const seed = ctx.rng.pick([5, 11, 23, 37, 61, 97]);
    const here = ctx.stateAt(layer.id, t);
    const amount = {
      ...(axis !== "y" ? { x: round(size, 1) } : {}),
      ...(axis !== "x" ? { y: round(size, 1) } : {}),
      ...(turn > 0 ? { rotation: round(turn, 2) } : {}),
    };
    const covers = coversFrameAt(ctx, layer.id, t);
    refuseOwnMove("shake", layer, [...Object.keys(amount), ...(covers ? ["scaleX", "scaleY"] : [])], t, t + length);
    // It dies down to (1 - decay) of its size by the end: e^(-rate * length) = 1 - decay.
    const dying = decay > 0 ? round(-Math.log(1 - decay * 0.999) / length, 3) : 0;
    const rest = Object.fromEntries(Object.keys(amount).map((key) => [key, round(here[key] ?? layer[key] ?? 0, 2)]));
    ctx.animate(layer.id, "shake", { ...motion({ name: "Shake", start: t, duration: length, easing: SNAP, from: rest, to: rest }),
      behavior: { wiggle: { amount, rate: input.frequency ?? 8, seed, ...(dying > 0 ? { decay: dying } : {}) } } });
    // A layer that fills the frame grows just enough to cover its edges at the largest offset and
    // turn (the wiggle never passes its amount), then eases back while the shake dies down.
    if (covers) {
      const scaleX = here.scaleX ?? layer.scaleX ?? 1, scaleY = here.scaleY ?? layer.scaleY ?? 1;
      const wide = (here.width ?? layer.width) * scaleX, tall = (here.height ?? layer.height) * scaleY;
      const turned = (turn * Math.PI / 180) * Math.max(wide, tall) / Math.min(wide, tall);
      const need = Math.max(axis !== "y" ? (2 * size) / wide : 0, axis !== "x" ? (2 * size) / tall : 0) + turned;
      const grow = round(need * 1.1, 4);
      const base = { scaleX: round(scaleX, 4), scaleY: round(scaleY, 4) };
      const peak = { scaleX: round(scaleX * (1 + grow), 4), scaleY: round(scaleY * (1 + grow), 4) };
      const up = Math.min(0.08, length * 0.2), back = decay > 0 ? 0.4 : 0.15;
      ctx.animate(layer.id, "grow", motion({ name: "Shake cover", start: t, duration: up, easing: CURVES.settle, from: base, to: peak }));
      ctx.animate(layer.id, "settle", motion({ name: "Shake cover back", start: t + length * (1 - back), duration: length * back, easing: CURVES.drift, from: peak, to: base }));
    }
    return { end: round(t + length), tags: shake.tags };
  },
};
