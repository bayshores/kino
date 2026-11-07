// build-in: the parts of a real UI come in one by one (the panel is empty for a beat after the
// cut, then each row resolves from a soft blur, top row first, or result rows fade up a few
// pixels, one after another). Made for the pieces split_image cuts
// from a screenshot, so the UI on screen is the product's own pixels, never a redraw.
//
// finish resolve (the default): blur 6 px to sharp, opacity 0.3 to full, a rise of 1% of the
// frame's height, expo-out over 0.4 s (later pieces a little longer), each piece 0.2 s after the
// one before. fade: opacity only (the reduced-motion version). Each piece is hidden until its
// turn; a tall piece settles longer.
import { motion, round, show } from "./kit.js";

// Expo out: fast start, a long soft landing (the rows "settle" rather than slide).
const EXPO_OUT = Object.freeze([0.19, 1, 0.22, 1]);
const BLUR = 6;
const RISE = 0.01;
const FAINT = 0.3;

const timing = (input) => ({ length: round((input.empty ?? 0) + (input.stagger ?? 0.2) * Math.max(0, (input.layers?.length ?? 1) - 1) + (input.each ?? 0.4) * 2) });

export const buildIn = {
  name: "build-in",
  about: "the parts of a real UI (split_image pieces) come in one by one, each resolving from a soft blur as it rises into place",
  fits: "a screenshot built up row by row",
  tags: ["ui-build"],
  length: 1.4,
  timing,
  fields: {
    layers: { kind: "layers", min: 1, most: 40, about: "the pieces, such as split_image's <layer>-<name> layers (inside a group too)" },
    order: { kind: "choice", values: ["top-down", "left-right", "given"], about: "who comes first: top-down (default, by each piece's top edge), left-right, or the order given" },
    stagger: { kind: "number", low: 0, high: 2, about: "seconds between one piece and the next (default 0.2)" },
    finish: { kind: "choice", values: ["resolve", "fade"], about: "resolve: blur 6 to 0, opacity 0.3 to 1, a 1% rise, expo-out (default); fade: opacity only" },
    each: { kind: "number", low: 0.1, high: 2, about: "seconds each piece takes (default 0.4)" },
    empty: { kind: "number", low: 0, high: 3, about: "seconds of empty frame after at before the first piece (a beat after a cut, 0.6); default 0" },
  },
  example: { layers: ["shot-a", "phone"], order: "top-down", stagger: 0.2, finish: "resolve", empty: 0.6, at: 0.3 },
  setup: 'split_image {layer, boxes:[{name, rect}]} first; the pieces are <layer>-<name>',
  build(ctx, input) {
    const pieces = input.layers.map((layerId) => {
      const { layer, top, box } = ctx.inside(layerId, "layers");
      if (layer.type === "audio") throw new Error(`build-in layers: ${layerId} is a sound; give a layer that is drawn.`);
      const topBox = ctx.boxAt(top, ctx.start);
      return { layer, x: topBox.x + box.x, y: topBox.y + box.y };
    });
    if (new Set(pieces.map((piece) => piece.layer.id)).size !== pieces.length) throw new Error("build-in layers: a layer is named twice.");
    const order = input.order ?? "top-down";
    if (order !== "given") {
      // A row a few pixels lower is still the same row: within 2% of the frame, the other axis decides.
      const near = (order === "top-down" ? ctx.frame.height : ctx.frame.width) * 0.02;
      const [main, cross] = order === "top-down" ? ["y", "x"] : ["x", "y"];
      pieces.sort((a, b) => (Math.abs(a[main] - b[main]) > near ? a[main] - b[main] : a[cross] - b[cross]));
    }
    const look = ctx.reduced ? "fade" : input.finish ?? "resolve";
    const stagger = input.stagger ?? 0.2;
    const each = input.each ?? 0.4;
    const first = ctx.start + (input.empty ?? 0);
    const rise = round(ctx.frame.height * RISE, 1);
    const blur = round(BLUR * ctx.scale, 2);
    // A big piece (a camera view over a row of buttons) settles longer than a row: up to 1.6x
    // `each` by the square root of its height over the middle piece's height. On top, each later
    // piece settles 6% longer (up to 1.4x), as rows land in a calm launch film, so equal rows never share one
    // timing (same_motion).
    const heights = pieces.map(({ layer }) => layer.height).sort((a, b) => a - b);
    const middle = heights[Math.floor(heights.length / 2)] || 1;
    let end = first;
    pieces.forEach(({ layer }, index) => {
      const start = round(first + stagger * index);
      const seconds = round(each * Math.min(1.6, Math.max(1, Math.sqrt(layer.height / middle))) * Math.min(1.4, 1 + 0.06 * index));
      const opacity = layer.opacity ?? 1;
      const from = look === "resolve" ? { opacity: round(FAINT * opacity), blur: round((layer.blur ?? 0) + blur, 2), y: round(layer.y + rise, 1) } : { opacity: 0 };
      const to = look === "resolve" ? { opacity, blur: layer.blur ?? 0, y: layer.y } : { opacity };
      ctx.animate(layer.id, "show", show(start), layer.id);
      ctx.animate(layer.id, look, motion({ name: look === "resolve" ? "Resolve" : "Fade in", start, duration: seconds, easing: EXPO_OUT, from, to }), layer.id);
      end = Math.max(end, start + seconds);
    });
    return { end: round(end) };
  },
};
