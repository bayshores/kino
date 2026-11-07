// Frame formats, the safe area, and slots: a 6×6 grid over the safe area.
// Columns are A–F (left to right) and rows 1–6 (top to bottom); "C2:E3" is the box from
// cell C2 to cell E3. Because slots are relative, the same layout fits 16:9, 9:16 and 1:1.
import { SAFE_ZONES } from "../quality/rules/layout.js";

export const GRID = 6;
const COLUMNS = "ABCDEF";

export const FORMATS = Object.freeze({
  "1920x1080": Object.freeze({ width: 1920, height: 1080 }),
  "1080x1920": Object.freeze({ width: 1080, height: 1920 }),
  "1080x1080": Object.freeze({ width: 1080, height: 1080 }),
  "1080x1350": Object.freeze({ width: 1080, height: 1350 }),
});
const FORMAT_ALIASES = {
  "16:9": "1920x1080", landscape: "1920x1080", wide: "1920x1080",
  "9:16": "1080x1920", vertical: "1080x1920", portrait: "1080x1920", story: "1080x1920",
  "1:1": "1080x1080", square: "1080x1080",
  "4:5": "1080x1350",
};

// Named slots for common places, in grid cells.
export const NAMED_SLOTS = Object.freeze({
  full: "A1:F6", center: "B2:E5", top: "A1:F2", middle: "A3:F4", bottom: "A5:F6",
  left: "A1:C6", right: "D1:F6", "top-left": "A1:C3", "top-right": "D1:F3", "bottom-left": "A4:C6", "bottom-right": "D4:F6",
});

/** {width, height, name} for "1920x1080", "16:9", "vertical", or any WxH from 64 to 4096. */
export function parseFormat(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const name = FORMAT_ALIASES[text] ?? text;
  if (FORMATS[name]) return { ...FORMATS[name], name };
  const match = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/.exec(name);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width >= 64 && height >= 64 && width <= 4096 && height <= 4096) return { width, height, name: `${width}x${height}` };
  }
  throw new Error(`Unknown format "${value}". Use 1920x1080, 1080x1920, 1080x1080, 1080x1350, 16:9, 9:16, 1:1, 4:5, or any WxH from 64 to 4096.`);
}

/** True for 9:16 and taller frames (the checker uses the vertical limits for them). */
export const isPortraitFrame = ({ width, height }) => height / width >= 1.5;

/** How much bigger than a 1080-pixel short side the frame is. */
export const frameScale = ({ width, height }) => Math.min(width, height) / 1080;

/** The safe area in pixels: {x, y, width, height}, the same area the checker's safe_zone uses. */
export function safeArea(frame) {
  const zone = isPortraitFrame(frame) ? SAFE_ZONES.portrait : SAFE_ZONES.landscape;
  const x = Math.ceil(zone.left * frame.width);
  const y = Math.ceil(zone.top * frame.height);
  return { x, y, width: Math.floor(frame.width * (1 - zone.right)) - x, height: Math.floor(frame.height * (1 - zone.bottom)) - y };
}

const CELL = /^([A-F])([1-6])$/;

function parseCell(text) {
  const match = CELL.exec(text);
  if (!match) return null;
  return { column: COLUMNS.indexOf(match[1]), row: Number(match[2]) - 1 };
}

/** Reads "C2", "C2:E3" or a named slot into {column0, row0, column1, row1} (inclusive cells). */
export function parseSlot(value) {
  const text = String(value ?? "").trim();
  const named = NAMED_SLOTS[text.toLowerCase()];
  const source = (named ?? text).toUpperCase();
  const [start, end = start, extra] = source.split(":");
  const a = parseCell(start);
  const b = parseCell(end);
  if (!a || !b || extra !== undefined)
    throw new Error(`Unknown slot "${value}". A slot is a cell such as C2, a range such as C2:E3 (columns A–F, rows 1–6, over the safe area), or one of ${Object.keys(NAMED_SLOTS).join(", ")}.`);
  return { column0: Math.min(a.column, b.column), row0: Math.min(a.row, b.row), column1: Math.max(a.column, b.column), row1: Math.max(a.row, b.row) };
}

/** The pixel box {x, y, width, height} of a slot in a frame. */
export function slotBox(frame, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const box = { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) };
    if (!Object.values(box).every(Number.isFinite) || box.width <= 0 || box.height <= 0)
      throw new Error("A slot in pixels is {x, y, width, height} with a positive width and height.");
    return box;
  }
  const cells = parseSlot(value);
  const safe = safeArea(frame);
  const cellWidth = safe.width / GRID;
  const cellHeight = safe.height / GRID;
  const x = safe.x + cells.column0 * cellWidth;
  const y = safe.y + cells.row0 * cellHeight;
  return {
    x: Math.round(x), y: Math.round(y),
    width: Math.round((cells.column1 - cells.column0 + 1) * cellWidth),
    height: Math.round((cells.row1 - cells.row0 + 1) * cellHeight),
  };
}

/** Splits a box into rows (heights in shares, gap in pixels). */
export function splitRows(box, shares, gap = 0) {
  const total = shares.reduce((sum, share) => sum + share, 0);
  const free = box.height - gap * (shares.length - 1);
  let y = box.y;
  return shares.map((share) => {
    const height = Math.round((free * share) / total);
    const part = { x: box.x, y, width: box.width, height };
    y += height + gap;
    return part;
  });
}

/** Splits a box into columns (widths in shares, gap in pixels). */
export function splitColumns(box, shares, gap = 0) {
  const total = shares.reduce((sum, share) => sum + share, 0);
  const free = box.width - gap * (shares.length - 1);
  let x = box.x;
  return shares.map((share) => {
    const width = Math.round((free * share) / total);
    const part = { x, y: box.y, width, height: box.height };
    x += width + gap;
    return part;
  });
}
