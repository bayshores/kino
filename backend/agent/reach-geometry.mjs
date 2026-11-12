import { DOMParser } from "@xmldom/xmldom";
import { duplicateRepeated, duplicateSelection, DUPLICATE_OFFSET } from "../../engine/duplicate.js";
import { moveRootLayers } from "../../engine/svgImport.js";
import { isEffectivelyLocked } from "../../engine/layerTree.js";
import { parseDocument } from "../../engine/model.js";
import { carryAnimations } from "../../engine/animationShift.js";
import { applyFromStart, inParentSpace, nudgeSelection, selectionBox, transformTargets } from "../../engine/multiTransform.js";
import { selectionTransformFromFields } from "../../engine/selectionTransformFields.js";
import { importSvg } from "../../engine/svgImport.js";
import { splitLayer } from "../../engine/splitLayer.js";

export const GEOMETRY_OPERATIONS = Object.freeze(["duplicate_layers", "split_layer", "multi_transform", "import_svg"]);

function requireScene(document, sceneId) {
  if (typeof sceneId !== "string" || !sceneId) throw new Error("A resolved sceneId is required.");
  const scene = document?.scenes?.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} was not found.`);
  return scene;
}

function requireLayerIds(scene, layerIds) {
  if (!Array.isArray(layerIds) || layerIds.length === 0)
    throw new Error("layerIds must name at least one layer.");
  if (new Set(layerIds).size !== layerIds.length)
    throw new Error("layerIds must not contain duplicates.");
  const byId = new Map(scene.layers.map((layer) => [layer.id, layer]));
  for (const id of layerIds) {
    if (typeof id !== "string" || !id) throw new Error("Every layerId must be a resolved layer ID.");
    if (!byId.has(id)) throw new Error(`Layer ${id} was not found in scene ${scene.id}.`);
  }
  return byId;
}

function selectedAncestor(layer, byId, selected) {
  const visited = new Set([layer.id]);
  let parent = byId.get(layer.parentId);
  while (parent && !visited.has(parent.id)) {
    if (selected.has(parent.id)) return parent;
    visited.add(parent.id);
    parent = byId.get(parent.parentId);
  }
  return null;
}

// The manual transform tools reduce a selection to its top-level roots and skip locked/audio
// layers. Agents get an explicit refusal for a skipped root so a partially applied selection is
// never mistaken for a complete transform. A selected child under a selected group follows that
// group exactly as it does on the canvas.
function transformSelection(scene, layerIds) {
  const byId = requireLayerIds(scene, layerIds);
  const selected = new Set(layerIds);
  for (const id of layerIds) {
    const layer = byId.get(id);
    if (selectedAncestor(layer, byId, selected)) continue;
    if (layer.type === "audio") throw new Error(`Audio layer “${layer.name || layer.id}” has no transform box.`);
    if (isEffectivelyLocked(scene.layers, id))
      throw new Error(`Layer “${layer.name || layer.id}” is locked and cannot be transformed.`);
  }
  const targets = transformTargets(scene.layers, layerIds);
  if (!targets.length) throw new Error("Select layers with a usable transform box.");
  return targets;
}

function finiteNumber(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} needs a finite number.`);
  return value;
}

function withSceneLayers(document, scene, layers) {
  return parseDocument({
    ...document,
    scenes: document.scenes.map((item) => item.id === scene.id ? { ...item, layers } : item),
  });
}

// duplicate_layers {layers, offset?} makes one copy; with count, layout, spacing, columns,
// radius or stagger it makes up to 50 real copies in a line, grid or ring (duplicate.js).
// at (seconds, cues already resolved by blocks.mjs applyTiming) and vary place copies in time.
const REPEAT_FIELDS = ["count", "layout", "spacing", "columns", "radius", "stagger", "at", "vary"];

// translate.mjs copyNames chose each copy's ID and name ({original ID: {id, name}} per copy), so
// later operations of the same edit can name the copies.
const chosenCopies = (copies) => (Array.isArray(copies) ? copies : []).map((copy) => {
  const entries = Object.entries(copy ?? {});
  return { ids: new Map(entries.map(([from, chosen]) => [from, chosen.id])), names: new Map(entries.map(([from, chosen]) => [from, chosen.name])) };
});

function duplicate(document, operation, fonts) {
  const scene = requireScene(document, operation.sceneId);
  requireLayerIds(scene, operation.layerIds);
  const offset = finiteNumber(operation.offset, "offset", DUPLICATE_OFFSET);
  const copies = chosenCopies(operation.copies);
  if (!REPEAT_FIELDS.some((field) => operation[field] !== undefined))
    return { document: parseDocument(duplicateSelection(document, scene.id, operation.layerIds, offset, copies[0]).document) };
  const options = Object.fromEntries(REPEAT_FIELDS.filter((field) => operation[field] !== undefined).map((field) => [field, operation[field]]));
  options.copies = copies;
  if (operation.withMoves !== undefined) options.withMoves = operation.withMoves;
  if (operation.offset !== undefined) options.offset = offset;
  const result = duplicateRepeated(document, scene.id, operation.layerIds, options, { fonts });
  return { document: parseDocument(result.document), rootIds: result.rootIds,
    ...(result.first !== undefined ? { first: result.first, report: result.report } : {}) };
}

// split_layer {layer, at} cuts a timed layer in two; {layer, from, to} also skips the file
// between (splitLayer.js).
function split(document, operation) {
  const scene = requireScene(document, operation.sceneId);
  if (typeof operation.layerId !== "string") throw new Error("split_layer needs a layer.");
  const skip = operation.from !== undefined || operation.to !== undefined;
  if (skip && operation.at !== undefined) throw new Error("split_layer takes at (a cut) or from and to (a skip), not both.");
  const at = finiteNumber(skip ? operation.from : operation.at, skip ? "from" : "at");
  const to = skip ? finiteNumber(operation.to, "to") : undefined;
  const chosen = Object.values(operation.copies?.[0] ?? {})[0];
  return { document: parseDocument(splitLayer(document, scene.id, operation.layerId, { at, to, copy: chosen ?? {} }).document) };
}

function transform(document, operation, fonts) {
  const scene = requireScene(document, operation.sceneId);
  const targets = transformSelection(scene, operation.layerIds);
  const action = operation.action;
  if (!action || typeof action !== "object" || Array.isArray(action))
    throw new Error("multi_transform needs an action.");

  let layers, transformMatrix = null;
  if (action.kind === "move") {
    const dx = finiteNumber(action.dx, "dx"), dy = finiteNumber(action.dy, "dy");
    const changes = nudgeSelection(scene.layers, operation.layerIds, dx, dy);
    if (!changes.length) throw new Error("The selected layers cannot be moved.");
    const patches = new Map(changes.map((change) => [change.id, change]));
    layers = scene.layers.map((layer) => patches.has(layer.id) ? { ...layer, ...patches.get(layer.id) } : layer);
  } else if (action.kind === "scale" || action.kind === "rotate") {
    if (action.keepAspect !== undefined && typeof action.keepAspect !== "boolean")
      throw new Error("keepAspect must be true or false.");
    const box = selectionBox(targets, scene.layers, { scenes: document.scenes, fonts });
    const result = selectionTransformFromFields(scene.layers, operation.layerIds, box, action, {
      scenes: document.scenes,
      fonts,
    });
    layers = applyFromStart(scene.layers, scene.layers, operation.layerIds, result.changes);
    transformMatrix = result.transform;
  } else {
    throw new Error('action.kind must be "move", "scale", or "rotate".');
  }

  return { document: withSceneLayers(document, scene, carriedAnimations(scene.layers, layers, targets, transformMatrix)) };
}

// An animation's x and y are places in the scene (a slide ends at the layer's own x), so the
// moved, scaled or turned roots take their animations along; otherwise the layer would slide
// back to its old place. Layers inside a moved group need nothing, and those inside a scaled
// or turned group were already changed by the group-resize rules.
function carriedAnimations(start, layers, targets, transformMatrix) {
  const before = new Map(start.map((layer) => [layer.id, layer]));
  const roots = new Map(targets.map((layer) => {
    const parentSpace = transformMatrix ? inParentSpace(before.get(layer.id), start, transformMatrix) : null;
    return [layer.id, parentSpace ? parentSpace.slice(0, 4) : [1, 0, 0, 1]];
  }));
  return layers.map((layer) => {
    if (!roots.has(layer.id) || !Array.isArray(layer.animations)) return layer;
    const animations = carryAnimations(layer.animations, before.get(layer.id), layer, roots.get(layer.id));
    return animations.every((item, index) => item === layer.animations[index]) ? layer : { ...layer, animations };
  });
}

function importSvgOperation(document, operation) {
  const scene = requireScene(document, operation.sceneId);
  const x = finiteNumber(operation.x, "x", 0);
  const y = finiteNumber(operation.y, "y", 0);
  const name = operation.name === undefined ? "Imported SVG" : operation.name;
  if (typeof name !== "string") throw new Error("name must be text.");
  const imported = importSvg(operation.svg, { name, explicit: operation.name !== undefined, DOMParser });
  const layers = moveRootLayers(imported.layers, x, y);
  const nextScene = { ...scene, layers: [...scene.layers, ...layers] };
  return {
    document: withSceneLayers(document, scene, nextScene.layers),
    ...(imported.warnings.length ? { warnings: imported.warnings } : {}),
  };
}

/** Apply a server-side geometry/import operation to an already resolved scene and layer set. */
export async function applyGeometryOperation(document, operation, { fonts } = {}) {
  const type = operation?.type ?? operation?.op;
  if (!GEOMETRY_OPERATIONS.includes(type)) throw new Error(`Unsupported geometry operation "${String(type)}".`);
  if (type === "duplicate_layers") return duplicate(document, operation, fonts);
  if (type === "split_layer") return split(document, operation);
  if (type === "multi_transform") return transform(document, operation, fonts);
  return importSvgOperation(document, operation);
}
