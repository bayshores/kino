// mosaic-reveal: a picture or clip builds out of flat-colored cells (each the picture's mean color
// there) that arrive in an order, merge into coarser blocks and resolve to the clean picture by the
// end; mode out runs it backwards as an exit. One call drives the mosaic effect's progress
// (engine/effects/mosaic.js, where every default's source is written down).
//
// Defaults from the reference (.scratch/recreate/product-film, GAPS item 13):
//   dur 4 s       the reference reveal runs from the cut at f122 to the clean photo at f222 (25 fps).
//   cell 30, gap 9, radius 2, order clusters, dots 2, merges 2: see mosaic.js. Cell, gap and radius
//                 are for a 1080 px short side and scale with the frame (the reference is 1080p).
//   ease linear   cells arrived at an even rate in the reference (f125 to f175).
import { effect, round } from "./kit.js";
import { shared, curveOf } from "../move.js";
import { MOSAIC_ORDERS } from "../../effects/mosaic.js";

export const mosaicReveal = {
  name: "mosaic-reveal",
  needsAt: true,
  about: "a picture builds out of flat-colored cells that merge into blocks and resolve to it",
  fits: "a photo appearing beside spec text, a reveal out of pixels",
  tags: ["mask-wipe"],
  length: 4,
  shortest: 0.3,
  fields: {
    layer: { kind: "layer", required: true, about: "the picture or clip that builds out of cells" },
    cell: { kind: "number", low: 4, high: 128, whole: true, about: "cell pitch in px (default 30 on a 1080p frame; cell, gap and radius scale with the frame's short side)" },
    gap: { kind: "number", low: 0, high: 64, about: "gap between cells and blocks in px (default 9; 0 no gaps)" },
    order: { kind: "choice", values: [...MOSAIC_ORDERS], aliases: { "center-out": "center", clustered: "clusters" }, about: "the order cells arrive: clusters (default: clumps that grow), random, sweep (along angle) or center (out from the middle)" },
    ...shared({ angle: "the sweep direction in degrees for order sweep: 0 left to right, 90 top to bottom (default 0)" }, { ease: "how progress runs over dur (default linear)" }),
    radius: { kind: "number", low: 0, high: 64, about: "cell corner radius in px (default 2)" },
    merges: { kind: "number", low: 0, high: 2, whole: true, about: "merge steps before the picture resolves: 2 (default: 2x2 then 4x4 blocks), 1, or 0 (cells resolve straight to the picture)" },
    dots: { kind: "number", low: 0, high: 4, whole: true, about: "small dots per cell side shown just before a cell arrives (default 2; 0 none)" },
    outline: { kind: "color", about: "fill the gaps of shown cells with this hex color (default none: what is behind shows)" },
    mode: { kind: "choice", values: ["in", "out"], about: "in (default: builds from nothing to the picture) or out (the picture breaks into cells and goes)" },
    seed: { kind: "number", low: 0, high: 100000, whole: true, about: "another whole number gives another cell order (default the move's seed)" },
  },
  example: { layer: "shot-a", at: 0.5 },
  setup: "shot-a, a full-frame picture",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const out = input.mode === "out";
    // The measured sizes are for a frame 1080 px on its short side; other frames scale them, so a
    // 720p or 4K edit gets the same number of cells across (a 1080 x 1920 frame keeps 30).
    const k = Math.min(ctx.frame.width, ctx.frame.height) / 1080 || 1;
    const sized = (value) => Math.round(value * k * 2) / 2;
    const to = {
      cell: input.cell ?? Math.max(4, Math.round(30 * k)), gap: input.gap ?? sized(9), radius: input.radius ?? sized(2), order: input.order ?? "clusters",
      angle: input.angle ?? 0, merges: input.merges ?? 2, dots: input.dots ?? 2,
      seed: input.seed ?? Math.floor(ctx.rng.next() * 1000),
      ...(input.outline ? { outline: 1, outlineColor: input.outline } : {}),
    };
    const easing = input.ease ? curveOf(input.ease) : [0, 0, 1, 1];
    // keepStill both: before the start the from value holds (hidden for in, whole for out), after
    // the end the to value (whole for in, hidden for out).
    ctx.animate(layer.id, out ? "out" : "in", effect({ name: out ? "Mosaic out" : "Mosaic reveal", effect: "mosaic", start: ctx.start, duration: ctx.duration, easing,
      from: { progress: out ? 1 : 0 }, to: { ...to, progress: out ? 0 : 1 }, keepStill: "both" }), "layer");
    ctx.note(`mosaic-reveal ${layer.id}: ${to.cell} px cells, gap ${to.gap}, ${to.order}, ${out ? "out" : "in"} over ${round(ctx.duration)} s`);
    return { end: round(ctx.end), tags: mosaicReveal.tags };
  },
};
