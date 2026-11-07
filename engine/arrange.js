// Alignment tools: line selected layers up with their parent, the scene, or each other.
//
// How it works, step by step:
// 1. Work out which layers move (`alignmentTargets`). A layer whose group is also selected
//    moves with that group, so it is not moved a second time. Audio layers have no box.
// 2. Work out what they line up with (`alignmentFrame`):
//    - one layer: its parent group's box, or the whole scene when it is not in a group;
//    - several layers: the box around all of them, so they line up with each other.
// 3. For each layer, find how far its box must travel in scene ("world") pixels to reach the
//    chosen edge or center of that frame, then turn that distance into a change of the
//    layer's own x/y (`moveLayerByWorldDelta`). x/y are measured inside the parent group,
//    so a rotated or scaled group changes how far, and in which direction, x/y must change.
// 4. Position animations store absolute x/y values, so they shift by the same amount and the
//    whole motion moves along with the layer.
//
// Boxes are axis-aligned: { left, top, right, bottom } in scene pixels, after every rotation,
// scale and skew of the layer and its parent groups. They use the design values that the
// Design tab edits, not the animated position at the playhead.
import { componentGeometry, inverse, parentMatrix, point, worldMatrix } from "./geometry.js";
import { resizeTextLayer } from "./textLayout.js";
import { shiftAnimation } from "./animationShift.js";
import { boxAround, unionBox } from "./boxes.js";

/** The six alignment actions, in the order the Design tab shows them. */
export const ALIGNMENTS = Object.freeze([
  { id: "left", label: "Align left", axis: "x", edge: "start", shortcut: "⌥A", keys: "Alt+A" },
  { id: "center", label: "Align center horizontally", axis: "x", edge: "center", shortcut: "⌥H", keys: "Alt+H" },
  { id: "right", label: "Align right", axis: "x", edge: "end", shortcut: "⌥D", keys: "Alt+D" },
  { id: "top", label: "Align top", axis: "y", edge: "start", shortcut: "⌥W", keys: "Alt+W" },
  { id: "middle", label: "Align center vertically", axis: "y", edge: "center", shortcut: "⌥V", keys: "Alt+V" },
  { id: "bottom", label: "Align bottom", axis: "y", edge: "end", shortcut: "⌥S", keys: "Alt+S" },
].map((alignment) => Object.freeze(alignment)));

export const ALIGNMENT_IDS = Object.freeze(ALIGNMENTS.map((alignment) => alignment.id));

// Layer positions must stay inside the range the document format accepts.
const MAX_COORDINATE = 1_000_000;
// Moves smaller than this (in the layer's own pixels) are rounding noise, not a change.
const MIN_MOVE = 1e-6;

/** The layers an alignment moves, in scene order. */
export function alignmentTargets(layers, layerIds) {
  const selected = new Set(layerIds);
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  return layers.filter((layer) => selected.has(layer.id) && layer.type !== "audio" && !hasSelectedAncestor(layer, byId, selected));
}

function hasSelectedAncestor(layer, byId, selected) {
  const visited = new Set([layer.id]);
  let parent = byId.get(layer.parentId);
  while (parent && !visited.has(parent.id)) {
    if (selected.has(parent.id)) return true;
    visited.add(parent.id);
    parent = byId.get(parent.parentId);
  }
  return false;
}

// The position and size the layer is drawn with, which can differ from the stored values:
// - a component instance is drawn as large as its source scene (see linkedComponents.js);
// - auto-sized text is measured again on every draw (resizeTextLayer, as render.js does), so
//   a stored width/height left over from older text does not decide where it lines up.
//   Measuring keeps the text's alignment anchor, so moving the stored x/y by some amount
//   moves the drawn text by that same amount.
export function geometryOf(layer, scenes, fonts) {
  return layer.type === "text" ? resizeTextLayer(layer, fonts) : componentGeometry(layer, scenes);
}

/**
 * A layer's axis-aligned box in scene pixels, after its own and its parents' transforms.
 * `fonts` (default: the editor's loaded fonts) measures auto-sized text.
 */
export function layerWorldBox(layer, layers, scenes = [], fonts) {
  const geometry = geometryOf(layer, scenes, fonts);
  const matrix = worldMatrix(geometry, layers);
  const corners = [[0, 0], [geometry.width, 0], [0, geometry.height], [geometry.width, geometry.height]]
    .map(([x, y]) => point(matrix, x, y));
  return boxAround(corners);
}

/**
 * What the selected layers line up with: "scene" or "group" for one layer, "selection" for
 * several, or null when nothing selected can be aligned. Cheap enough to call on every render.
 */
export function alignmentReference(layers, layerIds) {
  const targets = alignmentTargets(layers, layerIds);
  if (!targets.length) return null;
  if (targets.length > 1) return "selection";
  return layers.some((layer) => layer.id === targets[0].parentId) ? "group" : "scene";
}

/**
 * The box the selected layers line up with, or null when nothing selected can be aligned.
 * Returns { reference: "scene" | "group" | "selection", box }.
 */
export function alignmentFrame(scene, layerIds, scenes = [], fonts) {
  const targets = alignmentTargets(scene.layers, layerIds);
  const reference = alignmentReference(scene.layers, layerIds);
  if (reference === "selection") {
    return { reference, box: unionBox(targets.map((layer) => layerWorldBox(layer, scene.layers, scenes, fonts))) };
  }
  if (reference === "group") {
    const parent = scene.layers.find((layer) => layer.id === targets[0].parentId);
    return { reference, box: layerWorldBox(parent, scene.layers, scenes, fonts) };
  }
  if (reference === "scene") return { reference, box: { left: 0, top: 0, right: scene.width, bottom: scene.height } };
  return null;
}

/** How far (in scene pixels, along the alignment's axis) a box must move to be aligned. */
export function alignmentDistance(box, frame, alignment) {
  const [start, end] = alignment.axis === "x" ? ["left", "right"] : ["top", "bottom"];
  if (alignment.edge === "start") return frame[start] - box[start];
  if (alignment.edge === "end") return frame[end] - box[end];
  return (frame[start] + frame[end]) / 2 - (box[start] + box[end]) / 2;
}

/**
 * The new x, y and animations that move a layer's box by (dx, dy) scene pixels, or null when
 * the layer does not need to move or cannot move (its group is scaled to zero).
 */
export function moveLayerByWorldDelta(layer, layers, dx, dy) {
  // x/y live in the parent group's space. Changing them by (localX, localY) moves the layer
  // by the parent's rotation/scale/skew applied to that change, so undo that transform here.
  const toParent = inverse(parentMatrix(layer, layers));
  if (!toParent) return null;
  const localX = toParent[0] * dx + toParent[2] * dy,
    localY = toParent[1] * dx + toParent[3] * dy;
  if (Math.abs(localX) < MIN_MOVE && Math.abs(localY) < MIN_MOVE) return null;
  const position = (value, change) => checkedPosition(layer, value + change);
  return {
    id: layer.id,
    x: position(layer.x, localX),
    y: position(layer.y, localY),
    // Animated x and y values are absolute positions, so they move by the same amount as the
    // layer (animationShift.js). Animations of other properties are kept as they are.
    animations: Array.isArray(layer.animations)
      ? layer.animations.map((animation) => shiftAnimation(animation, localX, localY, position))
      : layer.animations,
  };
}

function checkedPosition(layer, value) {
  // Rounded to a millionth of a pixel so saved files do not carry floating-point noise.
  const rounded = Math.round(value * 1e6) / 1e6 + 0;
  if (!Number.isFinite(rounded) || Math.abs(rounded) > MAX_COORDINATE) {
    throw new RangeError(`Aligning would move “${layer.name ?? layer.id}” outside the supported position range.`);
  }
  return rounded;
}

/**
 * Aligns the selected layers of one scene. Returns the changes to make, one
 * { id, x, y, animations } per layer that moves, and leaves `scene` untouched.
 * `scenes` (the document's scenes) gives component instances their size, and `fonts`
 * (default: the editor's loaded fonts) measures auto-sized text. Throws when a text layer's
 * font is not loaded, because its drawn size is then unknown.
 */
export function alignLayers(scene, layerIds, align, scenes = [], fonts) {
  const alignment = ALIGNMENTS.find((item) => item.id === align);
  if (!alignment) throw new RangeError(`Unknown alignment "${String(align)}". Use ${ALIGNMENT_IDS.join(", ")}.`);
  const frame = alignmentFrame(scene, layerIds, scenes, fonts);
  if (!frame) return [];
  const moves = [];
  for (const layer of alignmentTargets(scene.layers, layerIds)) {
    const distance = alignmentDistance(layerWorldBox(layer, scene.layers, scenes, fonts), frame.box, alignment);
    const move = moveLayerByWorldDelta(
      layer,
      scene.layers,
      alignment.axis === "x" ? distance : 0,
      alignment.axis === "y" ? distance : 0,
    );
    if (move) moves.push(move);
  }
  return moves;
}
