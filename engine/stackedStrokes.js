// Stacked strokes: a layer's optional `strokes` list, drawn after its single stroke.
// Each entry is { color, width, align? (center|inside|outside, default center), opacity? (0..1,
// default 1), dash? ([on, off, ...] px, default solid), join? (miter|round|bevel, default miter),
// cap? (butt|round|square, default butt), taper? (a share of the length 0..1 for both ends, or
// {start, end}: the line narrows to a point there), style? (plain|neon), glow? (neon only, px) }.
// style neon is a light core inside a dim soft glow (strokeStyles.js); its width defaults to 3, glow to 24.
// Later entries paint over earlier ones, so list wide outside outlines first for a sticker or neon edge. On text the list follows the
// outline of all the letters together (outside strokes listed first stay under letters drawn apart); on shapes it follows the layer's trim. Static: no
// animation moves the list.

import { shadowAlpha } from "./shadowInterpolation.js";
import { NEON_DEFAULTS } from "./strokeStyles.js";

export const MAX_STACKED_STROKES = 16;
export const STACKED_STROKE_TYPES = new Set(["rectangle", "ellipse", "star", "path", "text"]);
const ALIGNS = new Set(["center", "inside", "outside"]);
const JOINS = new Set(["miter", "round", "bevel"]);
const CAPS = new Set(["butt", "round", "square"]);
const STYLES = new Set(["plain", "neon"]);
const FIELDS = ["color", "width", "align", "opacity", "dash", "join", "cap", "taper", "style", "glow"];

/**
 * The checked list, or throws a message naming the bad part. `path` names the field.
 * null, undefined and [] mean no list (the caller deletes the field).
 */
export function normalizeStrokeList(value, path = "strokes") {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error(`${path} must be a list of strokes [{color, width, align?, opacity?, dash?, join?, cap?, taper?, style?, glow?}]`);
  if (value.length > MAX_STACKED_STROKES) throw new Error(`${path} holds at most ${MAX_STACKED_STROKES} strokes`);
  if (!value.length) return null;
  return value.map((entry, index) => {
    const at = `${path}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} must be {color, width, align?, opacity?, dash?, join?, cap?, taper?, style?, glow?}`);
    const extra = Object.keys(entry).filter((key) => !FIELDS.includes(key));
    if (extra.length) throw new Error(`${at} has unknown field ${extra[0]}; a stroke is {color, width, align?, opacity?, dash?, join?, cap?, taper?, style?, glow?}`);
    if (typeof entry.color !== "string" || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(entry.color))
      throw new Error(`${at}.color must be a hex color such as #ffffff or #ffffff80`);
    const number = (given, key, min, max) => {
      if (typeof given !== "number" || !Number.isFinite(given) || given < min || given > max)
        throw new Error(`${at}.${key} must be a number from ${min} to ${max}`);
      return given;
    };
    if (entry.style !== undefined && !STYLES.has(entry.style)) throw new Error(`${at}.style must be plain or neon`);
    const neon = entry.style === "neon";
    if (entry.glow !== undefined && !neon) throw new Error(`${at}.glow needs style "neon"`);
    const stroke = { color: entry.color, width: neon && entry.width === undefined ? NEON_DEFAULTS.width : number(entry.width, "width", 0, 10_000) };
    if (neon) {
      stroke.style = "neon";
      stroke.glow = entry.glow === undefined ? NEON_DEFAULTS.glow : number(entry.glow, "glow", 0, 2_000);
    }
    if (entry.cap !== undefined) {
      if (!CAPS.has(entry.cap)) throw new Error(`${at}.cap must be butt, round, or square`);
      stroke.cap = entry.cap;
    }
    if (entry.taper !== undefined && entry.taper !== null) {
      const taper = typeof entry.taper === "number" ? { start: entry.taper, end: entry.taper } : entry.taper;
      if (!taper || typeof taper !== "object" || Array.isArray(taper) || Object.keys(taper).some((key) => key !== "start" && key !== "end"))
        throw new Error(`${at}.taper must be a share 0..1 for both ends or {start, end}`);
      const shares = { start: taper.start === undefined ? 0 : number(taper.start, "taper.start", 0, 1), end: taper.end === undefined ? 0 : number(taper.end, "taper.end", 0, 1) };
      if (shares.start > 0 || shares.end > 0) stroke.taper = shares;
    }
    if (entry.align !== undefined) {
      if (!ALIGNS.has(entry.align)) throw new Error(`${at}.align must be center, inside, or outside`);
      stroke.align = entry.align;
    }
    if (entry.join !== undefined) {
      if (!JOINS.has(entry.join)) throw new Error(`${at}.join must be miter, round, or bevel`);
      stroke.join = entry.join;
    }
    if (entry.opacity !== undefined) stroke.opacity = number(entry.opacity, "opacity", 0, 1);
    if (entry.dash !== undefined && entry.dash !== null) {
      if (!Array.isArray(entry.dash) || entry.dash.length > 16) throw new Error(`${at}.dash must be a list of up to 16 lengths [on, off, ...]`);
      const dash = entry.dash.map((length, step) => number(length, `dash[${step}]`, 0, 100_000));
      if (dash.length && !dash.some((length) => length > 0)) throw new Error(`${at}.dash needs at least one length above 0, or [] for a solid stroke`);
      if (dash.length) stroke.dash = dash;
    }
    return stroke;
  });
}

/** The list entries that paint (width and opacity above 0), or [] for none. */
export function stackedStrokes(state) {
  return Array.isArray(state?.strokes)
    ? state.strokes.filter((stroke) => stroke && typeof stroke === "object" && stroke.width > 0 && (stroke.opacity ?? 1) > 0)
    : [];
}

/** How far strokes reach past the layer's edge at most (the single stroke counted whole, as before). */
export function strokeReach(state) {
  const single = Math.max(0, Number(state?.strokeWidth) || 0);
  // A neon glow is blurred by 0.4 of its width (strokeStyles.js), so it reaches about twice as far.
  return stackedStrokes(state).reduce((reach, stroke) => Math.max(reach, stroke.width, stroke.style === "neon" ? stroke.glow * 2 : 0), single);
}

/**
 * Letters drawn apart (by letter or word, or outline_text's letter shapes) split the list: the
 * outside strokes listed first go `under` every letter, so a neighbor's outline never covers a
 * letter; the rest stay `over` each letter. `solid`: the first under stroke is opaque and the widest, so
 * it rings each letter and casts the letters' shadows. null when the list does not start with an outside stroke.
 */
export function splitLetterStrokes(state) {
  const list = stackedStrokes(state);
  let count = 0;
  while (count < list.length && list[count].align === "outside") count++;
  if (!count) return null;
  const under = list.slice(0, count);
  return { under, over: list.slice(count), solid: (under[0].opacity ?? 1) === 1 && shadowAlpha(under[0].color) === 1 && under.every((stroke) => stroke.width <= under[0].width) };
}
