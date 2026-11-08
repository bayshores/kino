// Short transitions between two shots, the kinds social editors offer first: zoom-blur, flash, light-leak, slice, glitch, blur-dissolve, card-tilt and shape-wipe.
// Each works on two of the scene's own layers, `from` (leaves) and `to` (arrives), like
// whip-pan, and lasts 0.3 to 0.6 s. The cut sits inside the move; align:"end" on the move op
// lands its last frame on a beat. Under reduced motion each is a plain cross-fade.
// Every move takes the shared ease and speed fields (move.js SHARED); colors and curves come
// from DEFAULTS through ctx.color and ctx.curve, so a field can change each one.
import { createLayer } from "../../model.js";
import { boxOf, effect, hide, motion, pointIn, round, scaledAbout, show } from "./kit.js";
import { crossFade, startClips } from "./transitions.js";
import { shared } from "../move.js";

// defaults:start (the only place cuts.js names a color or a curve; a guard test checks)
const DEFAULTS = Object.freeze({
  colors: Object.freeze({ flash: "#FFFFFF", leak: "#FFA04D", wash: "#FFF3E0", surface: "#1B1D21", mask: "#FFFFFF" }),
  curves: Object.freeze({
    // The most used curve in motion templates: a strong ease-out with a soft start.
    smooth: Object.freeze([0.5, 0, 0, 1]),
    accelerate: "accelerate", settle: "settle", fade: "fade", drift: "drift", leave: "leave", linear: "linear",
    // A band leaving: slow start, out fast.
    clear: Object.freeze([0.5, 0, 0.75, 0]),
    // Two frames off register: nearly a jump.
    jolt: Object.freeze([0.9, 0, 1, 0.1]),
  }),
});
// defaults:end
const COLORS = DEFAULTS.colors;
const CURVE = DEFAULTS.curves;

function pair(ctx, input, name) {
  const from = ctx.layer(input.from, "from");
  const to = ctx.layer(input.to, "to");
  if (from.id === to.id) throw new Error(`${name} needs two different layers.`);
  return { from, to };
}

/** `to` shows at `at` (a 0.04 s appear, so a clip starts there too); `from` hides a frame later. */
function cutAt(ctx, from, to, at) {
  // The new shot is whole a moment before the cut: a shot whose own hide or clip end falls on the
  // cut (one built as plain cuts) then never leaves a half-faded frame over the background.
  startClips(ctx, to.id, at - 0.04);
  ctx.animate(to.id, "in", motion({ name: "Appear", kind: "in", start: Math.max(0, at - 0.04), duration: 0.02, easing: ctx.curve(CURVE.fade), from: { opacity: 0 }, to: { opacity: 1 } }), "to");
  ctx.animate(from.id, "hide", hide(at + 0.02), "from");
}

/** The scale of a layer as drawn at the move's start, as {scaleX, scaleY}. */
function scaleNow(ctx, layer) {
  const state = ctx.stateAt(layer.id, ctx.start);
  return { x: round(state.x ?? layer.x, 1), y: round(state.y ?? layer.y, 1), scaleX: round(state.scaleX ?? 1, 4), scaleY: round(state.scaleY ?? 1, 4) };
}

/** A full-frame rectangle over everything (a flash or a color). */
function cover(ctx, part, name, fill, extra = {}) {
  return ctx.add(part, createLayer("rectangle", { name, x: 0, y: 0, width: ctx.frame.width, height: ctx.frame.height, fill, opacity: 0, role: "decor", allowOverlap: true, ...extra }));
}

/** A motion or effect record whose beat runs on the move's paced clock. */
const paced = (make, pace, { start, duration, ...rest }) => make({ ...pace.span(start, duration), ...rest });

const shots = { from: { kind: "layer", required: true, about: "the shot that leaves" }, to: { kind: "layer", required: true, about: "the shot that arrives" } };
const SETUP = "shot-a and shot-b, two full-frame pictures or videos";
const SPEED = shared("speed");

export const zoomBlur = {
  name: "zoom-blur",
  needsAt: true,
  about: "a quick punch into the shot with a radial zoom blur that peaks on the cut; the next shot lands out of the same blur, a little close, and settles",
  fits: "a quick cut on a beat",
  tags: ["zoom-through"],
  length: 0.4,
  shortest: 0.24,
  fields: {
    ...shots,
    point: { kind: "point", about: "[x, y] in % of from's box the zoom aims at (default its center)" },
    punch: { kind: "number", low: 1, high: 2.5, about: "how far the shot pushes in before the cut, as a scale (default 1.25)" },
    blur: { kind: "number", low: 0, high: 1, about: "the zoom blur at the cut (default 0.75); the next shot lands from about 3/4 of it" },
    settle: { kind: "number", low: 1, high: 1.6, about: "how close the next shot lands before it settles, as a scale (default 1.15)" },
    ...shared({ ease: "the curve of both halves (default speeding into the cut, easing out after)" }), ...SPEED,
  },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "zoom-blur");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const box = boxOf(from);
    const aim = pointIn(box, input.point);
    const middle = ctx.start + ctx.duration / 2;
    const half = ctx.duration / 2;
    const pace = ctx.pace(middle);
    const now = scaleNow(ctx, from);
    const punch = input.punch ?? 1.25;
    const peak = input.blur ?? 0.75;
    const lands = input.blur === undefined ? 0.55 : round(peak * 11 / 15);
    const into = ctx.ease(CURVE.accelerate);
    const out = ctx.ease(CURVE.smooth);
    const landed = scaledAbout(box, aim, punch);
    const center = { centerX: round((aim.x - box.x) / box.width), centerY: round((aim.y - box.y) / box.height) };
    ctx.animate(from.id, "push", paced(motion, pace, { name: "Punch in", start: ctx.start, duration: half, easing: into, from: now, to: { x: landed.x, y: landed.y, scaleX: round(now.scaleX * punch, 4), scaleY: round(now.scaleY * punch, 4) } }), "from");
    ctx.animate(from.id, "blur", paced(effect, pace, { name: "Zoom blur", effect: "zoom-blur", start: ctx.start, duration: half, easing: into, from: { amount: 0 }, to: { amount: peak, ...center } }), "from");
    cutAt(ctx, from, to, middle);
    ctx.animate(from.id, "unblur", paced(effect, pace, { name: "Zoom blur rests", effect: "zoom-blur", start: middle + 0.02, duration: 0.04, easing: ctx.curve(CURVE.fade), from: { amount: peak }, to: { amount: 0, ...center } }), "from");
    const big = input.settle ?? 1.15;
    ctx.animate(to.id, "settle", paced(motion, pace, { name: "Settle", start: middle, duration: half, easing: out,
      from: { scaleX: round(big * (to.scaleX ?? 1), 4), scaleY: round(big * (to.scaleY ?? 1), 4) }, to: { scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    ctx.animate(to.id, "blur", paced(effect, pace, { name: "Zoom blur", effect: "zoom-blur", start: middle, duration: half, easing: out, from: { amount: lands }, to: { amount: 0, centerX: 0.5, centerY: 0.5 } }), "to");
    return { end: ctx.end };
  },
};

export const flash = {
  name: "flash",
  needsAt: true,
  about: "the frame flashes to white (or a color) for a moment and the cut happens under the flash; the next shot eases back from a touch close",
  fits: "a hit, impact, a photo flash",
  tags: ["flash"],
  length: 0.3,
  shortest: 0.15,
  fields: { ...shots, ...shared({ color: `the flash color, hex (default ${COLORS.flash})`, ease: "the curve of the flash's fall and the settle (default a strong ease-out)" }), ...SPEED },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "flash");
    const fill = ctx.color("color", COLORS.flash);
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    // Up fast to full (a third of the move), the cut at the peak, then a longer fall.
    const peak = ctx.start + ctx.duration * 0.35;
    const pace = ctx.pace(peak);
    const fall = ctx.ease(CURVE.smooth);
    const layer = cover(ctx, "flash", "Flash", fill);
    ctx.animate(layer, "up", paced(motion, pace, { name: "Flash", start: ctx.start, duration: peak - ctx.start, easing: ctx.curve(CURVE.accelerate), from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(layer, "down", paced(motion, pace, { name: "Flash fades", start: peak, duration: ctx.end - peak, easing: fall, from: { opacity: 1 }, to: { opacity: 0 } }));
    ctx.animate(layer, "hide", hide(pace.at(ctx.end) + 0.01));
    cutAt(ctx, from, to, peak);
    ctx.animate(to.id, "settle", paced(motion, pace, { name: "Settle", start: peak, duration: Math.max(0.3, ctx.end - peak), easing: fall,
      from: { scaleX: round(1.04 * (to.scaleX ?? 1), 4), scaleY: round(1.04 * (to.scaleY ?? 1), 4) }, to: { scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    return { end: round(Math.max(ctx.end + 0.01, peak + 0.3)) };
  },
};

export const lightLeak = {
  name: "light-leak",
  needsAt: true,
  about: "a warm, soft light blooms across the frame from one side (screen blend), the shots cross under its brightest moment and the light drifts off",
  fits: "warm, filmic changes; not UI",
  tags: ["flash"],
  length: 0.6,
  shortest: 0.4,
  fields: {
    ...shots,
    ...shared({ color: `the light's color, hex (default warm amber ${COLORS.leak})`, accent: `the short wash at its brightest moment, hex (default ${COLORS.wash})` }),
    side: { kind: "choice", values: ["left", "right"], about: "where the light comes from (default a seeded left or right)" },
    ...shared({ ease: "the curve of the light's drift (default drift)" }), ...SPEED,
  },
  example: { from: "shot-a", to: "shot-b", at: 1, side: "left" },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "light-leak");
    const fill = ctx.color("color", COLORS.leak);
    const washColor = ctx.color("accent", COLORS.wash);
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const side = input.side ?? ctx.rng.pick(["left", "right"]);
    const sign = side === "left" ? 1 : -1;
    const { width, height } = ctx.frame;
    const big = Math.max(width, height);
    const peak = ctx.start + ctx.duration * 0.45;
    const pace = ctx.pace(peak);
    const fade = ctx.curve(CURVE.fade);
    // A large soft glow screened over the picture, drifting across.
    for (const [part, name, color, size, top] of [["glow", "Light leak", fill, 1.4, 0.9]]) {
      const w = Math.round(big * size);
      const h = Math.round(height * (size + 0.3));
      const y = Math.round((height - h) / 2);
      const startX = side === "left" ? -w * 0.75 : width - w * 0.25;
      const layer = ctx.add(part, createLayer("ellipse", { name, x: Math.round(startX), y, width: w, height: h, fill: color, opacity: 0, blur: Math.round(big * 0.2), blendMode: "screen", role: "decor", allowOverlap: true }));
      ctx.animate(layer, "drift", paced(motion, pace, { name: "Drift", start: ctx.start, duration: ctx.duration, easing: ctx.ease(CURVE.drift), from: { x: Math.round(startX) }, to: { x: Math.round(startX + sign * width * 0.55) } }));
      ctx.animate(layer, "up", paced(motion, pace, { name: "Bloom", start: ctx.start, duration: peak - ctx.start, easing: fade, from: { opacity: 0 }, to: { opacity: top } }));
      ctx.animate(layer, "down", paced(motion, pace, { name: "Fade", start: peak, duration: ctx.end - peak, easing: fade, from: { opacity: top }, to: { opacity: 0 } }));
      ctx.animate(layer, "hide", hide(pace.at(ctx.end) + 0.01));
    }
    // A short warm-white wash over the whole frame at the peak (0.3 s, so check counts it as a
    // planned flash): the brightest moment, which hides the change.
    const wash = cover(ctx, "wash", "Light leak wash", washColor, { blendMode: "screen" });
    const rise = Math.min(0.12, peak - ctx.start);
    ctx.animate(wash, "up", paced(motion, pace, { name: "Wash", start: peak - rise, duration: rise, easing: fade, from: { opacity: 0 }, to: { opacity: 0.9 } }));
    ctx.animate(wash, "down", paced(motion, pace, { name: "Wash fades", start: peak, duration: 0.16, easing: fade, from: { opacity: 0.9 }, to: { opacity: 0 } }));
    ctx.animate(wash, "hide", hide(pace.at(peak + 0.16) + 0.01));
    // The cut sits under the brightest moment, so the change reads as the light.
    cutAt(ctx, from, to, peak);
    return { end: round(ctx.end + 0.01) };
  },
};

export const slice = {
  name: "slice",
  needsAt: true,
  about: "bands of color slide in from alternate sides to cover the frame, the cut happens under them, and they slide on out the other side",
  fits: "graphic section changes",
  tags: ["mask-wipe"],
  length: 0.6,
  shortest: 0.4,
  fields: {
    ...shots,
    count: { kind: "number", low: 2, high: 8, whole: true, about: "how many bands (default 4)" },
    ...shared({ color: "the bands' color, hex (default the look's surface color)", accent: "every other band's color, hex (default the same as color)" }),
    axis: { kind: "choice", values: ["across", "down"], about: "across: horizontal bands moving sideways (default); down: vertical bands moving up and down" },
    ...shared({ ease: "the curve of the bands covering the frame (default a strong ease-out)" }), ...SPEED,
  },
  example: { from: "shot-a", to: "shot-b", at: 1, count: 4 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "slice");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const fill = ctx.color("color", ctx.style.colors.surface ?? ctx.style.colors.bg ?? COLORS.surface);
    const other = ctx.color("accent", fill);
    const count = input.count ?? 4;
    const across = (input.axis ?? "across") === "across";
    const { width, height } = ctx.frame;
    const middle = ctx.start + ctx.duration / 2;
    const pace = ctx.pace(middle);
    const coverCurve = ctx.ease(CURVE.smooth);
    // Each band starts a little after the one before; all cover the frame at the middle.
    const stagger = Math.min(0.04, (ctx.duration / 2) * 0.4 / Math.max(1, count - 1));
    const run = ctx.duration / 2 - stagger * (count - 1);
    const key = across ? "x" : "y";
    const travel = across ? width : height;
    for (let index = 0; index < count; index += 1) {
      const sign = index % 2 === 0 ? 1 : -1;
      // Bands overlap by a pixel so no hairline of the picture shows between them.
      const lo = Math.floor((index * (across ? height : width)) / count);
      const hi = Math.ceil(((index + 1) * (across ? height : width)) / count) + 1;
      const place = across ? { x: -sign * travel, y: lo, width, height: hi - lo } : { x: lo, y: -sign * travel, width: hi - lo, height };
      const band = ctx.add(`band-${index + 1}`, createLayer("rectangle", { name: "Slice band", ...place, fill: index % 2 ? other : fill, role: "decor", allowOverlap: true }));
      const begin = ctx.start + index * stagger;
      ctx.animate(band, "cover", paced(motion, pace, { name: "Cover", start: begin, duration: run, easing: coverCurve, from: { [key]: -sign * travel }, to: { [key]: 0 } }));
      ctx.animate(band, "clear", paced(motion, pace, { name: "Clear", start: middle + index * stagger, duration: run, easing: ctx.curve(CURVE.clear), from: { [key]: 0 }, to: { [key]: sign * travel } }));
      ctx.animate(band, "hide", hide(pace.at(middle + index * stagger + run) + 0.01));
    }
    cutAt(ctx, from, to, middle);
    return { end: round(pace.at(middle + stagger * (count - 1) + run) + 0.01) };
  },
};

export const glitch = {
  name: "glitch",
  needsAt: true,
  about: "a short, subtle digital glitch on the cut: the colors split and the picture jumps a few pixels sideways for two frames, then the next shot snaps back into register",
  fits: "tech; a hard accent, rarely",
  tags: ["glitch-hit"],
  length: 0.3,
  shortest: 0.16,
  fields: {
    ...shots,
    strength: { kind: "number", low: 0.2, high: 1, about: "how far the colors split and the picture jumps (default 0.5)" },
    split: { kind: "number", low: 0, high: 1, about: "how far the colors split, 0 to 1 (default 0.9 x strength)" },
    blocks: { kind: "number", low: 0, high: 8, whole: true, about: "bands of the picture torn sideways for the two frames before the cut, placed by seed (default 0)" },
    ...shared({ angle: "the direction of the split, the jump and the torn bands in degrees: 0 sideways, 90 down (default 0)", ease: "the curve of the split growing (default speeding into the cut)" }), ...SPEED,
  },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "glitch");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const strength = input.strength ?? 0.5;
    const angle = input.angle ?? 0;
    const middle = ctx.start + ctx.duration / 2;
    const pace = ctx.pace(middle);
    const jump = Math.max(2, Math.round(ctx.frame.width * 0.02 * strength));
    const split = round(input.split ?? 0.9 * strength);
    const close = 1 + (jump * 2.4) / ctx.frame.width;
    const now = scaleNow(ctx, from);
    const fromX = ctx.stateAt(from.id, ctx.start).x ?? from.x;
    const fromY = ctx.stateAt(from.id, ctx.start).y ?? from.y;
    // The way it jumps; y only moves when the angle is not sideways (old moves keep x alone).
    const along = { x: Math.cos((angle * Math.PI) / 180), y: Math.sin((angle * Math.PI) / 180) };
    const sideways = angle % 180 === 0;
    const shifted = (x, y, by) => ({ x: round(x + by * (sideways ? Math.sign(along.x) : along.x), 1), ...(sideways ? {} : { y: round(y + by * along.y, 1) }) });
    const jolt = pace.span(middle - 0.07, 0.034);
    ctx.animate(from.id, "split", paced(effect, pace, { name: "RGB split", effect: "rgb-shift", start: ctx.start, duration: middle - ctx.start, easing: ctx.ease(CURVE.accelerate), from: { amount: 0 }, to: { amount: split, direction: angle } }), "from");
    // Two frames off register just before the cut.
    ctx.animate(from.id, "jump", motion({ name: "Jump", ...jolt, easing: ctx.curve(CURVE.jolt),
      from: { ...shifted(fromX, fromY, 0), scaleX: now.scaleX, scaleY: now.scaleY }, to: { ...shifted(fromX, fromY, jump), scaleX: round(now.scaleX * close, 4), scaleY: round(now.scaleY * close, 4) } }), "from");
    tear(ctx, from, input.blocks ?? 0, { jolt, end: pace.at(middle) + 0.02, along, sideways, jump, at: shifted(fromX, fromY, jump), y: fromY, scale: { scaleX: round(now.scaleX * close, 4), scaleY: round(now.scaleY * close, 4) } });
    cutAt(ctx, from, to, middle);
    // The outgoing shot is hidden from the cut: its split goes back to 0 there, so it never stays on.
    ctx.animate(from.id, "split-off", paced(effect, pace, { name: "RGB split off", effect: "rgb-shift", start: middle, duration: 0.034, easing: ctx.curve(CURVE.linear), from: { amount: split }, to: { amount: 0, direction: angle } }), "from");
    ctx.animate(to.id, "snap", paced(motion, pace, { name: "Snap back", start: middle, duration: Math.min(0.1, ctx.end - middle), easing: ctx.curve(CURVE.settle), from: { ...shifted(to.x, to.y, -jump * 0.7), scaleX: round((to.scaleX ?? 1) * close, 4), scaleY: round((to.scaleY ?? 1) * close, 4) }, to: { x: to.x, ...(sideways ? {} : { y: to.y }), scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    ctx.animate(to.id, "split", paced(effect, pace, { name: "RGB split", effect: "rgb-shift", start: middle, duration: ctx.end - middle, easing: ctx.curve(CURVE.settle), from: { amount: split }, to: { amount: 0, direction: angle } }), "to");
    return { end: ctx.end };
  },
};

/**
 * Glitch's torn bands: each is a copy of `from` seen through a thin mask band across the jump,
 * shoved further along it, on screen only from the jump to the cut. Placed by the move's seed.
 */
function tear(ctx, from, count, { jolt, end, along, sideways, jump, at, y, scale }) {
  if (!count) return;
  if (from.type === "group") return ctx.note("glitch blocks: from is a group, so no bands are torn (give a picture or clip)");
  const { width, height } = ctx.frame;
  // Bands run across the jump: horizontal bands for a sideways jump, vertical ones for an up or down one.
  const rows = Math.abs(along.x) >= Math.abs(along.y);
  const { id: _id, name: _name, animations: _animations, move: _move, parentId: _parent, ...look } = from;
  for (let index = 0; index < count; index += 1) {
    const thick = Math.round((rows ? height : width) * (0.03 + ctx.rng.next() * 0.1));
    const spot = Math.round(ctx.rng.next() * ((rows ? height : width) - thick));
    const push = jump * (1.5 + ctx.rng.next() * 3) * (ctx.rng.next() < 0.5 ? -1 : 1);
    const band = rows ? { x: 0, y: spot, width, height: thick } : { x: spot, y: 0, width: thick, height };
    const mask = ctx.add(`block-mask-${index + 1}`, createLayer("rectangle", { name: "Glitch band mask", ...band, fill: ctx.color("mask", COLORS.mask), isMask: true, role: "decor" }), { above: from.id });
    const place = sideways ? { x: round(at.x + push * Math.sign(along.x || 1), 1), y } : { x: round(at.x + push * along.x, 1), y: round(at.y + push * along.y, 1) };
    const copy = ctx.add(`block-${index + 1}`, createLayer(from.type, { ...look, ...place, ...scale, opacity: 1, role: "decor", allowOverlap: true, ...(from.type === "video" ? { volume: 0 } : {}) }), { above: mask.id });
    for (const layer of [mask, copy]) {
      ctx.animate(layer, "show", show(jolt.start));
      ctx.animate(layer, "hide", hide(end));
    }
  }
}

export const blurDissolve = {
  name: "blur-dissolve",
  needsAt: true,
  about: "the shot softens out of focus while the next one dissolves in, already soft, and sharpens",
  fits: "soft changes, time passing",
  tags: ["blur-through"],
  length: 0.5,
  shortest: 0.3,
  fields: {
    ...shots,
    blur: { kind: "number", low: 0, high: 120, about: "how soft both shots get, px at 1080 tall (default 28)" },
    overlap: { kind: "number", low: 0.2, high: 0.9, about: "share of the move the new shot takes to dissolve in over the old one; the old fades in the rest (default 0.55)" },
    ...shared({ ease: "the curve of the new shot sharpening (default a strong ease-out)" }), ...SPEED,
  },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "blur-dissolve");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const soft = input.blur === undefined ? Math.max(6, Math.round(28 * ctx.scale)) : Math.round(input.blur * ctx.scale);
    // The new shot is full before the old one fades, so the frame never dips toward the background.
    const meet = ctx.start + ctx.duration * (input.overlap ?? 0.55);
    const pace = ctx.pace(meet);
    const fade = ctx.curve(CURVE.fade);
    const begins = pace.at(ctx.start);
    const ends = pace.at(ctx.end);
    startClips(ctx, to.id, begins);
    ctx.animate(to.id, "in", paced(motion, pace, { name: "Dissolve in", kind: "in", start: ctx.start, duration: meet - ctx.start, easing: fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
    ctx.animate(to.id, "focus", paced(motion, pace, { name: "Sharpen", start: ctx.start, duration: ctx.duration, easing: ctx.ease(CURVE.smooth), from: { blur: soft }, to: { blur: to.blur ?? 0 } }), "to");
    ctx.animate(from.id, "soften", paced(motion, pace, { name: "Soften", start: ctx.start, duration: meet - ctx.start, easing: ctx.curve(CURVE.accelerate), from: { blur: from.blur ?? 0 }, to: { blur: soft } }), "from");
    ctx.animate(from.id, "fade", paced(motion, pace, { name: "Dissolve out", start: meet, duration: ctx.end - meet, easing: fade, from: { opacity: 1 }, to: { opacity: 0 } }), "from");
    ctx.animate(from.id, "hide", hide(ends), "from");
    // Once hidden its blur goes back, so the shot is sharp if it is shown again later.
    ctx.animate(from.id, "unsoften", motion({ name: "Sharp again", start: ends, duration: 0.02, easing: fade, from: { blur: soft }, to: { blur: from.blur ?? 0 } }), "from");
    return { end: round(ctx.end + 0.02) };
  },
};

export const cardTilt = {
  name: "card-tilt",
  needsAt: true,
  about: "the shot turns away in 3D like a card and slides off to one side as the next turns in from the other side and lands flat with a small spring",
  fits: "products or cards in a row",
  tags: ["push-transition"],
  length: 0.55,
  shortest: 0.35,
  fields: {
    ...shots,
    direction: { kind: "choice", values: ["left", "right", "up", "down"], about: "where the picture moves (default a seeded left or right)" },
    turn: { kind: "number", low: 5, high: 85, about: "how far each card turns, degrees (default 50)" },
    shift: { kind: "number", low: 0, high: 1, about: "how far each card slides, a share of the frame (default 0.32)" },
    scale: { kind: "number", low: 0.3, high: 1, about: "how small each card gets while turned (default 0.82)" },
    ...shared({ ease: "the curve of both cards' turn; replaces the landing spring (default leaving fast, landing with a spring)" }), ...SPEED,
  },
  example: { from: "shot-a", to: "shot-b", at: 1, direction: "left" },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "card-tilt");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const direction = input.direction ?? ctx.rng.pick(["left", "right"]);
    const sign = direction === "left" || direction === "up" ? -1 : 1;
    const flat = direction === "left" || direction === "right";
    // Sideways cards turn about their vertical axis and slide in x; up or down, about the horizontal one in y.
    const key = flat ? "x" : "y";
    const spin = flat ? "rotateY" : "rotateX";
    const shift = Math.round((flat ? ctx.frame.width : ctx.frame.height) * (input.shift ?? 0.32));
    const turn = input.turn ?? 50;
    const small = input.scale ?? 0.82;
    // Moving up, the top edge goes back (positive rotateX); moving left, the left edge (negative rotateY).
    const lean = flat ? sign : -sign;
    const perspective = Math.round(Math.max(ctx.frame.width, ctx.frame.height) * 1.1);
    const leave = ctx.duration * 0.55;
    const arrive = ctx.start + ctx.duration * 0.4;
    const pace = ctx.pace(ctx.start + ctx.duration / 2);
    const now = scaleNow(ctx, from);
    const springs = input.ease === undefined;
    // The leading edge turns away: moving left, the left edge goes back (negative rotateY).
    ctx.animate(from.id, "tilt", paced(motion, pace, { name: "Tilt away", start: ctx.start, duration: leave, easing: ctx.ease(CURVE.leave),
      from: { [key]: now[key], scaleX: now.scaleX, scaleY: now.scaleY, [spin]: 0, perspective },
      to: { [key]: round(now[key] + sign * shift, 1), scaleX: round(now.scaleX * small, 4), scaleY: round(now.scaleY * small, 4), [spin]: lean * turn, perspective } }), "from");
    ctx.animate(from.id, "fade", paced(motion, pace, { name: "Fade", start: ctx.start + leave * 0.6, duration: leave * 0.4, easing: ctx.curve(CURVE.fade), from: { opacity: 1 }, to: { opacity: 0 } }), "from");
    ctx.animate(from.id, "hide", hide(pace.at(ctx.start + leave)), "from");
    startClips(ctx, to.id, pace.at(arrive));
    const land = ctx.end - arrive;
    ctx.animate(to.id, "in", paced(motion, pace, { name: "Fade in", kind: "in", start: arrive, duration: land * 0.35, easing: ctx.curve(CURVE.fade), from: { opacity: 0 }, to: { opacity: 1 } }), "to");
    // The landing springs a touch past flat (FilmCraft's back-out), so the card has weight.
    const tiltIn = paced(motion, pace, { name: "Tilt in", start: arrive, duration: land, easing: ctx.ease(CURVE.smooth),
      from: { [key]: round(to[key] - sign * shift, 1), scaleX: round((to.scaleX ?? 1) * small, 4), scaleY: round((to.scaleY ?? 1) * small, 4), [spin]: -lean * turn, perspective },
      to: { [key]: to[key], scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1, [spin]: 0, perspective } });
    ctx.animate(to.id, "tilt", springs ? { ...tiltIn, easing: "back-out", intensity: 20 } : tiltIn, "to");
    return { end: ctx.end };
  },
};

const SHAPES = ["circle", "rounded", "diamond", "clock"];

export const shapeWipe = {
  name: "shape-wipe",
  needsAt: true,
  about: "a shape in the accent color grows from a point to cover the frame, and the next shot opens inside it in the same shape, a beat behind",
  fits: "graphic, brand-color changes",
  tags: ["mask-wipe"],
  length: 0.6,
  shortest: 0.4,
  fields: {
    ...shots,
    shape: { kind: "choice", values: SHAPES, about: "circle, rounded, diamond, or clock (a hand sweeps around the point) (default circle)" },
    angle: { kind: "number", low: -360, high: 360, about: "clock only: where the hand starts, degrees (default -90, 12 o'clock)" },
    ...shared({ color: "the shape's color, hex (default the brand accent)" }),
    point: { kind: "point", about: "[x, y] in % of to's box where the shape grows from (default the center)" },
    ...shared({ ease: "the curve of the shape and the opening growing (default a strong ease-out)" }), ...SPEED,
  },
  example: { from: "shot-a", to: "shot-b", at: 1, shape: "circle" },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "shape-wipe");
    const fill = ctx.color("color", "accent");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const shape = input.shape ?? "circle";
    const box = boxOf(to);
    const origin = pointIn(box, input.point);
    if (shape === "clock") return clockWipe(ctx, from, to, fill, box, origin, input.angle ?? -90);
    const pace = ctx.pace(ctx.start);
    const curve = ctx.ease(CURVE.smooth);
    const reach = Math.max(...[[0, 0], [ctx.frame.width, 0], [0, ctx.frame.height], [ctx.frame.width, ctx.frame.height]].map(([x, y]) => Math.hypot(x - origin.x, y - origin.y)));
    const size = Math.ceil(reach * (shape === "circle" ? 2.04 : shape === "diamond" ? 2.1 : 2.3));
    const place = { x: Math.round(origin.x - size / 2), y: Math.round(origin.y - size / 2), width: size, height: size };
    const type = shape === "circle" ? "ellipse" : "rectangle";
    const outline = { radius: shape === "rounded" ? Math.round(size * 0.22) : 0, rotation: shape === "diamond" ? 45 : 0 };
    const grow = (start, duration) => ({ ...paced(motion, pace, { name: "Grow", kind: "in", start, duration, easing: curve, from: { width: 1, height: 1 }, to: { width: size, height: size } }), anchor: "center" });
    // Drawn bottom to top: from, the color shape, the mask, to (a mask shows the layer just above it).
    if (ctx.order(to.id) < ctx.order(from.id)) ctx.raise(to.id, from.id);
    const color = ctx.add("shape", createLayer(type, { name: "Wipe shape", ...place, ...outline, fill, opacity: 0, role: "decor", allowOverlap: true }), { below: to.id });
    ctx.animate(color, "show", motion({ name: "Show", start: ctx.start, duration: 0.02, easing: ctx.curve(CURVE.fade), from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(color, "grow", grow(ctx.start, ctx.duration * 0.6));
    const mask = ctx.add("mask", createLayer(type, { name: "Wipe mask", ...place, ...outline, fill: ctx.color("mask", COLORS.mask), isMask: true, role: "decor" }), { below: to.id });
    const opens = ctx.start + ctx.duration * 0.3;
    ctx.animate(mask, "grow", grow(opens, ctx.end - opens));
    startClips(ctx, to.id, pace.at(opens));
    ctx.animate(color, "hide", hide(pace.at(ctx.end)), null);
    ctx.animate(from.id, "hide", hide(pace.at(ctx.end)), "from");
    return { end: ctx.end };
  },
};

// The clock: a frame of the color sweeps around the point (a reveal, engine/wipe.js), and the next
// shot sweeps in behind it, a beat later.
function clockWipe(ctx, from, to, fill, box, origin, angle) {
  if (ctx.order(to.id) < ctx.order(from.id)) ctx.raise(to.id, from.id);
  const { width, height } = ctx.frame;
  const pace = ctx.pace(ctx.start);
  const curve = ctx.ease(CURVE.smooth);
  const sweep = (centerX, centerY, progress) => ({ reveal: { progress, direction: "up", softness: 0, shape: "clock", angle, centerX: within(centerX), centerY: within(centerY) } });
  const within = (value) => round(Math.max(-1, Math.min(2, value)), 4);
  const onFrame = [origin.x / width, origin.y / height], onShot = [(origin.x - box.x) / Math.max(1, box.width), (origin.y - box.y) / Math.max(1, box.height)];
  const color = ctx.add("shape", createLayer("rectangle", { name: "Wipe shape", x: 0, y: 0, width, height, fill, opacity: 0, role: "decor", allowOverlap: true }), { below: to.id });
  ctx.animate(color, "show", motion({ name: "Show", start: ctx.start, duration: 0.02, easing: ctx.curve(CURVE.fade), from: { opacity: 0 }, to: { opacity: 1 } }));
  ctx.animate(color, "sweep", paced(motion, pace, { name: "Sweep", kind: "in", start: ctx.start, duration: ctx.duration * 0.6, easing: curve, from: sweep(...onFrame, 0), to: sweep(...onFrame, 1) }));
  const opens = ctx.start + ctx.duration * 0.3;
  ctx.animate(to.id, "sweep", paced(motion, pace, { name: "Sweep in", kind: "in", start: opens, duration: ctx.end - opens, easing: curve, from: sweep(...onShot, 0), to: sweep(...onShot, 1) }), "to");
  startClips(ctx, to.id, pace.at(opens));
  ctx.animate(color, "hide", hide(pace.at(ctx.end)), null);
  ctx.animate(from.id, "hide", hide(pace.at(ctx.end)), "from");
  return { end: ctx.end };
}

export const CUTS = [zoomBlur, flash, lightLeak, slice, glitch, blurDissolve, cardTilt, shapeWipe];
