// lightning: jagged electric bolts drawn in code, over what the layer paints (Post FX, next to the
// other drawn overlays speed-lines and impact-lines).
// Why an effect and not a move or a path layer: the bolt has to change shape every few frames
// (drawn lightning is re-drawn, not animated), and only an effect is drawn fresh at each moment
// from (settings, seed, time). It goes on any layer: a frame-size carrier rectangle, or straight
// on the clip (it draws over the picture, clipped to the layer's box).
//
// How one picture is made:
// - each bolt is a line between two points cut in two again and again, each new middle point
//   pushed sideways by a random amount that halves (times 0.55) at every level: midpoint
//   displacement, the usual way to draw lightning. `jag` is the first push, as a share of the
//   bolt's length.
// - branches leave the bolt at random points, turned 15 to 45 degrees off it, shorter, thinner and
//   fading toward their tips.
// - every line is drawn three times: a wide soft glow and a tight glow in `color`, then a bright
//   core in `core` on top, narrowing toward its end by `taper`. The bolts sit on the picture with
//   the screen blend (light only adds), like energy-aura's add-blend group.
// - the shapes are re-drawn `rate` times a second on a seeded sequence (step = floor(time * rate)),
//   like impact-lines and energy-aura's electric style (12, drawn effects on twos at 24 fps).
// - without startX/startY/endX/endY, each bolt starts near the middle of the box (the subject)
//   and runs out past a random edge; with them, every bolt runs between the same two points (an arc).
// Everything is the same for the same seed and time.
import { clipEffect } from "./svg.js";
import { clamp } from "../numbers.js";

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
const color = (label, value) => ({ type: "color", label, default: value });
const choice = (label, value, options) => ({ type: "enum", label, default: value, options: options.map((option) => [option, option[0].toUpperCase() + option.slice(1)]) });

export const LIGHTNING_BLENDS = ["screen", "normal", "overlay"];

export const LIGHTNING_FIELDS = Object.freeze({
  // Bolts and branches: the fan-fast reference frame (f150) shows 3 to 4 long arcs crossing the
  // frame, each with a few short side strokes (.scratch/recreate/fan-fast/ref/f0150.jpg).
  bolts: number("Bolts", 3, 1, 12, 1, "", { integer: true }),
  branches: number("Branches", 3, 0, 12, 1, "", { integer: true }),
  // Where every bolt starts and ends, as a share of the box (0..1, outside allowed). Unset: from
  // near the middle out past an edge. Optional, so they are stored only when given.
  startX: number("Start X", 0.5, -0.5, 1.5, 0.01, "", { optional: true }),
  startY: number("Start Y", 0.5, -0.5, 1.5, 0.01, "", { optional: true }),
  endX: number("End X", 0.5, -0.5, 1.5, 0.01, "", { optional: true }),
  endY: number("End Y", 0.5, -0.5, 1.5, 0.01, "", { optional: true }),
  // The first sideways push, as a share of the bolt's length. 0.3 a guess tuned by eye toward the
  // reference's arcs, which wander about a quarter of their length off a straight line.
  jag: number("Jaggedness", 0.3, 0, 1, 0.01),
  // Core width at 1080p: the reference's white strokes are about 4 to 6 px wide at 960x540
  // (measured on f0150.jpg), so 10 px at 1920 (8 read thinner than the reference on the first proof).
  thickness: number("Thickness", 10, 0.5, 60, 0.5, "px"),
  // 0 keeps the width to the end, 1 draws it to a point (guess: 0.4; the reference's arcs keep
  // most of their width to the frame edge, 0.6 left hairline ends on the first proof).
  taper: number("Taper", 0.4, 0, 1, 0.01),
  // The glow color; the core is white. Near white with a cool cast: the reference's glow reads
  // white over its red picture (f0150.jpg); a pale blue #A8C8FF on the first proof read blue there.
  color: color("Color", "#EAF0FF"),
  core: color("Core", "#FFFFFF"),
  // How wide and strong the soft glow is (0 a bare line).
  glow: number("Glow", 0.6, 0, 1, 0.01),
  opacity: number("Opacity", 1, 0, 1, 0.01),
  rate: number("Rate", 12, 0, 30, 1, "changes/s", { integer: true, animatable: false }),
  // The share of re-draws on which each bolt shows (1 always, lower it blinks on and off).
  life: number("Life", 1, 0.05, 1, 0.01),
  // A strike flash: the box filled with the core color at this opacity on the first re-draw only
  // (1/rate s: one or two frames). Off by default: a flash is a separate choice.
  flash: number("Flash", 0, 0, 1, 0.01),
  seed: number("Seed", 0, 0, 1_000_000, 1, "", { integer: true, animatable: false }),
  blend: choice("Blend", "screen", LIGHTNING_BLENDS),
});

function read(frame, key) {
  const field = LIGHTNING_FIELDS[key];
  const value = frame?.parameters?.[key];
  if (field.type === "color") return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : field.default;
  if (field.type === "enum") return field.options.some(([option]) => option === value) ? value : field.default;
  if (field.optional && !Number.isFinite(value)) return null;
  const result = clamp(Number.isFinite(value) ? value : field.default, field.min, field.max);
  return field.integer ? Math.round(result) : result;
}

const fmt = (value) => {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

function hash(...values) {
  let state = 0x9e3779b9;
  for (const value of values) {
    state = Math.imul(state ^ (value | 0), 0x85ebca6b);
    state ^= state >>> 13;
    state = Math.imul(state, 0xc2b2ae35);
    state ^= state >>> 16;
  }
  return state >>> 0;
}
// A seeded sequence of numbers from 0 to 1 for one (seed, step, bolt).
function sequence(...values) {
  let index = 0;
  return () => hash(...values, index++) / 0x100000000;
}

// Midpoint displacement between a and b: each level halves every segment and pushes its middle
// sideways by up to `push`, which shrinks by 0.55 a level (a guess: 0.5 is the textbook value;
// a little more keeps the fine crackle the reference's arcs have). Stops at `finest` px.
function displace(a, b, push, finest, random) {
  let points = [a, b];
  for (let level = 0; level < 9; level += 1) {
    const next = [points[0]];
    let longest = 0;
    for (let index = 1; index < points.length; index += 1) {
      const [px, py] = points[index - 1], [qx, qy] = points[index];
      const length = Math.hypot(qx - px, qy - py) || 1;
      longest = Math.max(longest, length);
      const shift = (random() * 2 - 1) * push;
      next.push([(px + qx) / 2 - ((qy - py) / length) * shift, (py + qy) / 2 + ((qx - px) / length) * shift], points[index]);
    }
    points = next;
    push *= 0.55;
    if (longest / 2 < finest) break;
  }
  return points;
}

/**
 * The lines at a frame: [{points, width, alpha, taper}] in layer units, plus the flash opacity.
 * Plain numbers, for tests.
 */
export function lightningAt(frame) {
  const { x = 0, y = 0, width, height } = frame.bounds;
  if (!(width > 0) || !(height > 0)) return { lines: [], flash: 0 };
  const get = (key) => read(frame, key);
  const time = Number.isFinite(frame.time) ? Math.max(0, frame.time) : 0;
  const rate = get("rate");
  const step = rate > 0 ? Math.floor(time * rate + 1e-6) : 0;
  const scale = Math.max(width, height) / 1920;
  const thick = get("thickness") * scale, jag = get("jag"), taper = get("taper"), life = get("life"), seed = get("seed");
  const given = [get("startX"), get("startY"), get("endX"), get("endY")];
  const pinned = given.some((value) => value !== null);
  const lines = [];
  for (let bolt = 0; bolt < get("bolts"); bolt += 1) {
    const random = sequence(seed, step, bolt);
    if (random() > life) continue;
    // Brightness wavers a little from one re-draw to the next (0.75 to 1, a guess).
    const bright = 0.75 + 0.25 * random();
    let a, b;
    if (pinned) {
      a = [x + (given[0] ?? 0.5) * width, y + (given[1] ?? 0.5) * height];
      b = [x + (given[2] ?? 0.5) * width, y + (given[3] ?? 0.5) * height];
    } else {
      // From inside the middle 40% of the box out past an edge, in a random direction.
      a = [x + (0.3 + 0.4 * random()) * width, y + (0.3 + 0.4 * random()) * height];
      const turn = (bolt / get("bolts") + 0.25 * random()) * 2 * Math.PI;
      const ux = Math.cos(turn), uy = Math.sin(turn);
      const reach = Math.min(ux ? Math.abs(((ux > 0 ? x + width : x) - a[0]) / ux) : Infinity, uy ? Math.abs(((uy > 0 ? y + height : y) - a[1]) / uy) : Infinity) + 0.04 * Math.max(width, height);
      b = [a[0] + ux * reach, a[1] + uy * reach];
    }
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1) continue;
    // With fixed ends the extra bolts are thinner strands of the same arc.
    const own = pinned && bolt > 0 ? 0.6 : 1;
    // Detail down to 8 px at 1080p (finer adds markup, not a visible crackle).
    const finest = Math.max(2, 8 * scale);
    const main = displace(a, b, jag * length, finest, random);
    lines.push({ points: main, width: thick * own, alpha: bright * own, taper });
    for (let branch = 0; branch < get("branches"); branch += 1) {
      const at = Math.floor((0.15 + 0.7 * random()) * (main.length - 1));
      const ahead = main[Math.min(main.length - 1, at + Math.max(2, Math.round(main.length / 16)))];
      const [sx, sy] = main[at];
      const along = Math.atan2(ahead[1] - sy, ahead[0] - sx);
      const turn = along + (random() < 0.5 ? -1 : 1) * (15 + 30 * random()) * Math.PI / 180;
      const reach = length * (0.15 + 0.3 * random());
      const end = [sx + Math.cos(turn) * reach, sy + Math.sin(turn) * reach];
      lines.push({ points: displace([sx, sy], end, jag * reach, finest, random), width: thick * own * 0.7, alpha: bright * own * 0.9, taper: 1, fade: true });
    }
  }
  const flash = get("flash") > 0 && step === 0 ? get("flash") : 0;
  return { lines, flash };
}

// A line as a few strokes, each narrower (and for branches fainter) than the one before, so the
// width tapers along it with round joins between.
function strokes(line, paint, widthScale, alphaScale) {
  const pieces = 6, count = line.points.length, out = [];
  for (let piece = 0; piece < pieces; piece += 1) {
    const from = Math.floor((piece / pieces) * (count - 1)), to = Math.ceil(((piece + 1) / pieces) * (count - 1));
    if (to <= from) continue;
    const share = (piece + 0.5) / pieces;
    const width = line.width * (1 - line.taper * share) * widthScale;
    const alpha = line.alpha * (line.fade ? 1 - 0.7 * share : 1) * alphaScale;
    if (width < 0.05 || alpha < 0.004) continue;
    const d = line.points.slice(from, to + 1).map(([px, py], index) => `${index ? "L" : "M"}${fmt(px)} ${fmt(py)}`).join("");
    out.push(`<path d="${d}" stroke="${paint}" stroke-width="${fmt(width)}" stroke-opacity="${Math.round(Math.min(1, alpha) * 1000) / 1000}"/>`);
  }
  return out.join("");
}

export function renderLightning(frame) {
  const opacity = read(frame, "opacity");
  if (opacity === 0) return frame.content;
  const { lines, flash } = lightningAt(frame);
  if (!lines.length && !flash) return frame.content;
  const { x = 0, y = 0, width, height } = frame.bounds;
  const scale = Math.max(width, height) / 1920;
  const glow = read(frame, "glow"), glowColor = read(frame, "color");
  const blend = read(frame, "blend");
  const parts = [];
  if (flash > 0) parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" fill="${read(frame, "core")}" fill-opacity="${flash}"/>`);
  const core = lines.map((line) => strokes(line, read(frame, "core"), 1, 1)).join("");
  if (glow > 0 && lines.length) {
    // The core lines once, in defs, drawn three times: a wide soft glow and a tight glow (the
    // lines' shape blurred and filled with `color`), then sharp. Wide blur 24 px at 1080p and glow
    // 1, tight 4 px; alpha gains 2.5 and 2: guesses tuned by eye on the fan-fast reference frame,
    // where the glow hugs the line and fades within about 3 line widths.
    const group = frame.helpers.id("lightning-core"), wide = frame.helpers.id("lightning-glow"), tight = frame.helpers.id("lightning-halo");
    const region = `filterUnits="userSpaceOnUse" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" color-interpolation-filters="sRGB"`;
    const halo = (id, blur, gain) => `<filter id="${id}" ${region}><feGaussianBlur in="SourceAlpha" stdDeviation="${fmt(Math.max(0.5, blur))}"/>` +
      `<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${fmt(gain)} 0" result="spread"/><feFlood flood-color="${glowColor}"/><feComposite in2="spread" operator="in"/></filter>`;
    frame.helpers.defs.push(`<g id="${group}">${core}</g>`, halo(wide, 24 * scale * glow, 2.5 * glow), halo(tight, 4 * scale, 2));
    parts.push(`<use href="#${group}" filter="url(#${wide})"/>`, `<use href="#${group}" filter="url(#${tight})"/>`, `<use href="#${group}"/>`);
  } else parts.push(core);
  const style = blend === "normal" ? "" : ` style="mix-blend-mode:${blend}"`;
  const bolts = `<g aria-hidden="true" pointer-events="none" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${style}>${parts.join("")}</g>`;
  return clipEffect(frame, `<g style="isolation:isolate">${frame.content}${bolts}</g>`);
}

export const LIGHTNING_EFFECT = { key: "lightning", label: "Lightning", group: "Post FX", kind: "ranged", keepStill: "off",
  render: renderLightning, parameters: LIGHTNING_FIELDS };
