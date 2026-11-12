// light-shape: a made light any edit can drop in: a lit plate (a see-through glowing bar with a
// crisp bright edge line), a streak (a light bar, full width or angled, with tapered ends and a soft
// bloom at its middle) or a ring (a halo: a thin bright ring with a soft outer falloff). Each is a
// few soft shapes in one group added onto the picture (blend add), so it brightens what is under
// it and its falloff stays soft instead of ending in a hard opaque core.
//
// Why a move and not a new layer kind: it is built only from what layers already draw (ellipses
// and rectangles with blur, stroke, opacity and blendMode), so every renderer, export and check
// already handles it, and an agent can still edit each part afterward.
//
// Where the defaults come from (.scratch/recreate, GAPS item 4):
// - streak thickness 0.03 of the frame height: the floor streak in fan-fast's reference f0074
//   measures 13 to 17 px at half its peak on a 540 px frame (0.024 to 0.031), one smooth hump 80 to
//   118 luma over the picture with a faint tail (the halo here is 2.2 times the thickness at 0.12).
//   The bloom at its middle, 0.45 of the height across, is read by eye from the same frame. Its core
//   is the color mixed 70% toward white (the reference core is pale violet, not pure white).
// - plate: product-film's reference f085: the plate's fill at its ends is about 20% of its color
//   (45,10,3 on black for an orange 230,150,80 middle), its middle glows near full color, and its
//   edge line is 2 to 3 px on 540 (0.005 of the height) and lighter than the fill (mixed about 30%
//   toward white). Size 0.5 x 0.08 of the frame is a guess near those plates.
// - ring: 0.3 of the frame height across is a guess. The line, 0.006 of the height, matches
//   film-trailer's halo ring around the dot in f040 (2 to 3 px on 540, about 20 px across, so send
//   height 0.037 for that size); its soft glow stays outside the ring so the inside keeps the picture.
// - motion: streak "sweep" (grows out from its middle), ring "pulse" (flares up and fades while
//   it widens a little), plate "hold" (fades in, stays, fades out): guesses at what each shape
//   usually does; all three are open to every shape.
// Reduced motion: no growth or widening, the light only fades in and out.
import { createLayer } from "../../model.js";
import { CURVES, hide, mix, motion, round, show } from "./kit.js";

const HEX = /^#[0-9a-f]{6}$/i;
const SHAPES = Object.freeze({
  streak: { width: 1.2, height: 0.03, motion: "sweep" },
  plate: { width: 0.5, height: 0.08, motion: "hold" },
  ring: { width: null, height: 0.3, motion: "pulse" },
});

export const lightShape = {
  name: "light-shape",
  needsAt: true,
  about: "soft added light: streak (light bar), plate (glow plate), ring (halo)",
  fits: "glow plates, light bars, floor streaks, halos",
  tags: ["light-sweep"],
  length: 0.6,
  shortest: 0.04,
  fields: {
    shape: { kind: "choice", values: ["streak", "plate", "ring", "halo"], about: "streak (default: a light bar with tapered ends), plate (lit see-through bar with an edge line) or ring (halo, the same)" },
    x: { kind: "number", low: -0.5, high: 1.5, about: "its middle across the frame, 0 left to 1 right (default 0.5)" },
    y: { kind: "number", low: -0.5, high: 1.5, about: "its middle down the frame, 0 top to 1 bottom (default 0.5)" },
    width: { kind: "number", low: 0.005, high: 3, about: "length as a share of the frame width (default streak 1.2, full width; plate 0.5; ring as tall as it is wide)" },
    height: { kind: "number", low: 0.002, high: 3, about: "thickness as a share of the frame height (default streak 0.03, plate 0.08; ring: its size across, 0.3)" },
    angle: { kind: "number", low: -360, high: 360, about: "turn in degrees (default 0, level)" },
    color: { kind: "text", max: 7, about: "the light's color, hex (default #FFFFFF)" },
    intensity: { kind: "number", low: 0, high: 3, about: "how bright (default 1)" },
    softness: { kind: "number", low: 0, high: 1, about: "how far the glow falls off around it, 0 crisp to 1 the widest (default 0.6)" },
    motion: { kind: "choice", values: ["sweep", "pulse", "hold"], about: "sweep grows out from its middle, pulse flares up and fades, hold fades in, stays and fades out (default streak sweep, ring pulse, plate hold)" },
    blend: { kind: "choice", values: ["add", "screen"], about: "how it lights the picture under it (default add)" },
  },
  example: { shape: "streak", at: 0.5, y: 0.75 },
  setup: "any scene",
  build(ctx, input) {
    // "halo" is the word agents searched with (review: shape "halo" was refused and the fix swapped
    // the ring for the example's streak), so it draws the ring.
    const shape = input.shape === "halo" ? "ring" : input.shape ?? "streak";
    const own = SHAPES[shape];
    if (input.color !== undefined && !HEX.test(input.color)) throw new Error("light-shape color is a hex color such as \"#FFE2B0\".");
    const color = input.color ?? "#FFFFFF";
    const { width: W, height: H } = ctx.frame;
    const intensity = input.intensity ?? 1;
    const soft = input.softness ?? 0.6;
    const tall = (input.height ?? own.height) * H;
    const long = input.width !== undefined ? input.width * W : own.width === null ? tall : own.width * W;
    const cx = (input.x ?? 0.5) * W, cy = (input.y ?? 0.5) * H;
    const angle = input.angle ?? 0;
    const kind = ctx.reduced ? "hold" : input.motion ?? own.motion;
    const group = ctx.add("light", createLayer("group", { x: 0, y: 0, width: W, height: H, blendMode: input.blend ?? "add", opacity: 0, role: "decor", allowOverlap: true }));
    const parts = [];
    const part = (name, type, w, h, props) => {
      const layer = ctx.add(name, createLayer(type, { x: round(cx - w / 2, 1), y: round(cy - h / 2, 1), width: round(Math.max(1, w), 1), height: round(Math.max(1, h), 1),
        rotation: angle, strokeWidth: 0, role: "decor", allowOverlap: true, ...props }), "top", group);
      parts.push(layer);
      return layer;
    };
    const a = (value) => round(Math.min(1, value * intensity), 3);
    const blur = (value) => round(Math.max(0, value * soft), 1);
    if (shape === "streak") {
      // Halo, then core, then the bloom at the middle: concentric, tapered ellipses. The core is
      // 0.9 of the thickness and blurred by about half its size, so the cross-section is one smooth
      // hump (fan-fast f0074: 13 to 16 px at half its peak on 540, 80 to 118 luma over the picture,
      // no hard line inside); the halo is the faint tail (about +10 luma 20 px out on the same frame).
      part("halo", "ellipse", long, tall * 2.2, { fill: color, opacity: a(0.12), blur: blur(tall * 1.2) });
      part("core", "ellipse", long * 0.92, Math.max(1.5, tall * 0.9), { fill: mix(color, "#FFFFFF", 0.7), opacity: a(0.45), blur: blur(tall * 0.55) });
      part("bloom", "ellipse", H * 0.45, H * 0.45 * Math.min(1, Math.max(0.35, tall * 12 / H)), { fill: mix(color, "#FFFFFF", 0.3), opacity: a(0.5), blur: blur(H * 0.12) });
    } else if (shape === "plate") {
      const line = Math.max(1.5, H * 0.005);
      part("glow", "rectangle", long * 1.04, tall * 2, { fill: color, opacity: a(0.3), blur: blur(tall * 0.8) });
      part("fill", "rectangle", long, tall, { fill: color, opacity: a(0.22) });
      // The inner glow fades out along the plate (blur from its length too), so it reads as light
      // from the middle rather than a separate oval (the first try's oval, product-film review).
      part("inner", "ellipse", long * 0.8, tall * 0.7, { fill: mix(color, "#FFFFFF", 0.15), opacity: a(0.7), blur: blur(Math.max(tall * 0.6, long * 0.1)) });
      part("edge-glow", "rectangle", long, tall, { fillEnabled: false, stroke: color, strokeWidth: round(line * 3, 1), opacity: a(0.45), blur: blur(line * 2.5) });
      part("edge", "rectangle", long, tall, { fillEnabled: false, stroke: mix(color, "#FFFFFF", 0.3), strokeWidth: round(line, 1), opacity: a(1) });
    } else {
      const line = Math.max(1.5, H * 0.006);
      // The haze is a wide soft band just outside the ring, not a filled disc: a fill added onto a
      // light picture turned the whole inside white (film-trailer f040 keeps the gray between the
      // dot and its halo ring). Widths and opacities are guesses.
      part("haze", "ellipse", long * 1.12, tall * 1.12, { fillEnabled: false, stroke: color, strokeWidth: round(Math.max(line, tall * 0.14), 1), opacity: a(0.16), blur: blur(Math.max(line, tall * 0.1)) });
      part("glow", "ellipse", long, tall, { fillEnabled: false, stroke: color, strokeWidth: round(Math.max(line * 1.2, tall * 0.06), 1), opacity: a(0.4), blur: blur(Math.max(line, tall * 0.06)) });
      part("ring", "ellipse", long, tall, { fillEnabled: false, stroke: mix(color, "#FFFFFF", 0.6), strokeWidth: round(line, 1), opacity: a(1), blur: round(line * 0.3, 1) });
    }
    const t = ctx.start, end = ctx.end, dur = ctx.duration;
    // Brightness on the group: sweep and pulse rise in the first quarter and fall over the rest;
    // hold fades in and out over a fifth each (at most 0.2 s).
    const fadeIn = kind === "hold" ? Math.min(0.2, dur * 0.2) : dur * 0.25;
    const fadeOut = kind === "hold" ? Math.min(0.2, dur * 0.2) : dur - fadeIn;
    ctx.animate(group, "on", show(t));
    ctx.animate(group, "in", motion({ name: "Light in", start: t, duration: fadeIn, easing: CURVES.arrive, from: { opacity: 0 }, to: { opacity: 1 } }));
    ctx.animate(group, "out", motion({ name: "Light out", start: end - fadeOut, duration: fadeOut, easing: CURVES.fade, from: { opacity: 1 }, to: { opacity: 0 } }));
    ctx.animate(group, "off", hide(end));
    if (kind === "sweep" || kind === "pulse") {
      const grow = kind === "sweep" ? { from: { scaleX: 0.15 }, to: { scaleX: 1 } } : { from: { scaleX: 0.85, scaleY: 0.85 }, to: { scaleX: 1.12, scaleY: 1.12 } };
      for (const layer of parts) ctx.animate(layer, "grow", motion({ name: kind === "sweep" ? "Light sweep" : "Light pulse", start: t, duration: kind === "sweep" ? dur * 0.45 : dur, easing: CURVES.settle, ...grow }));
    }
    ctx.note(`light-shape ${shape} at ${round(cx)}, ${round(cy)}: ${round(long)} x ${round(tall)} px, ${kind}`);
    return { end: round(end), tags: lightShape.tags };
  },
};
