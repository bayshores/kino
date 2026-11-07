// split_image: cuts a picture layer (a screenshot, a still of a screen recording) into pieces
// in place, so each part of a real UI can be animated on its own (rows resolve or fade up one by
// one). No pixel is redrawn: each piece is a clipping
// group the size of its box holding a copy of the whole picture, placed so the picture sits
// exactly where it was. Until a piece is animated, nothing on screen changes.
//
// The picture layer is replaced by its pieces (in its place in the stack, in its group). A part
// left out of every box is no longer shown. Plain data in, plain data out.
import { createLayer } from "./model.js";

const PART = /^[a-z0-9][a-z0-9-]{0,40}$/;
// Above this many screen pixels per picture pixel, a piece looks soft.
export const SOFT_SCALE = 1.3;

const round = (value) => Math.round(value * 100) / 100;

/**
 * Splits `layerId` in `scene` into pieces. boxes: [{name, rect: [x, y, w, h]}] in % of the
 * layer's box. taken: a Set of IDs already used in the document. source: {width, height} of the
 * picture file, or null. Returns {layers (the new scene.layers), pieces (IDs), notes}.
 */
export function splitImage(scene, layerId, boxes, { taken = new Set(), source = null } = {}) {
  const layer = scene.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`split_image: no layer "${layerId}" in this scene.`);
  if (layer.type === "video") throw new Error(`split_image: ${layerId} is a video. Save the frame as a picture: render {action:"start", quality:"final", format:"png", options:{time}}, import it (project {action:"import"}), and split that.`);
  if (layer.type !== "image") throw new Error(`split_image: ${layerId} is a ${layer.type}; give a picture layer (a screenshot or a still).`);
  if (layer.isMask) throw new Error(`split_image: ${layerId} is a mask; split a picture that is drawn.`);
  if ((layer.rotation ?? 0) !== 0 || (layer.scaleX ?? 1) !== 1 || (layer.scaleY ?? 1) !== 1 || (layer.skewX ?? 0) !== 0)
    throw new Error(`split_image: ${layerId} is turned or scaled; split it first, then group the pieces and move the group.`);
  if ((layer.animations ?? []).length)
    throw new Error(`split_image: ${layerId} has animations; split it before animating, then animate the pieces (move build-in) or their group.`);
  if (!Array.isArray(boxes) || boxes.length < 1 || boxes.length > 40) throw new Error("split_image boxes is a list of 1 to 40 {name, rect}.");
  const names = new Set();
  const pieces = [];
  const notes = [];
  for (const [index, box] of boxes.entries()) {
    const where = `split_image boxes[${index}]`;
    if (!box || typeof box !== "object" || Array.isArray(box) || Object.keys(box).some((key) => !["name", "rect"].includes(key)))
      throw new Error(`${where} is {name, rect: [x, y, w, h]} (% of the picture's box), such as {name: "row1", rect: [5, 20, 90, 8]}.`);
    const name = String(box.name ?? "").trim().toLowerCase();
    if (!PART.test(name)) throw new Error(`${where}.name is 1 to 41 lowercase letters, digits or dashes, such as "row1".`);
    if (names.has(name)) throw new Error(`${where}.name "${name}" is used twice.`);
    names.add(name);
    const rect = box.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((value) => typeof value === "number" && Number.isFinite(value)) || rect[0] < 0 || rect[1] < 0 || rect[2] <= 0 || rect[3] <= 0 || rect[0] + rect[2] > 100.01 || rect[1] + rect[3] > 100.01)
      throw new Error(`${where}.rect is [x, y, w, h] in % of the picture's box, inside 0 to 100 (x, y the top-left corner).`);
    const id = `${layer.id}-${name}`;
    if (taken.has(id) || taken.has(`${id}-px`)) throw new Error(`${where}: the ID ${id} is already used; pick another name.`);
    const x = round(layer.x + (layer.width * rect[0]) / 100);
    const y = round(layer.y + (layer.height * rect[1]) / 100);
    const piece = createLayer("group", {
      id, name: id, parentId: layer.parentId ?? null, x, y,
      width: round((layer.width * rect[2]) / 100), height: round((layer.height * rect[3]) / 100),
      clipContent: true, fillEnabled: false, opacity: layer.opacity ?? 1, blur: layer.blur ?? 0,
      ...(layer.blendMode ? { blendMode: layer.blendMode } : {}),
    });
    // The whole picture, its corner at the old corner: the group's box clips it to the piece.
    const { id: _id, name: _name, parentId: _parent, animations: _animations, ...look } = layer;
    const pixels = { ...look, id: `${id}-px`, name: `${id}-px`, parentId: id, x: round(layer.x - x), y: round(layer.y - y), opacity: 1, blur: 0, shadow: null, animations: [] };
    pieces.push(piece, pixels);
  }
  if (layer.shadow) notes.push(`split_image: ${layer.id}'s shadow is not on the pieces (each would cast its own)`);
  // How many screen pixels each picture pixel takes ("slice" fills the box), with the groups around it.
  if (source?.width > 0 && source?.height > 0) {
    let scale = Math.max(layer.width / source.width, layer.height / source.height);
    for (let parent = scene.layers.find((item) => item.id === layer.parentId); parent; parent = scene.layers.find((item) => item.id === parent.parentId))
      scale *= Math.max(Math.abs(parent.scaleX ?? 1), Math.abs(parent.scaleY ?? 1));
    if (scale > SOFT_SCALE) notes.push(`split_image: warning, ${layer.id} is shown at ${round(scale)}x its pixels (${source.width}×${source.height} file), above ${SOFT_SCALE}x, so its pieces look soft. Use a sharper capture (2x) or show it smaller.`);
  }
  const index = scene.layers.indexOf(layer);
  const layers = [...scene.layers.slice(0, index), ...pieces, ...scene.layers.slice(index + 1)];
  notes.unshift(`split_image ${layer.id} into ${boxes.length} pieces: ${pieces.filter((item) => item.type === "group").map((item) => item.id).join(", ")} (real pixels; nothing moves until animated)`);
  return { layers, pieces: pieces.filter((item) => item.type === "group").map((item) => item.id), notes };
}
