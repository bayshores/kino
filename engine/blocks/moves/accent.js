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
//
// Pictures, clips and groups (and a sweep at a slant on text or a shape): the overlay is a mask
// group holding a white copy of your layer (its own alpha, engine/blocks/subject.js) under a
// rectangle of the color or the band, so the color lands only where your layer draws; the glow
// is on the group, so its halo spreads past the edges as it does on text.
import { createLayer } from "../../model.js";
import { layoutText, resizeTextLayer } from "../../textLayout.js";
import { enabledAnimations } from "../../animationEnabled.js";
import { withTextStyleRange } from "../../textStyleRanges.js";
import { easingAt } from "../../easing.js";
import { behaviorKeys } from "../../behavior.js";
import { CURVES, effect, hide, motion, round, show } from "./kit.js";

const COLORED = ["text", "rectangle", "ellipse", "star", "path"];
// Drawn through a white copy of the layer: the color takes the layer's own alpha.
const CLIPPED = ["image", "video", "group"];
// The ease field: a named curve, or linear (the sweep's default: a light passing never slows).
const EASES = ["linear", ...Object.keys(CURVES)];
const curveOf = (name, fallback) => (name === undefined ? fallback : name === "linear" ? LINEAR : CURVES[name]);
const HEX = /^#[0-9a-f]{6}$/i;
// The overlay copies the moves of these: your layer's place, size and turn.
const FOLLOW = new Set(["x", "y", "scaleX", "scaleY", "rotation", "skewX", "skewY", "width", "height"]);
// Two frames at 30 fps: the color is on before the eye sees it change.
const FLASH = 0.067;
const REDUCED_FLASH = 0.15;
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
    // A behavior or a stepped (discrete) track may name keys that were cut: they go too.
    const { id, shadowChannels, discrete, behavior, ...rest } = animation;
    const wiggle = behavior && behaviorKeys(behavior).every((key) => keep.has(key));
    // Keys are cut the same way (their first and last value are from and to).
    const keys = Array.isArray(rest.keys) ? rest.keys.map((key) => ({ ...key, value: pick(key.value, keep) })) : rest.keys;
    return [{ ...rest, from, to, ...(keys ? { keys } : {}), ...(wiggle ? { behavior } : {}) }];
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
  if (!COLORED.includes(layer.type)) throw new Error(`${move} colors a text, shape, picture, clip or group layer; ${layer.id} is a ${layer.type}.`);
  onScreen(ctx, move, layer);
  const { id, name, animations, parentId, move: made, textStyleRanges, shadow, ...rest } = layer;
  const ranges = overlayRanges(layer, hit);
  const copy = ctx.add("overlay", createLayer(layer.type, { ...rest, ...props, ...(ranges ? { textStyleRanges: ranges } : {}), role: "decor", allowOverlap: true }), { above: layer.id });
  motionsOf(layer, fades ? new Set([...FOLLOW, "opacity"]) : FOLLOW)
    .forEach((animation, index) => ctx.animate(copy, `follow-${index + 1}`, animation));
  return copy;
}

function onScreen(ctx, move, layer) {
  if (!ctx.shownAt(layer.id, ctx.start)) throw new Error(`${move}: ${layer.id} is not on screen at ${ctx.start} s; start the move while it shows.`);
}

/**
 * The overlay for a layer drawn through its own alpha: a mask group (in your layer's group, just
 * above it) holding a white copy of your layer that follows its moves of place, size and turn,
 * and `paint` (a layer of the color, in the group's coordinates) over it. The group follows your
 * layer's fades when `fades`. Returns {group, paint}.
 */
function clippedOverlay(ctx, move, layer, paint, { fades = false, opacity } = {}) {
  if (![...COLORED, ...CLIPPED].includes(layer.type)) throw new Error(`${move} colors a text, shape, picture, clip or group layer; ${layer.id} is a ${layer.type}.`);
  if (layer.isMask) throw new Error(`${move}: ${layer.id} is a mask; give the layer it masks or its group.`);
  onScreen(ctx, move, layer);
  const subject = ctx.subject(layer.id);
  const holder = layer.parentId ? ctx.sceneLayers().find((entry) => entry.id === layer.parentId) : null;
  const group = ctx.add("overlay", createLayer("group", { name: "Overlay", x: 0, y: 0, width: holder?.width ?? ctx.frame.width, height: holder?.height ?? ctx.frame.height,
    opacity: opacity ?? (fades ? layer.opacity ?? 1 : 1), isMaskGroup: true, role: "decor", allowOverlap: true }), { above: layer.id });
  const mask = subject.mask("overlay-mask", "top", group);
  motionsOf(layer, FOLLOW).forEach((animation, index) => ctx.animate(mask, `follow-${index + 1}`, animation));
  if (fades) motionsOf(layer, new Set(["opacity"])).forEach((animation, index) => ctx.animate(group, `fade-${index + 1}`, animation));
  return { group, paint: ctx.add("overlay-paint", createLayer(paint.type ?? "rectangle", { name: "Overlay paint", ...paint, role: "decor", allowOverlap: true }), "top", group) };
}

/** Refuses a move whose own opacity steps would fight a fade of the layer during [start, end]. */
function steadyOpacity(move, layer, start, end) {
  const fading = motionsOf(layer, new Set(["opacity"])).find((animation) => animation.start < end && animation.start + animation.duration > start);
  if (fading) throw new Error(`${move}: ${layer.id} fades during the move (${round(fading.start)} to ${round(fading.start + fading.duration)} s); start it after the entrance and end it before the exit.`);
}

// The glow effect's largest radius in px (engine/effects/light.js).
const HALO_MOST = 400;
const glowTo = (color, radius, strength) => ({ strength, radius: round(radius, 1), threshold: 0, softness: 0, color, colorMix: 1, passes: 2 });

export const accentHit = {
  name: "accent-hit",
  needsAt: true,
  // A layer inside a group works as itself: the overlay goes beside it in its group.
  nested: ["layer"],
  about: "a word, shape or picture flashes to one color with a glow that blooms and decays back in a few frames (a verb as it is said): color only where it means something",
  fits: "the one word that matters in a line, a verb as it is said, a button pressed, a status that turns on",
  tags: ["accent-hit"],
  length: FLASH + 0.1 + 0.2,
  lasts: "not needed: flash, hold and decay (each repeat)",
  fields: {
    layer: { kind: "layer", required: true, about: "the layer that is hit: text, shape, path, picture, clip or group (a picture takes the color only where it is not see-through)" },
    word: { kind: "text", max: 60, about: "only this word (or words) of a text layer is hit (default the whole layer)" },
    color: { kind: "text", max: 7, about: "the hit color, hex (default the brand accent)" },
    glow: { kind: "number", low: 0, high: 80, about: "the glow's radius in px at 1080p (default 30; 0: no glow)" },
    hold: { kind: "number", low: 0, high: 10, about: "seconds the color holds at full (default 0.1)" },
    decay: { kind: "number", low: 0.1, high: 2, about: "seconds back to the layer's own color (default 0.2)" },
    ease: { kind: "choice", values: EASES, about: "the curve of the flash, decay and glow (default arrive)" },
    repeat: { kind: "number", low: 1, high: 6, whole: true, about: "hits one after another (default 1)" },
  },
  example: { layer: "prompt", word: "issues", color: "#FF4F9A", at: 1 },
  setup: "prompt, a text layer",
  // Reduced, each flash is gentler (REDUCED_FLASH), so the span is timed with it.
  timing: (input, { reduced = false } = {}) => ({ length: ((reduced ? REDUCED_FLASH : FLASH) + (input.hold ?? 0.1) + (input.decay ?? 0.2)) * (input.repeat ?? 1) }),
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const color = colorOf(ctx, "accent-hit", input.color);
    if (input.word && layer.type !== "text") throw new Error(`accent-hit word: ${layer.id} is a ${layer.type}, not text.`);
    const range = input.word ? wordRange(layer.text, input.word) : null;
    const hold = input.hold ?? 0.1;
    const decay = input.decay ?? 0.2;
    const flash = ctx.reduced ? REDUCED_FLASH : FLASH;
    const repeat = input.repeat ?? 1;
    const easing = curveOf(input.ease, CURVES.arrive);
    const each = flash + hold + decay;
    const t = ctx.start;
    // The hit steps the copy's opacity on and off, so it cannot also follow a fade of the layer.
    steadyOpacity("accent-hit", layer, t, t + each * repeat);
    const full = layer.opacity ?? 1;
    // Text and shapes: a copy in the color. Pictures, clips and groups: the color through their alpha.
    const clipped = CLIPPED.includes(layer.type);
    // The paint covers far past the frame (a group inside a group may be offset): the mask shapes it.
    const cover = { x: -ctx.frame.width * 1.5, y: -ctx.frame.height * 1.5, width: ctx.frame.width * 4, height: ctx.frame.height * 4 };
    const hit = clipped ? clippedOverlay(ctx, "accent-hit", layer, { ...cover, fill: color }, { opacity: 0 }) : null;
    const copy = hit ? hit.group : overlay(ctx, "accent-hit", layer, range ? { fill: "#00000000", opacity: 0 } : { fill: color, opacity: 0 },
      { hit: range && { ...range, color } });
    const radius = (input.glow ?? 30) * ctx.scale;
    for (let index = 0; index < repeat; index += 1) {
      const at = t + each * index;
      const key = (name) => (index ? `${name}-${index + 1}` : name);
      ctx.animate(copy, key("flash"), motion({ name: "Accent on", start: at, duration: flash, easing, from: { opacity: 0 }, to: { opacity: full } }));
      ctx.animate(copy, key("decay"), motion({ name: "Accent decay", start: at + flash + hold, duration: decay, easing, from: { opacity: full }, to: { opacity: 0 } }));
      if (!ctx.reduced && radius > 0) {
        // The glow blooms while the color is on and decays with it (keepStill off: no glow outside).
        ctx.animate(copy, key("bloom"), effect({ name: "Bloom", effect: "glow", start: at, duration: flash + hold, easing, from: { strength: 0 }, to: glowTo(color, radius, 1.6), keepStill: "off" }));
        ctx.animate(copy, key("fade"), effect({ name: "Bloom decay", effect: "glow", start: at + flash + hold, duration: decay, easing, from: { strength: 1.6 }, to: glowTo(color, radius, 0), keepStill: "off" }));
      }
    }
    ctx.animate(copy, "hide", hide(t + each * repeat));
    return { end: round(t + each * repeat), tags: accentHit.tags };
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
/** A layer's box height and the part its lines fill top to bottom, as shares of it: {height, lo, hi}. */
export function inkRows(layer, fonts) {
  if (layer.type !== "text") return { height: layer.height, lo: 0, hi: 1 };
  const measured = resizeTextLayer(layer, fonts);
  const height = Math.max(1, measured.height);
  const lines = layoutText(measured, fonts).lines ?? [];
  if (!lines.length) return { height, lo: 0, hi: 1 };
  const top = Math.max(0, Math.min(...lines.map((line) => line.y - line.ascent)));
  const bottom = Math.min(height, Math.max(...lines.map((line) => line.y + line.descent)));
  return bottom > top ? { height, lo: top / height, hi: bottom / height } : { height, lo: 0, hi: 1 };
}
// Keyframes of the band's crossing: between them its stops move in straight lines.
const SWEEP_STEPS = 10;
// The way the light travels, as the angle of its path (0: to the right, 90: down).
const HEADINGS = { right: 0, down: 90, left: 180, up: 270 };
const SWEEP_LENGTH = 1.2;

/**
 * The band's rectangle for a sweep through the layer's alpha: centered on the layer's box,
 * turned to the light's path (`heading` degrees) and long and wide enough that the band, crossing
 * it from end to end, crosses every corner of the box. In the layer's own group's coordinates.
 */
export function sweepRect(box, heading, rotation = 0) {
  const turn = heading * Math.PI / 180;
  const cos = Math.abs(Math.cos(turn));
  const sin = Math.abs(Math.sin(turn));
  // 4% more each way: a layer scaled unevenly at a slant stays covered.
  const width = Math.ceil((box.width * cos + box.height * sin) * 1.04) + 2;
  const height = Math.ceil((box.width * sin + box.height * cos) * 1.04) + 2;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return { x: round(middle.x - width / 2), y: round(middle.y - height / 2), width, height, rotation: round(heading + rotation) };
}

export const lightSweep = {
  name: "light-sweep",
  needsAt: true,
  nested: ["layer"],
  about: "a band of light in one color, with a soft halo, travels once across a word, a shape or a picture's solid part, left to right by default (a sign-off)",
  fits: "a name, wordmark or logo just landed; once, not on every line",
  tags: ["light-sweep"],
  length: SWEEP_LENGTH,
  shortest: 0.4,
  fields: {
    layer: { kind: "layer", required: true, about: "the layer the light crosses: text, shape, path, picture, clip or group" },
    color: { kind: "text", max: 7, about: "the light's color, hex (default the brand accent)" },
    width: { kind: "text", max: 12, about: "the band's width: \"2ch\" (characters; default for text and shapes going sideways), \"30%\" of the layer (25% default for pictures, clips and groups; up or down, a quarter of the lines' height), or \"120px\"" },
    direction: { kind: "choice", values: Object.keys(HEADINGS), about: "the way the light travels (default right)" },
    angle: { kind: "number", low: -60, high: 60, about: "degrees the band leans from straight across its path (default 0; 20 is a classic sheen)" },
    ease: { kind: "choice", values: EASES, about: "the band's speed across (default linear: a passing light never slows)" },
    repeat: { kind: "number", low: 1, high: 6, whole: true, about: "times the light crosses (default 1), each taking the same time" },
  },
  example: { layer: "prompt", at: 1 },
  setup: "prompt, a text layer",
  timing: (input) => ({ length: round(SWEEP_LENGTH * (input.repeat ?? 1)) }),
  build(ctx, input) {
    const layer = ctx.layer(input.layer, "layer");
    const color = colorOf(ctx, "light-sweep", input.color);
    const direction = input.direction ?? "right";
    const lean = input.angle ?? 0;
    const repeat = input.repeat ?? 1;
    const curve = curveOf(input.ease, LINEAR);
    // Text and shapes with an upright band: the copy's own fill is the band (as always). Pictures,
    // clips, groups and a leaning band: the band is a turned rectangle through the layer's alpha.
    const clipped = CLIPPED.includes(layer.type) || lean !== 0;
    const sized = layer.type === "text" ? resizeTextLayer(layer, ctx.fonts) : layer;
    const size = layer.type === "text" ? layer.fontSize ?? 40 : layer.height;
    const across = direction === "down" || direction === "up";
    // The gradient spans the layer's box; the light crosses only the letters in it (a wide box
    // with centered words would leave the band crossing empty space most of the time).
    const span = clipped ? null : across ? inkRows(layer, ctx.fonts) : inkSpan(layer, ctx.fonts);
    const rect = clipped ? sweepRect({ x: sized.x, y: sized.y, width: sized.width, height: sized.height }, HEADINGS[direction] + lean, layer.rotation ?? 0) : null;
    const length = clipped ? rect.width : across ? span.height : span.width;
    // Going left or up the gradient runs backwards (offset 0 at the far edge), so the ink's span flips.
    const [lo, hi] = !span ? [0, 1] : direction === "left" || direction === "up" ? [1 - span.hi, 1 - span.lo] : [span.lo, span.hi];
    // A picture, clip or group has no characters: its band is a quarter of its width by default.
    // Up or down, an upright band is a quarter of the lines' (or shape's) height: "2ch" would cover it.
    const asked = input.width ?? (CLIPPED.includes(layer.type) ? "25%" : across && !clipped ? `${round(25 * (hi - lo))}%` : "2ch");
    const share = Math.min(0.8 * (hi - lo), Math.max(0.04 * (hi - lo), bandWidth(asked, length, size) / Math.max(1, length)));
    const t = ctx.start;
    const end = round(t + ctx.duration);
    // An upright band runs the copy's gradient the light's way (left and up: from the far edge).
    const angle = clipped ? 0 : HEADINGS[direction];
    const paintOf = (fill) => (clipped ? { ...rect, fill } : { fill });
    const makeCopy = (fill) => {
      if (!clipped) return { copy: overlay(ctx, "light-sweep", layer, { fill }, { fades: true }) };
      const made = clippedOverlay(ctx, "light-sweep", layer, paintOf(fill), { fades: true });
      // The band follows the layer's moves too, about the same middle (its own turn added).
      const dx = rect.x - layer.x, dy = rect.y - layer.y, turned = rect.rotation - (layer.rotation ?? 0);
      motionsOf(layer, new Set(["x", "y", "scaleX", "scaleY", "rotation"])).forEach((animation, index) => {
        const shift = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) =>
          [key, key === "x" ? value + dx : key === "y" ? value + dy : key === "rotation" ? value + turned : value]));
        const keys = animation.keys?.map((key) => ({ ...key, value: shift(key.value) }));
        ctx.animate(made.paint, `follow-${index + 1}`, { ...animation, from: shift(animation.from), to: shift(animation.to), ...(keys ? { keys } : {}) });
      });
      return { copy: made.group, paint: made.paint };
    };
    const bandAt = (middle) => ({ ...band(color, middle, share), angle });
    if (ctx.reduced) {
      // No sweep: the layer turns the color and back (by its fill, so the copy can follow a fade
      // of your layer); on and off never overlap, however short the move.
      const clear = `${color}00`;
      const on = Math.min(0.2, ctx.duration / 2);
      const off = Math.max(t + on, end - 0.3);
      const { copy, paint } = makeCopy(clear);
      const target = paint ?? copy;
      ctx.animate(target, "on", motion({ name: "Color on", start: t, duration: on, easing: CURVES.fade, from: { fill: clear }, to: { fill: color } }));
      ctx.animate(target, "off", motion({ name: "Color off", start: off, duration: round(end - off), easing: CURVES.fade, from: { fill: color }, to: { fill: clear } }));
      ctx.animate(copy, "show", show(t));
      ctx.animate(copy, "hide", hide(end));
      return { end, tags: [] };
    }
    // The band's middle crosses from just outside one edge to just outside the other, linear by
    // default (a light passing never slows), so it never stops or jumps.
    const from = lo - share / 2;
    const travel = hi - lo + share;
    // Linear keeps the old order of operations, so an old sweep's stops round the same.
    const middleAt = (step) => from + (curve === LINEAR ? travel * step / SWEEP_STEPS : travel * easingAt(curve, step / SWEEP_STEPS));
    // The copy follows a fade of your layer too: a sign-off that fades takes its light with it.
    const { copy, paint } = makeCopy(bandAt(from));
    const target = paint ?? copy;
    const pass = ctx.duration / repeat;
    const stepLength = pass / SWEEP_STEPS;
    for (let crossing = 0; crossing < repeat; crossing += 1)
      for (let step = 0; step < SWEEP_STEPS; step += 1)
        ctx.animate(target, `sweep-${crossing ? `${crossing + 1}-` : ""}${step + 1}`, motion({ name: "Light sweep", start: t + crossing * pass + step * stepLength, duration: stepLength, easing: LINEAR,
          from: { fill: bandAt(middleAt(step)) }, to: { fill: bandAt(middleAt(step + 1)) } }));
    // The halo: the band glows (only it has color), wide and soft. A tall picture (a full-frame clip
    // over 1142 px high) would ask for more than the glow's largest radius, so it takes that.
    ctx.animate(copy, "halo", effect({ name: "Halo", effect: "glow", start: t, duration: ctx.duration, easing: CURVES.fade, to: glowTo(color, Math.min(HALO_MOST, size * 0.35), 1.2), keepStill: "off" }));
    ctx.animate(copy, "show", show(t));
    ctx.animate(copy, "hide", hide(end));
    return { end, tags: lightSweep.tags };
  },
};
