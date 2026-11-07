// Resizing a group, and what happens to the layers inside it.
//
// Resizing a group resizes all of its layers in proportion,
// and holding Control while resizing changes only the group's box.
//
// How it works, step by step (`resizeGroup`):
// 1. The group gets its new box: x, y, width and height. Its rotation, scale and skew stay.
// 2. In proportion (the default): every point inside the group stretches by
//    (new width ÷ old width) across and (new height ÷ old height) down, measured from the
//    group's top-left corner. Each layer inside gets the size, rotation and skew that draw its
//    box exactly where the stretched box lands. A rotated layer in a group stretched more one
//    way than the other becomes slanted (skewed), as in other design tools. Groups inside pass
//    the stretch on to their own layers. Component instances always have their main
//    component's size, so their scale changes instead.
// 3. Box only (Control held): the layers inside stay exactly where they are on the canvas.
//    Their x/y change by however far the group's top-left corner moved.
// 4. Animated values change with the same "multiply, then add" formulas as the design values,
//    so a value halfway through an animation is still halfway through afterwards. That keeps
//    every moment of the animation exactly stretched when the group stretches the same amount
//    both ways. When it stretches more one way than the other, some animations can't be
//    written that way, and resizing refuses with an UnevenStretchError that names the layer:
//    - an animated rotation: a turning layer would need a different slant at every angle;
//    - an animated scale that changes the layer's shape (its scaleX : scaleY), on a layer
//      rotated at an angle (not a multiple of 90°): its slant would depend on the scale at
//      each moment. Growing or shrinking the same amount both ways is fine;
//    - an animated width or height on a layer that is rotated (not upright or upside down):
//      its center would drift as its size changes.
// 5. Auto-sized text is first saved with the box it is drawn in (reparent.js withDrawnBox),
//    then gets a fixed box, so it does not resize itself back.
//
// A corner drag calls `resizeGroupFromStart` on every pointer move. It starts again from the
// layers as they were when the drag began, so dragging back, or pressing or releasing Control
// partway, leaves nothing behind from earlier moves.
import { componentGeometry, inverse, layerMatrix, multiply, point } from "./geometry.js";
import { isMoveAnimation, mapMotionPath, motionEndpoints } from "./motionPath.js";
import { animatedKeys, withDrawnBox } from "./reparent.js";
import { flattenAnimations, isComposedAnimation } from "./animationTree.js";
import { isRecord } from "./numbers.js";

const MAX_COORDINATE = 1_000_000;
const MAX_DIMENSION = 65_536;
const MIN_DIMENSION = 0.001;
const MAX_SCALE = 1_000;
const MAX_ROTATION = 360_000;
const MAX_SKEW = 89.999;
// Stretches this close (relative) count as the same both ways. Sizes are saved to a
// billionth of a pixel, so a resize that keeps proportions can still differ by about that much.
const EVEN = 1e-8;
// Everything a resize can change on a layer (see stretchLayer and shiftLayer).
export const RESIZED_KEYS = ["x", "y", "width", "height", "rotation", "scaleX", "scaleY", "skewX", "animations", "textResize", "pathBounds"];

const label = (layer) => `“${layer.name || layer.id}”`;

/**
 * Thrown when a layer inside the group can't keep its animation if the group stretches more one
 * way than the other. `reason` says which layer and why; a corner drag uses it to keep the
 * group's proportions instead.
 */
export class UnevenStretchError extends RangeError {
  constructor(group, reason) {
    super(
      `Can't stretch ${label(group)} more one way than the other: ${reason}, which would then play differently. Drag a corner to resize it in proportion, or hold Control while dragging to resize only the group's box.`,
    );
    this.name = "UnevenStretchError";
    this.reason = reason;
  }
}

const isEven = (across, down) => Math.abs(across - down) <= EVEN * Math.max(Math.abs(across), Math.abs(down));

// True when every animated scale keeps the layer's own scaleX : scaleY, so at every moment the
// layer has the same shape and is only bigger or smaller. An animation that leaves a value out
// starts or ends at the value before it (animation.js evaluateLayer), so each `from` and `to`
// must set both scales or neither.
function keepsScaleShape(layer) {
  const restX = layer.scaleX ?? 1,
    restY = layer.scaleY ?? 1;
  for (const animation of flattenAnimations(layer.animations ?? [])) {
    for (const values of [animation?.from, animation?.to]) {
      if (!isRecord(values)) continue;
      const hasX = Object.hasOwn(values, "scaleX"),
        hasY = Object.hasOwn(values, "scaleY");
      if (!hasX && !hasY) continue;
      if (!hasX || !hasY || !Number.isFinite(values.scaleX) || !Number.isFinite(values.scaleY)) return false;
      const sideways = values.scaleX * restY,
        upright = values.scaleY * restX;
      if (Math.abs(sideways - upright) > EVEN * Math.max(Math.abs(sideways), Math.abs(upright))) return false;
    }
  }
  return true;
}

// Why an uneven stretch can't keep this layer's animations exact (see step 4 above), or null.
function unevenProblem(layer, component) {
  const animated = animatedKeys(layer);
  if (animated.has("rotation")) return `${label(layer)} animates its rotation`;
  const quarters = (layer.rotation ?? 0) / 90;
  const square = Math.abs(quarters - Math.round(quarters)) < 1e-9;
  if (!square && (animated.has("scaleX") || animated.has("scaleY")) && !keepsScaleShape(layer)) {
    return `${label(layer)} animates its scale more one way than the other while rotated`;
  }
  const upright = square && Math.round(quarters) % 2 === 0;
  if (!component && !upright && (animated.has("width") || animated.has("height"))) return `${label(layer)} animates its size while rotated`;
  return null;
}

function position(layer, value) {
  const rounded = Math.round(value * 1e6) / 1e6 + 0;
  if (!Number.isFinite(rounded) || Math.abs(rounded) > MAX_COORDINATE) {
    throw new RangeError(`Resizing the group would move ${label(layer)} outside the supported position range.`);
  }
  return rounded;
}

function dimension(layer, value) {
  const rounded = Math.max(MIN_DIMENSION, Math.round(value * 1e9) / 1e9);
  if (!Number.isFinite(rounded) || rounded > MAX_DIMENSION) {
    throw new RangeError(`Resizing the group would make ${label(layer)} larger than 65,536 pixels.`);
  }
  return rounded;
}

function scale(layer, value) {
  const rounded = Math.round(value * 1e12) / 1e12 + 0;
  if (!Number.isFinite(rounded) || Math.abs(rounded) > MAX_SCALE) {
    throw new RangeError(`Resizing the group would scale ${label(layer)} past ${MAX_SCALE}×.`);
  }
  return rounded;
}

// Applies `change[key]` to animated values. Optional point maps also transform stored motion
// paths; active Move endpoints are complete positions even when a source keyframe saved one axis.
function changeAnimations(layer, change, motionMap = null) {
  function changeAnimation(animation) {
    if (!isRecord(animation)) return animation;
    if (isComposedAnimation(animation)) {
      const animations = (Array.isArray(animation.animations) ? animation.animations : []).map(changeAnimation);
      return animations.every((item, index) => item === animation.animations?.[index])
        ? animation : { ...animation, animations };
    }
    const activeMotion = isMoveAnimation(animation) && animation.motionPath?.points?.length > 0;
    const update = (values, skipPosition = false) => {
      if (!isRecord(values) || !Object.keys(change).some((key) => typeof values[key] === "number")) return values;
      const next = { ...values };
      for (const [key, formula] of Object.entries(change)) {
        if (skipPosition && (key === "x" || key === "y")) continue;
        if (typeof next[key] === "number") next[key] = formula(next[key]);
      }
      return next;
    };
    let from = update(animation.from, activeMotion && Boolean(motionMap?.mapPosition));
    let to = update(animation.to, activeMotion && Boolean(motionMap?.mapPosition));
    if (activeMotion && typeof motionMap?.mapPosition === "function") {
      const { start, end } = motionEndpoints(layer, animation);
      const mappedStart = motionMap.mapPosition(start);
      const mappedEnd = motionMap.mapPosition(end);
      from = { ...(isRecord(animation.from) ? animation.from : {}), ...mappedStart };
      to = { ...(isRecord(animation.to) ? animation.to : {}), ...mappedEnd };
    }
    let motionPath = animation.motionPath;
    if (motionPath != null && typeof motionMap?.mapPosition === "function") {
      motionPath = mapMotionPath(motionPath, motionMap.mapPosition, motionMap.mapVector ?? ((value) => value));
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
  return (layer.animations ?? []).map(changeAnimation);
}

// Box only: moves a layer (and its animated x/y) by dx, dy inside its group.
function shiftLayer(layer, dx, dy) {
  const shift = { x: (value) => position(layer, value + dx), y: (value) => position(layer, value + dy) };
  const motionMap = {
    mapPosition: (value) => ({ x: position(layer, value.x + dx), y: position(layer, value.y + dy) }),
    mapVector: (value) => value,
  };
  return { id: layer.id, x: shift.x(layer.x), y: shift.y(layer.y), animations: changeAnimations(layer, shift, motionMap) };
}

/**
 * The new values for one layer inside a group whose space stretches by `across` × `down` from
 * its top-left corner. Returns the change and the stretch its own children need. `group` is the
 * group being resized, for error messages.
 */
function stretchLayer(original, [a, b, c, d], [tx, ty], { scenes, fonts, group, ownValuesOnly = false }) {
  let layer = original;
  if (layer.type === "text" && layer.textResize && layer.textResize !== "fixed") {
    // The text gets a fixed box below, so it must start from the box it is drawn in. A size
    // animation on auto-sized text only shifts it (or rewraps it), which a fixed box can't copy.
    const animated = animatedKeys(layer);
    if (animated.has("width") || animated.has("height")) {
      throw new RangeError(`${label(layer)} sizes itself to its text and animates its width or height. Set its text sizing to Fixed before resizing the group.`);
    }
    layer = withDrawnBox(layer, fonts) ?? layer;
  }
  const box = componentGeometry(layer, scenes);
  const width = box.width,
    height = box.height;
  const scaleX = layer.scaleX ?? 1,
    scaleY = layer.scaleY ?? 1;
  if (!scaleX || !scaleY) throw new RangeError(`${label(layer)} is scaled to zero. Reset its scale before resizing the group.`);
  const rotation = layer.rotation ?? 0;
  const component = layer.type === "component";

  let turn, slant, sizeX, sizeY; // new rotation and skew; how much width/height (or scale) grow
  if (Math.abs(b) < 1e-12 && Math.abs(c) < 1e-12 && isEven(a, d)) {
    // Same stretch both ways: the layer just gets bigger or smaller.
    turn = rotation;
    slant = layer.skewX ?? 0;
    sizeX = sizeY = a;
  } else {
    const problem = ownValuesOnly ? null : unevenProblem(layer, component);
    if (problem) throw new UnevenStretchError(group, problem);
    // Where the stretched layer's top edge and left edge point, per pixel of width/height.
    const [a0, b0, c0, d0] = layerMatrix({ ...box, x: 0, y: 0 });
    const top = [a * a0 + c * b0, b * a0 + d * b0],
      side = [a * c0 + c * d0, b * c0 + d * d0];
    // The new rotation follows the top edge. A layer flipped across (negative scaleX) points
    // its top edge the other way.
    turn = (Math.atan2(top[1], top[0]) * 180) / Math.PI - (scaleX < 0 ? 180 : 0);
    turn += 360 * Math.round((rotation - turn) / 360);
    const angle = (turn * Math.PI) / 180,
      cos = Math.cos(angle),
      sin = Math.sin(angle);
    // In the new rotated frame, the top edge is (topLength, 0) and the left edge is
    // (sideAlong, sideAcross); a skew slants the left edge.
    const topLength = Math.hypot(top[0], top[1]) * Math.sign(scaleX);
    const sideAlong = cos * side[0] + sin * side[1],
      sideAcross = -sin * side[0] + cos * side[1];
    sizeX = topLength / scaleX;
    sizeY = sideAcross / scaleY;
    // A component keeps its size, so its new scale is (topLength, sideAcross) and the skew's
    // slope is sideAlong ÷ topLength. Other layers keep their scale and change size instead.
    const slope = component ? sideAlong / topLength : sideAlong / (scaleX * sizeY);
    slant = Math.round(((Math.atan(slope) * 180) / Math.PI) * 1e9) / 1e9 + 0;
    if (Math.abs(slant) > MAX_SKEW) throw new RangeError(`Resizing the group that much would slant ${label(layer)} past the supported skew.`);
  }
  if (!(sizeX > 0) || !(sizeY > 0)) throw new RangeError(`Resizing the group would flip ${label(layer)}.`);

  // The layer's center stretches with the group's space.
  const newWidth = component ? width : dimension(layer, width * sizeX),
    newHeight = component ? height : dimension(layer, height * sizeY);
  const offsetX = (a * width + c * height - newWidth) / 2 + tx,
    offsetY = (b * width + d * height - newHeight) / 2 + ty;
  const turnBy = turn - rotation;
  const angleValue = (value) => {
    const rounded = Math.round((value + turnBy) * 1e9) / 1e9 + 0;
    if (!Number.isFinite(rounded) || Math.abs(rounded) > MAX_ROTATION) throw new RangeError(`Resizing would turn ${label(layer)} past the supported rotation range.`);
    return rounded;
  };
  const formulas = {
    x: (value) => position(layer, a * value + c * layer.y + offsetX),
    y: (value) => position(layer, b * layer.x + d * value + offsetY),
    rotation: angleValue,
  };
  const motionMap = {
    mapPosition: (value) => ({
      x: position(layer, a * value.x + c * value.y + offsetX),
      y: position(layer, b * value.x + d * value.y + offsetY),
    }),
    mapVector: (value) => ({ x: a * value.x + c * value.y, y: b * value.x + d * value.y }),
  };
  if (component) {
    formulas.scaleX = (value) => scale(layer, value * sizeX);
    formulas.scaleY = (value) => scale(layer, value * sizeY);
  } else {
    formulas.width = (value) => dimension(layer, value * (newWidth / width));
    formulas.height = (value) => dimension(layer, value * (newHeight / height));
  }
  const change = {
    id: layer.id,
    x: formulas.x(layer.x),
    y: formulas.y(layer.y),
    rotation: formulas.rotation(rotation),
    skewX: slant,
  };
  // A multi-selection handle changes the target's design pose only. Measuring auto text
  // first can shift its position keyframes without changing its look (withDrawnBox).
  if (!ownValuesOnly) change.animations = changeAnimations(layer, formulas, motionMap);
  else if (layer !== original) change.animations = layer.animations;
  if (component) Object.assign(change, { scaleX: formulas.scaleX(scaleX), scaleY: formulas.scaleY(scaleY) });
  else Object.assign(change, { width: newWidth, height: newHeight });
  // Without optional bounds the shared SVG/Lottie renderers draw path coordinates at 1×.
  // Save the starting layer size as that 1× basis; deriving it from the path's extents
  // would change its existing size and origin. Snapshot restart also restores this field.
  if (layer.type === "path" && !layer.pathBounds) change.pathBounds = { width, height };
  // Automatic text sizing would undo the new box, so the text keeps the box it was given.
  if (layer.type === "text" && layer.textResize !== "fixed") change.textResize = "fixed";
  return { change, inner: [sizeX, sizeY] };
}

// Descendants always stretch along their own parent's axes. Only the selected root can
// receive a general map; its new rotation/skew carries the other part of that map.
function stretchChildren(layers, groupId, across, down, options, changes) {
  const children = new Map();
  for (const layer of layers) {
    if (!children.has(layer.parentId)) children.set(layer.parentId, []);
    children.get(layer.parentId).push(layer);
  }
  const visited = new Set([groupId]);
  const visit = (parentId, x, y) => {
    if (Math.abs(x - 1) < 1e-12 && Math.abs(y - 1) < 1e-12) return;
    for (const layer of children.get(parentId) ?? []) {
      if (layer.type === "audio" || visited.has(layer.id)) continue;
      visited.add(layer.id);
      const { change, inner } = stretchLayer(layer, [x, 0, 0, y], [0, 0], { ...options, ownValuesOnly: false });
      changes.push(change);
      if (layer.type === "group") visit(layer.id, inner[0], inner[1]);
    }
  };
  visit(groupId, across, down);
}

/** Apply a parent-space affine map to one target's design values and stretch its children. */
export function stretchLayerBy(layers, layerId, matrix, { scenes = [], fonts } = {}) {
  const layer = layers.find((item) => item.id === layerId);
  if (!layer || layer.type === "audio") throw new Error(`Visual layer ${String(layerId)} was not found.`);
  if (matrix.length !== 6 || !matrix.every(Number.isFinite)) throw new TypeError("A stretch needs a finite affine matrix.");
  const { change, inner } = stretchLayer(layer, matrix.slice(0, 4), matrix.slice(4), { scenes, fonts, group: layer, ownValuesOnly: true });
  const changes = [change];
  if (layer.type === "group") stretchChildren(layers, layer.id, inner[0], inner[1], { scenes, fonts, group: layer }, changes);
  return changes;
}

/**
 * Gives a group a new box ({ x, y, width, height } in its parent's space) and returns the
 * changes to make: one { id, ...values } per layer that changes, the group first. `layers`
 * is left untouched. With `scaleChildren` (the default) the layers inside stretch with the
 * group; without it they stay where they are on the canvas. `scenes` (the document's scenes)
 * gives component instances their size, and `fonts` (default: the editor's loaded fonts)
 * measures auto-sized text. Throws an UnevenStretchError or another Error when the layers
 * can't take the new box; nothing changes then.
 */
export function resizeGroup(layers, groupId, box, { scaleChildren = true, scenes = [], fonts } = {}) {
  const group = layers.find((layer) => layer.id === groupId);
  if (!group || group.type !== "group") throw new Error(`Group ${String(groupId)} was not found.`);
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(box[key])) throw new TypeError(`The group's new ${key} must be a number.`);
  }
  const resized = {
    id: group.id,
    x: position(group, box.x),
    y: position(group, box.y),
    width: dimension(group, box.width),
    height: dimension(group, box.height),
  };
  const changes = [resized];
  const children = new Map();
  for (const layer of layers) {
    if (!children.has(layer.parentId)) children.set(layer.parentId, []);
    children.get(layer.parentId).push(layer);
  }
  const inside = (id) => (children.get(id) ?? []).filter((layer) => layer.type !== "audio");

  if (!scaleChildren) {
    // The group's corner moved; move the layers back by the same amount, measured inside the
    // resized group, so they stay where they are on the canvas.
    const toResized = inverse(layerMatrix({ ...group, ...resized }));
    if (!toResized) throw new RangeError(`${label(group)} is scaled to zero. Reset its scale before resizing it.`);
    const corner = point(multiply(toResized, layerMatrix(group)), 0, 0);
    for (const layer of inside(group.id)) changes.push(shiftLayer(layer, corner.x, corner.y));
    return changes;
  }

  stretchChildren(layers, group.id, resized.width / group.width, resized.height / group.height, { scenes, fonts, group }, changes);
  return changes;
}
