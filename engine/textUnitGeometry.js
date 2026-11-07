import { textUnits } from "./textLayout.js";

const UNIT_MODES = new Set(["layer", "letters", "words", "lines"]);
const cachedUnits = new WeakMap();

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function extentBox() {
  return { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
}

function addX(box, first, second = first) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return;
  box.left = Math.min(box.left, first, second);
  box.right = Math.max(box.right, first, second);
}

function addY(box, first, second = first) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return;
  box.top = Math.min(box.top, first, second);
  box.bottom = Math.max(box.bottom, first, second);
}

function addRect(box, x, y, width, height) {
  if (![x, y, width, height].every(Number.isFinite)) return;
  addX(box, x, x + width);
  addY(box, y, y + height);
}

function addGlyph(box, glyph) {
  const x = finite(glyph.x);
  const y = finite(glyph.y);
  const advance = finite(glyph.advance);
  addX(box, x, x + advance);
  if (glyph.bounds) {
    addRect(
      box,
      x + finite(glyph.bounds.x),
      y + finite(glyph.bounds.y),
      finite(glyph.bounds.width),
      finite(glyph.bounds.height),
    );
  }
}

function addLineCell(box, layout, line, includeAdvance = false) {
  const lineHeight = finite(layout.lineHeight);
  const ascent = finite(line.ascent);
  const descent = finite(line.descent);
  const baseline = finite(line.y);
  const leading = (lineHeight - ascent - descent) / 2;
  addY(box, baseline - ascent - leading, baseline + descent + leading);
  if (includeAdvance) {
    const x = finite(line.x);
    addX(box, x, x + finite(line.width));
  }
}

function result(box, emptyX = 0) {
  const left = Number.isFinite(box.left) ? box.left : emptyX;
  const top = Number.isFinite(box.top) ? box.top : 0;
  const right = Number.isFinite(box.right) ? box.right : left;
  const bottom = Number.isFinite(box.bottom) ? box.bottom : top;
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function isWholeLine(unit, line) {
  return unit.sourceStart === line.start && unit.text === line.text;
}

/**
 * The local pivot and clip box of one unit returned by textUnits(layout, mode).
 * Shaped glyph ink and advances are kept together, and text units include their
 * line-height cell so accents and glyph overhang remain inside the box.
 */
export function textUnitBounds(layout, unit) {
  if (!layout || typeof layout !== "object" || !Array.isArray(layout.lines))
    throw new TypeError("layout must be a text layout");
  if (!unit || typeof unit !== "object" || !Array.isArray(unit.glyphs))
    throw new TypeError("unit must come from textUnits(layout, mode)");

  const box = extentBox();
  const layerUnit = unit.sourceEnd === Infinity;
  if (layerUnit) {
    addRect(box, 0, 0, finite(layout.width), finite(layout.height));
    for (const line of layout.lines) addLineCell(box, layout, line, true);
    for (const glyph of unit.glyphs) addGlyph(box, glyph);
    return result(box);
  }

  const line = Number.isInteger(unit.lineIndex) ? layout.lines[unit.lineIndex] : null;
  if (line) {
    addLineCell(box, layout, line, isWholeLine(unit, line));
    for (const glyph of unit.glyphs) addGlyph(box, glyph);
    return result(box, finite(line.x));
  }

  // textUnits() layer units have an infinite end; any other unit without a line
  // index is malformed, but a finite empty rectangle is safer than NaN geometry.
  return result(box);
}

function unitsFor(layout, mode) {
  let byMode = cachedUnits.get(layout);
  if (!byMode) {
    byMode = new Map();
    cachedUnits.set(layout, byMode);
  }
  if (!byMode.has(mode)) byMode.set(mode, textUnits(layout, mode));
  return byMode.get(mode);
}

/**
 * Find the source-range unit that owns a drawing unit, even when its animated
 * layout wrapped differently from this layout. Returns null for source gaps
 * such as spaces removed at a wrapped line break.
 */
export function textUnitGroup(layout, drawingUnit, mode) {
  if (!layout || typeof layout !== "object" || !Array.isArray(layout.lines))
    throw new TypeError("layout must be a text layout");
  if (!UNIT_MODES.has(mode)) throw new RangeError("mode must be layer, letters, words, or lines");

  const units = unitsFor(layout, mode);
  if (mode === "layer") {
    const unit = units[0];
    return { unit, index: 0, count: 1, bounds: textUnitBounds(layout, unit) };
  }

  const sourceStart = Number(drawingUnit?.sourceStart);
  if (!Number.isFinite(sourceStart)) return null;
  let low = 0, high = units.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (units[middle].sourceStart <= sourceStart) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  if (index < 0 || sourceStart >= units[index].sourceEnd) return null;
  const unit = units[index];
  return { unit, index, count: units.length, bounds: textUnitBounds(layout, unit) };
}
