// Small helpers the recipes build with: seeded choices, text that fits its slot, shapes,
// images, and entrances and exits timed with the motion tokens. Everything here is plain data
// in, plain data out, so a recipe gives the same layers for the same settings and seed.
import { createLayer } from "../model.js";
import { layoutText } from "../textLayout.js";
import { durationOf, easingOf } from "./tokens.js";
import { typeFloor } from "./looks.js";
import { round } from "../numbers.js";

/** A seeded random source (mulberry32): the same seed always gives the same choices. */
export function seeded(seed = 1) {
  let state = (Math.floor(Number(seed) || 1) * 2654435761) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: (list) => list[Math.floor(next() * list.length) % list.length],
    between: (low, high) => low + (high - low) * next(),
  };
}

const HEADLINE_ROLES = new Set(["headline", "hero"]);

/** A colour role (bg, text, accent, …) as hex, or the hex itself. */
export function paint(style, color) {
  return style.colors[color] ?? color;
}

/** A colour with an alpha from 0 to 1 ("#FF6B4A" at 0.2 → "#FF6B4A33"). */
export function withAlpha(hex, alpha) {
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0");
  return `${hex.slice(0, 7)}${byte}`;
}

// ---- motion timing ------------------------------------------------------------------------
// How long each kind of thing takes to enter, using the token bands the checker expects:
// letters a micro timing, words and lines a standard one, headlines, logos and large
// pictures an emphasis one, small shapes a micro one.
const KIND_TOKEN = {
  letters: "micro", words: "standard", lines: "standard", text: "standard",
  headline: "emphasis", logo: "emphasis", large: "emphasis", medium: "standard", small: "micro",
};

/** {duration, easing} for an entrance of this kind, in the look's feel. */
export function entranceTiming(ctx, kind, { easing = "enter", nudge = 0 } = {}) {
  const feel = ctx.style.feel;
  const position = Math.min(1, Math.max(0, feel.position + nudge));
  return { duration: durationOf(KIND_TOKEN[kind] ?? "standard", position), easing: easingOf(easing, feel.intensity) };
}

/** The kind of a shape or picture by how much of the frame it covers. */
export function sizeKind(ctx, width, height) {
  const share = (width * height) / (ctx.frame.width * ctx.frame.height);
  return share >= 0.25 ? "large" : share >= 0.01 ? "medium" : "small";
}

// The duration bands the checker judges a motion by (its duration_band rule): letters get a
// micro band, words and lines a standard one, logos 0.3–2 s, headlines and large layers a hero
// band, other text and shapes a band by size. Exits use the same band scaled to 55–75%.
const BANDS = { hero: [0.5, 2], standard: [0.3, 1.1], micro: [0.15, 0.5], logo: [0.3, 2] };

/** [shortest, longest] seconds for a motion of `layer` moving by `unit` (layer, letters, words, lines). */
export function bandFor(ctx, layer, unit = "layer") {
  if (unit === "letters") return BANDS.micro;
  if (unit === "words" || unit === "lines") return BANDS.standard;
  if (layer.role === "logo") return BANDS.logo;
  if (["hero", "background", "headline"].includes(layer.role)) return BANDS.hero;
  if (layer.type === "text") return layer.fontSize >= typeFloor(ctx.frame).headline ? BANDS.hero : BANDS.standard;
  const kind = sizeKind(ctx, layer.width, layer.height);
  return kind === "large" ? BANDS.hero : kind === "medium" ? BANDS.standard : BANDS.micro;
}

// An entrance's length kept inside its band, and long enough that a 55–75% exit can still
// meet the exit band.
function fitBand(ctx, layer, unit, duration) {
  const [low, high] = bandFor(ctx, layer, unit);
  const exitLow = bandFor(ctx, layer)[0] * 0.55 + 0.005;
  return Math.ceil(Math.min(high, Math.max(low, duration, exitLow / 0.72)) * 100 - 1e-6) / 100;
}

/** Seconds an exit takes after an entrance of `length` seconds: about 65%, inside the exit band. */
export function exitLength(ctx, layer, length) {
  const [low, high] = bandFor(ctx, layer);
  const shortest = Math.max(length * 0.56, low * 0.55 + 0.005);
  const longest = Math.min(length * 0.74, high * 0.75 - 0.005);
  return round(Math.max(0.12, Math.min(longest, Math.max(shortest, length * 0.65))));
}

/**
 * Stagger seconds per unit so the whole spread stays at or under `spread` seconds. `most` defaults
 * to a template median of 44 ms between neighbors (letters 20 ms, lines and titles 100 ms).
 */
export function staggerFor(units, spread = 0.36, most = 0.044) {
  if (units <= 1) return 0;
  return round(Math.min(most, spread / (units - 1)), 4);
}

// ---- layers -----------------------------------------------------------------------------
/**
 * A text layer that fits `box`: it starts at the look's size for `step` and steps down until
 * the text fits the box's width and height, never below the checker's minimum for its role.
 * Throws a plain "shorten the copy" message when even the minimum does not fit.
 */
export function textLayer(ctx, { part, text, role, step = "body", size, box, align = "left", valign = "top", face, color = "text", weight, lineHeight, maxLines, uppercase = false, name }) {
  const style = ctx.style;
  const floor = typeFloor(ctx.frame);
  const headline = HEADLINE_ROLES.has(role);
  const minimum = headline ? floor.headline : floor.body;
  const font = style.fonts[face ?? (headline || ["display", "h1", "h2"].includes(step) ? "display" : "body")];
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) throw new Error(`${ctx.recipe} needs text for ${part ?? "its text"}.`);
  let fontSize = Math.max(minimum, size ?? style.type[step] ?? style.type.body);
  const tracking = ["display", "h1", "h2"].includes(step) ? style.tracking * 100 : 0;
  const base = createLayer("text", {
    name: name ?? (value.length > 40 ? `${value.slice(0, 37)}…` : value),
    text: value, role, x: box.x, y: box.y, width: box.width, height: box.height,
    fontFamily: font.fontFamily, fontSource: font.fontSource ?? "", fontWeight: weight ?? font.fontWeight, fontStyle: font.fontStyle ?? "normal",
    fill: paint(style, color), textAlign: align, verticalAlign: "top", textResize: "height",
    lineHeight: lineHeight ?? (headline || ["display", "h1", "h2"].includes(step) ? 1.08 : 1.3),
    letterSpacing: round(tracking, 2), textCase: uppercase ? "upper" : "normal",
  });
  // A text at one size: {candidate, layout, widest, room, inset, fits}.
  const tryAt = (size, words = value) => {
    // Some letters draw a little past their advance, so the text keeps a small inset.
    const inset = Math.ceil(size * 0.04);
    const room = Math.max(1, Math.floor(box.width - 2 * inset));
    const candidate = { ...base, text: words, fontSize: size, x: Math.round(box.x + inset), width: room };
    const layout = layoutText(candidate, ctx.fonts);
    const widest = Math.max(0, ...layout.lines.map((line) => line.width ?? 0));
    const fits = layout.height <= box.height + 0.5 && widest <= room + 0.5 && (!maxLines || layout.lines.length <= maxLines);
    return { candidate, layout, widest, room, inset, fits };
  };
  const place = ({ candidate, layout, widest, room, inset }, width = room) => {
    // The layer is as wide as its longest line (plus a space, so wrapping is unchanged).
    const snug = Math.min(width, Math.ceil(widest + candidate.fontSize * 0.4));
    if (snug < width && layoutText({ ...candidate, width: snug }, ctx.fonts).lines.length === layout.lines.length) width = snug;
    const x = align === "center" ? box.x + (box.width - width) / 2 : align === "right" ? box.x + box.width - inset - width : box.x + inset;
    const anchor = valign === "middle" ? 0.5 : valign === "bottom" ? 1 : 0;
    return { ...candidate, x: Math.round(x), width, height: Math.ceil(layout.height), y: Math.round(box.y + (box.height - layout.height) * anchor), lines: layout.lines.length };
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = tryAt(fontSize);
    if (found.fits) return place(...balanced(ctx, found, { tryAt, value, minimum, maxLines }));
    if (fontSize <= minimum) break;
    fontSize = Math.max(minimum, Math.floor(fontSize * 0.93));
  }
  const room = Math.max(4, Math.floor(value.length * 0.6));
  throw Object.assign(new Error(`${ctx.recipe}: "${value.length > 50 ? `${value.slice(0, 47)}…` : value}" does not fit its slot at the smallest allowed size (${minimum}px). Shorten it to about ${room} characters, or give a larger slot.`), { tooLong: true });
}

// The pieces a short title may break between: its words, and the parts of a hyphenated word
// ("double-booking" is "double-" and "booking"). Joined again with a space, or nothing after a hyphen.
function piecesOf(words) {
  return words.flatMap((word) => word.split(/(?<=-)(?=[^-])/u));
}
// True when list `a` sorts before list `b`, comparing the first entries that differ.
const before = (a, b) => {
  const index = a.findIndex((value, at) => value !== b[at]);
  return index >= 0 && a[index] < b[index];
};
const joinPieces = (pieces) => pieces.reduce((text, piece) => (!text ? piece : text.endsWith("-") ? `${text}${piece}` : `${text} ${piece}`), "");

// Every way to put `pieces` on 2 to `most` lines, in order (["a b", "c"], ["a", "b c"], …).
function splitsOf(pieces, most) {
  const found = [];
  const walk = (rest, lines) => {
    if (!rest.length) { if (lines.length >= 2) found.push(lines); return; }
    if (lines.length === most) return;
    for (let take = 1; take <= rest.length; take += 1) walk(rest.slice(take), [...lines, joinPieces(rest.slice(0, take))]);
  };
  walk(pieces, []);
  return found;
}

/**
 * Even lines for a text that wraps. A title of one to three words is not broken by the
 * wrap: it gets smaller (to 78% of its size, never under the minimum) until it fits one line,
 * and when it still does not, its words go on lines kino chooses (typed line breaks, as even as
 * can be; after a hyphen only when a word is too long for a line). A longer text gets the
 * narrowest width that keeps its number of lines, so the last line is as long as it can be,
 * never one short word under a long line.
 * `found` is the fitting layout from textLayer; returns the arguments for its place().
 */
function balanced(ctx, found, { tryAt, value, minimum, maxLines }) {
  const lines = found.layout.lines;
  if (lines.length < 2) return [found];
  const words = value.split(" ");
  const sizes = [];
  for (let size = found.candidate.fontSize; ; size = Math.max(minimum, Math.floor(size * 0.95))) {
    sizes.push(size);
    if (size <= minimum) break;
  }
  if (words.length <= 3) {
    const floor = Math.max(minimum, Math.round(found.candidate.fontSize * 0.78));
    for (const size of sizes.filter((entry) => entry >= floor)) {
      const one = tryAt(size);
      if (one.fits && one.layout.lines.length === 1) return [one];
    }
    const pieces = piecesOf(words);
    if (pieces.length < 2) return [found];
    // Words before the parts of a hyphenated word: a break inside one is the last resort.
    const inside = (split) => split.filter((line) => line.endsWith("-")).length;
    for (const size of sizes) {
      let best = null;
      for (const split of splitsOf(pieces, Math.min(3, maxLines ?? 3))) {
        const made = tryAt(size, split.join("\n"));
        // Each typed line must fit on its own line (no wrap inside it).
        if (!made.fits || made.layout.lines.length !== split.length) continue;
        // Fewest breaks inside a word, then fewest lines, then the most even lines.
        const rank = [inside(split), split.length, made.widest];
        if (!best || before(rank, best.rank)) best = { made, rank };
      }
      if (best) return [best.made];
    }
    return [found];
  }
  const count = (width) => layoutText({ ...found.candidate, width }, ctx.fonts).lines.length;
  let low = Math.max(1, Math.floor(found.widest / lines.length));
  let high = found.room;
  if (count(low) <= lines.length) high = low;
  while (high - low > 2) {
    const middle = Math.floor((low + high) / 2);
    if (count(middle) <= lines.length) high = middle; else low = middle;
  }
  const width = Math.min(found.room, high + 2);
  const layout = layoutText({ ...found.candidate, width }, ctx.fonts);
  const widest = Math.max(0, ...layout.lines.map((line) => line.width ?? 0));
  return [{ ...found, candidate: { ...found.candidate, width }, layout, widest }, width];
}

/**
 * Stacks already-sized layers top to bottom inside `box` with `gap` pixels between them (an
 * entry's own `gap` is the space above it), placed at the top, middle or bottom of the box.
 * Moves the layers in place and returns the stack's {x, y, width, height}.
 */
export function column(box, entries, { gap = 0, valign = "middle" } = {}) {
  const list = entries.filter(Boolean);
  const total = list.reduce((sum, entry, index) => sum + entry.layer.height + (index ? entry.gap ?? gap : 0), 0);
  let y = box.y + (box.height - total) * (valign === "middle" ? 0.5 : valign === "bottom" ? 1 : 0);
  const top = Math.round(y);
  list.forEach((entry, index) => {
    if (index) y += entry.gap ?? gap;
    entry.layer.y = Math.round(y);
    y += entry.layer.height;
  });
  return { x: box.x, y: top, width: box.width, height: Math.round(total) };
}

/** Moves a layer horizontally inside `box`: left, center or right. */
export function alignIn(layer, box, align) {
  layer.x = Math.round(align === "center" ? box.x + (box.width - layer.width) / 2 : align === "right" ? box.x + box.width - layer.width : box.x);
  return layer;
}

/** The widest line of a text layer, in pixels. */
export function textWidth(ctx, layer) {
  const layout = layoutText(layer, ctx.fonts);
  return Math.ceil(Math.max(0, ...layout.lines.map((line) => line.width ?? 0)));
}

/** A rectangle (or ellipse) layer. */
export function shapeLayer(ctx, { type = "rectangle", box, color = "surface", radius = 0, role, name, opacity = 1, stroke, strokeWidth = 0 }) {
  return createLayer(type, {
    name: name ?? (role ? `${role} shape` : "Shape"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)),
    fill: typeof color === "string" ? paint(ctx.style, color) : color, radius, opacity,
    ...(stroke ? { stroke: paint(ctx.style, stroke), strokeWidth, strokeAlign: "inside" } : {}),
    ...(role ? { role } : {}),
  });
}

/** An image layer fitted inside `box` (keeping its proportions), centred unless `align` says. */
export function imageLayer(ctx, { media, box, role, name, align = "center", valign = "middle" }) {
  const width = media.width || box.width;
  const height = media.height || box.height;
  const scale = Math.min(box.width / width, box.height / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const x = align === "left" ? box.x : align === "right" ? box.x + box.width - w : box.x + (box.width - w) / 2;
  const y = valign === "top" ? box.y : valign === "bottom" ? box.y + box.height - h : box.y + (box.height - h) / 2;
  // A video (a screen recording) plays silently from when its part enters (runRecipe sets mediaStart).
  const video = media.kind === "video" ? { ...(media.duration > 0 ? { mediaSourceDuration: media.duration } : {}), volume: 0 } : {};
  return createLayer(media.kind === "video" ? "video" : "image", { name: name ?? media.name ?? "Image", src: media.src, x: Math.round(x), y: Math.round(y), width: w, height: h, ...video, ...(role ? { role } : {}) });
}

// ---- animations ---------------------------------------------------------------------------
function animation({ name, kind, start, duration, easing, unit = "layer", stagger = 0, from, to, extra = {} }) {
  return { name, kind, start: round(start), duration: round(duration), easing, unit, stagger, order: "forward", from, to, ...extra };
}

/**
 * An entrance for `layer`. Styles: rise (words float up), letters, lines (each line slides up
 * out of a mask), fade-up, slide-left / slide-right, scale, wipe (reveals left to right) and
 * fade; slam (drops in from larger), pop (a fade plus a separate scale that overshoots a little),
 * fade-down, grow-x / grow-y (a bar filling up from `anchor`) and draw (an ellipse's arc
 * sweeping round). Reduced motion (ctx.reduced) turns every style into a short fade with no
 * movement. Returns the animation, any extra animation it needs (`also`) and when it ends.
 */
export function entrance(ctx, layer, { style = "fade-up", start, kind, nudge = 0, easing = "enter", anchor }) {
  const isText = layer.type === "text";
  const units = isText ? unitsOf(layer, style) : 1;
  const chosenKind = kind ?? (style === "letters" || style === "type" ? "letters" : style === "rise" ? "words" : style === "lines" ? "lines"
    : isText ? (HEADLINE_ROLES.has(layer.role) || layer.fontSize >= typeFloor(ctx.frame).headline ? "headline" : "text")
    : layer.role === "logo" ? "logo" : sizeKind(ctx, layer.width, layer.height));
  if (ctx.reduced) {
    const timing = entranceTiming(ctx, isText && chosenKind !== "headline" ? "text" : chosenKind === "small" ? "medium" : chosenKind, { easing: "move", nudge });
    const made = animation({ name: "Fade in", kind: "in", start, duration: fitBand(ctx, layer, "layer", timing.duration), easing: timing.easing, from: { opacity: 0 }, to: { opacity: 1 } });
    return { animation: made, end: round(start + made.duration) };
  }
  const timing = entranceTiming(ctx, chosenKind, { easing, nudge });
  const unit = !isText ? "layer" : style === "letters" || style === "type" ? "letters" : style === "rise" ? "words" : style === "lines" ? "lines" : "layer";
  timing.duration = fitBand(ctx, layer, unit, style === "type" ? durationOf("micro", 0) : timing.duration);
  const scale = ctx.style.scale;
  const lift = isText ? Math.round(Math.min(layer.fontSize * 0.45, 60 * scale)) : Math.round(36 * scale);
  let made;
  if (style === "rise" || style === "letters" || style === "lines") {
    const unit = style === "letters" ? "letters" : style === "rise" ? "words" : "lines";
    const spread = unit === "letters" ? 0.42 : 0.36;
    const most = unit === "letters" ? 0.02 : unit === "words" ? 0.044 : 0.1;
    const drop = unit === "lines" ? Math.round(layer.fontSize * (layer.lineHeight ?? 1.2)) : unit === "letters" ? Math.round(layer.fontSize * 0.3) : lift;
    made = animation({
      name: unit === "lines" ? "Lines up" : unit === "letters" ? "Letters in" : "Words rise", kind: "in", start, duration: timing.duration, easing: timing.easing,
      unit, stagger: staggerFor(units, spread, most), from: { opacity: 0, y: layer.y + drop }, to: { opacity: 1, y: layer.y },
      extra: unit === "lines" ? { textClip: true } : {},
    });
  } else if (style === "slide-left" || style === "slide-right") {
    // A tenth of the frame (the lower quartile of template entrance travel; the median, 30%, is a layer parked off frame).
    const distance = Math.round(Math.min(ctx.frame.width * 0.1, 200 * scale));
    made = animation({ name: "Slide in", kind: "in", start, duration: timing.duration, easing: timing.easing,
      from: { opacity: 0, x: layer.x + (style === "slide-left" ? distance : -distance) }, to: { opacity: 1, x: layer.x } });
  } else if (style === "scale") {
    made = animation({ name: "Scale in", kind: "in", start, duration: timing.duration, easing: timing.easing,
      from: { opacity: 0, scaleX: 0.9, scaleY: 0.9 }, to: { opacity: 1, scaleX: 1, scaleY: 1 } });
  } else if (style === "grow-x" || style === "grow-y") {
    // A Resize that keeps the left (or bottom) edge in place, like a bar filling up. It also
    // fades in, so the 1 px bar it starts from is hidden until the entrance starts.
    const key = style === "grow-x" ? "width" : "height";
    made = animation({ name: "Grow", kind: "in", start, duration: timing.duration, easing: easingOf("move", ctx.style.feel.intensity),
      from: { opacity: 0, [key]: 1 }, to: { opacity: 1, [key]: layer[key] }, extra: { anchor: anchor ?? (style === "grow-x" ? "left" : "bottom") } });
  } else if (style === "slam") {
    // Up to 18% larger, but never so large that the layer reaches past the frame's edge.
    const grow = round(Math.max(1, Math.min(1.18, roomToGrow(ctx.frame, layer))), 3);
    made = animation({ name: "Slam in", kind: "in", start, duration: timing.duration, easing: timing.easing,
      from: { opacity: 0, scaleX: grow, scaleY: grow }, to: { opacity: 1, scaleX: 1, scaleY: 1 } });
  } else if (style === "pop") {
    // The fade and the overshooting scale are separate animations: a spring on opacity flickers.
    made = animation({ name: "Fade in", kind: "in", start, duration: round(timing.duration * 0.6), easing: easingOf("move", ctx.style.feel.intensity), from: { opacity: 0 }, to: { opacity: 1 } });
    const pop = animation({ name: "Pop", kind: "custom", start, duration: timing.duration, easing: [0.34, 1.45, 0.64, 1], from: { scaleX: 0.7, scaleY: 0.7 }, to: { scaleX: 1, scaleY: 1 } });
    return { animation: made, also: [{ key: "pop", animation: pop }], end: round(start + timing.duration) };
  } else if (style === "type") {
    // Typing: each letter appears in turn, about 14 letters a second, with no movement.
    made = animation({ name: "Type on", kind: "in", start, duration: timing.duration, easing: easingOf("move", ctx.style.feel.intensity),
      unit: "letters", stagger: staggerFor(units, 1.1, 0.07), from: { opacity: 0 }, to: { opacity: 1 } });
  } else if (style === "fade-down") {
    made = animation({ name: "Fade down", kind: "in", start, duration: timing.duration, easing: timing.easing,
      from: { opacity: 0, y: layer.y - lift }, to: { opacity: 1, y: layer.y } });
  } else if (style === "draw") {
    made = animation({ name: "Draw", kind: "in", start, duration: timing.duration, easing: easingOf("move", ctx.style.feel.intensity), from: { sweep: 0 }, to: { sweep: 1 } });
  } else if (style === "wipe") {
    made = animation({ name: "Wipe in", kind: "in", start, duration: timing.duration, easing: easingOf("move", ctx.style.feel.intensity),
      from: { reveal: { direction: "right", softness: 0, progress: 0 } }, to: { reveal: { direction: "right", softness: 0, progress: 1 } } });
  } else if (style === "fade") {
    made = animation({ name: "Fade in", kind: "in", start, duration: timing.duration, easing: easingOf("move", ctx.style.feel.intensity), from: { opacity: 0 }, to: { opacity: 1 } });
  } else {
    made = animation({ name: "Fade up", kind: "in", start, duration: timing.duration, easing: timing.easing,
      from: { opacity: 0, y: layer.y + lift }, to: { opacity: 1, y: layer.y } });
  }
  const spread = made.stagger * Math.max(0, units - 1);
  const fade = ["grow-x", "grow-y", "slam"].includes(style) ? null : splitFade(made);
  return { animation: made, ...(fade ? { also: [{ key: "fade", animation: fade }] } : {}), end: round(start + made.duration + spread) };
}

// The template fade-in: 0.2 s, linear, under a longer move. An entrance
// that moves or scales and fades in one curve gives its opacity to a separate short linear fade
// with the same units and stagger, so the layer is seen early and then settles on the move's curve.
// (A grow keeps its fade: it only hides the 1 px bar it starts from. A slam keeps it too: seen at
// its larger size it would reach past the safe area.)
const FADE_IN = 0.2;
function splitFade(made) {
  if (made.from?.opacity !== 0 || Object.keys(made.from).length < 2 || made.duration <= FADE_IN) return null;
  delete made.from.opacity;
  delete made.to.opacity;
  return animation({ name: "Fade in", kind: "in", start: made.start, duration: FADE_IN, easing: "linear",
    unit: made.unit, stagger: made.stagger, from: { opacity: 0 }, to: { opacity: 1 } });
}

/** How much larger than itself a layer can grow about its centre and stay inside the frame. */
function roomToGrow(frame, layer) {
  const cx = layer.x + layer.width / 2;
  const cy = layer.y + layer.height / 2;
  const across = Math.min(cx, frame.width - cx) / Math.max(1, layer.width / 2);
  const down = Math.min(cy, frame.height - cy) / Math.max(1, layer.height / 2);
  return Math.min(across, down) * 0.99;
}

/** An exit that ends at `end`, after an entrance of `length` seconds (see exitLength), on the smooth move curve; fade: a fade in place. */
export function exitFor(ctx, layer, length, end, { fade = false } = {}) {
  const duration = exitLength(ctx, layer, length);
  const start = round(end - duration);
  // Exits ride the same smooth curve as entrances (one curve both ways).
  const easing = easingOf("move", ctx.style.feel.intensity);
  if (fade || ctx.reduced || layer.type !== "text" && layer.role === "decor") {
    return animation({ name: "Fade out", kind: "out", start, duration, easing, from: { opacity: 1 }, to: { opacity: 0 } });
  }
  const shift = Math.round(Math.min(24, (layer.fontSize ?? 40) * 0.25) * ctx.style.scale);
  return animation({ name: "Leave", kind: "out", start, duration, easing, from: { opacity: 1, y: layer.y }, to: { opacity: 0, y: layer.y - shift } });
}

function unitsOf(layer, style) {
  const unit = style === "letters" || style === "type" ? "letters" : style === "rise" ? "words" : style === "lines" ? "lines" : null;
  if (!unit) return 1;
  if (unit === "words") return Math.max(1, layer.text.split(/\s+/).filter(Boolean).length);
  if (unit === "letters") return Math.max(1, [...layer.text].length);
  return Math.max(1, layer.lines ?? 1);
}

/** Seconds a text needs to be read: 20 characters a second, never under 20 frames at 30 fps. */
export function readSeconds(text) {
  return Math.max(String(text ?? "").length / 20, 20 / 30);
}
