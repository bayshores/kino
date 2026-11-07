// ⌘D and the Inspector's Duplicate buttons: copies of the selected layers.
//
// How it works, step by step (`duplicateSelection`):
// 1. Copy the layers with the same code as Option-drag and paste (layerClipboard.js
//    `duplicateLayers`). The copies go directly above the originals, in the same groups.
//    A selected group is copied with everything inside it. A mask and the layer it masks are
//    copied together, and the copied mask masks the copied layer, so the scene still draws.
//    When a copy can't work, it throws an Error that says why and nothing changes. For
//    example, a mask group's mask selected on its own: its copy would mask a layer that the
//    original doesn't mask.
// 2. Move each copied top layer DUPLICATE_OFFSET scene pixels right and down, so the copy
//    shows next to the original. arrange.js `moveLayerByWorldDelta` does the move, so a copy
//    inside a rotated or scaled group still moves right and down on the canvas, and its
//    animated x and y values move with it: the copy animates like the original, just offset.
// 3. Name every copied layer "<name> copy".
// The document passed in is never changed.
//
// `duplicateRepeated` (the agent's duplicate_layers with count) makes up to 50 real copies in a
// line, a grid or a ring, Cavalry-duplicator style, each a normal layer that every check, look
// and export sees exactly. Copy n is named "<name> n+1" (the original is 1), and its animations
// may start n * stagger seconds later.
import { moveLayerByWorldDelta } from "./arrange.js";
import { duplicateLayers } from "./layerClipboard.js";
import { selectionBox, transformTargets } from "./multiTransform.js";

/** How far (in scene pixels, right and down) each copy lands from its original. */
export const DUPLICATE_OFFSET = 24;
const NAME_SUFFIX = " copy";
const MAX_NAME_LENGTH = 256; // the longest layer name model.js accepts

const label = (layer) => `“${layer.name || layer.id}”`;

/** A copied layer's name: "<name> copy", shortened so it still fits in a layer name. */
export function copyName(name) {
  return `${String(name ?? "").slice(0, MAX_NAME_LENGTH - NAME_SUFFIX.length)}${NAME_SUFFIX}`;
}

/**
 * Duplicates the given layers of one scene (see the steps above). Returns { document, rootIds }:
 * the next document and the IDs of the copied top layers, which the editor selects. `ids` and
 * `names` (Maps from an original layer's ID) give chosen copies their ID and name, so the agent's
 * later operations in the same edit can name them (translate.mjs copyNames). Throws an
 * Error that says why when the layers can't be duplicated; the document is then unchanged.
 */
export function duplicateSelection(document, sceneId, layerIds, offset = DUPLICATE_OFFSET, { dy = offset, name = copyName, ids, names } = {}) {
  const dx = offset;
  const { document: copied, rootIds, idMap } = duplicateLayers(document, sceneId, layerIds, { ids });
  const originalOf = new Map([...idMap].map(([original, copy]) => [copy, original]));
  const scene = copied.scenes.find((item) => item.id === sceneId);
  const copyIds = new Set(idMap.values());
  const rootSet = new Set(rootIds);

  // Each copied top layer sits in an original group (or at the top level), which doesn't move,
  // so every move is measured against the scene's layers as the paste left them.
  const moves = new Map();
  for (const layer of scene.layers) {
    if (!rootSet.has(layer.id)) continue;
    let move;
    try {
      move = moveLayerByWorldDelta(layer, scene.layers, dx, dy);
    } catch {
      throw new Error(`Can't duplicate ${label(layer)}: its copy would be outside the supported position range.`);
    }
    if (move) moves.set(layer.id, move); // null: its group is scaled to zero, so it stays put
  }

  const layers = scene.layers.map((layer) => {
    if (!copyIds.has(layer.id)) return layer;
    const move = moves.get(layer.id);
    const placed = move ? { x: move.x, y: move.y, animations: move.animations } : {};
    return { ...layer, ...placed, name: names?.get(originalOf.get(layer.id)) ?? name(layer.name) };
  });
  return {
    document: { ...copied, scenes: copied.scenes.map((item) => (item.id === sceneId ? { ...item, layers } : item)) },
    rootIds, copyIds: [...copyIds],
  };
}

export const MAX_COPIES = 50;
export const DUPLICATE_LAYOUTS = Object.freeze(["line", "grid", "radial"]);
const MAX_STAGGER = 10;
const round = (value) => Math.round(value * 1000) / 1000 + 0;

function spacingOf(spacing, fallback, label) {
  if (spacing === undefined) return fallback;
  const value = typeof spacing === "number" ? { x: spacing, y: label === "line" ? 0 : spacing } : spacing;
  if (!value || typeof value !== "object" || !Number.isFinite(value.x ?? 0) || !Number.isFinite(value.y ?? 0))
    throw new Error("spacing must be a number of pixels or {x, y}.");
  return { x: value.x ?? 0, y: value.y ?? 0 };
}

/**
 * How far copy n (1..count) moves from the originals, in scene pixels: [[dx, dy], ...].
 * Without a layout each copy steps `offset` right and down from the last. `box` is the
 * originals' box ({width, height}); it sets the default spacing and ring size.
 *   line    in a row, spacing {x, y} apart (default: the box width plus 24 to the right)
 *   grid    rows of `columns` (default about square), spacing apart (default: the box plus 24)
 *   radial  a ring of count + 1 places with the original at the top (12 o'clock), copies going
 *           clockwise; `radius` (default: wide enough that the copies do not touch)
 */
export function copyOffsets({ count, layout, offset = DUPLICATE_OFFSET, spacing, columns, radius }, box = { width: 0, height: 0 }) {
  const copies = Array.from({ length: count }, (_, index) => index + 1);
  const gap = DUPLICATE_OFFSET;
  if (layout === undefined) return copies.map((n) => [n * offset, n * offset]);
  if (layout === "line") {
    const step = spacingOf(spacing, { x: box.width + gap, y: 0 }, "line");
    return copies.map((n) => [round(n * step.x), round(n * step.y)]);
  }
  if (layout === "grid") {
    const step = spacingOf(spacing, { x: box.width + gap, y: box.height + gap }, "grid");
    const across = columns ?? Math.ceil(Math.sqrt(count + 1));
    if (!Number.isInteger(across) || across < 1 || across > MAX_COPIES + 1) throw new Error(`columns must be a whole number from 1 to ${MAX_COPIES + 1}.`);
    return copies.map((n) => [round((n % across) * step.x), round(Math.floor(n / across) * step.y)]);
  }
  if (layout === "radial") {
    const places = count + 1;
    const ring = radius ?? Math.max(50, Math.round((places * Math.max(box.width, box.height) * 1.5) / (2 * Math.PI)));
    if (!Number.isFinite(ring) || ring <= 0) throw new Error("radius must be a number of pixels above 0.");
    // The ring's center is `ring` below the original, so the original sits at angle -90 degrees.
    return copies.map((n) => {
      const angle = -Math.PI / 2 + (n * 2 * Math.PI) / places;
      return [round(ring * Math.cos(angle)), round(ring + ring * Math.sin(angle))];
    });
  }
  throw new Error(`layout must be one of ${DUPLICATE_LAYOUTS.join(", ")}.`);
}

/**
 * `count` copies of the given layers placed by copyOffsets, each copy's animations starting
 * n * stagger seconds after the original's. Returns { document, copyIds }. Throws an Error that
 * says why when the copies can't be made; the document passed in is never changed.
 */
// The layouts each placement field works with (undefined: copies without a layout).
const FIELD_LAYOUTS = { offset: [undefined], spacing: ["line", "grid"], columns: ["grid"], radius: ["radial"] };

export function duplicateRepeated(document, sceneId, layerIds, options = {}, { fonts } = {}) {
  const { count = 1, layout, stagger = 0 } = options;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COPIES) throw new Error(`count must be a whole number from 1 to ${MAX_COPIES}.`);
  if (typeof stagger !== "number" || !Number.isFinite(stagger) || stagger < 0 || stagger > MAX_STAGGER)
    throw new Error(`stagger must be seconds from 0 to ${MAX_STAGGER} between copies.`);
  if (layout !== undefined && !DUPLICATE_LAYOUTS.includes(layout)) throw new Error(`layout must be one of ${DUPLICATE_LAYOUTS.join(", ")}.`);
  // Nothing is dropped unseen: a field the layout does not use is refused.
  for (const [field, layouts] of Object.entries(FIELD_LAYOUTS)) {
    if (options[field] === undefined || layouts.includes(layout)) continue;
    const uses = layouts.map((item) => (item === undefined ? "no layout" : `layout "${item}"`)).join(" or ");
    throw new Error(`${field} works only with ${uses}${layout ? `, not "${layout}"` : ""}.`);
  }
  const scene = document.scenes.find((item) => item.id === sceneId);
  let box = { width: 0, height: 0 };
  const needsBox = layout === "radial" ? options.radius === undefined : layout !== undefined && options.spacing === undefined;
  if (needsBox) {
    box = selectionBox(transformTargets(scene.layers, layerIds), scene.layers, { scenes: document.scenes, fonts });
    if (!box) throw new Error(`The layers have no measurable box: give ${layout === "radial" ? "radius" : "spacing"}.`);
  }
  const offsets = copyOffsets({ ...options, count }, box);
  // Numbered names only when count is given, so a plain duplicate stays "<name> copy". Copy n
  // takes the n-th number from 2 that no layer in the scene has yet, so names stay unique.
  const numbered = options.count !== undefined;
  const taken = new Set(scene.layers.map((layer) => layer.name));
  const free = new Map();
  const numberedName = (n) => (name) => {
    const base = String(name ?? "").slice(0, 240);
    if (!free.has(base)) {
      const numbers = [];
      for (let k = 2; numbers.length < count; k += 1) if (!taken.has(`${base} ${k}`)) numbers.push(k);
      free.set(base, numbers);
    }
    return `${base} ${free.get(base)[n - 1]}`;
  };
  // Each copy lands right after its original, so the last copy is made first: the list then
  // reads "<name>, <name> 2, <name> 3".
  let next = document;
  const copies = [];
  for (let n = count; n >= 1; n -= 1) {
    const [dx, dy] = offsets[n - 1];
    const chosen = options.copies?.[n - 1];
    const result = duplicateSelection(next, sceneId, layerIds, dx, { dy, name: numbered ? numberedName(n) : copyName, ids: chosen?.ids, names: chosen?.names });
    next = stagger > 0 ? delayLayers(result.document, sceneId, new Set(result.copyIds), round(n * stagger)) : result.document;
    copies.unshift(result.copyIds);
  }
  return { document: next, copyIds: copies.flat() };
}

// The document with every animation of the named layers starting `delay` seconds later.
function delayLayers(document, sceneId, ids, delay) {
  const later = (animation) => (typeof animation?.start === "number" ? { ...animation, start: round(animation.start + delay) } : animation);
  return { ...document, scenes: document.scenes.map((scene) => scene.id !== sceneId ? scene : {
    ...scene, layers: scene.layers.map((layer) => ids.has(layer.id) && Array.isArray(layer.animations) ? { ...layer, animations: layer.animations.map(later) } : layer),
  }) };
}
