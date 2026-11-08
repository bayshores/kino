// Where a push into one of your layers can fill the frame (push-through-type): the layer's box
// as drawn, an inside(x, y) test of what it draws and the point where a push fills the frame
// soonest, in its own pixels at scale 1. Text: each letter's ink. Paths and shapes: their filled
// outline. Pictures: their alpha grid when kino could read the file (else the whole box).
// Clips: the whole box. Groups: their parts, each through its own place and scale.
import { evaluateLayer } from "../../animation.js";
import { layoutText, resizeTextLayer, textUnits } from "../../textLayout.js";
import { parsePath } from "../../vectorPath.js";
import { shapeContours } from "../../shapes.js";
import { coverScale, glyphInside, gridInk, inkPoint, outlineInk } from "./kit.js";

const STEPS = 8;

/** Closed polygons (pixels) from cubic contours, each cubic sampled in STEPS. */
function polygonsOf(contours, scaleX = 1, scaleY = 1) {
  return contours.filter((contour) => contour.segments.length).map((contour) => {
    let at = contour.start;
    const points = [[at[0] * scaleX, at[1] * scaleY]];
    for (const { c1, c2, end } of contour.segments) {
      for (let step = 1; step <= STEPS; step += 1) {
        const t = step / STEPS;
        const value = (axis) => (1 - t) ** 3 * at[axis] + 3 * (1 - t) ** 2 * t * c1[axis] + 3 * (1 - t) * t ** 2 * c2[axis] + t ** 3 * end[axis];
        points.push([value(0) * scaleX, value(1) * scaleY]);
      }
      at = end;
    }
    return points;
  });
}

/** A layer as drawn at `time`, a text sized to its words. */
export function drawnState(layer, time, fonts) {
  const state = { ...layer, ...evaluateLayer(layer, time), type: layer.type };
  return layer.type === "text" ? resizeTextLayer(state, fonts) : state;
}

/**
 * The ink of `layer` at `time`: {state, inside(x, y), best {x, y, need} | null, letters (text:
 * each letter's best point), measured (false when its see-through parts are not known)}.
 * need is the scale (of the layer at scale 1) at which the frame, centered on best, is all ink.
 */
export function subjectInk(layer, { layers, time, fonts, frame, alpha }) {
  const state = drawnState(layer, time, fonts);
  const { width, height } = state;
  const whole = () => {
    const inside = (x, y) => x >= 0 && y >= 0 && x <= width && y <= height;
    const best = { x: width / 2, y: height / 2, need: coverScale(inside, width / 2, height / 2, frame, 1) };
    return { inside, best };
  };
  if (layer.type === "text") {
    const units = textUnits(layoutText(state, fonts), "letters").filter((unit) => unit.text.trim());
    const glyphs = units.flatMap((unit) => unit.glyphs);
    const tests = glyphs.map(glyphInside);
    const letters = units.map((unit) => unit.glyphs.map((glyph) => inkPoint(glyph, frame)).filter(Boolean).sort((a, b) => a.need - b.need)[0] ?? null);
    const best = letters.filter(Boolean).sort((a, b) => a.need - b.need)[0] ?? null;
    return { state, letters, best, inside: (x, y) => tests.some((test) => test(x, y)), measured: true };
  }
  if (layer.type === "path" || layer.type === "rectangle" || layer.type === "ellipse" || layer.type === "star") {
    // A path drawn as a line only (no fill) has no inside to push into: its box stands in.
    if (layer.type === "path" && (state.fillEnabled === false || !String(state.path ?? "").trim())) return { state, ...whole(), measured: false };
    const bounds = state.pathBounds;
    const contours = layer.type === "path" ? parsePath(state.path) : shapeContours(layer.type, state);
    const scaleX = layer.type === "path" && bounds?.width > 0 ? width / bounds.width : 1;
    const scaleY = layer.type === "path" && bounds?.height > 0 ? height / bounds.height : 1;
    const { best, inside } = outlineInk(polygonsOf(contours, scaleX, scaleY), frame);
    return { state, best, inside, measured: true };
  }
  if (layer.type === "image") {
    const grid = alpha?.(state.src) ?? null;
    if (!grid) return { state, ...whole(), measured: false };
    return { state, ...gridInk(grid, width, height, frame), measured: true };
  }
  if (layer.type === "group") {
    // Each part through its own place and scale (about its center) in the group's pixels.
    const parts = layers.filter((entry) => entry.parentId === layer.id && entry.type !== "audio" && entry.visible !== false && !entry.isMask).map((child) => {
      const ink = subjectInk(child, { layers, time, fonts, frame, alpha });
      const { x, y, width: w, height: h, scaleX = 1, scaleY = 1, rotation = 0 } = ink.state;
      const toGroup = (p) => ({ x: x + w / 2 + (p.x - w / 2) * scaleX, y: y + h / 2 + (p.y - h / 2) * scaleY });
      const toPart = (px, py) => [w / 2 + (px - x - w / 2) / (scaleX || 1), h / 2 + (py - y - h / 2) / (scaleY || 1)];
      const turned = Math.abs(rotation) > 0.01;
      return {
        measured: ink.measured && !turned,
        inside: turned ? () => false : (px, py) => ink.inside(...toPart(px, py)),
        best: !turned && ink.best ? { ...toGroup(ink.best), need: ink.best.need / Math.min(Math.abs(scaleX), Math.abs(scaleY)) } : null,
      };
    });
    const best = parts.map((part) => part.best).filter(Boolean).sort((a, b) => a.need - b.need)[0] ?? null;
    return { state, best, inside: (px, py) => parts.some((part) => part.inside(px, py)), measured: parts.every((part) => part.measured) };
  }
  return { state, ...whole(), measured: layer.type === "video" };
}
