// Short transitions between two shots, the kinds social editors offer first: zoom-blur, flash, light-leak, slice, glitch, blur-dissolve, card-tilt and shape-wipe.
// Each works on two of the scene's own layers, `from` (leaves) and `to` (arrives), like
// whip-pan, and lasts 0.3 to 0.6 s. The cut sits inside the move; align:"end" on the move op
// lands its last frame on a beat. Under reduced motion each is a plain cross-fade.
import { createLayer } from "../../model.js";
import { CURVES, boxOf, effect, hide, motion, pointIn, round, scaledAbout } from "./kit.js";
import { crossFade, startClips } from "./transitions.js";

// The most used curve in motion templates: a strong ease-out with a soft start.
const SMOOTH = Object.freeze([0.5, 0, 0, 1]);
const COLOR = /^#[0-9a-fA-F]{6}$/;

function pair(ctx, input, name) {
  const from = ctx.layer(input.from, "from");
  const to = ctx.layer(input.to, "to");
  if (from.id === to.id) throw new Error(`${name} needs two different layers.`);
  return { from, to };
}

function colorOf(name, value, fallback) {
  if (value === undefined) return fallback;
  if (!COLOR.test(value)) throw new Error(`${name} color is a hex color such as #FFFFFF.`);
  return value.toUpperCase();
}

/** `to` shows at `at` (a 0.04 s appear, so a clip starts there too); `from` hides a frame later. */
function cutAt(ctx, from, to, at) {
  // The new shot is whole a moment before the cut: a shot whose own hide or clip end falls on the
  // cut (one built as plain cuts) then never leaves a half-faded frame over the background.
  startClips(ctx, to.id, at - 0.04);
  ctx.animate(to.id, "in", motion({ name: "Appear", kind: "in", start: Math.max(0, at - 0.04), duration: 0.02, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
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

const shots = { from: { kind: "layer", required: true, about: "the shot that leaves" }, to: { kind: "layer", required: true, about: "the shot that arrives" } };
const SETUP = "shot-a and shot-b, two full-frame pictures or videos";

export const zoomBlur = {
  name: "zoom-blur",
  needsAt: true,
  about: "a quick punch into the shot with a radial zoom blur that peaks on the cut; the next shot lands out of the same blur, a little close, and settles",
  fits: "a quick energetic cut on a beat",
  tags: ["zoom-through"],
  length: 0.4,
  shortest: 0.24,
  fields: { ...shots, point: { kind: "point", about: "[x, y] in % of from's box the zoom aims at (default its center)" } },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "zoom-blur");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const box = boxOf(from);
    const aim = pointIn(box, input.point);
    const middle = ctx.start + ctx.duration / 2;
    const half = ctx.duration / 2;
    const now = scaleNow(ctx, from);
    const punch = 1.25;
    const landed = scaledAbout(box, aim, punch);
    const center = { centerX: round((aim.x - box.x) / box.width), centerY: round((aim.y - box.y) / box.height) };
    ctx.animate(from.id, "push", motion({ name: "Punch in", start: ctx.start, duration: half, easing: CURVES.accelerate, from: now, to: { x: landed.x, y: landed.y, scaleX: round(now.scaleX * punch, 4), scaleY: round(now.scaleY * punch, 4) } }), "from");
    ctx.animate(from.id, "blur", effect({ name: "Zoom blur", effect: "zoom-blur", start: ctx.start, duration: half, easing: CURVES.accelerate, from: { amount: 0 }, to: { amount: 0.75, ...center } }), "from");
    cutAt(ctx, from, to, middle);
    ctx.animate(from.id, "unblur", effect({ name: "Zoom blur rests", effect: "zoom-blur", start: middle + 0.02, duration: 0.04, easing: CURVES.fade, from: { amount: 0.75 }, to: { amount: 0, ...center } }), "from");
    const big = 1.15;
    ctx.animate(to.id, "settle", motion({ name: "Settle", start: middle, duration: half, easing: SMOOTH,
      from: { scaleX: round(big * (to.scaleX ?? 1), 4), scaleY: round(big * (to.scaleY ?? 1), 4) }, to: { scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    ctx.animate(to.id, "blur", effect({ name: "Zoom blur", effect: "zoom-blur", start: middle, duration: half, easing: SMOOTH, from: { amount: 0.55 }, to: { amount: 0, centerX: 0.5, centerY: 0.5 } }), "to");
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
  fields: { ...shots, color: { kind: "text", max: 7, about: "the flash color, hex (default #FFFFFF)" } },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "flash");
    const fill = colorOf("flash", input.color, "#FFFFFF");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    // Up fast to full (a third of the move), the cut at the peak, then a longer fall.
    const peak = ctx.start + ctx.duration * 0.35;
    const layer = cover(ctx, "flash", "Flash", fill);
    ctx.animate(layer, "up", motion({ name: "Flash", start: ctx.start, duration: peak - ctx.start, easing: CURVES.accelerate, from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(layer, "down", motion({ name: "Flash fades", start: peak, duration: ctx.end - peak, easing: SMOOTH, from: { opacity: 1 }, to: { opacity: 0 } }));
    ctx.animate(layer, "hide", hide(ctx.end + 0.01));
    cutAt(ctx, from, to, peak);
    ctx.animate(to.id, "settle", motion({ name: "Settle", start: peak, duration: Math.max(0.3, ctx.end - peak), easing: SMOOTH,
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
    color: { kind: "text", max: 7, about: "the light's color, hex (default warm amber #FFA04D)" },
    side: { kind: "choice", values: ["left", "right"], about: "where the light comes from (default a seeded left or right)" },
  },
  example: { from: "shot-a", to: "shot-b", at: 1, side: "left" },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "light-leak");
    const fill = colorOf("light-leak", input.color, "#FFA04D");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const side = input.side ?? ctx.rng.pick(["left", "right"]);
    const sign = side === "left" ? 1 : -1;
    const { width, height } = ctx.frame;
    const big = Math.max(width, height);
    const peak = ctx.start + ctx.duration * 0.45;
    // A large soft glow screened over the picture, drifting across.
    for (const [part, name, color, size, top] of [["glow", "Light leak", fill, 1.4, 0.9]]) {
      const w = Math.round(big * size);
      const h = Math.round(height * (size + 0.3));
      const y = Math.round((height - h) / 2);
      const startX = side === "left" ? -w * 0.75 : width - w * 0.25;
      const layer = ctx.add(part, createLayer("ellipse", { name, x: Math.round(startX), y, width: w, height: h, fill: color, opacity: 0, blur: Math.round(big * 0.2), blendMode: "screen", role: "decor", allowOverlap: true }));
      ctx.animate(layer, "drift", motion({ name: "Drift", start: ctx.start, duration: ctx.duration, easing: CURVES.drift, from: { x: Math.round(startX) }, to: { x: Math.round(startX + sign * width * 0.55) } }));
      ctx.animate(layer, "up", motion({ name: "Bloom", start: ctx.start, duration: peak - ctx.start, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: top } }));
      ctx.animate(layer, "down", motion({ name: "Fade", start: peak, duration: ctx.end - peak, easing: CURVES.fade, from: { opacity: top }, to: { opacity: 0 } }));
      ctx.animate(layer, "hide", hide(ctx.end + 0.01));
    }
    // A short warm-white wash over the whole frame at the peak (0.3 s, so check counts it as a
    // planned flash): the brightest moment, which hides the change.
    const wash = cover(ctx, "wash", "Light leak wash", "#FFF3E0", { blendMode: "screen" });
    const rise = Math.min(0.12, peak - ctx.start);
    ctx.animate(wash, "up", motion({ name: "Wash", start: peak - rise, duration: rise, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 0.9 } }));
    ctx.animate(wash, "down", motion({ name: "Wash fades", start: peak, duration: 0.16, easing: CURVES.fade, from: { opacity: 0.9 }, to: { opacity: 0 } }));
    ctx.animate(wash, "hide", hide(peak + 0.17));
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
    color: { kind: "text", max: 7, about: "the bands' color, hex (default the look's surface color)" },
    axis: { kind: "choice", values: ["across", "down"], about: "across: horizontal bands moving sideways (default); down: vertical bands moving up and down" },
  },
  example: { from: "shot-a", to: "shot-b", at: 1, count: 4 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "slice");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const fill = colorOf("slice", input.color, ctx.style.colors.surface ?? ctx.style.colors.bg ?? "#1B1D21");
    const count = input.count ?? 4;
    const across = (input.axis ?? "across") === "across";
    const { width, height } = ctx.frame;
    const middle = ctx.start + ctx.duration / 2;
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
      const band = ctx.add(`band-${index + 1}`, createLayer("rectangle", { name: "Slice band", ...place, fill, role: "decor", allowOverlap: true }));
      const begin = ctx.start + index * stagger;
      ctx.animate(band, "cover", motion({ name: "Cover", start: begin, duration: run, easing: SMOOTH, from: { [key]: -sign * travel }, to: { [key]: 0 } }));
      ctx.animate(band, "clear", motion({ name: "Clear", start: middle + index * stagger, duration: run, easing: [0.5, 0, 0.75, 0], from: { [key]: 0 }, to: { [key]: sign * travel } }));
      ctx.animate(band, "hide", hide(middle + index * stagger + run + 0.01));
    }
    cutAt(ctx, from, to, middle);
    return { end: round(middle + stagger * (count - 1) + run + 0.01) };
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
  fields: { ...shots, strength: { kind: "number", low: 0.2, high: 1, about: "how far the colors split and the picture jumps (default 0.5)" } },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "glitch");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const strength = input.strength ?? 0.5;
    const middle = ctx.start + ctx.duration / 2;
    const jump = Math.max(2, Math.round(ctx.frame.width * 0.02 * strength));
    const split = round(0.9 * strength);
    const close = 1 + (jump * 2.4) / ctx.frame.width;
    const now = scaleNow(ctx, from);
    const fromX = ctx.stateAt(from.id, ctx.start).x ?? from.x;
    ctx.animate(from.id, "split", effect({ name: "RGB split", effect: "rgb-shift", start: ctx.start, duration: middle - ctx.start, easing: CURVES.accelerate, from: { amount: 0 }, to: { amount: split, direction: 0 } }), "from");
    // Two frames off register just before the cut.
    ctx.animate(from.id, "jump", motion({ name: "Jump", start: middle - 0.07, duration: 0.034, easing: [0.9, 0, 1, 0.1],
      from: { x: round(fromX, 1), scaleX: now.scaleX, scaleY: now.scaleY }, to: { x: round(fromX + jump, 1), scaleX: round(now.scaleX * close, 4), scaleY: round(now.scaleY * close, 4) } }), "from");
    cutAt(ctx, from, to, middle);
    // The outgoing shot is hidden from the cut: its split goes back to 0 there, so it never stays on.
    ctx.animate(from.id, "split-off", effect({ name: "RGB split off", effect: "rgb-shift", start: middle, duration: 0.034, easing: [0, 0, 1, 1], from: { amount: split }, to: { amount: 0, direction: 0 } }), "from");
    ctx.animate(to.id, "snap", motion({ name: "Snap back", start: middle, duration: Math.min(0.1, ctx.end - middle), easing: CURVES.settle, from: { x: round(to.x - jump * 0.7, 1), scaleX: round((to.scaleX ?? 1) * close, 4), scaleY: round((to.scaleY ?? 1) * close, 4) }, to: { x: to.x, scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1 } }), "to");
    ctx.animate(to.id, "split", effect({ name: "RGB split", effect: "rgb-shift", start: middle, duration: ctx.end - middle, easing: CURVES.settle, from: { amount: split }, to: { amount: 0, direction: 0 } }), "to");
    return { end: ctx.end };
  },
};

export const blurDissolve = {
  name: "blur-dissolve",
  needsAt: true,
  about: "the shot softens out of focus while the next one dissolves in, already soft, and sharpens",
  fits: "soft changes, time passing",
  tags: ["blur-through"],
  length: 0.5,
  shortest: 0.3,
  fields: { ...shots },
  example: { from: "shot-a", to: "shot-b", at: 1 },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "blur-dissolve");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const soft = Math.max(6, Math.round(28 * ctx.scale));
    // The new shot is full before the old one fades, so the frame never dips toward the background.
    const meet = ctx.start + ctx.duration * 0.55;
    startClips(ctx, to.id, ctx.start);
    ctx.animate(to.id, "in", motion({ name: "Dissolve in", kind: "in", start: ctx.start, duration: meet - ctx.start, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
    ctx.animate(to.id, "focus", motion({ name: "Sharpen", start: ctx.start, duration: ctx.duration, easing: SMOOTH, from: { blur: soft }, to: { blur: to.blur ?? 0 } }), "to");
    ctx.animate(from.id, "soften", motion({ name: "Soften", start: ctx.start, duration: meet - ctx.start, easing: CURVES.accelerate, from: { blur: from.blur ?? 0 }, to: { blur: soft } }), "from");
    ctx.animate(from.id, "fade", motion({ name: "Dissolve out", start: meet, duration: ctx.end - meet, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }), "from");
    ctx.animate(from.id, "hide", hide(ctx.end), "from");
    // Once hidden its blur goes back, so the shot is sharp if it is shown again later.
    ctx.animate(from.id, "unsoften", motion({ name: "Sharp again", start: ctx.end, duration: 0.02, easing: CURVES.fade, from: { blur: soft }, to: { blur: from.blur ?? 0 } }), "from");
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
  fields: { ...shots, direction: { kind: "choice", values: ["left", "right"], about: "where the picture moves (default a seeded left or right)" } },
  example: { from: "shot-a", to: "shot-b", at: 1, direction: "left" },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "card-tilt");
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const direction = input.direction ?? ctx.rng.pick(["left", "right"]);
    const sign = direction === "left" ? -1 : 1;
    const shift = Math.round(ctx.frame.width * 0.32);
    const turn = 50;
    const small = 0.82;
    const perspective = Math.round(Math.max(ctx.frame.width, ctx.frame.height) * 1.1);
    const leave = ctx.duration * 0.55;
    const arrive = ctx.start + ctx.duration * 0.4;
    const now = scaleNow(ctx, from);
    // The leading edge turns away: moving left, the left edge goes back (negative rotateY).
    ctx.animate(from.id, "tilt", motion({ name: "Tilt away", start: ctx.start, duration: leave, easing: CURVES.leave,
      from: { x: now.x, scaleX: now.scaleX, scaleY: now.scaleY, rotateY: 0, perspective },
      to: { x: round(now.x + sign * shift, 1), scaleX: round(now.scaleX * small, 4), scaleY: round(now.scaleY * small, 4), rotateY: sign * turn, perspective } }), "from");
    ctx.animate(from.id, "fade", motion({ name: "Fade", start: ctx.start + leave * 0.6, duration: leave * 0.4, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }), "from");
    ctx.animate(from.id, "hide", hide(ctx.start + leave), "from");
    startClips(ctx, to.id, arrive);
    const land = ctx.end - arrive;
    ctx.animate(to.id, "in", motion({ name: "Fade in", kind: "in", start: arrive, duration: land * 0.35, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }), "to");
    // The landing springs a touch past flat (FilmCraft's back-out), so the card has weight.
    ctx.animate(to.id, "tilt", { ...motion({ name: "Tilt in", start: arrive, duration: land, easing: SMOOTH,
      from: { x: round(to.x - sign * shift, 1), scaleX: round((to.scaleX ?? 1) * small, 4), scaleY: round((to.scaleY ?? 1) * small, 4), rotateY: -sign * turn, perspective },
      to: { x: to.x, scaleX: to.scaleX ?? 1, scaleY: to.scaleY ?? 1, rotateY: 0, perspective } }), easing: "back-out", intensity: 20 }, "to");
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
    color: { kind: "text", max: 7, about: "the shape's color, hex (default the brand accent)" },
    point: { kind: "point", about: "[x, y] in % of to's box where the shape grows from (default the center)" },
  },
  example: { from: "shot-a", to: "shot-b", at: 1, shape: "circle" },
  setup: SETUP,
  build(ctx, input) {
    const { from, to } = pair(ctx, input, "shape-wipe");
    const fill = colorOf("shape-wipe", input.color, ctx.style.colors.accent);
    if (ctx.reduced) return crossFade(ctx, from.id, to.id);
    const shape = input.shape ?? "circle";
    const box = boxOf(to);
    const origin = pointIn(box, input.point);
    if (shape === "clock") return clockWipe(ctx, from, to, fill, box, origin, input.angle ?? -90);
    const reach = Math.max(...[[0, 0], [ctx.frame.width, 0], [0, ctx.frame.height], [ctx.frame.width, ctx.frame.height]].map(([x, y]) => Math.hypot(x - origin.x, y - origin.y)));
    const size = Math.ceil(reach * (shape === "circle" ? 2.04 : shape === "diamond" ? 2.1 : 2.3));
    const place = { x: Math.round(origin.x - size / 2), y: Math.round(origin.y - size / 2), width: size, height: size };
    const type = shape === "circle" ? "ellipse" : "rectangle";
    const outline = { radius: shape === "rounded" ? Math.round(size * 0.22) : 0, rotation: shape === "diamond" ? 45 : 0 };
    const grow = (start, duration) => ({ ...motion({ name: "Grow", kind: "in", start, duration, easing: SMOOTH, from: { width: 1, height: 1 }, to: { width: size, height: size } }), anchor: "center" });
    // Drawn bottom to top: from, the color shape, the mask, to (a mask shows the layer just above it).
    if (ctx.order(to.id) < ctx.order(from.id)) ctx.raise(to.id, from.id);
    const color = ctx.add("shape", createLayer(type, { name: "Wipe shape", ...place, ...outline, fill, opacity: 0, role: "decor", allowOverlap: true }), { below: to.id });
    ctx.animate(color, "show", motion({ name: "Show", start: ctx.start, duration: 0.02, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(color, "grow", grow(ctx.start, ctx.duration * 0.6));
    const mask = ctx.add("mask", createLayer(type, { name: "Wipe mask", ...place, ...outline, fill: "#FFFFFF", isMask: true, role: "decor" }), { below: to.id });
    const opens = ctx.start + ctx.duration * 0.3;
    ctx.animate(mask, "grow", grow(opens, ctx.end - opens));
    startClips(ctx, to.id, opens);
    ctx.animate(color, "hide", hide(ctx.end), null);
    ctx.animate(from.id, "hide", hide(ctx.end), "from");
    return { end: ctx.end };
  },
};

// The clock: a frame of the color sweeps around the point (a reveal, engine/wipe.js), and the next
// shot sweeps in behind it, a beat later.
function clockWipe(ctx, from, to, fill, box, origin, angle) {
  if (ctx.order(to.id) < ctx.order(from.id)) ctx.raise(to.id, from.id);
  const { width, height } = ctx.frame;
  const sweep = (centerX, centerY, progress) => ({ reveal: { progress, direction: "up", softness: 0, shape: "clock", angle, centerX: within(centerX), centerY: within(centerY) } });
  const within = (value) => round(Math.max(-1, Math.min(2, value)), 4);
  const onFrame = [origin.x / width, origin.y / height], onShot = [(origin.x - box.x) / Math.max(1, box.width), (origin.y - box.y) / Math.max(1, box.height)];
  const color = ctx.add("shape", createLayer("rectangle", { name: "Wipe shape", x: 0, y: 0, width, height, fill, opacity: 0, role: "decor", allowOverlap: true }), { below: to.id });
  ctx.animate(color, "show", motion({ name: "Show", start: ctx.start, duration: 0.02, easing: CURVES.fade, from: { opacity: 0 }, to: { opacity: 1 } }));
  ctx.animate(color, "sweep", motion({ name: "Sweep", kind: "in", start: ctx.start, duration: ctx.duration * 0.6, easing: SMOOTH, from: sweep(...onFrame, 0), to: sweep(...onFrame, 1) }));
  const opens = ctx.start + ctx.duration * 0.3;
  ctx.animate(to.id, "sweep", motion({ name: "Sweep in", kind: "in", start: opens, duration: ctx.end - opens, easing: SMOOTH, from: sweep(...onShot, 0), to: sweep(...onShot, 1) }), "to");
  startClips(ctx, to.id, opens);
  ctx.animate(color, "hide", hide(ctx.end), null);
  ctx.animate(from.id, "hide", hide(ctx.end), "from");
  return { end: ctx.end };
}

export const CUTS = [zoomBlur, flash, lightLeak, slice, glitch, blurDissolve, cardTilt, shapeWipe];
