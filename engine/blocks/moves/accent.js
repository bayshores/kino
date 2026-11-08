// Color only as meaning: one accent color,
// on one word or shape, for a moment, with light around it.
//
// Both moves draw on a copy of your layer laid exactly over it (the "overlay"), so your layer
// keeps its own color, gradient and styled words, and taking the move away leaves it as it was.
// The overlay follows your layer's moves of place, size and turn (light-sweep's also its fades;
// accent-hit refuses a layer that fades during it), keeps the sizes and fonts of its styled words
// so the letters line up, is hidden outside the move and glows only where it has color (glow
// threshold 0 lights every opaque pixel, and the rest of the overlay is transparent).
//
// - accent-hit: the overlay flashes in the color (2 frames) while its glow blooms, holds, and
//   decays back to your layer's own color in `decay` seconds (4 to 8 frames by default).
// - light-sweep: the overlay's fill is a gradient that is transparent except one band of the
//   color; the band travels across the layer once and the glow is its soft halo.
// Reduced motion: no glow and no sweep, the layer just turns the color and back.
import { createLayer } from "../../model.js";
import { layoutText, resizeTextLayer } from "../../textLayout.js";
import { enabledAnimations } from "../../animationEnabled.js";
import { withTextStyleRange } from "../../textStyleRanges.js";
import { CURVES, effect, hide, motion, round, show } from "./kit.js";

const COLORED = ["text", "rectangle", "ellipse", "star", "path"];
const HEX = /^#[0-9a-f]{6}$/i;
// The overlay copies the moves of these: your layer's place, size and turn.
const FOLLOW = new Set(["x", "y", "scaleX", "scaleY", "rotation", "skewX", "skewY", "width", "height"]);
// Two frames at 30 fps: the color is on before the eye sees it change.
const FLASH = 0.067;
const LINEAR = [0, 0, 1, 1];

function colorOf(ctx, move, value) {
  const color = value ?? ctx.style.colors.accent;
  if (!HEX.test(color)) throw new Error(`${move} color is a hex color such as "#FF4F9A" (default the brand accent).`);
  return color.toUpperCase();
}

/** Where `word` (whole words, case ignored) first is in `text`: {start, end}. */
export function wordRange(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, "iu").exec(text);
  if (!found) throw new Error(`accent-hit word: "${word}" is not in "${text}".`);
  const start = found.index + found[1].length;
  return { start, end: start + found[2].length };
}

const pick = (values, keep) => Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => keep.has(key)));
// The layer's own operations that move it (in order), each cut down to the `keep` keys.
function motionsOf(layer, keep) {
  return enabledAnimations(layer.animations ?? []).flatMap((animation) => {
    if (!animation || !["in", "out", "custom"].includes(animation.kind) || (animation.unit && animation.unit !== "layer")) return [];
    const from = pick(animation.from, keep);
    const to = pick(animation.to, keep);
    if (!Object.keys(from).length && !Object.keys(to).length) return [];
    // A wiggle or a stepped (discrete) track may name keys that were cut: they go too.
    const { id, shadowChannels, discrete, behavior, ...rest } = animation;
    const amount = behavior?.wiggle?.amount;
    const wiggle = behavior && (typeof amount !== "object" || Object.keys(amount).every((key) => keep.has(key)));
    return [{ ...rest, from, to, ...(wiggle ? { behavior } : {}) }];
  });
}

/**
 * The text style ranges the overlay keeps: your layer's own (size, weight, font, spacing) so its
 * letters lay out exactly as yours, without their colors, and `hit` ({start, end, color}) on top.
 */
function overlayRanges(layer, hit) {
  if (layer.type !== "text") return undefined;
  const ranges = (layer.textStyleRanges ?? []).map(({ start, end, style: { fill, ...style } }) => ({ start, end, style }))
    .filter((range) => Object.keys(range.style).length);
  const styled = hit ? withTextStyleRange({ text: layer.text, textStyleRanges: ranges }, hit.start, hit.end, { fill: hit.color }).textStyleRanges : ranges;
  return styled?.length ? styled : undefined;
}

/**
 * The overlay: your layer copied over it, hidden, with no shadow and no animations of its own
 * except your layer's moves of place, size and turn (and of opacity when `fades`), so the color
 * stays on your letters while they slide, rise or drift. `hit` colors one word only.
 */
function overlay(ctx, move, layer, props, { hit, fades = false } = {}) {
  if (!COLORED.includes(layer.type)) throw new Error(`${move} colors a text or shape layer; ${layer.id} is a ${layer.type}.`);
  if (!ctx.shownAt(layer.id, ctx.start)) throw new Error(`${move}: ${layer.id} is not on screen at ${ctx.start} s; start the move while it shows.`);
  const { id, name, animations, parentId, move: made, textStyleRanges, shadow, ...rest } = layer;
  const ranges = overlayRanges(layer, hit);
  const copy = ctx.add("overlay", createLayer(layer.type, { ...rest, ...props, ...(ranges ? { textStyleRanges: ranges } : {}), role: "decor", allowOverlap: true }), { above: layer.id });
  motionsOf(layer, fades ? new Set([...FOLLOW, "opacity"]) : FOLLOW)
    .forEach((animation, index) => ctx.animate(copy, `follow-${index + 1}`, animation));
  return copy;
}

/** Refuses a move whose own opacity steps would fight a fade of the layer during [start, end]. */
function steadyOpacity(move, layer, start, end) {
  const fading = motionsOf(layer, new Set(["opacity"])).find((animation) => animation.start < end && animation.start + animation.duration > start);
  if (fading) throw new Error(`${move}: ${layer.id} fades during the move (${round(fading.start)} to ${round(fading.start + fading.duration)} s); start it after the entrance and end it before the exit.`);
}

const glowTo = (color, radius, strength) => ({ strength, radius: round(radius, 1), threshold: 0, softness: 0, color, colorMix: 1, passes: 2 });

export const accentHit = {
  name: "accent-hit",
  needsAt: true,
  // A layer inside a group works as itself: the overlay goes beside it in its group.
  nested: ["layer"],
  about: "a word or shape flashes to one color with a glow that blooms and decays back to its own color in a few frames (a verb as it is said): color only where it means something",
  fits: "the one word that matters in a line, a verb as it is said, a button pressed, a status that turns on",
  tags: ["accent-hit"],
  length: FLASH + 0.1 + 0.2,
  lasts: "not needed: flash, hold and decay",
  fields: {
    layer: { kind: "layer", required: true, about: "the text or shape layer that is hit" },
    word: { kind: "text", max: 60, about: "only this word (or words) of a text layer is hit (default the whole layer)" },
    color: { kind: "text", max: 7, about: "the hit color, hex (default the brand accent)" },
    glow: { kind: "number", low: 0, high: 80, about: "the glow's radius in px at 1080p (default 30; 0: no glow)" },
    hold: { kind: "number", low: 0, high: 10, about: "seconds the color holds at full (default 0.1)" },
    decay: { kind: "number", low: 0.1, high: 2, about: "seconds back to the layer's own color (default 0.2)" },
  },
  example: { layer: "prompt", word: "issues", color: "#FF4F9A", at: 1 },
  setup: "prompt, a text layer",
  timing: (input) => ({ length: FLASH + (input.hold ?? 0.1) + (input.decay ?? 0.2) }),
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const color = colorOf(ctx, "accent-hit", input.color);
    if (input.word && layer.type !== "text") throw new Error(`accent-hit word: ${layer.id} is a ${layer.type}, not text.`);
    const range = input.word ? wordRange(layer.text, input.word) : null;
    const hold = input.hold ?? 0.1;
    const decay = input.decay ?? 0.2;
    const flash = ctx.reduced ? 0.15 : FLASH;
    const t = ctx.start;
    // The hit steps the copy's opacity on and off, so it cannot also follow a fade of the layer.
    steadyOpacity("accent-hit", layer, t, t + flash + hold + decay);
    const copy = overlay(ctx, "accent-hit", layer, range ? { fill: "#00000000", opacity: 0 } : { fill: color, opacity: 0 },
      { hit: range && { ...range, color } });
    const full = layer.opacity ?? 1;
    ctx.animate(copy, "flash", motion({ name: "Accent on", start: t, duration: flash, easing: CURVES.arrive, from: { opacity: 0 }, to: { opacity: full } }));
    ctx.animate(copy, "decay", motion({ name: "Accent decay", start: t + flash + hold, duration: decay, easing: CURVES.arrive, from: { opacity: full }, to: { opacity: 0 } }));
    const radius = (input.glow ?? 30) * ctx.scale;
    if (!ctx.reduced && radius > 0) {
      // The glow blooms while the color is on and decays with it (keepStill off: no glow outside).
      ctx.animate(copy, "bloom", effect({ name: "Bloom", effect: "glow", start: t, duration: flash + hold, easing: CURVES.arrive, from: { strength: 0 }, to: glowTo(color, radius, 1.6), keepStill: "off" }));
      ctx.animate(copy, "fade", effect({ name: "Bloom decay", effect: "glow", start: t + flash + hold, duration: decay, easing: CURVES.arrive, from: { strength: 1.6 }, to: glowTo(color, radius, 0), keepStill: "off" }));
    }
    ctx.animate(copy, "hide", hide(t + flash + hold + decay));
    return { end: round(t + flash + hold + decay), tags: accentHit.tags };
  },
};

/** "2ch", "40%" or "120px" (or a number of px) as px across a layer `width` px wide set in `size` px type. */
export function bandWidth(value, width, size) {
  const match = /^(\d+(?:\.\d+)?)(ch|%|px)?$/.exec(String(value ?? "2ch").trim());
  if (!match) throw new Error(`light-sweep width is like "2ch" (characters), "30%" (of the layer) or "120px".`);
  const amount = Number(match[1]);
  // A character is about 0.6 of the type size wide.
  return match[2] === "%" ? width * amount / 100 : match[2] === "px" || !match[2] ? amount : amount * 0.6 * size;
}

/**
 * The overlay's fill with the band's middle at `middle` (0 the layer's left edge, 1 its right)
 * and `share` wide: transparent, rising to `color` at the middle and back. A band partly past an
 * edge is cut there (its stop at the edge takes the color the band has there), not squeezed.
 */
export function band(color, middle, share) {
  const half = share / 2;
  const alpha = (x) => Math.max(0, 1 - Math.abs(x - middle) / half);
  const at = (x) => Math.min(1, Math.max(0, x));
  const stop = (x) => ({ offset: round(at(x)), color: `${color}${Math.round(alpha(at(x)) * 255).toString(16).padStart(2, "0").toUpperCase()}` });
  return { type: "linear", angle: 0, stops: [stop(0), stop(middle - half), stop(middle), stop(middle + half), stop(1)] };
}
/** A layer's box width and the part its letters fill, as shares of it: {width, lo, hi}. */
export function inkSpan(layer, fonts) {
  if (layer.type !== "text") return { width: layer.width, lo: 0, hi: 1 };
  const measured = resizeTextLayer(layer, fonts);
  const width = Math.max(1, measured.width);
  const lines = layoutText(measured, fonts).lines ?? [];
  const widest = Math.min(width, Math.max(1, ...lines.map((line) => line.width)));
  const left = layer.textAlign === "center" ? (width - widest) / 2 : layer.textAlign === "right" ? width - widest : 0;
  return { width, lo: left / width, hi: (left + widest) / width };
}
// Keyframes of the band's crossing: between them its stops move in straight lines.
const SWEEP_STEPS = 10;

export const lightSweep = {
  name: "light-sweep",
  needsAt: true,
  nested: ["layer"],
  about: "a band of light in one color, with a soft halo, travels once across a word or a shape, left to right (a sign-off)",
  fits: "a name or wordmark that has just landed, a word that should catch the light; once, not on every line",
  tags: ["light-sweep"],
  length: 1.2,
  shortest: 0.4,
  fields: {
    layer: { kind: "layer", required: true, about: "the text or shape layer the light crosses" },
    color: { kind: "text", max: 7, about: "the light's color, hex (default the brand accent)" },
    width: { kind: "text", max: 12, about: "the band's width: \"2ch\" (default, characters), \"30%\" of the layer, or \"120px\"" },
  },
  example: { layer: "prompt", at: 1 },
  setup: "prompt, a text layer",
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const color = colorOf(ctx, "light-sweep", input.color);
    const size = layer.type === "text" ? layer.fontSize ?? 40 : layer.height;
    // The gradient spans the layer's box; the light crosses only the letters in it (a wide box
    // with centered words would leave the band crossing empty space most of the time).
    const { width, lo, hi } = inkSpan(layer, ctx.fonts);
    const share = Math.min(0.8 * (hi - lo), Math.max(0.04 * (hi - lo), bandWidth(input.width, width, size) / Math.max(1, width)));
    const t = ctx.start;
    const end = round(t + ctx.duration);
    if (ctx.reduced) {
      // No sweep: the layer turns the color and back (by its fill, so the copy can follow a fade
      // of your layer); on and off never overlap, however short the move.
      const clear = `${color}00`;
      const on = Math.min(0.2, ctx.duration / 2);
      const off = Math.max(t + on, end - 0.3);
      const copy = overlay(ctx, "light-sweep", layer, { fill: clear }, { fades: true });
      ctx.animate(copy, "on", motion({ name: "Color on", start: t, duration: on, easing: CURVES.fade, from: { fill: clear }, to: { fill: color } }));
      ctx.animate(copy, "off", motion({ name: "Color off", start: off, duration: round(end - off), easing: CURVES.fade, from: { fill: color }, to: { fill: clear } }));
      ctx.animate(copy, "show", show(t));
      ctx.animate(copy, "hide", hide(end));
      return { end, tags: [] };
    }
    // The band's middle crosses from just outside the left edge to just outside the right at one
    // speed (linear on purpose: a light passing never slows), so it never stops or jumps.
    const from = lo - share / 2;
    const across = hi - lo + share;
    const middleAt = (step) => from + across * step / SWEEP_STEPS;
    // The copy follows a fade of your layer too: a sign-off that fades takes its light with it.
    const copy = overlay(ctx, "light-sweep", layer, { fill: band(color, from, share) }, { fades: true });
    const length = ctx.duration / SWEEP_STEPS;
    for (let step = 0; step < SWEEP_STEPS; step += 1)
      ctx.animate(copy, `sweep-${step + 1}`, motion({ name: "Light sweep", start: t + step * length, duration: length, easing: LINEAR,
        from: { fill: band(color, middleAt(step), share) }, to: { fill: band(color, middleAt(step + 1), share) } }));
    // The halo: the band glows (only it has color), wide and soft.
    ctx.animate(copy, "halo", effect({ name: "Halo", effect: "glow", start: t, duration: ctx.duration, easing: CURVES.fade, to: glowTo(color, size * 0.35, 1.2), keepStill: "off" }));
    ctx.animate(copy, "show", show(t));
    ctx.animate(copy, "hide", hide(end));
    return { end, tags: lightSweep.tags };
  },
};
