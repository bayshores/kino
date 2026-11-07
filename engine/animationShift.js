// Moving a layer's animated positions along with the layer.
//
// An animation that moves a layer stores absolute x and y values in its `from` and `to` (a Slide
// In ends at the layer's own x, for example). So when the layer itself moves by (dx, dy), its
// position animations must move by the same amount, or the motion would jump back to the old
// place. Animations of other properties are kept as they are.
//
// arrange.js uses this when it aligns layers, and componentOverrides.js when an instance moves a
// layer of its main component with an x or y override. carryAnimations does the same for a
// layer that is also scaled or turned (the agent's multi_transform).
import { mapMotionPath } from "./motionPath.js";
import { isComposedAnimation } from "./animationTree.js";

/**
 * The animation with its from/to x and y moved by (dx, dy), or the same object when it has no
 * position values. `position(value, change)` works out each new value (default: value + change),
 * so a caller can round it or refuse values out of range.
 */
export function shiftAnimation(animation, dx, dy, position = addChange) {
  if (!animation || typeof animation !== "object") return animation;
  const animations = isComposedAnimation(animation)
    ? (Array.isArray(animation.animations)
      ? animation.animations.map((item) => shiftAnimation(item, dx, dy, position))
      : animation.animations)
    : animation.animations;
  const from = shiftValues(animation.from, dx, dy, position),
    to = shiftValues(animation.to, dx, dy, position);
  const motionPath = animation.motionPath == null
    ? animation.motionPath
    : mapMotionPath(
      animation.motionPath,
      (value) => ({ x: position(value.x, dx), y: position(value.y, dy) }),
      (value) => value,
    );
  return from === animation.from && to === animation.to && motionPath === animation.motionPath && animations === animation.animations
    ? animation
    : {
      ...animation,
      ...(animations !== animation.animations ? { animations } : {}),
      ...(from !== animation.from ? { from } : {}),
      ...(to !== animation.to ? { to } : {}),
      ...(motionPath !== animation.motionPath ? { motionPath } : {}),
    };
}

/** One side of an animation (its from or to values) with x and y moved by (dx, dy). */
export function shiftValues(values, dx, dy, position = addChange) {
  if (!values || typeof values !== "object") return values;
  const hasX = typeof values.x === "number",
    hasY = typeof values.y === "number";
  if (!hasX && !hasY) return values;
  return {
    ...values,
    ...(hasX ? { x: position(values.x, dx) } : {}),
    ...(hasY ? { y: position(values.y, dy) } : {}),
  };
}

/**
 * A layer's animations after the layer itself changed from `before` to `after` (its x, y, size,
 * scale and rotation). `linear` ([a, b, c, d], identity for a plain move) is how the change
 * stretches and turns the layer's parent space. Each animated place keeps its offset from the
 * layer's place, stretched and turned the same way: place → after + linear·(place − before).
 * So a slide still ends where the layer now is, and a 150% scale makes it slide 1.5 times as
 * far. Animated sizes and scales grow by the layer's own growth, and an animated rotation turns
 * by the layer's turn (a path the layer turns along keeps its heading).
 * A quarter turn makes an animated y the new x (a slide up slides across). Any other turn needs
 * both x and y at each end, so the one left out is taken from the layer's own place.
 */
export function carryAnimations(animations, before, after, linear = [1, 0, 0, 1]) {
  if (!Array.isArray(animations)) return animations;
  const tiny = (value) => Math.abs(value) < 1e-10;
  const [a, b, c, d] = linear.map((value) => (tiny(value) ? 0 : value));
  const straight = b === 0 && c === 0, quarter = a === 0 && d === 0;
  const round = (value) => Math.round(value * 1e6) / 1e6 + 0;
  const place = (point) => {
    const across = point.x - before.x, down = point.y - before.y;
    return { x: round(after.x + a * across + c * down), y: round(after.y + b * across + d * down) };
  };
  const vector = (point) => ({ x: a * point.x + c * point.y, y: b * point.x + d * point.y });
  const growth = {};
  for (const [key, rest] of [["width"], ["height"], ["scaleX", 1], ["scaleY", 1]]) {
    const was = before[key] ?? rest, now = after[key] ?? rest;
    if (typeof was === "number" && typeof now === "number" && was !== 0 && was !== now) growth[key] = now / was;
  }
  const turn = (after.rotation ?? 0) - (before.rotation ?? 0);
  const values = (side) => {
    if (!side || typeof side !== "object" || Array.isArray(side)) return side;
    const next = { ...side };
    const hasX = typeof side.x === "number", hasY = typeof side.y === "number";
    if (hasX || hasY) {
      const moved = place({ x: hasX ? side.x : before.x, y: hasY ? side.y : before.y });
      delete next.x;
      delete next.y;
      if (straight ? hasX : quarter ? hasY : true) next.x = moved.x;
      if (straight ? hasY : quarter ? hasX : true) next.y = moved.y;
    }
    for (const [key, times] of Object.entries(growth)) if (typeof side[key] === "number") next[key] = round(side[key] * times);
    if (turn && typeof side.rotation === "number") next.rotation = round(side.rotation + turn);
    const same = Object.keys(next).length === Object.keys(side).length && Object.keys(next).every((key) => next[key] === side[key]);
    return same ? side : next;
  };
  const carry = (animation) => {
    if (!animation || typeof animation !== "object") return animation;
    if (isComposedAnimation(animation))
      return Array.isArray(animation.animations) ? { ...animation, animations: animation.animations.map(carry) } : animation;
    const from = values(animation.from), to = values(animation.to);
    let motionPath = animation.motionPath;
    if (motionPath != null) {
      motionPath = mapMotionPath(motionPath, place, vector);
      // An aligned layer faces along its path, which now turns with it, so the layer's own
      // turn (already in its rotation) must not be added a second time.
      if (motionPath.alignToPath && turn) {
        const alignmentOffset = round((animation.motionPath.alignmentOffset ?? 0) - turn);
        motionPath = { ...motionPath };
        if (alignmentOffset === 0) delete motionPath.alignmentOffset;
        else motionPath.alignmentOffset = alignmentOffset;
      }
    }
    return from === animation.from && to === animation.to && motionPath === animation.motionPath
      ? animation
      : { ...animation, ...(from !== animation.from ? { from } : {}), ...(to !== animation.to ? { to } : {}), ...(motionPath !== animation.motionPath ? { motionPath } : {}) };
  };
  return animations.map(carry);
}

function addChange(value, change) {
  return value + change;
}
