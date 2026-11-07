// One world-space frame for selected roots. Each pointer move starts from the press snapshot;
// it changes roots' own values, while group descendants follow the normal group-resize rules.
import { alignmentTargets } from "./arrange.js";
import { boxAround, sizedBox } from "./boxes.js";
import { IDENTITY, inverse, multiply, parentMatrix } from "./geometry.js";
import { RESIZED_KEYS, stretchLayerBy } from "./groupResize.js";
import { isEffectivelyLocked } from "./layerTree.js";
import { reparentLayer, withDrawnBox } from "./reparent.js";
import { layerQuad } from "./selection.js";
import { resizeTextLayer } from "./textLayout.js";

export { boxAround, unionBox } from "./boxes.js";

const stored = (layer) => layer;
const isIdentity = (T) => T.every((value, i) => value === IDENTITY[i]);

export function transformTargets(layers, selectedIds) {
  return alignmentTargets(layers, selectedIds).filter((layer) => !isEffectivelyLocked(layers, layer.id));
}

/** Keyboard movement uses the same roots and world axes as a canvas drag. */
export function nudgeSelection(layers, selectedIds, dx, dy, evaluate = stored) {
  return transformTargets(layers, selectedIds).flatMap((layer) => {
    const M = inverse(parentMatrix(layer, layers, evaluate));
    if (!M) return [];
    const x = Math.round((layer.x + M[0] * dx + M[2] * dy) * 1e6) / 1e6 + 0;
    const y = Math.round((layer.y + M[1] * dx + M[3] * dy) * 1e6) / 1e6 + 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) throw new RangeError("Moving the selection would exceed the supported position range.");
    return [{ id: layer.id, x, y }];
  });
}

export function selectionBox(targets, layers, { evaluate = stored, scenes = [], fonts } = {}) {
  if (!targets.length) return null;
  try {
    const measure = (layer) => resizeTextLayer(evaluate(layer), fonts);
    const corners = [];
    for (const layer of targets) {
      if (!inverse(parentMatrix(layer, layers, measure))) return null;
      corners.push(...layerQuad(layer, layers, { evaluate: measure, scenes }));
    }
    if (!corners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
    return sizedBox(boxAround(corners));
  } catch {
    // Missing fonts mean there is no trustworthy frame to drag.
    return null;
  }
}

export function boxScaleMatrix(from, to) {
  if (!(from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0)) throw new RangeError("Scaling needs a positive selection size.");
  const across = to.width / from.width, down = to.height / from.height;
  return [across, 0, 0, down, to.x - across * from.x, to.y - down * from.y];
}

export function rotationAbout(center, degrees) {
  const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [c, s, -s, c, center.x - c * center.x + s * center.y, center.y - s * center.x - c * center.y];
}

export function inParentSpace(layer, layers, T, evaluate = stored) {
  const P = parentMatrix(layer, layers, evaluate), toParent = inverse(P);
  return toParent ? multiply(multiply(toParent, T), P) : null;
}

// A handle solves the pose you see, but saves design values. Evaluate the proposed edit
// again before correcting its position: size-animation anchors and auto-text alignment
// can add an offset which itself changes when the design pose changes. Their keyframes
// stay intact; only withDrawnBox's existing, look-preserving text offset is retained.
function designChange(layer, source, change, wanted, evaluate, fonts) {
  const patch = {
    ...(source !== layer ? { width: source.width, height: source.height, animations: source.animations } : {}),
    ...change,
  };
  const actual = resizeTextLayer(evaluate({ ...source, ...patch }), fonts);
  for (const key of ["x", "y"]) {
    const value = Math.round((patch[key] + wanted[key] - actual[key]) * 1e6) / 1e6 + 0;
    if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw new RangeError("Transforming the selection would exceed the supported position range.");
    patch[key] = value;
  }
  return patch;
}

export function scaleSelection(start, targetIds, T, { evaluate = stored, scenes = [], fonts } = {}) {
  if (isIdentity(T)) return [];
  return transformTargets(start, targetIds).flatMap((layer) => {
    const M = inParentSpace(layer, start, T, evaluate);
    if (!M) throw new RangeError("A group around the selection is scaled to zero.");
    const source = withDrawnBox(layer, fonts);
    if (!source) throw new RangeError("Auto-sized text animates its width or height. Set its sizing to Fixed before resizing the selection.");
    const shown = resizeTextLayer(evaluate(layer), fonts);
    // Stretch the evaluated geometry, retaining the target's live scale. The stretch
    // decomposes into writable size/rotation/skew, so an animated scale stays untouched.
    // Descendants still start from their stored values and use group-resize animation rules.
    const geometry = { ...shown, animations: [], ...(shown.type === "text" ? { textResize: "fixed" } : {}) };
    const changes = stretchLayerBy(start.map((item) => item === layer ? geometry : item), layer.id, M, { scenes, fonts });
    const change = { ...changes[0], ...(shown.type === "text" && layer.textResize !== "fixed" ? { textResize: "fixed" } : {}) };
    const wanted = { ...shown, ...change };
    changes[0] = designChange(layer, source, change, wanted, evaluate, fonts);
    return changes;
  });
}

function drawnSize(layer, scenes) {
  const source = layer.type === "component" && scenes.find((scene) => scene.id === layer.componentSceneId);
  return source || layer;
}

export function rotateSelection(start, targetIds, T, { evaluate = stored, scenes = [], fonts } = {}) {
  if (isIdentity(T)) return [];
  return transformTargets(start, targetIds).map((layer) => {
    const M = inParentSpace(layer, start, T, evaluate);
    if (!M) throw new RangeError("A group around the selection is scaled to zero.");
    const source = withDrawnBox(layer, fonts) ?? layer;
    const shown = resizeTextLayer(evaluate(layer), fonts);
    let pose;
    try {
      pose = reparentLayer({ ...shown, animations: [] }, M, drawnSize(shown, scenes));
    } catch (error) {
      // Reparent's validation predates canvas transforms and throws plain Errors.
      throw new RangeError(error.message);
    }
    const { x, y, rotation, scaleX, scaleY, skewX } = pose;
    const change = { id: layer.id, x, y, rotation, scaleX, scaleY, skewX };
    return designChange(layer, source, change, { ...shown, ...change }, evaluate, fonts);
  });
}

/** Restore only transform-owned fields; concurrent fill/name/etc. edits survive. */
export function applyFromStart(layers, start, rootIds, changes) {
  const roots = new Set(rootIds), initial = new Map(start.map((layer) => [layer.id, layer]));
  const affected = new Set(roots);
  for (const layer of start) {
    let current = layer;
    const visited = new Set();
    while (current && !visited.has(current.id)) {
      if (roots.has(current.id)) { affected.add(layer.id); break; }
      visited.add(current.id);
      current = initial.get(current.parentId);
    }
  }
  const patches = new Map(changes.map((change) => [change.id, change]));
  return layers.map((layer) => {
    const before = affected.has(layer.id) && initial.get(layer.id);
    if (!before) return layer;
    const next = { ...layer };
    for (const key of RESIZED_KEYS) {
      if (Object.hasOwn(before, key)) next[key] = before[key];
      else delete next[key];
    }
    return { ...next, ...patches.get(layer.id) };
  });
}
