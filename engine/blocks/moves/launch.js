// Type moves from a study of pro launch videos: a section
// title whose headline writes on gray to ink (headline-write), a
// logo mark that lands from 2.6x while its name types on beside it (logo-settle), and a stat that
// counts up to its number with a label writing on under it (count-up).
//
// "Gray" is the word at part opacity: it mixes toward whatever is behind it, so the same move
// reads on a dark or a light background. Timings are the study's measurements.
import { createLayer } from "../../model.js";
import { parseCounterText } from "../../counterFormat.js";
import { layoutText, resizeTextLayer } from "../../textLayout.js";
import { readSeconds, textLayer } from "../build.js";
import { safeArea } from "../formats.js";
import { CURVES, centerOf, hide, motion, round, scaledAbout } from "./kit.js";

// expo-out and quart-out (study: "Easing names").
const EXPO_OUT = [0.16, 1, 0.3, 1];
const QUART_OUT = [0.25, 1, 0.5, 1];
const readTime = (text) => Math.max(readSeconds(text), 20 / 30);

/**
 * A text written on unit by unit (words or letters): each unit shows at `gray` opacity at its
 * turn, `every` seconds apart, then darkens to full in `darken` seconds. Returns when the last
 * unit is full.
 */
function writeOn(ctx, layer, { unit, start, every, gray, darken, animate = (key, animation) => ctx.animate(layer, key, animation), full = 1 }) {
  const shared = { unit, stagger: every, order: "forward" };
  animate("arrive", { ...motion({ name: "Arrive gray", kind: "in", start, duration: 0.03, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: round(gray * full, 3) } }), ...shared });
  animate("ink", { ...motion({ name: "Darken", start: start + 0.03, duration: darken, easing: QUART_OUT, from: { opacity: round(gray * full, 3) }, to: { opacity: full } }), ...shared });
  const count = unit === "words" ? layer.text.split(/\s+/).filter(Boolean).length : [...layer.text].filter((character) => character.trim()).length;
  return round(start + 0.03 + every * Math.max(0, count - 1) + darken);
}

/**
 * A slow push (up to 3% bigger) on `layers` together, about the middle of their boxes, from
 * `from` to `until`: the study's holds always drift (1 to 3% a second), so a held title never
 * reads as a slide.
 */
function holdPush(ctx, layers, from, until, animate = (layer, key, animation) => ctx.animate(layer, key, animation)) {
  if (ctx.reduced || until - from < 0.4) return;
  const left = Math.min(...layers.map((layer) => layer.x));
  const top = Math.min(...layers.map((layer) => layer.y));
  const pivot = centerOf({ x: left, y: top, width: Math.max(...layers.map((layer) => layer.x + layer.width)) - left, height: Math.max(...layers.map((layer) => layer.y + layer.height)) - top });
  const grow = round(1 + Math.min(0.03, 0.015 * (until - from)), 3);
  for (const layer of layers) {
    const pushed = scaledAbout(layer, pivot, grow);
    const [sx, sy] = [layer.scaleX ?? 1, layer.scaleY ?? 1];
    animate(layer, "push", motion({ name: "Slow push", start: from, duration: round(until - from), easing: CURVES.drift,
      from: { x: layer.x, y: layer.y, scaleX: sx, scaleY: sy }, to: { x: pushed.x, y: pushed.y, scaleX: round(grow * sx, 4), scaleY: round(grow * sy, 4) } }));
  }
}

/**
 * Your own text layer for a move's `field` (it keeps its font, size, color and place) and how to
 * animate a list of layers that may hold it: your layer by its ID under the role `field`, the
 * move's own parts as they are.
 */
function yourText(ctx, id, field) {
  const layer = ctx.layer(id, field);
  if (layer.type !== "text") throw new Error(`${ctx.move} ${field}: ${layer.id} is a ${layer.type}; give a text layer.`);
  const animate = (target, key, animation) => (target.id === layer.id ? ctx.animate(layer.id, key, animation, field) : ctx.animate(target, key, animation));
  return { layer: resizeTextLayer(layer, ctx.fonts), animate };
}

// ---- headline-write -----------------------------------------------------------------------
// The headline: a word every 0.25 s (4 a second), each from 40% to full in 0.2 s.
// It once had a small caps label decoding above it (kicker-headline, still accepted by that
// name); a label stacked over a headline reads as a template, so the kicker is left out.
const WORD_EVERY = 0.25;
const WORD_GRAY = 0.4;
const WORD_DARKEN = 0.2;

export const headlineWrite = {
  name: "headline-write",
  about: "a section title: the headline writes on word by word, 4 words a second, each word arriving gray and darkening to full in 0.2 s, centered",
  fits: "the title of each section of a launch or explainer video; a quiet, typographic way to say what comes next",
  tags: ["type-words"],
  length: 2.2,
  fields: {
    headline: { kind: "text", max: 60, about: "the headline, one short line (4 to 7 words reads best), or give layer" },
    layer: { kind: "layer", about: "your own text layer instead: it writes on in its own font, size, color and place" },
    kicker: { kind: "text", max: 80, retired: true, about: "retired: accepted and left out" },
    exit: { kind: "choice", values: ["stay", "dim", "fade"], about: "at the end: stay (default), dim (fades to 20% so the next section builds over it) or fade (out and gone)" },
  },
  oneOf: [["headline", "layer"]],
  example: { headline: "Set it up in seconds", at: 0.3 },
  setup: "none",
  build(ctx, input) {
    if (input.layer) return headlineOn(ctx, input, yourText(ctx, input.layer, "layer"));
    const safe = safeArea(ctx.frame);
    const width = Math.round(safe.width * (ctx.portrait ? 1 : 0.8));
    const box = { x: Math.round(ctx.frame.width / 2 - width / 2), y: safe.y, width, height: safe.height };
    // Sized to the reference frames: the headline's capitals about 5% of the frame's height (a
    // 7.5% font size).
    const headline = textLayer(ctx, { part: "headline", text: input.headline, role: "headline", step: "h2", size: Math.round(Math.min(ctx.frame.height * 0.075, ctx.frame.width * 0.085)), box, align: "center", face: "body", maxLines: 2, weight: ctx.brandFonts ? undefined : 600 });
    if (input.kicker) ctx.note("kicker left out: a small label stacked over a headline reads as a template");
    const top = Math.round(ctx.frame.height / 2 - headline.height / 2);
    const layers = [];
    const writeAt = ctx.start;
    const line = ctx.add("headline", { ...headline, y: top, name: input.headline });
    // Two lines of about the same length, never one long line and a lone word under it: the
    // narrowest width that still takes two lines.
    if (layoutText(line, ctx.fonts).lines.length === 2) {
      let [low, high] = [Math.ceil(line.width / 2), line.width];
      while (high - low > 2) {
        const middle = Math.round((low + high) / 2);
        if (layoutText({ ...line, width: middle }, ctx.fonts).lines.length > 2) low = middle; else high = middle;
      }
      line.width = Math.min(box.width, high + Math.ceil(line.fontSize * 0.2));
      line.x = Math.round(ctx.frame.width / 2 - line.width / 2);
    }
    layers.push(line);
    const written = writeOn(ctx, line, { unit: "words", start: writeAt, every: WORD_EVERY, gray: WORD_GRAY, darken: WORD_DARKEN });
    const exitFor = input.exit === "dim" || input.exit === "fade" ? 0.3 : 0;
    const end = round(Math.max(ctx.end, written + Math.max(readTime(input.headline), 0.8) + exitFor));
    holdPush(ctx, layers, written, end - exitFor);
    if (exitFor) {
      for (const layer of layers) {
        ctx.animate(layer, input.exit === "dim" ? "dim" : "out", motion({ name: input.exit === "dim" ? "Dim" : "Fade out", kind: input.exit === "dim" ? "custom" : "out", start: end - exitFor, duration: exitFor, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: input.exit === "dim" ? 0.2 : 0 } }));
        if (input.exit === "fade") ctx.animate(layer, "hide", hide(end));
      }
    }
    return { end };
  },
};

// headline-write on your text layer: the same write-on, hold and exit, on it as it is.
function headlineOn(ctx, input, { layer, animate }) {
  if (input.kicker) ctx.note("kicker left out: a small label stacked over a headline reads as a template");
  const written = writeOn(ctx, layer, { unit: "words", start: ctx.start, every: WORD_EVERY, gray: WORD_GRAY, darken: WORD_DARKEN, full: layer.opacity ?? 1, animate: (key, animation) => animate(layer, key, animation) });
  const exitFor = input.exit === "dim" || input.exit === "fade" ? 0.3 : 0;
  const end = round(Math.max(ctx.end, written + Math.max(readTime(layer.text), 0.8) + exitFor));
  holdPush(ctx, [layer], written, end - exitFor, animate);
  const full = layer.opacity ?? 1;
  if (exitFor) {
    animate(layer, input.exit === "dim" ? "dim" : "out", motion({ name: input.exit === "dim" ? "Dim" : "Fade out", kind: input.exit === "dim" ? "custom" : "out", start: end - exitFor, duration: exitFor, easing: CURVES.fade, from: { opacity: full }, to: { opacity: input.exit === "dim" ? round(0.2 * full, 3) : 0 } }));
    if (input.exit === "fade") animate(layer, "hide", hide(end));
  }
  return { end };
}

// ---- logo-settle --------------------------------------------------------------------------
const LOGO_FROM = 2.6;
const LOGO_SETTLE = 0.45;
const LETTER_EVERY = 0.06;
const LETTER_GRAY = 0.35;
const LETTER_DARKEN = 0.1;

export const logoSettle = {
  name: "logo-settle",
  about: "a logo mark lands from 2.6x its size (no overshoot, 0.45 s), then its name types on beside it letter by letter, each letter from faint to full, while the lockup slides to stay centered; header:true then shrinks it and lifts it into a small header",
  fits: "the open or the end card of a launch video: the brand's mark and name, calm and precise",
  tags: ["type-letters"],
  length: 2.2,
  fields: {
    wordmark: { kind: "text", max: 24, about: "the name typed on beside the mark (default the brand's name)" },
    picture: { kind: "picture", about: "an uploaded picture of the mark (default the brand's logo)" },
    logo: { kind: "layer", about: "your own mark layer instead (it lands where it is; the name types on to its right)" },
    header: { kind: "choice", values: [true, false], about: "true: after the name, the lockup shrinks to 40% and moves up 12% of the frame, a header for what follows" },
  },
  example: { wordmark: "acme", at: 0.3 },
  setup: "set_brand with a logo picture (or give picture or logo)",
  build(ctx, input) {
    const given = input.logo ? ctx.layer(input.logo, "logo") : null;
    const picture = given ? null : input.picture ? ctx.picture(input.picture) : ctx.logo?.media ?? null;
    if (!given && !picture) throw new Error("logo-settle needs logo (your mark layer), picture (an uploaded picture), or a brand with a logo picture.");
    const name = input.wordmark ?? ctx.logo?.text ?? null;
    // The mark about 15% of the frame's height (a wide frame) and the name about as tall.
    const markHeight = given ? given.height : Math.round(Math.min(ctx.frame.height * 0.15, ctx.frame.width * 0.13));
    const markWidth = given ? given.width : Math.round(markHeight * picture.width / picture.height);
    const gap = Math.round(markHeight * 0.22);
    const label = name ? textLayer(ctx, { part: "name", text: name, role: "logo", step: "h2", size: Math.round(markHeight * 0.85), box: { x: 0, y: 0, width: ctx.frame.width * 4, height: ctx.frame.height }, align: "left", face: "display", maxLines: 1 }) : null;
    const lockupWidth = markWidth + (label ? gap + label.width : 0);
    // The lockup is centered in the frame; your own mark stays where it is.
    const markX = given ? given.x : Math.round(ctx.frame.width / 2 - lockupWidth / 2);
    const markY = given ? given.y : Math.round(ctx.frame.height / 2 - markHeight / 2);
    const mark = given ?? ctx.add("mark", createLayer("image", { name: "Logo", src: picture.src, x: markX, y: markY, width: markWidth, height: markHeight, role: "logo" }));
    const animateMark = (key, animation) => (given ? ctx.animate(given.id, key, animation, "logo") : ctx.animate(mark, key, animation));
    // The mark lands centered on its own, then the lockup slides left as the name types on (made
    // mark only; your own mark keeps its place).
    const shift = given || !label ? 0 : Math.round(ctx.frame.width / 2 - (markX + markWidth / 2));
    const x = mark.x;
    if (ctx.reduced) animateMark("in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.3, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    else {
      animateMark("in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.1, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
      animateMark("land", motion({ name: "Land", kind: "in", start: ctx.start, duration: LOGO_SETTLE, easing: EXPO_OUT,
        from: { scaleX: LOGO_FROM * (mark.scaleX ?? 1), scaleY: LOGO_FROM * (mark.scaleY ?? 1), x: x + shift }, to: { scaleX: mark.scaleX ?? 1, scaleY: mark.scaleY ?? 1, x: x + shift } }));
    }
    let done = round(ctx.start + (ctx.reduced ? 0.3 : LOGO_SETTLE));
    let typed = null;
    if (label) {
      const typeAt = round(ctx.start + LOGO_SETTLE + 0.1);
      typed = ctx.add("name", { ...label, x: mark.x + markWidth + gap, y: Math.round(mark.y + markHeight / 2 - label.height / 2), fill: ctx.style.colors.text, name });
      done = writeOn(ctx, typed, { unit: "letters", start: typeAt, every: LETTER_EVERY, gray: LETTER_GRAY, darken: LETTER_DARKEN });
      if (shift && !ctx.reduced) {
        const slide = { start: typeAt, duration: round(done - typeAt), easing: CURVES.drift };
        animateMark("center", motion({ name: "Stay centered", ...slide, from: { x: x + shift }, to: { x } }));
        ctx.animate(typed, "center", motion({ name: "Stay centered", kind: "in", ...slide, from: { x: typed.x + shift }, to: { x: typed.x } }));
      }
    }
    let end = round(Math.max(ctx.end, done + Math.max(readTime(name ?? ""), 0.8)));
    if (input.header !== true && !given) holdPush(ctx, [mark, typed].filter(Boolean), done, end);
    if (input.header === true) {
      // Shrink to 40% about the lockup's middle and rise 12% of the frame: a header.
      const at = round(done + 0.5);
      const pivot = centerOf({ x: mark.x, y: mark.y, width: lockupWidth, height: markHeight });
      const rise = Math.round(ctx.frame.height * 0.12);
      for (const layer of [mark, typed].filter(Boolean)) {
        const small = scaledAbout(layer, pivot, 0.4);
        const animation = motion({ name: "Become a header", start: at, duration: 0.6, easing: EXPO_OUT,
          from: { x: layer.x, y: layer.y, scaleX: layer.scaleX ?? 1, scaleY: layer.scaleY ?? 1 }, to: { x: small.x, y: small.y - rise, scaleX: 0.4 * (layer.scaleX ?? 1), scaleY: 0.4 * (layer.scaleY ?? 1) } });
        if (layer === mark) animateMark("header", animation); else ctx.animate(layer, "header", animation);
      }
      end = round(Math.max(ctx.end, at + 0.6 + 0.3));
    }
    return { end };
  },
};

// ---- count-up -----------------------------------------------------------------------------
const COUNT_SECONDS = 1;

export const countUp = {
  name: "count-up",
  about: "a big number in the accent color counts up to your stat (quart-out: most of the count early, the last digits slow; digits all one width so it never jitters), then a label writes on under it word by word, gray to full",
  fits: "one stat worth a beat of its own: a percentage, a price, a multiple",
  tags: ["type-counter", "type-words"],
  length: 2.6,
  fields: {
    value: { kind: "text", max: 16, about: "the stat as it should read at the end, with its prefix and suffix: 98%, $1.2M, 3x, 10,000+; or give layer" },
    layer: { kind: "layer", about: "your own text layer holding the stat (its text, such as 98%): it counts up in its own font, size, color and place" },
    label: { kind: "text", max: 40, about: "the words under it, such as codebase context" },
    from: { kind: "number", low: -1e9, high: 1e9, about: "where the count starts (default 0)" },
    count: { kind: "number", low: 0.4, high: 3, about: "seconds the count takes (default 1)" },
  },
  oneOf: [["value", "layer"]],
  example: { value: "98%", label: "codebase context", at: 0.3 },
  setup: "none",
  build(ctx, input) {
    if (input.layer) return countOn(ctx, input, yourText(ctx, input.layer, "layer"));
    const parsed = parseCounterText(input.value);
    if (!parsed) throw new Error(`count-up: value "${input.value}" has no number in it; give one such as 98%, $1.2M or 3x.`);
    const decimals = (String(input.value).match(/\d+\.(\d+)/)?.[1] ?? "").length;
    const safe = safeArea(ctx.frame);
    const box = { x: safe.x, y: safe.y, width: safe.width, height: safe.height };
    // The number 14% of the frame's height (the study's 8 to 15%), the label 5%.
    const number = textLayer(ctx, { part: "number", text: input.value, role: "headline", step: "display", size: Math.round(Math.min(ctx.frame.height * 0.14, ctx.frame.width * 0.18)), box, align: "center", color: "accent", maxLines: 1 });
    const label = input.label ? textLayer(ctx, { part: "label", text: input.label, role: "body", step: "body", size: Math.round(Math.min(ctx.frame.height * 0.05, ctx.frame.width * 0.06)), box, align: "center", face: "body", maxLines: 2 }) : null;
    const gap = label ? Math.round(label.fontSize * 0.2) : 0;
    const top = Math.round(ctx.frame.height / 2 - (number.height + (label ? gap + label.height : 0)) / 2);
    // Left-aligned where the final number is centered, so a shorter number early in the count
    // never shifts the place the digits grow from.
    const made = ctx.add("number", { ...number, y: top, tabularNumbers: true, textAlign: "left", name: input.value });
    const inked = layoutText({ ...made, width: ctx.frame.width * 4 }, ctx.fonts).lines[0].width ?? made.width;
    made.width = Math.ceil(inked + made.fontSize * 0.3);
    made.x = Math.round(ctx.frame.width / 2 - inked / 2);
    const seconds = input.count ?? COUNT_SECONDS;
    ctx.animate(made, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.12, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(made, "count", { name: "Count up", kind: "counter", start: round(ctx.start), duration: round(seconds), easing: [...QUART_OUT],
      from: input.from ?? 0, to: parsed.value, step: 10 ** -decimals, out: null, in: null });
    let done = round(ctx.start + seconds);
    const parts = [made];
    if (label) {
      const words = ctx.add("label", { ...label, y: top + number.height + gap, name: input.label });
      parts.push(words);
      done = writeOn(ctx, words, { unit: "words", start: round(ctx.start + seconds + 0.2), every: WORD_EVERY, gray: WORD_GRAY, darken: WORD_DARKEN });
    }
    const end = round(Math.max(ctx.end, done + Math.max(readTime(`${input.value} ${input.label ?? ""}`), 0.8)));
    holdPush(ctx, parts, done, end);
    return { end };
  },
};

// count-up on your text layer: it counts to its own text; a label (if given) writes on under it,
// centered on it, in the move's own body style.
function countOn(ctx, input, { layer, animate }) {
  const parsed = parseCounterText(layer.text);
  if (!parsed) throw new Error(`count-up layer: ${layer.id} reads "${layer.text}", with no number in it; its text is the stat, such as 98%.`);
  const decimals = (String(layer.text).match(/\d+\.(\d+)/)?.[1] ?? "").length;
  const seconds = input.count ?? COUNT_SECONDS;
  const full = layer.opacity ?? 1;
  animate(layer, "in", motion({ name: "Fade in", kind: "in", start: ctx.start, duration: 0.12, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: full } }));
  animate(layer, "count", { name: "Count up", kind: "counter", start: round(ctx.start), duration: round(seconds), easing: [...QUART_OUT],
    from: input.from ?? 0, to: parsed.value, step: 10 ** -decimals, out: null, in: null });
  if (!layer.tabularNumbers) ctx.note(`${layer.id} has no tabularNumbers: its digits may shift while it counts (set tabularNumbers true on it)`);
  let done = round(ctx.start + seconds);
  const parts = [layer];
  if (input.label) {
    const size = Math.round(Math.min(ctx.frame.height * 0.05, ctx.frame.width * 0.06, layer.fontSize * 0.4));
    const label = textLayer(ctx, { part: "label", text: input.label, role: "body", step: "body", size, box: { x: 0, y: 0, width: Math.max(layer.width, size * 12), height: ctx.frame.height }, align: "center", face: "body", maxLines: 2 });
    const words = ctx.add("label", { ...label, x: Math.round(layer.x + layer.width / 2 - label.width / 2), y: Math.round(layer.y + layer.height + label.fontSize * 0.2), name: input.label });
    parts.push(words);
    done = writeOn(ctx, words, { unit: "words", start: round(ctx.start + seconds + 0.2), every: WORD_EVERY, gray: WORD_GRAY, darken: WORD_DARKEN });
  }
  const end = round(Math.max(ctx.end, done + Math.max(readTime(`${layer.text} ${input.label ?? ""}`), 0.8)));
  holdPush(ctx, parts, done, end, animate);
  return { end };
}
