// add_sequence: one video made of several scenes, one after another, with transitions.
//
// A sequence is an ordinary scene. It holds one component instance (linkedComponents.js) per
// listed scene, placed back to back on its timeline, so each part stays editable in its own
// scene and the sequence follows every change. Listed scenes become main components
// (isComponent), which is what an instance needs; the quality checker then checks them as part
// of the sequence instead of on their own.
//
// Timeline: part 1 starts at 0. Each transition overlaps the end of one part with the start of
// the next by its duration, so part n+1 starts at (start of part n) + (its length) − (transition).
// The sequence lasts until the last part ends, at most MAX_TIME (600 s, the scene limit).
//
// Transitions are animations on the instances, in sequence time:
//   cut        the next part replaces the last at once (no motion; the default)
//   crossfade  the last part fades out while the next fades in
//   push       the next part pushes the last out of frame (direction: left, right, up, down)
//   wipe       an edge sweeps across, revealing the next part (direction: the way the edge moves)
//   zoom       the last part grows to 110% and fades out; the next grows from 80% and fades in
//              (never past 110%: the reading check measures text at its largest size)
//   whip       a push that snaps: both parts move fastest at the middle ("natural" easing, 5
//              times the average speed) under a directional blur along the move that peaks there
//              at a fifth of the frame (a 180° shutter at 30 fps for a 0.4 s whip); an edge fill
//              (mirror) lets the smear near the parts' edges pick up picture, not the background
//   spin       the last part turns 90° and fades out while the next turns in from −90° and fades
//              in, under a spin blur that peaks at 30° in the middle; an edge fill (mirror) keeps
//              the corners of the turned frame filled with picture
// whip and spin use the effects in effects/motionBlurs.js and effects/edges.js, so a sequence
// with them is drawn with Chromium in exports, like any scene with effects.
// Every part is shown from its start with a Show and hidden at its end with a Hide. During a
// crossfade, wipe or zoom both parts change together, so text in the two parts is never fully
// shown at the same time (the overlap check stays quiet).
import { createScene, uid, MAX_TIME } from "./model.js";
import { createComponentInstance } from "./linkedComponents.js";
import { createVisibilityOperation } from "./visibilityOps.js";
import { nextScenePosition } from "./sceneLayout.js";
import { round } from "./numbers.js";

export const TRANSITIONS = ["cut", "crossfade", "push", "wipe", "zoom", "whip", "spin"];
const MOVING = ["push", "wipe", "whip"]; // transitions that take a direction
const WHIP_BLUR = 0.2; // peak directional blur, as a share of the frame along the move
const SPIN_TURN = 90; // degrees each part turns
const SPIN_BLUR = 30; // peak spin blur, degrees
export const TRANSITION_DIRECTIONS = ["left", "right", "up", "down"];
export const DEFAULT_TRANSITION_SECONDS = 0.5;
export const MAX_SEQUENCE_PARTS = 50;
const WIPE_SOFTNESS = 10;
const EASING = "smooth";
const OPPOSITE = { left: "right", right: "left", up: "down", down: "up" };

function fail(message) {
  throw new Error(`add_sequence: ${message}`);
}

// {type, duration, direction} from "crossfade" or {type, duration?, direction?}.
function transitionFrom(value, fallback, label) {
  const entry = value === undefined ? fallback : typeof value === "string" ? { type: value } : value;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${label} must be a transition name (${TRANSITIONS.join(", ")}) or {type, duration?, direction?}.`);
  const type = entry.type ?? "cut";
  if (!TRANSITIONS.includes(type)) fail(`${label} type must be one of ${TRANSITIONS.join(", ")}.`);
  // A cut has no length, so a default cut does not lend its 0 s to a named transition.
  const lent = fallback?.type === "cut" ? undefined : fallback?.duration;
  const duration = type === "cut" ? 0 : entry.duration ?? lent ?? DEFAULT_TRANSITION_SECONDS;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 5) fail(`${label} duration must be 0 to 5 seconds.`);
  const direction = entry.direction ?? fallback?.direction ?? "left";
  if (!TRANSITION_DIRECTIONS.includes(direction)) fail(`${label} direction must be one of ${TRANSITION_DIRECTIONS.join(", ")}.`);
  return { type: duration === 0 ? "cut" : type, duration: duration === 0 ? 0 : round(duration), direction };
}

const custom = (name, start, duration, from, to, easing = EASING) => ({ id: uid(), name, kind: "custom", start: round(start), duration, easing, from, to });
const effect = (name, key, start, duration, to, easing, extra = {}) =>
  ({ id: uid(), name, kind: "effect", effect: key, start: round(start), duration, easing, to, ...extra });

// A blur whose `strength` field grows from 0 to `peak` until the middle of the transition and is
// back at 0 at its end: two value-effect animations, up with ease-in and down with ease-out, as
// the parts speed up and slow down. `fixed` holds the fields that stay the same (a direction).
function blurUpAndDown(label, key, start, duration, strength, peak, fixed = {}) {
  // Too short to split into two halves of at least 1 ms: no blur (an animation needs a length).
  if (duration < 0.002) return [];
  const half = round(duration / 2);
  return [
    effect(`${label} blur`, key, start, half, { ...fixed, [strength]: peak }, "ease-in", { from: { ...fixed, [strength]: 0 } }),
    effect(`${label} blur end`, key, start + half, round(duration - half), { ...fixed, [strength]: 0 }, "ease-out", { from: { ...fixed, [strength]: peak } }),
  ];
}

// The animations that bring a part in (or take it out) for one transition.
function transitionAnimations(transition, start, { width, height }, incoming) {
  const { type, duration, direction } = transition;
  if (type === "cut") return [];
  const label = `${type[0].toUpperCase()}${type.slice(1)} ${incoming ? "in" : "out"}`;
  if (type === "whip") {
    const key = direction === "left" || direction === "right" ? "x" : "y";
    const size = key === "x" ? width : height;
    const sign = direction === "left" || direction === "up" ? -1 : 1;
    const length = Math.min(4000, Math.round(size * WHIP_BLUR));
    // The edge fill goes first (same start, earlier in the list), so the smear near each part's
    // edge picks up mirrored picture instead of fading into the background between the parts.
    return [
      custom(label, start, duration, { [key]: incoming ? -sign * size : 0 }, { [key]: incoming ? 0 : sign * size }, "natural"),
      effect(`${label} edge fill`, "edge-fill", start, duration, { mode: "mirror", extend: WHIP_BLUR / 2 }, "linear", { keepStill: "off" }),
      ...blurUpAndDown(label, "directional-blur", start, duration, "length", length, { angle: key === "x" ? 0 : 90 }),
    ];
  }
  if (type === "spin") {
    return [
      custom(label, start, duration,
        incoming ? { rotation: -SPIN_TURN, opacity: 0 } : { rotation: 0, opacity: 1 },
        incoming ? { rotation: 0, opacity: 1 } : { rotation: SPIN_TURN, opacity: 0 }, "natural"),
      effect(`${label} edge fill`, "edge-fill", start, duration, { mode: "mirror", extend: 1 }, "linear", { keepStill: "off" }),
      ...blurUpAndDown(label, "spin-blur", start, duration, "angle", SPIN_BLUR),
    ];
  }
  if (type === "crossfade")
    return [custom(label, start, duration, { opacity: incoming ? 0 : 1 }, { opacity: incoming ? 1 : 0 })];
  if (type === "zoom")
    return [custom(label, start, duration,
      incoming ? { opacity: 0, scaleX: 0.8, scaleY: 0.8 } : { opacity: 1, scaleX: 1, scaleY: 1 },
      incoming ? { opacity: 1, scaleX: 1, scaleY: 1 } : { opacity: 0, scaleX: 1.1, scaleY: 1.1 })];
  if (type === "push") {
    // Content moves toward `direction`: the next part comes in from the opposite side.
    const key = direction === "left" || direction === "right" ? "x" : "y";
    const size = key === "x" ? width : height;
    const sign = direction === "left" || direction === "up" ? -1 : 1;
    return [custom(label, start, duration, { [key]: incoming ? -sign * size : 0 }, { [key]: incoming ? 0 : sign * size })];
  }
  // wipe: the next part is revealed from the side the edge leaves; the last part is hidden
  // behind the same edge, so together they always fill the frame once.
  const reveal = (progress, way) => ({ reveal: { progress, direction: way, softness: WIPE_SOFTNESS } });
  return incoming
    ? [custom(label, start, duration, reveal(0, direction), reveal(1, direction))]
    : [custom(label, start, duration, reveal(1, OPPOSITE[direction]), reveal(0, OPPOSITE[direction]))];
}

/**
 * The sequence scene add_sequence would add, without changing the document:
 * {scene, components (ids of listed scenes that become main components), report}.
 */
export function planSequence(document, operation) {
  const properties = operation.properties ?? {};
  const ids = operation.scenes;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_SEQUENCE_PARTS) fail(`scenes must list 2 to ${MAX_SEQUENCE_PARTS} scenes, in order.`);
  const parts = ids.map((id, index) => {
    const scene = document.scenes.find((item) => item.id === id);
    if (!scene) fail(`scenes[${index}]: scene ${id} was not found.`);
    if (properties.id !== undefined && scene.id === properties.id) fail("a sequence cannot contain itself.");
    return scene;
  });
  const { width, height } = parts[0];
  const odd = parts.find((scene) => scene.width !== width || scene.height !== height);
  if (odd) fail(`every scene must be ${width}×${height} like "${parts[0].name}"; "${odd.name}" is ${odd.width}×${odd.height}.`);
  const fallback = transitionFrom(operation.transition, { type: "cut" }, "transition");
  const list = operation.transitions;
  if (list !== undefined && (!Array.isArray(list) || list.length !== parts.length - 1)) fail(`transitions must list ${parts.length - 1} transitions, one between each pair of scenes.`);
  const transitions = parts.slice(1).map((_, index) => transitionFrom(list?.[index], fallback, `transitions[${index}]`));
  const starts = [0];
  parts.forEach((scene, index) => {
    const before = transitions[index - 1]?.duration ?? 0;
    const after = transitions[index]?.duration ?? 0;
    if (before + after > scene.duration + 1e-9) fail(`"${scene.name}" lasts ${scene.duration}s, too short for transitions of ${before}s and ${after}s; shorten them.`);
    if (index < parts.length - 1) starts.push(round(starts[index] + scene.duration - after));
  });
  const total = round(starts.at(-1) + parts.at(-1).duration);
  if (total > MAX_TIME) fail(`the sequence would last ${total}s; a scene can last at most ${MAX_TIME}s (${MAX_TIME / 60} minutes). Use fewer or shorter scenes, or longer transitions.`);
  const size = { width, height };
  const layers = parts.map((scene, index) => {
    const start = starts[index];
    const end = round(start + scene.duration);
    const incoming = transitions[index - 1];
    const outgoing = transitions[index];
    const animations = [];
    if (index > 0) animations.push(createVisibilityOperation("show", start, uid()));
    if (incoming) animations.push(...transitionAnimations(incoming, start, size, true));
    if (outgoing) animations.push(...transitionAnimations(outgoing, end - outgoing.duration, size, false));
    if (index < parts.length - 1) animations.push(createVisibilityOperation("hide", end, uid()));
    return createComponentInstance({ ...scene, isComponent: true }, {
      id: uid(), name: scene.name, x: 0, y: 0, componentStart: start, componentVisibility: "both", animations,
    });
  });
  const scene = createScene({
    ...nextScenePosition(document.scenes),
    ...(properties.id !== undefined ? { id: properties.id } : {}),
    name: properties.name ?? "Sequence",
    width,
    height,
    duration: total,
    background: operation.background ?? parts[0].background,
    layers,
  });
  const components = [...new Set(parts.filter((part) => !part.isComponent).map((part) => part.id))];
  const report = {
    name: scene.name,
    duration: total,
    parts: parts.map((part, index) => ({ scene: part.name, start: starts[index], end: round(starts[index] + part.duration) })),
    transitions: transitions.map((transition) => (transition.type === "cut" ? "cut" : `${transition.type} ${transition.duration}s${MOVING.includes(transition.type) ? ` ${transition.direction}` : ""}`)),
    ...(components.length ? { madeComponents: components.map((id) => document.scenes.find((item) => item.id === id).name) } : {}),
  };
  return { scene, components, report };
}

/** Applies add_sequence to the document (changed in place). Returns the plan's report. */
export function applyAddSequence(document, operation) {
  const plan = planSequence(document, operation);
  for (const id of plan.components) document.scenes.find((scene) => scene.id === id).isComponent = true;
  document.scenes.push(plan.scene);
  return plan.report;
}
