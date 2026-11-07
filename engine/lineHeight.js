// Line height, saved as a multiple of the font size.
//
// A text layer's `lineHeight` of 1.2 on 40 px text puts the lines 1.2 × 40 = 48 px apart
// (textLayout.js). Design and Animate show that multiple as a percentage (120%). A Line height
// animation changes it over time, so the text block grows taller or shorter: textLayout.js lays
// the text out again on every frame with the animated value, and text that sizes its own height
// grows and shrinks with it.
//
// The panel shows the multiplier as a percentage (120%); kino keeps the multiplier itself in
// documents and MCP.

/** The smallest and largest line height a layer or a Line height animation can save. */
export const LINE_HEIGHT_MIN = 0.01;
export const LINE_HEIGHT_MAX = 100;

/** The line height of a new text layer, and of text whose line height is not a number. */
export const DEFAULT_LINE_HEIGHT = 1.2;

/** UI values and edits are percentages; the stored multiplier is unchanged. */
export const LINE_HEIGHT_FIELD = Object.freeze({
  min: LINE_HEIGHT_MIN * 100, max: LINE_HEIGHT_MAX * 100, step: 1, suffix: "%",
});

/** How much taller a new Line height animation makes the lines: To = the current value + 0.4. */
export const LINE_HEIGHT_PRESET_STEP = 0.4;

/**
 * The line height text is laid out with: at least 0.01. A number is kept (an animated value can
 * pass below 0.01, or reach 0, with an overshooting easing such as Elastic); anything else is
 * the default 1.2.
 */
export function layoutLineHeight(lineHeight) {
  if (typeof lineHeight === "number" && Number.isFinite(lineHeight)) return Math.max(LINE_HEIGHT_MIN, lineHeight);
  return Math.max(LINE_HEIGHT_MIN, Number(lineHeight) || DEFAULT_LINE_HEIGHT);
}

/** The distance in pixels from one line to the next: the line height times `fontSize`. */
export function lineHeightPixels(lineHeight, fontSize) {
  return layoutLineHeight(lineHeight) * fontSize;
}

/** The To value of a new Line height animation: the layer's line height + 0.4, at most 100. */
export function lineHeightPresetTo(layer) {
  const current = typeof layer?.lineHeight === "number" && Number.isFinite(layer.lineHeight)
    ? layer.lineHeight
    : DEFAULT_LINE_HEIGHT;
  return Math.min(LINE_HEIGHT_MAX, Math.round((current + LINE_HEIGHT_PRESET_STEP) * 1e6) / 1e6);
}
