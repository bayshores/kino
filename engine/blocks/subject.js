// A move's subject (ctx.subject): what a move pushes into, sweeps or hits, given as plain words or
// as one of your layers (text, picture, clip, path, rectangle, ellipse, star or group).
// It answers what every move needs to know about it at one time:
//   kind       "words", "text", "image", "video", "path", "shape" or "group"
//   layer      the layer (null for words); type is its layer type (rectangle for a shape)
//   box        where it is drawn, in its group's coordinates (scene pixels at the top level),
//              its scale about its center applied, a text's box as its words lay out
//   sceneBox   the box it covers on screen in scene pixels, through every group around it
//   center     the middle of what it draws, in scene pixels; localCenter the same in box's coordinates
//   centerFrom how center was found: "lines" (a text's lines), "path" (a path's outline),
//              "parts" (a group's parts) or "box" (the box's middle: shapes, pictures and clips;
//              a picture's see-through edges are not measured)
//   mask(part, place)  adds a white copy of it as a mask (engine/masking.js: a mask shows the
//              layer above it where it is white) and returns it, or null for words
import { createLayer } from "../model.js";
import { evaluateLayer } from "../animation.js";
import { layoutText, resizeTextLayer } from "../textLayout.js";
import { pathBounds } from "../vectorPath.js";
import { IDENTITY, layerMatrix, multiply, point } from "../geometry.js";

const KINDS = { text: "text", image: "image", video: "video", path: "path", group: "group", rectangle: "shape", ellipse: "shape", star: "shape" };
const WHITE = "#FFFFFF";
// Keeps a picture's or clip's see-through parts and turns every other pixel white (lightness 1).
const WHITEN = Object.freeze({ name: "Mask white", kind: "effect", effect: "hue-saturation", start: 0, duration: 0.001, easing: [0, 0, 1, 1], to: { lightness: 1 }, keepStill: "both" });

const middle = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const union = (boxes) => {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  return { x: left, y: top, width: Math.max(...boxes.map((box) => box.x + box.width)) - left, height: Math.max(...boxes.map((box) => box.y + box.height)) - top };
};
const r2 = (value) => Math.round(value * 100) / 100;
const rounded = (box) => box && { x: r2(box.x), y: r2(box.y), width: r2(box.width), height: r2(box.height) };

/** A layer as drawn at `time`: its own animations, and a text sized to its words. */
function stateOf(layer, time, fonts) {
  const state = { ...layer, ...evaluateLayer(layer, time), type: layer.type };
  return layer.type === "text" ? resizeTextLayer(state, fonts) : state;
}

/** The matrix from a layer's own pixels to the scene: its groups' and its own transforms at `time`. */
function toScene(layer, layers, time, fonts) {
  const chain = [];
  for (let at = layers.find((entry) => entry.id === layer.parentId); at; at = layers.find((entry) => entry.id === at.parentId)) chain.unshift(at);
  return [...chain, layer].reduce((matrix, entry) => multiply(matrix, layerMatrix(stateOf(entry, time, fonts))), IDENTITY);
}

/** The axis-aligned box a local box covers once `matrix` maps it. */
function mapped(matrix, box) {
  const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]].map(([x, y]) => point(matrix, x, y));
  return union(corners.map((corner) => ({ x: corner.x, y: corner.y, width: 0, height: 0 })));
}

/** What a layer draws, in its own pixels: a text's lines, a path's outline, or null for its whole box. */
function inkOf(state, fonts) {
  if (state.type === "text") {
    const lines = layoutText(state, fonts).lines.filter((line) => line.width > 0);
    return union(lines.map((line) => ({ x: line.x, y: line.y - line.ascent, width: line.width, height: line.ascent + line.descent })));
  }
  if (state.type === "path" && String(state.path ?? "").trim()) {
    const ink = pathBounds(state.path);
    const bounds = state.pathBounds;
    const sx = bounds?.width > 0 ? state.width / bounds.width : 1;
    const sy = bounds?.height > 0 ? state.height / bounds.height : 1;
    return { x: ink.x * sx, y: ink.y * sy, width: ink.width * sx, height: ink.height * sy };
  }
  return null;
}

/** The scene box of what a layer and its parts draw (groups: their parts' union). */
function drawnBox(layer, layers, time, fonts, seen = new Set()) {
  if (seen.has(layer.id)) return null;
  seen.add(layer.id);
  if (layer.type === "group") {
    return union(layers.filter((entry) => entry.parentId === layer.id && entry.type !== "audio" && entry.visible !== false && !entry.isMask)
      .map((entry) => drawnBox(entry, layers, time, fonts, seen)).filter(Boolean));
  }
  const state = stateOf(layer, time, fonts);
  return mapped(toScene(layer, layers, time, fonts), inkOf(state, fonts) ?? { x: 0, y: 0, width: state.width, height: state.height });
}

/** A copy of a layer as it is at `time`, white where it draws, with no animations or move record. */
function whiteCopy(layer, time, fonts) {
  const { id, name, animations, parentId, move, shadow, isMaskGroup, textStyleRanges, ...rest } = stateOf(layer, time, fonts);
  const copy = { ...rest, opacity: 1, blendMode: "normal", blur: 0, role: "decor", allowOverlap: true };
  if (layer.type === "group") return createLayer("group", { ...copy, isMaskGroup: isMaskGroup ?? false });
  if (layer.type === "image" || layer.type === "video") return createLayer(layer.type, { ...copy, volume: 0 });
  // Sizes, fonts and spacing of styled words stay (the letters line up); their colors go.
  const ranges = (textStyleRanges ?? []).map(({ start, end, style: { fill, ...style } }) => ({ start, end, style })).filter((range) => Object.keys(range.style).length);
  return createLayer(layer.type, { ...copy, fill: WHITE, ...(copy.strokeWidth > 0 ? { stroke: WHITE } : {}), ...(ranges.length ? { textStyleRanges: ranges } : {}) });
}

/**
 * The subject of a move. `input` is a layer ID, a layer, or {text} (plain words the move lays
 * out itself). `field` names the move field it came from (for messages); `at` is the time its
 * box is read at (the move's start by default). `ctx` is the move's context (ctx.layer finds and
 * checks the layer, ctx.add adds the mask); `layers` are the scene's layers.
 */
export function subjectOf(ctx, layers, input, { field = "layer", at = ctx.start } = {}) {
  if (input && typeof input === "object" && !Array.isArray(input) && typeof input.text === "string" && !("id" in input)) {
    const text = input.text.trim();
    if (!text) throw new Error(`${ctx.move} ${field}: give the words, or one of your layers.`);
    return { kind: "words", text, layer: null, type: null, box: null, sceneBox: null, center: null, localCenter: null, centerFrom: null, mask: () => null };
  }
  const id = typeof input === "string" ? input : input?.id;
  if (typeof id !== "string") throw new Error(`${ctx.move} ${field}: give a layer, or {text} for plain words.`);
  const layer = ctx.layer(id, field);
  const kind = KINDS[layer.type];
  if (!kind) throw new Error(`${ctx.move} ${field}: ${layer.id} is a ${layer.type}; give a text, picture, clip, path, shape or group layer.`);
  if (layer.isMask) throw new Error(`${ctx.move} ${field}: ${layer.id} is a mask; give the layer it masks or the mask group.`);
  const state = stateOf(layer, at, ctx.fonts);
  const width = state.width * Math.abs(state.scaleX ?? 1);
  const height = state.height * Math.abs(state.scaleY ?? 1);
  const box = { x: state.x + (state.width - width) / 2, y: state.y + (state.height - height) / 2, width, height };
  const matrix = toScene(layer, layers, at, ctx.fonts);
  const sceneBox = mapped(matrix, { x: 0, y: 0, width: state.width, height: state.height });
  const ink = layer.type === "group" ? drawnBox(layer, layers, at, ctx.fonts) : (() => {
    const local = inkOf(state, ctx.fonts);
    return local && mapped(matrix, local);
  })();
  const centerFrom = ink ? { text: "lines", path: "path", group: "parts" }[layer.type] : "box";
  const center = middle(ink ?? sceneBox);
  // The same point in the box's coordinates (its group's): the scene point less the group's transform.
  const parent = layer.parentId ? toScene(layers.find((entry) => entry.id === layer.parentId), layers, at, ctx.fonts) : IDENTITY;
  const [a, b, c, d, e, f] = parent;
  const det = a * d - b * c || 1;
  const localCenter = { x: (d * (center.x - e) - c * (center.y - f)) / det, y: (a * (center.y - f) - b * (center.x - e)) / det };
  return {
    kind, layer, type: layer.type, box: rounded(box), sceneBox: rounded(sceneBox),
    center: { x: r2(center.x), y: r2(center.y) }, localCenter: { x: r2(localCenter.x), y: r2(localCenter.y) }, centerFrom,
    /**
     * Adds a white copy of the subject as it is at `at` as a mask (isMask), placed by `place`
     * (default just below the subject, in its group). A group's copy holds white copies of its
     * parts. The copy has no animations: the move animates it. Returns the mask layer.
     */
    mask(part, place = { below: layer.id }) {
      const whiten = (made, source) => { if (source.type === "image" || source.type === "video") ctx.animate(made, "white", { ...WHITEN, easing: [...WHITEN.easing], to: { ...WHITEN.to } }); return made; };
      const top = whiten(ctx.add(part, { ...whiteCopy(layer, at, ctx.fonts), isMask: true }, place), layer);
      if (layer.type === "group") {
        let count = 0;
        const copyParts = (groupId, into) => {
          for (const child of layers.filter((entry) => entry.parentId === groupId && entry.type !== "audio")) {
            count += 1;
            const made = whiten(ctx.add(`${part}-${count}`, { ...whiteCopy(child, at, ctx.fonts), isMask: child.isMask === true }, "top", into), child);
            if (child.type === "group") copyParts(child.id, made);
          }
        };
        copyParts(layer.id, top);
      }
      return top;
    },
  };
}
