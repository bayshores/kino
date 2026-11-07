// Transitions between two beats: cut-on-motion, push and mask-wipe. A transition
// rewrites how the outgoing layers leave (their exits end at the boundary `at`) and how the
// incoming layers enter (they start at `at` or later, keeping their own timing). The outgoing
// and incoming layers are never on screen together, so nothing overlaps during the change.
// Moves stop at the frame's edge, so no layer is pushed partly out of the picture.
import { createLayer } from "../../model.js";
import { exitLength, paint } from "../build.js";
import { durationOf, easingOf } from "../tokens.js";
import { round } from "../../numbers.js";

// Entrances that change a size, an arc or a reveal stay as they are: they are a shape drawing
// itself, not a layer arriving.
const KEEP_KEYS = new Set(["width", "height", "sweep", "reveal"]);

export const TRANSITIONS = Object.freeze({
  "cut-on-motion": {
    name: "cut-on-motion",
    about: "the outgoing beat moves up and away; the incoming beat carries on upward into place, so the motion hides the cut",
  },
  push: {
    name: "push",
    about: "the outgoing beat slides out to the left; the incoming beat slides in from the right",
  },
  "mask-wipe": {
    name: "mask-wipe",
    about: "an accent bar sweeps across the frame; the incoming beat is revealed behind it",
  },
});
export const TRANSITION_NAMES = Object.freeze(Object.keys(TRANSITIONS));

function keeps(animation) {
  return [animation.from, animation.to].some((side) => side && Object.keys(side).some((key) => KEEP_KEYS.has(key)));
}

function replaceExit(layer, exit) {
  const id = `${layer.id}.out`;
  layer.animations = (layer.animations ?? []).filter((animation) => animation.id !== id);
  layer.animations.push({ id, ...exit });
}

const SETTLE = 0.1;
const holdOf = (layer) => (layer.animations ?? []).find((animation) => String(animation.id ?? "").endsWith(".hold")) ?? null;

// The layer where its hold drift leaves it: its box moved by the drift (the push is left out).
function heldPlace(layer) {
  const hold = holdOf(layer);
  return hold ? { ...layer, x: hold.to.x ?? layer.x, y: hold.to.y ?? layer.y } : layer;
}

function entranceOf(layer) {
  return (layer.animations ?? []).find((animation) => animation.id === `${layer.id}.in`) ?? null;
}

// How long a layer's exit takes: about 65% of its entrance (a pop counts its scale too).
function leaveLength(ctx, layer, fallback) {
  const entering = entranceOf(layer);
  if (!entering) return fallback;
  const together = (layer.animations ?? []).filter((animation) => animation.kind !== "out" && Math.abs(animation.start - entering.start) < 1e-6);
  return exitLength(ctx, layer, Math.max(...together.map((animation) => animation.duration)));
}

// How far a layer may move toward one side and stay fully inside the frame (at most `most`).
function room(layer, frame, side, most) {
  const space = {
    left: layer.x, right: frame.width - (layer.x + (layer.width ?? 0)),
    up: layer.y, down: frame.height - (layer.y + (layer.height ?? 0)),
  }[side];
  return Math.max(0, Math.min(most, Math.floor(space)));
}

function exitShape(ctx, { start, duration, from, to, name }) {
  return { name, kind: "out", start: round(start), duration: round(duration), easing: easingOf("exit", ctx.style.feel.intensity), unit: "layer", stagger: 0, order: "forward", from, to };
}

/**
 * Applies transition `name` at `at` seconds. `outgoing` and `incoming` are layers (changed in
 * place). Returns new layers to add on top (mask-wipe's bar), each marked with `recipe`.
 */
export function applyTransition(name, ctx, { outgoing, incoming, at, id }) {
  if (!TRANSITIONS[name]) throw new Error(`Unknown transition "${name}". Transitions: ${TRANSITION_NAMES.join(", ")}.`);
  const { frame } = ctx;
  const standard = durationOf("standard", ctx.style.feel.position);
  const reduced = Boolean(ctx.reduced);
  // Exits end at the boundary. Each leaves from where its hold drift (engine/blocks/hold.js) left it.
  for (const layer of outgoing) {
    const held = heldPlace(layer);
    const length = leaveLength(ctx, layer, standard);
    const fadeOnly = reduced || name === "mask-wipe" || (layer.role === "decor" && layer.type !== "text");
    if (fadeOnly) {
      replaceExit(layer, exitShape(ctx, { name: "Fade out", start: at - length, duration: length, from: { opacity: 1 }, to: { opacity: 0 } }));
    } else if (name === "push") {
      const distance = room(held, frame, "left", Math.round(frame.width * 0.1));
      replaceExit(layer, exitShape(ctx, { name: "Push out", start: at - length, duration: length, from: { opacity: 1, x: held.x }, to: { opacity: 0, x: held.x - distance } }));
    } else {
      const lift = room(held, frame, "up", Math.round(frame.height * 0.08));
      replaceExit(layer, exitShape(ctx, { name: "Move out", start: at - length, duration: length, from: { opacity: 1, y: held.y }, to: { opacity: 0, y: held.y - lift } }));
    }
  }
  // The holds end a moment before the first exit starts, all at once (the group drifts as one).
  const leaving = Math.min(...outgoing.map((layer) => (layer.animations ?? []).find((animation) => animation.kind === "out")?.start ?? Infinity));
  for (const layer of outgoing) {
    const hold = holdOf(layer);
    if (hold && Number.isFinite(leaving) && hold.start + hold.duration > leaving - SETTLE) hold.duration = round(Math.max(0.1, leaving - SETTLE - hold.start));
  }
  // Entrances start at the boundary or later and take the transition's direction.
  for (const layer of incoming) {
    const entering = entranceOf(layer);
    if (!entering || keeps(entering)) continue;
    if (entering.start < at) entering.start = round(at);
    // A move's short fade-in (build.js splitFade) starts with its move.
    const fade = (layer.animations ?? []).find((animation) => animation.id === `${layer.id}.fade`);
    if (fade) fade.start = entering.start;
    if (reduced) continue;
    if (name === "push") {
      const distance = room(layer, frame, "right", Math.round(frame.width * 0.1));
      entering.from = { opacity: 0, x: layer.x + distance };
      entering.to = { opacity: 1, x: layer.x };
    } else if (name === "cut-on-motion") {
      const lift = room(layer, frame, "down", Math.round(frame.height * 0.08));
      entering.from = { opacity: 0, y: layer.y + lift };
      entering.to = { opacity: 1, y: layer.y };
    } else {
      entering.from = { reveal: { direction: "right", softness: 0.15, progress: 0 } };
      entering.to = { reveal: { direction: "right", softness: 0.15, progress: 1 } };
      entering.unit = "layer";
      entering.stagger = 0;
      delete entering.textClip;
      entering.easing = easingOf("move", ctx.style.feel.intensity);
    }
    entering.name = TRANSITIONS[name].name === "push" ? "Push in" : name === "cut-on-motion" ? "Move in" : "Wipe in";
  }
  if (name !== "mask-wipe" || reduced) return [];
  // The bar crosses the whole frame once the outgoing beat has gone, ahead of the incoming
  // reveal. A little blur stands in for motion blur so the fast pan does not judder.
  const width = Math.round(frame.width * 0.22);
  const sweep = 0.7;
  const bar = createLayer("rectangle", {
    id: `${id}-bar`, name: "Wipe bar", x: -width, y: 0, width, height: frame.height, fill: paint(ctx.style, "accent"),
    blur: Math.max(4, Math.round(frame.width * 0.004)),
    role: "decor", allowOverlap: true, recipe: { name: "mask-wipe", instance: `${id}-bar` },
    animations: [{
      id: `${id}-bar.sweep`, name: "Sweep", kind: "custom", start: round(at), duration: sweep,
      easing: easingOf("move", ctx.style.feel.intensity), unit: "layer", stagger: 0, order: "forward", from: { x: -width }, to: { x: frame.width },
    }],
  });
  return [bar];
}
