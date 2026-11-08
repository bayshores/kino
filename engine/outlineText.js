// outline_text {layer}: a text layer's letters become vector shapes. The glyph outlines kino
// already draws (layoutText + glyphPath) become one path layer per letter inside a group that
// takes the text's place, transform, timing and animations, and the text is hidden. Each letter
// is then a shape of its own (per-letter shape effects) and exports as plain vectors (Lottie).
import { createLayer, uid } from "./model.js";
import { glyphPath, glyphPathBounds, layoutText, textUnits } from "./textLayout.js";
import { parsePath, serializePath } from "./vectorPath.js";
import { freshAnimationIds } from "./animationTree.js";
import { isAnimationCompatible } from "./animationCompatibility.js";
import { splitLetterStrokes } from "./stackedStrokes.js";

// The group carries where the text is and how it moves; each letter carries how it is painted.
const PLACE = ["parentId", "x", "y", "width", "height", "rotation", "scaleX", "scaleY", "skewX", "opacity", "blendMode",
  "playbackWindows", "anchorX", "anchorY", "rotateX", "rotateY", "perspective"];
const PAINT = ["fill", "fillEnabled", "stroke", "strokeWidth", "strokeAlign", "shadow", "shadows", "strokes", "blur"];

const animationKeys = (animation) => [animation.from, animation.to, ...(animation.animations ?? []).flatMap((member) => [member.from, member.to])]
  .flatMap((side) => (side && typeof side === "object" ? Object.keys(side) : []));

/** A path layer's `path` moved by (dx, dy). */
function shifted(d, dx, dy) {
  const move = ([x, y]) => [x + dx, y + dy];
  return serializePath(parsePath(d).map((contour) => ({ start: move(contour.start), closed: contour.closed,
    segments: contour.segments.map((segment) => ({ c1: move(segment.c1), c2: move(segment.c2), end: move(segment.end) })) })));
}

/** The path of `glyphs` and its box, the path moved so the box starts at 0, 0. */
function outlinePath(glyphs) {
  const outlined = glyphs.filter((glyph) => glyph.path);
  const boxes = outlined.map(glyphPathBounds).filter((box) => box && box.width > 0 && box.height > 0);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box.x)), top = Math.min(...boxes.map((box) => box.y));
  const width = Math.max(...boxes.map((box) => box.x + box.width)) - left, height = Math.max(...boxes.map((box) => box.y + box.height)) - top;
  return { x: left, y: top, width, height, path: shifted(outlined.map(glyphPath).join(" "), -left, -top), pathBounds: { x: 0, y: 0, width, height } };
}

/**
 * The layers that replace a text layer: [group, ...letters] (group first) plus the text hidden.
 * A `strokes` list that starts with outside strokes goes on one path of all the letters under
 * them (splitLetterStrokes), so a letter's outline never covers its neighbor, as on the text.
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
  const split = splitLetterStrokes(layer);
  // With a solid outline under the letters, it casts the shadows the letters would.
  const shadowOnly = (animation) => animationKeys(animation).every((key) => key === "shadow");
  const letters = textUnits(layoutText(layer, fonts), "letters").flatMap((unit) => {
    const shape = outlinePath(unit.glyphs);
    if (!shape) return [];
    const letter = createLayer("path", { name: unit.text.trim() || unit.text, parentId: group.id, ...shape });
    for (const key of PAINT) if (layer[key] !== undefined) letter[key] = structuredClone(layer[key]);
    const first = unit.glyphs.find((glyph) => glyph.path);
    if (first.fill !== undefined) letter.fill = structuredClone(first.fill);
    letter.animations = animations.filter((animation) => paints(animation) && !(split?.solid && shadowOnly(animation)))
      .map((animation) => freshAnimationIds(animation, uid));
    if (split) {
      if (split.over.length) letter.strokes = structuredClone(split.over); else delete letter.strokes;
      if (split.solid) { delete letter.shadow; delete letter.shadows; }
    }
    return [letter];
  });
  if (!letters.length) throw new Error(`outline_text: ${layer.name} has no letters with outlines to convert.`);
  if (split) {
    const shape = outlinePath(textUnits(layoutText(layer, fonts), "layer")[0].glyphs);
    const outline = createLayer("path", { name: `${layer.name} outline`, parentId: group.id, ...shape, fillEnabled: false, strokes: structuredClone(split.under) });
    for (const key of split.solid ? ["shadow", "shadows", "blur"] : ["blur"]) if (layer[key] !== undefined) outline[key] = structuredClone(layer[key]);
    outline.animations = animations.filter((animation) => paints(animation) && animationKeys(animation).every((key) => key === "blur" || (split.solid && key === "shadow")))
      .map((animation) => freshAnimationIds(animation, uid));
    letters.unshift(outline);
  }
  return { group, letters, hidden: { ...layer, visible: false } };
}
