// split-fields: the shot is shown as two one-hue fields side by side, divided by a rough brush
// edge that drifts a little while the move plays. Built the way the hand-made version was (the
// grade-bloom-flash technique study): two copies of the shot, each with a duotone that first
// stretches the shot's own light range (normalize), the second one masked by a big rectangle whose
// edge is roughened (shapeModifiers.js roughen) and boils on twos.
// Defaults and where they come from:
// - colors #3BEA7A and #E0308F: the reference edit's green highlights and magenta shadows.
// - dark field: shadows 78% toward black (#0D331B, the reference's #0D3B2C), contrast 1.2 (the
//   study's green grade); light field: highlights 88% toward white (#FBE6F2, the reference's
//   #F8E6EE), midpoint 0.45 and contrast 2 (the study's final pink duotone).
// - travel 0.15 of the frame width and angle 8 degrees: the study's final edge tilt and the
//   synthesis treatment (travel 0.15). length 0.5 s: the study's split ran 0.5 s.
// - edge size 44 px at 1080, detail 0.7, boil 12 a second, blur 1.5 px: guesses tuned by eye in
//   two rounds on the study's frames against one reference still (30 px read as small saw teeth);
//   not measured.
// Reduced motion: the edge holds still (no travel, no boil).
import { createLayer } from "../../model.js";
import { CURVES, effect, hide, motion, round, show } from "./kit.js";

const EDGES = ["brush", "straight"];
const DEFAULT_COLORS = Object.freeze(["#3BEA7A", "#E0308F"]);

function mix(hex, toward, share) {
  const value = parseInt(hex.slice(1, 7), 16), end = toward === "white" ? 255 : 0;
  const channel = (shift) => Math.round(((value >> shift) & 255) * (1 - share) + end * share);
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** The duotone of a field: the first is dark (its color in the highlights), the second light. */
export function fieldTone(color, dark) {
  return dark ? { shadowColor: mix(color, "black", 0.78), highlightColor: color, midpoint: 0.5, contrast: 1.2, normalize: true }
    : { shadowColor: color, highlightColor: mix(color, "white", 0.88), midpoint: 0.45, contrast: 2, normalize: true };
}

export const splitFields = {
  name: "split-fields",
  needsAt: true,
  nested: ["layer"],
  about: "the shot splits into two one-hue fields (a dark and a light duotone of the same picture) divided by a rough brush edge that drifts a little; a two-color split, opposed color fields",
  fits: "a clash, a turn, two sides of one moment; 0.3 to 1 s on a full-frame shot",
  tags: ["mask-wipe"],
  length: 0.5,
  shortest: 0.1,
  fields: {
    layer: { kind: "layer", required: true, about: "the shot (a full-frame clip or picture); two graded copies of it are drawn over it while the move plays" },
    colors: { kind: "colors", min: 2, most: 2, about: "[left, right] field colors, hex: the left is a dark field (its color in the highlights), the right a light one (its color in the shadows) (default [\"#3BEA7A\", \"#E0308F\"])" },
    edge: { kind: "choice", values: EDGES, about: "brush (a rough, boiling dry-brush edge, default) or straight" },
    split: { kind: "number", low: 0, high: 100, about: "where the edge sits halfway through, % of the frame width (default 50)" },
    travel: { kind: "number", low: -1, high: 1, about: "how far the edge drifts over the move, share of the frame width; above 0 it moves left, below 0 right (default 0.15)" },
    angle: { kind: "number", low: -45, high: 45, about: "the edge's tilt from vertical, degrees (default 8)" },
    roughness: { kind: "number", low: 0, high: 200, about: "how far the brush teeth reach, px at 1080 tall (default 44)" },
    boil: { kind: "number", low: 0, high: 30, about: "new teeth this many times a second (default 12: on twos; 0 holds them still)" },
  },
  example: { layer: "shot-a", at: 1, colors: ["#3BEA7A", "#E0308F"] },
  setup: "shot-a, a full-frame picture",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const t = ctx.start, length = ctx.duration;
    const { width, height } = ctx.frame;
    const [left, right] = input.colors ?? DEFAULT_COLORS;
    const here = ctx.stateAt(layer.id, t);
    const { id: _id, name: _name, animations: _animations, move: _move, parentId: _parent, ...look } = layer;
    const place = { x: here.x ?? layer.x, y: here.y ?? layer.y, scaleX: here.scaleX ?? layer.scaleX ?? 1, scaleY: here.scaleY ?? layer.scaleY ?? 1 };
    const copy = (part, color, dark, where) => {
      const made = ctx.add(part, createLayer(layer.type, { ...look, ...place, name: `${dark ? "Dark" : "Light"} field`, role: "decor", allowOverlap: true, ...(layer.type === "video" ? { volume: 0 } : {}) }), where);
      ctx.animate(made, "tone", effect({ name: "Field tone", effect: "duotone", start: t, duration: length, easing: CURVES.fade, to: fieldTone(color, dark) }));
      ctx.animate(made, "show", show(t));
      ctx.animate(made, "hide", hide(t + length));
      return made;
    };
    const darkField = copy("dark", left, true, { above: layer.id });
    const lightField = copy("light", right, false, { above: darkField.id });
    // The mask: a rectangle far larger than the frame whose left edge passes through the split
    // point, turned by the angle about its own center (so the center sits off the edge).
    const turn = ((input.angle ?? 8) * Math.PI) / 180;
    const boxWidth = Math.round(width * 2.4), boxHeight = Math.round(height * 2.4 + width * Math.abs(Math.sin(turn)));
    const edgeAt = (x) => ({ x: round(x + (boxWidth / 2) * Math.cos(turn) - boxWidth / 2, 1), y: round(height / 2 + (boxWidth / 2) * Math.sin(turn) - boxHeight / 2, 1) });
    const middle = (width * (input.split ?? 50)) / 100;
    const drift = ctx.reduced ? 0 : ((input.travel ?? 0.15) * width) / 2;
    const brush = (input.edge ?? "brush") === "brush";
    const rough = brush ? {
      roughenSize: round((input.roughness ?? 44) * ctx.scale, 1), roughenDetail: 0.7, roughenSeed: ctx.rng.pick([3, 7, 11, 19, 29, 41]),
      ...(ctx.reduced ? {} : { roughenBoil: input.boil ?? 12 }), blur: round(1.5 * ctx.scale, 1),
    } : {};
    const mask = ctx.add("mask", createLayer("rectangle", { name: "Split edge", ...edgeAt(middle + drift), width: boxWidth, height: boxHeight, rotation: round(input.angle ?? 8, 2),
      fill: "#FFFFFF", isMask: true, role: "decor", ...rough }), { below: lightField.id });
    if (drift) ctx.animate(mask, "drift", motion({ name: "Edge drift", start: t, duration: length, easing: CURVES.drift, from: edgeAt(middle + drift), to: edgeAt(middle - drift) }));
    ctx.animate(mask, "show", show(t));
    ctx.animate(mask, "hide", hide(t + length));
    return { end: round(t + length), tags: splitFields.tags };
  },
};
