// outline_text {layer}: a text layer's letters become vector shapes. The glyph outlines kino
// already draws (layoutText + glyphPath) become one path layer per letter inside a group that
// takes the text's place, transform, timing and animations, and the text is hidden. Each letter
// is then a shape of its own (per-letter shape effects) and exports as plain vectors (Lottie).
import { createLayer, uid } from "./model.js";
import { glyphPath, glyphPathBounds, layoutText, textUnits } from "./textLayout.js";
import { parsePath, serializePath } from "./vectorPath.js";
import { freshAnimationIds } from "./animationTree.js";
import { isAnimationCompatible } from "./animationCompatibility.js";

// The group carries where the text is and how it moves; each letter carries how it is painted.
const PLACE = ["parentId", "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "skewX", "opacity", "blendMode",
  "playbackWindows", "anchorX", "anchorY", "rotateX", "rotateY", "perspective"];
const PAINT = ["fill", "fillEnabled", "stroke", "strokeWidth", "strokeAlign", "shadow", "blur"];

const animationKeys = (animation) => [animation.from, animation.to, ...(animation.animations ?? []).flatMap((member) => [member.from, member.to])]
  .flatMap((side) => (side && typeof side === "object" ? Object.keys(side) : []));

/** A path layer's `path` moved by (dx, dy). */
function shifted(d, dx, dy) {
  const move = ([x, y]) => [x + dx, y + dy];
  return serializePath(parsePath(d).map((contour) => ({ start: move(contour.start), closed: contour.closed,
    segments: contour.segments.map((segment) => ({ c1: move(segment.c1), c2: move(segment.c2), end: move(segment.end) })) })));
}

/**
 * The layers that replace a text layer: [group, ...letters] (group first) plus the text hidden.
 * Refuses text whose animations only text can play (by letter, typewriter, axes...), naming them.
 */
export function outlineTextLayers(layer, fonts) {
  if (layer?.type !== "text") throw new Error(`outline_text needs a text layer; ${layer?.name ?? "this layer"} is a ${layer?.type} layer.`);
  const group = createLayer("group", { name: `${layer.name} outlines` });
  for (const key of PLACE) if (layer[key] !== undefined) group[key] = structuredClone(layer[key]);
  // A text preset played on the whole layer (a fade, a slide) is the same move on the group.
  const animations = (layer.animations ?? []).map((animation) => {
    if ((animation.unit ?? "layer") !== "layer" || animation.textClip != null) return animation;
    const { textAnchor, ...rest } = animation;
    return rest.preset?.text ? { ...rest, preset: { ...rest.preset, text: false } } : rest;
  });
  const textOnly = animations.filter((animation) => (animation.unit ?? "layer") !== "layer" || !isAnimationCompatible(group, animation));
  if (textOnly.length)
    throw new Error(`outline_text: ${layer.name} has animations only text can play (${textOnly.map((item) => item.name ?? item.id).join(", ")}); delete them first, then outline it.`);
  const paints = (animation) => animationKeys(animation).every((key) => PAINT.includes(key));
  group.animations = animations.filter((animation) => !paints(animation)).map((animation) => freshAnimationIds(animation, uid));
  const letters = textUnits(layoutText(layer, fonts), "letters").flatMap((unit) => {
    const outlined = unit.glyphs.filter((glyph) => glyph.path);
    if (!outlined.length) return [];
    const boxes = outlined.map(glyphPathBounds).filter((box) => box && box.width > 0 && box.height > 0);
    if (!boxes.length) return [];
    const left = Math.min(...boxes.map((box) => box.x)), top = Math.min(...boxes.map((box) => box.y));
    const width = Math.max(...boxes.map((box) => box.x + box.width)) - left, height = Math.max(...boxes.map((box) => box.y + box.height)) - top;
    const letter = createLayer("path", { name: unit.text.trim() || unit.text, parentId: group.id, x: left, y: top, width, height,
      path: shifted(outlined.map(glyphPath).join(" "), -left, -top), pathBounds: { x: 0, y: 0, width, height } });
    for (const key of PAINT) if (layer[key] !== undefined) letter[key] = structuredClone(layer[key]);
    if (outlined[0].fill !== undefined) letter.fill = structuredClone(outlined[0].fill);
    letter.animations = animations.filter(paints).map((animation) => freshAnimationIds(animation, uid));
    return [letter];
  });
  if (!letters.length) throw new Error(`outline_text: ${layer.name} has no letters with outlines to convert.`);
  return { group, letters, hidden: { ...layer, visible: false } };
}
