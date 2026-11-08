// Moving a layer into another group without changing how it looks.
//
// A layer's x, y, rotation, scale and skew are measured inside its parent group. When a layer
// moves to a different group (grouping or ungrouping), those numbers must change so the layer
// stays in exactly the same place on the canvas, at every moment of its animations.
//
// How it works, step by step:
// 1. The caller passes `matrix`: the transform that turns a point measured in the old group's
//    space into the same point measured in the new group's space (geometry.js matrix format,
//    [a, b, c, d, e, f]).
// 2. The layer's center goes through that matrix. Position animations store absolute x/y
//    values, so every animated x/y goes through it too, and the whole motion stays in place.
// 3. The matrix's rotation is added to the layer's rotation and its scale multiplies the
//    layer's scale. Rotation and scale animations change the same way.
// 4. Some moves can't be written as values that still animate the same way. Example: a layer
//    whose rotation is animated, moved out of a group that is stretched more in one direction
//    than the other. Those throw an Error that says why, and nothing changes.
//
// Animations interpolate each value in a straight line between its "from" and "to". Every
// rule below changes a value with a fixed "multiply, then add" formula, so a value halfway
// through an animation is still halfway through after the change. That is why the animated
// result matches the original at every time, not only at the keyframes.
import { layerMatrix, multiply, pivotOf, transformProperties } from "./geometry.js";
import { shiftAnimation } from "./animationShift.js";
import { isMoveAnimation, mapMotionPath, motionEndpoints, normalizeMotionPath } from "./motionPath.js";
import { resizeTextLayer } from "./textLayout.js";
import { flattenAnimations, isComposedAnimation } from "./animationTree.js";
import { isRecord } from "./numbers.js";

// Limits from the document format (model.js).
const MAX_COORDINATE = 1_000_000;
const MAX_ROTATION = 360_000;
const MAX_SCALE = 1_000;
const MAX_SKEW = 89.999;
// Matrix entries this close to 0, 1 or -1 are treated as exactly that. Rotating by 90° with
// floating-point numbers leaves tiny leftovers such as 6e-17 instead of 0.
const SNAP = 1e-10;
const TOLERANCE = 1e-9;

const label = (layer) => `“${layer.name || layer.id}”`;

function snapEntry(value) {
  for (const target of [0, 1, -1]) if (Math.abs(value - target) < SNAP) return target;
  return value;
}

/** The value keys (x, rotation, …) that any of the layer's animations change. */
export function animatedKeys(layer) {
  const keys = new Set();
  for (const animation of flattenAnimations(layer.animations ?? [])) {
    for (const values of [animation?.from, animation?.to]) {
      if (isRecord(values)) for (const key of Object.keys(values)) keys.add(key);
    }
    if (isActiveMotion(animation)) {
      keys.add("x");
      keys.add("y");
      if (animation.motionPath.alignToPath) keys.add("rotation");
    }
  }
  return keys;
}

function isActiveMotion(animation) {
  return isMoveAnimation(animation) && animation.motionPath?.points?.length > 0;
}

/**
 * Auto-sized text, saved with the box it is actually drawn in.
 *
 * Text that sizes itself (textResize "width-height" or "height") is measured again every time it
 * is drawn (textLayout.js resizeTextLayer), so its saved width/height can be out of date: a new
 * text layer starts at 320 × 180, however short its words are. The measured box is anchored by
 * the text's alignment, so the drawn box sits `dx`, `dy` away from the saved x/y, and that
 * distance is the same at every moment of a position animation. Moving the saved x/y and every
 * animated x/y by it, and saving the measured size, therefore changes nothing on screen. It
 * gives code that turns or scales the layer (reparentLayer, groupResize.js) its real box.
 *
 * Returns the layer itself when nothing needs to change (not auto-sized text, or already
 * up to date), and null when the text animates its width or height: the measured box then
 * changes over time, so no single saved box describes it. `fonts` measures the text.
 */
export function withDrawnBox(layer, fonts) {
  if (layer?.type !== "text" || !layer.textResize || layer.textResize === "fixed") return layer;
  const drawn = resizeTextLayer(layer, fonts);
  const dx = drawn.x - layer.x,
    dy = drawn.y - layer.y;
  if (!dx && !dy && drawn.width === layer.width && drawn.height === layer.height) return layer;
  const animated = animatedKeys(layer);
  if (animated.has("width") || animated.has("height")) return null;
  return {
    ...drawn,
    animations: (layer.animations ?? []).map((animation) => shiftAnimation(animation, dx, dy)),
  };
}

// The rotation closest to `previous` that points the same way (keeps 720° as 720°, not 0°).
function nearestTurn(rotation, previous) {
  return rotation + 360 * Math.round((previous - rotation) / 360);
}

/**
 * The new { x, y, rotation, scaleX, scaleY, skewX, animations } that keep `layer` looking the
 * same after it moves to a group whose space is `matrix` applied to the old group's space.
 * `size` is the box the layer is drawn in (component instances use their source scene size).
 * Throws an Error that explains why when the move can't keep the layer's look.
 */
export function reparentLayer(layer, matrix, size = layer) {
  const width = size.width,
    height = size.height;
  const [a, b, c, d] = matrix.slice(0, 4).map(snapEntry);
  const [e, f] = matrix.slice(4);
  const animated = animatedKeys(layer);
  const sameShape = a === 1 && b === 0 && c === 0 && d === 1;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) throw new Error(`a group around ${label(layer)} is scaled to zero.`);

  // --- Position: the layer's center goes through the matrix. ---
  // x and y are the top-left of the layer's box before its own rotation, so the center is
  // (x + width / 2, y + height / 2).
  if (!sameShape && (animated.has("width") || animated.has("height"))) {
    throw new Error(`${label(layer)} animates its size, which can't stay in place when it moves into a rotated or scaled group.`);
  }
  // The pivot (the box center, or the layer's anchor) is the point that goes through the matrix.
  const [px, py] = pivotOf(layer, width, height);
  const moveCenter = (x, y) => ({
    x: a * (x + px) + c * (y + py) + e - px,
    y: b * (x + px) + d * (y + py) + f - py,
  });
  const mapPosition = (value) => {
    const mapped = moveCenter(value.x, value.y);
    return { x: checker(layer)("x", mapped.x), y: checker(layer)("y", mapped.y) };
  };
  const mapVector = (value) => ({ x: a * value.x + c * value.y, y: b * value.x + d * value.y });
  const straight = b === 0 && c === 0; // new x depends only on old x, new y only on old y
  const turned = a === 0 && d === 0; // a quarter turn: new x depends only on old y, and back
  function movePosition(values) {
    const hasX = typeof values.x === "number",
      hasY = typeof values.y === "number";
    if (!hasX && !hasY) return values;
    const next = { ...values };
    delete next.x;
    delete next.y;
    if (straight) {
      if (hasX) next.x = moveCenter(values.x, 0).x;
      if (hasY) next.y = moveCenter(0, values.y).y;
    } else if (turned) {
      if (hasY) next.x = moveCenter(0, values.y).x;
      if (hasX) next.y = moveCenter(values.x, 0).y;
    } else {
      // Both new values depend on both old ones, so each keyframe needs both. A value that is
      // never animated is the same at every time, so the layer's own value fills it in.
      let x = values.x,
        y = values.y;
      if (!hasX) {
        if (animated.has("x")) throw splitPosition(layer);
        x = layer.x;
      }
      if (!hasY) {
        if (animated.has("y")) throw splitPosition(layer);
        y = layer.y;
      }
      Object.assign(next, moveCenter(x, y));
    }
    return next;
  }

  // --- Rotation, scale and skew. ---
  // The layer's own transform is rotate · scale · skew (see layerMatrix in geometry.js).
  // Putting the matrix in front of it must give a transform of the same kind.
  let changeTurn; // one function per value key; each is "multiply, then add"
  let base; // the layer's new rotation, scale and skew
  let transformAngle = 0;
  const reflected = determinant < 0 ? -1 : 1;
  const stretch = Math.hypot(a, b);
  const uniform =
    Math.abs(a - reflected * d) <= TOLERANCE * Math.max(1, stretch) &&
    Math.abs(b + reflected * c) <= TOLERANCE * Math.max(1, stretch);
  const rotation = layer.rotation ?? 0;
  const quarterTurn = Math.abs(rotation / 90 - Math.round(rotation / 90)) < TOLERANCE;
  if (sameShape) {
    // Only moved, not turned or scaled: rotation, scale and skew stay exactly as they are.
    base = { rotation, scaleX: layer.scaleX ?? 1, scaleY: layer.scaleY ?? 1, skewX: layer.skewX ?? 0 };
  } else if (uniform) {
    // The matrix only rotates, scales the same amount in every direction, and maybe mirrors.
    // Rotation adds (or, when mirrored, flips), scale multiplies, skew stays.
    let angle = (Math.atan2(b, a) * 180) / Math.PI;
    if (Math.abs(angle / 90 - Math.round(angle / 90)) < TOLERANCE) angle = Math.round(angle / 90) * 90;
    transformAngle = angle;
    changeTurn = {
      rotation: (value) => tidy(angle + reflected * value),
      scaleX: (value) => tidy(stretch * value),
      scaleY: (value) => tidy(reflected * stretch * value),
    };
  } else if ((straight || turned) && quarterTurn && !animated.has("rotation")) {
    // The matrix stretches along its x and y axes (and maybe turns a quarter) and the layer
    // sits square to those axes, so each axis's stretch lands on one of the layer's scales.
    const [stretchX, stretchY] = straight ? [a, d] : [b, -c];
    const sideways = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    const [alongX, alongY] = sideways ? [stretchY, stretchX] : [stretchX, stretchY];
    const turn = straight ? 0 : 90;
    changeTurn = {
      rotation: (value) => tidy(value + turn),
      scaleX: (value) => tidy(alongX * value),
      scaleY: (value) => tidy(alongY * value),
    };
  } else {
    // An uneven stretch at an angle to the layer turns it into a skewed shape. The design pose
    // can still be written that way, but an animated rotation or scale can't.
    for (const key of ["rotation", "scaleX", "scaleY", "skewX", "skewY"]) {
      if (animated.has(key)) {
        throw new Error(
          `${label(layer)} animates its ${key === "rotation" ? "rotation" : key.startsWith("skew") ? "skew" : "scale"}, which can't keep its look when it moves into a group that is stretched unevenly at an angle to it.`,
        );
      }
    }
    if (!(layer.scaleX ?? 1) || !(layer.scaleY ?? 1)) throw new Error(`${label(layer)} is scaled to zero. Reset its scale first.`);
    const pose = transformProperties(multiply(matrix, layerMatrix({ ...layer, width, height })), width, height);
    base = {
      rotation: tidy(nearestTurn(pose.rotation, rotation)),
      scaleX: tidy(pose.scaleX),
      scaleY: tidy(pose.scaleY),
      skewX: tidy(pose.skewX),
      // The pose holds the whole skew; skewY is folded into it.
      ...(layer.skewY ? { skewY: 0 } : {}),
    };
  }
  base ??= {
    rotation: changeTurn.rotation(rotation),
    scaleX: changeTurn.scaleX(layer.scaleX ?? 1),
    scaleY: changeTurn.scaleY(layer.scaleY ?? 1),
    skewX: layer.skewX ?? 0,
  };

  const check = checker(layer);
  function changeValues(values) {
    if (!isRecord(values)) return values;
    let next = movePosition(values);
    for (const key of ["rotation", "scaleX", "scaleY"]) {
      if (typeof next[key] !== "number" || !changeTurn) continue;
      if (next === values) next = { ...values };
      next[key] = changeTurn[key](next[key]);
    }
    if (next === values) return values;
    for (const key of ["x", "y", "rotation", "scaleX", "scaleY"]) {
      if (typeof next[key] === "number") next[key] = check(key, next[key]);
    }
    return next;
  }
  const position = moveCenter(layer.x, layer.y);
  function changeAnimation(animation) {
    if (!isRecord(animation)) return animation;
    if (isComposedAnimation(animation)) {
      const animations = (Array.isArray(animation.animations) ? animation.animations : []).map(changeAnimation);
      return animations.every((item, index) => item === animation.animations?.[index])
        ? animation : { ...animation, animations };
    }
    const active = isActiveMotion(animation);
    let fromValues = animation.from;
    let toValues = animation.to;
    if (active) {
      const endpoints = motionEndpoints(layer, animation);
      fromValues = { ...(isRecord(animation.from) ? animation.from : {}), ...endpoints.start };
      toValues = { ...(isRecord(animation.to) ? animation.to : {}), ...endpoints.end };
    }
    let from = changeValues(fromValues);
    let to = changeValues(toValues);
    let motionPath = animation.motionPath;
    if (motionPath != null) {
      motionPath = mapMotionPath(motionPath, mapPosition, mapVector);
      if (active && animation.motionPath.alignToPath && !sameShape && uniform) {
        const alignmentOffset = reflected * (animation.motionPath.alignmentOffset ?? 0) - transformAngle;
        const adjusted = { ...motionPath };
        if (alignmentOffset === 0) delete adjusted.alignmentOffset;
        else adjusted.alignmentOffset = alignmentOffset;
        motionPath = normalizeMotionPath(adjusted);
      }
    }
    return from === animation.from && to === animation.to && motionPath === animation.motionPath
      ? animation
      : {
        ...animation,
        ...(from !== animation.from ? { from } : {}),
        ...(to !== animation.to ? { to } : {}),
        ...(motionPath !== animation.motionPath ? { motionPath } : {}),
      };
  }
  return {
    x: check("x", position.x),
    y: check("y", position.y),
    rotation: check("rotation", base.rotation),
    scaleX: check("scaleX", base.scaleX),
    scaleY: check("scaleY", base.scaleY),
    skewX: check("skewX", base.skewX),
    ...(base.skewY === 0 ? { skewY: 0 } : {}),
    animations: (layer.animations ?? []).map(changeAnimation),
  };
}

function splitPosition(layer) {
  return new Error(
    `${label(layer)} animates x and y in separate keyframes, which can't keep their path when it moves into a rotated group. Animate x and y together first.`,
  );
}

// Rounds a computed angle or scale so saved files don't carry floating-point noise such as
// 29.999999999999996. Twelve decimals is far below anything visible.
function tidy(value) {
  return Math.round(value * 1e12) / 1e12 + 0;
}

// Checks the document's limits for a value. Positions are also rounded to a millionth of a
// pixel, like the alignment tools do.
function checker(layer) {
  return (key, value) => {
    const rounded = key === "x" || key === "y" ? Math.round(value * 1e6) / 1e6 + 0 : value;
    const limit = { x: MAX_COORDINATE, y: MAX_COORDINATE, rotation: MAX_ROTATION, skewX: MAX_SKEW }[key] ?? MAX_SCALE;
    if (!Number.isFinite(rounded) || Math.abs(rounded) > limit) {
      const what = { x: "position", y: "position", rotation: "rotation", skewX: "skew" }[key] ?? "scale";
      throw new Error(`${label(layer)} would need a ${what} outside the supported range.`);
    }
    return rounded;
  };
}
