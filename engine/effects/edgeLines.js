// Edge lines: the layer's contours drawn as thin lines, found from its brightness. Works on a
// video or image (the line art of a face, a hand, a scene), and on anything drawn.
//
// How the SVG filter works, step by step:
// 1. Brightness: the picture as grays (alpha made whole, so transparent parts read as black).
// 2. Smooth: a small blur (`smooth`), so video compression blocks and grain do not become lines.
// 3. Difference: the gray picture against a copy shifted one pixel right, and against one shifted
//    one pixel down (feBlend "difference" is |a - b|), added together: a bright line wherever
//    the brightness changes. The shift is in layer pixels, so the lines keep their weight when a
//    layer is scaled or exported at a higher density.
// 4. Threshold: a ramp that keeps changes above `threshold` and fades the weaker ones in
//    (softness 0.5 of the threshold, then 6 times as steep as the raw step), so lines are
//    anti-aliased, not on or off.
// 5. Width: the lines grown by (width - 1) / 2 px.
// 6. Color: `color` shaped by those lines, only where the layer has pixels (a cut-out subject
//    gets lines on itself, not in the empty frame around it).
// 7. Background: "keep" (default) lays the lines over the picture, which `dim` darkens first
//    (0 leaves it as it is, 1 is black) so the lines read: one call on a clip gives the study's
//    dark figure with line art, with no separate grade (a dark grade before this effect hides
//    the edges from step 3). "transparent" is the lines alone, over whatever is under the layer.
//
// Defaults come from the glow-outline study (.scratch/studies/glow-outline, interior line art
// about 4 px thick at 1920 in the reference, lines in one color on a dark figure). The first
// defaults (width 2, threshold 0.1) found only the face's outer contour on the study's dark
// 1080p frame, about 1 px and faint; a skeptic re-run of width 3 with threshold 0.04, 0.05 and
// 0.06 (after-edge-lines-skeptic) picked width 3, threshold 0.05: brows, eyes, mouth, ears and
// scarf folds as single lines at about the reference's weight, little speckle. dim 0.7 sits
// between the study's -3 stop grade (0.875) and a picture that still reads (a guess); smooth 1
// and the ramp are guesses. Color defaults to white: the one color that reads on any dark picture
// (the dim only darkens the picture under it); a color the agent gives is kept as given.
import { filterEffect } from "./svg.js";
import { numberParameter } from "./periodicDisplacement.js";
import { hexColor } from "./glow.js";

export const EDGE_LINES_BACKGROUNDS = Object.freeze(["transparent", "keep"]);

const fmt = (value) => {
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

export function renderEdgeLines(frame) {
  const width = numberParameter(frame, "width", 3, 0.5, 12);
  const given = numberParameter(frame, "threshold", 0.05, 0, 1);
  const smooth = numberParameter(frame, "smooth", 1, 0, 8);
  const dim = numberParameter(frame, "dim", 0.7, 0, 1);
  const background = EDGE_LINES_BACKGROUNDS.includes(frame?.parameters?.background) ? frame.parameters.background : "keep";
  const rgb = hexColor(frame, "color", "#FFFFFF");
  // 1. Gray picture with whole alpha.
  const steps = [`<feColorMatrix in="SourceGraphic" type="matrix" values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 0 1" result="edgeGray"/>`];
  let gray = "edgeGray";
  // 1b. Adapt: the grays are lifted by a power below 1 (1 - 0.6 * adapt, so 0.4 at adapt 1), which
  // spreads the dark end (slope about 4 at 2% gray, 0.6 at 50%), and the threshold falls to 30% of
  // what was given (1 - 0.7 * adapt): a step from 2% to 5% gray (a dark clip, or a picture a grade
  // darkened before this effect) then draws, so `threshold` reads the picture's own contrast and
  // not its brightness. The ceiling studies drew near-black lines on dark clips because the plain
  // difference of two dark grays is under the threshold. 0.6 and 0.7 are guesses, sized so that
  // step draws and a one gray-level step (noise) does not; adapt 0 (the value of effects saved
  // before it existed) is the plain difference at the given threshold.
  const adapt = numberParameter(frame, "adapt", 0, 0, 1);
  const threshold = given * (1 - 0.7 * adapt);
  if (adapt > 0) {
    steps.push(`<feComponentTransfer in="edgeGray" result="edgeLift">${["R", "G", "B"].map((channel) => `<feFunc${channel} type="gamma" amplitude="1" exponent="${fmt(1 - 0.6 * adapt)}" offset="0"/>`).join("")}</feComponentTransfer>`);
    gray = "edgeLift";
  }
  // 2. Smooth.
  if (smooth > 0) {
    steps.push(`<feGaussianBlur in="${gray}" stdDeviation="${fmt(smooth)}" result="edgeSmooth"/>`);
    gray = "edgeSmooth";
  }
  // 3. Difference against copies shifted right and down, added.
  steps.push(`<feOffset in="${gray}" dx="1" dy="0" result="edgeRight"/>`,
    `<feBlend in="${gray}" in2="edgeRight" mode="difference" result="edgeDx"/>`,
    `<feOffset in="${gray}" dx="0" dy="1" result="edgeDown"/>`,
    `<feBlend in="${gray}" in2="edgeDown" mode="difference" result="edgeDy"/>`,
    `<feComposite in="edgeDx" in2="edgeDy" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="edgeSum"/>`);
  // 4. Threshold ramp on the red channel: 0 below `threshold`, rising to 1 over a span of
  // 0.5 * threshold (at least 0.02), then to alpha.
  const span = Math.max(0.02, threshold * 0.5);
  const slope = 1 / span;
  steps.push(`<feComponentTransfer in="edgeSum" result="edgeRamp"><feFuncR type="linear" slope="${fmt(slope)}" intercept="${fmt(-threshold * slope)}"/></feComponentTransfer>`,
    `<feColorMatrix in="edgeRamp" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1 0 0 0 0" result="edgeLine"/>`);
  let lines = "edgeLine";
  // 5. Width: grown by (width - 1) / 2, then a half pixel of blur for the anti-aliased edge.
  const grow = (width - 1) / 2;
  if (grow > 0.25) {
    steps.push(`<feMorphology in="edgeLine" operator="dilate" radius="${fmt(grow)}" result="edgeWide"/>`);
    lines = "edgeWide";
  }
  steps.push(`<feGaussianBlur in="${lines}" stdDeviation="0.5" result="edgeSoft"/>`);
  // 6. Color, kept on the layer's own pixels. On a video or image the box edge is the picture's
  // rectangle, not a contour: the shifted copies and the blur meet the empty padding there and
  // drew a false line along the top and left (glow-outline proof frame), so a strip of
  // 3 x smooth + 2 px along the box is left out. Shapes and text keep their box edge.
  const box = frame.bounds;
  const inset = Math.ceil(3 * smooth) + 2;
  const picture = ["video", "image"].includes(frame?.helpers?.layerType) && box.width > 2 * inset && box.height > 2 * inset;
  steps.push(`<feFlood flood-color="rgb(${rgb.join(",")})" result="edgeColor"/>`,
    `<feComposite in="edgeColor" in2="edgeSoft" operator="in" result="edgeColored"/>`);
  if (picture) steps.push(`<feFlood flood-color="#fff" x="${fmt(box.x + inset)}" y="${fmt(box.y + inset)}" width="${fmt(box.width - 2 * inset)}" height="${fmt(box.height - 2 * inset)}" result="edgeInner"/>`,
    `<feComposite in="edgeColored" in2="edgeInner" operator="in" result="edgeInside"/>`);
  steps.push(`<feComposite in="${picture ? "edgeInside" : "edgeColored"}" in2="SourceAlpha" operator="in" result="edgePaint"/>`);
  // 7. Background.
  if (background === "keep") {
    const keep = 1 - dim;
    steps.push(`<feColorMatrix in="SourceGraphic" type="matrix" values="${keep} 0 0 0 0 0 ${keep} 0 0 0 0 0 ${keep} 0 0 0 0 0 1 0" result="edgeBase"/>`,
      `<feMerge><feMergeNode in="edgeBase"/><feMergeNode in="edgePaint"/></feMerge>`);
  } else steps.push(`<feMerge><feMergeNode in="edgePaint"/></feMerge>`);
  return filterEffect(frame, steps, { padding: Math.ceil(width) + 2 });
}
