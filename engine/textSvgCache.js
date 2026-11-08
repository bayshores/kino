// Text drawing that render.js remembers from one frame to the next.
//
// layoutText (textLayout.js) keeps one layout object for each text, size, font, font registry
// version and so on, so the same layout object always holds the same glyphs in the same places.
// Anything worked out from a layout alone can be remembered for that object and reused: which
// glyphs a unit (a letter, word or line, or the whole layer) draws, their bounds, and their
// <path> markup for one paint. Text that holds still, or only moves, turns, scales or fades,
// keeps its layout from frame to frame.
//
// How long entries are kept:
// - Within one drawing (one renderSceneSvg call), every layout's entries are shared, so a
//   layer's bounds and its paths, or two copies of the same text, are worked out once.
// - Once a second drawing uses a layout, its entries are kept for later drawings too, until the
//   layout itself goes away (a WeakMap). Text whose size, letter spacing or line height
//   animates gets a new layout on every frame; keeping those would only fill memory.
// - A layout keeps at most MAX_ENTRIES_PER_LAYOUT entries and starts over when it has more: a
//   fill color that animates makes a new entry on every frame.
import { stackedStrokes } from "./stackedStrokes.js";
import { isFillEnabled } from "./paints.js";

const MAX_ENTRIES_PER_LAYOUT = 256;
const keptEntries = new WeakMap(); // layout → Map(key → value), once two drawings used it
const firstDrawingOf = new WeakMap(); // layout → number of the first drawing that used it
let currentDrawing = null;
let drawingNumber = 0;
let currentDrawingEntries = new Map(); // layout → Map(key → value), for layouts new in this drawing

function entriesFor(layout, drawing) {
  if (drawing !== currentDrawing) {
    currentDrawing = drawing;
    drawingNumber += 1;
    currentDrawingEntries = new Map();
  }
  let entries = keptEntries.get(layout);
  if (entries) return entries;
  const first = firstDrawingOf.get(layout);
  if (first === undefined || first === drawingNumber) {
    if (first === undefined) firstDrawingOf.set(layout, drawingNumber);
    entries = currentDrawingEntries.get(layout);
    if (!entries) currentDrawingEntries.set(layout, entries = new Map());
    return entries;
  }
  entries = new Map();
  keptEntries.set(layout, entries);
  return entries;
}

/**
 * The value for `key` on `layout`, made with `make()` unless one is remembered.
 * `drawing` is any object that is the same for the whole of one drawing and new for the next.
 */
export function rememberForLayout(layout, drawing, key, make) {
  const entries = entriesFor(layout, drawing);
  if (entries.has(key)) return entries.get(key);
  const value = make();
  if (entries.size >= MAX_ENTRIES_PER_LAYOUT) entries.clear();
  entries.set(key, value);
  return value;
}

const isObject = (value) => value !== null && typeof value === "object";

/**
 * Everything render.js textGlyphPaths reads from the text's state and drawing options, as one
 * string, so glyph markup can be remembered per paint. Null when the paint adds <defs>: a
 * gradient fill or stroke, or a stroke drawn inside or outside the outline. Those get new ids
 * on every drawing, so they are always drawn fresh. (A plain paint does not use the text box
 * size, which only places gradients.) Keep this in step with textGlyphPaths and paintedVector.
 */
export function plainPaintKey(state, context) {
  const fillOn = isFillEnabled(state);
  if (fillOn && isObject(state.fill)) return null;
  const strokeWidth = Number(state.strokeWidth);
  const stroked = Number.isFinite(strokeWidth) && strokeWidth > 0;
  if (stroked && (isObject(state.stroke) || (state.strokeAlign ?? "center") !== "center")) return null;
  // A stacked stroke list (stackedStrokes.js) is remembered too, unless one adds a clip or mask.
  const strokes = stackedStrokes(state);
  if (strokes.some((stroke) => (stroke.align ?? "center") !== "center")) return null;
  const key = [fillOn, state.fill, state.stroke, state.strokeWidth, state.strokeAlign, Boolean(context.canvas)];
  return JSON.stringify(strokes.length ? [...key, strokes] : key);
}
