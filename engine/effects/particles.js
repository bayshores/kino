// Overlay generators: the "Generate" effect group (embers, sparks, snow, dust, rain, bokeh, fog
// and light leaks). Each one is a ranged effect that draws particles inside its layer's box, on
// top of what the layer already paints. The usual carrier is a full-frame rectangle with its
// fill turned off and the add blend mode, so the particles brighten whatever is below.
//
// The picture at a moment depends only on the settings, the seed and that moment. There is no
// simulation that steps from frame to frame: every particle "slot" lives one life after another,
// and the time since its current life began (its age) is worked out directly from the clock.
// Random choices come from a hash of (seed, slot, life number), and the distance a particle has
// travelled is the integral of its velocity from its birth to now. Scrubbing, the dashboard, a
// segment render and a full export therefore all draw the same frame for the same time.
//
// When to read each setting (so animating one behaves predictably):
//   - at the particle's birth: count (a slot only lives when its number is below the count),
//     spread, the emitter origin, the edge an edge emitter uses;
//   - over the particle's whole life (integrated): speed, direction, wind, gravity;
//   - at the current moment: size, turbulence, colours, opacity, softness, glow, flicker, trail;
//   - fixed for the whole effect (refused in `from`): lifetime, seed, loop, emitter, prewarm.
import { easingAt } from "../easing.js";
import { clipEffect } from "./svg.js";
import { clamp } from "../numbers.js";

const TAU = Math.PI * 2;
const RADIANS = Math.PI / 180;
// Colours are mixed in this many steps, so a frame needs at most this many gradients per kind.
const COLOR_STEPS = 12;
// The finest step used to integrate an animated speed, direction, wind or gravity.
const STEP = 1 / 60;
const MAX_STEPS = 2400;
// Particles this faint are skipped.
const MIN_ALPHA = 0.004;
// The clock is read in ticks of 1/1200 s. Every common frame rate (10, 12, 15, 24, 25, 30, 48, 50
// and 60 fps) lands exactly on a tick, so frame times that differ only by rounding (an export's
// frame times drift from k/fps by under 0.25 ms at 60 fps) draw the same frame, and a loop repeats exactly.
export const CLOCK_TICKS = 1200;

const lerp = (a, b, t) => a + (b - a) * t;
// Where variation 1 takes a dot look's depth ranges unless the look sets its own `deep`.
// shade: the power on depth that leans near particles to color2 (2: only the nearest).
const DEEP_FIELD = Object.freeze({ speedJitter: 1.5, depth: [0.45, 1.7], parallax: [0.25, null], depthAlpha: 0.35, shade: 2 });
// The variation a new dot effect starts with (one without its own default). Run 8's embers at 0
// drew one dot size across the frame (.scratch/run8/trace/effects.md section 1); the human
// edits' snow and sparks vary in size and depth (section 2). 0.6 is the run 8 design's value,
// checked by the near/far size spread particlesAt gives (RESULT.md of the effect-defaults wave).
export const NEW_VARIATION = 0.6;
const smoothstep = (edge0, edge1, value) => {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
const fmt = (value) => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};
const fmtAlpha = (value) => String(Math.round(clamp(value, 0, 1) * 1000) / 1000);

// ---- Random numbers: a 32-bit integer hash, the same on every machine. ----
function mix(value) {
  let h = value | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
const hashBase = (seed, slot, life) => mix(mix(mix(seed ^ 0x2545f491) ^ slot) ^ life);
// A number from 0 (inclusive) to 1 (exclusive) for one channel of a (seed, slot, life) base.
const random = (base, channel) => mix(base ^ Math.imul(channel + 1, 0x9e3779b9)) / 4294967296;

// ---- Settings ----
const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
const color = (label, value) => ({ type: "color", label, default: value });
const EMITTERS = [["area", "Area"], ["bottom", "Bottom edge"], ["top", "Top edge"], ["left", "Left edge"],
  ["right", "Right edge"], ["point", "Point"]];

// Per-look character. shape: dot (round, optional streak), blob (soft ellipse). colorMode: "age"
// fades color -> color2 over each life; "random" gives every particle its own mix. fade: the share
// of a life spent fading in and out. depth: [near/far size scale]; parallax: [far, near] speed
// scale. maxCount keeps a frame affordable (measured in COMPATIBILITY.md).
export const PARTICLE_LOOKS = Object.freeze({
  embers: { label: "Embers", shape: "dot", colorMode: "age", maxCount: 1500, size: [0.5, 48],
    lifeJitter: 0.4, sizeJitter: 0.8, speedJitter: 0.6, depth: [0.55, 1.2], parallax: [0.7, 1.1], depthAlpha: 0.6,
    fade: [0.08, 0.45], sizeOverLife: [1, 0.45], flickerHz: [3, 7], wanderHz: [0.15, 0.6],
    defaults: { count: 150, size: 8, speed: 150, direction: 0, spread: 30, gravity: 0, wind: 10, turbulence: 20,
      lifetime: 7, color: "#FFD36B", color2: "#FF4A12", opacity: 1, softness: 0.5, glow: 0.8, flicker: 0.4,
      trail: 0, emitter: "bottom" } },
  sparks: { label: "Sparks", shape: "dot", colorMode: "age", maxCount: 800, size: [0.5, 32],
    lifeJitter: 0.45, sizeJitter: 0.7, speedJitter: 0.8, depth: [0.7, 1.15], parallax: [0.8, 1.05], depthAlpha: 0.75,
    fade: [0.02, 0.5], sizeOverLife: [1, 0.3], flickerHz: [8, 14], wanderHz: [0.5, 1.5],
    defaults: { count: 220, size: 3, speed: 520, direction: 0, spread: 70, gravity: 900, wind: 0, turbulence: 0,
      lifetime: 1.1, color: "#FFF6D0", color2: "#FF7A1A", opacity: 1, softness: 0.2, glow: 0.5, flicker: 0.6,
      trail: 0.06, emitter: "point", originX: 0.5, originY: 0.85 } },
  snow: { label: "Snow", shape: "dot", colorMode: "random", maxCount: 2000, size: [0.5, 64],
    lifeJitter: 0.3, sizeJitter: 0.6, speedJitter: 0.3, depth: [0.4, 1.6], parallax: [0.45, 1.15], depthAlpha: 0.5,
    fade: [0.1, 0.1], sizeOverLife: [1, 1], flickerHz: [0.5, 1.5], wanderHz: [0.1, 0.35],
    defaults: { count: 300, size: 9, speed: 70, direction: 180, spread: 20, gravity: 0, wind: 25, turbulence: 22,
      lifetime: 10, color: "#FFFFFF", color2: "#DCE8FF", opacity: 0.9, softness: 0.7, glow: 0, flicker: 0,
      trail: 0, emitter: "area" } },
  dust: { label: "Dust", shape: "dot", colorMode: "random", maxCount: 2000, size: [0.5, 32],
    lifeJitter: 0.4, sizeJitter: 0.8, speedJitter: 0.6, depth: [0.5, 1.3], parallax: [0.5, 1.1], depthAlpha: 0.45,
    fade: [0.25, 0.25], sizeOverLife: [1, 1], flickerHz: [0.4, 1.6], wanderHz: [0.05, 0.25],
    defaults: { count: 160, size: 5, speed: 12, direction: 0, spread: 360, gravity: 0, wind: 6, turbulence: 30,
      lifetime: 6, color: "#FFF4DC", color2: "#FFD9A0", opacity: 0.85, softness: 0.5, glow: 0.5, flicker: 0.3,
      trail: 0, emitter: "area" } },
  rain: { label: "Rain", shape: "dot", colorMode: "random", maxCount: 2000, size: [0.5, 16],
    lifeJitter: 0.25, sizeJitter: 0.5, speedJitter: 0.25, depth: [0.5, 1.2], parallax: [0.55, 1.1], depthAlpha: 0.45,
    fade: [0.05, 0.05], sizeOverLife: [1, 1], flickerHz: [1, 3], wanderHz: [0.3, 0.8],
    defaults: { count: 400, size: 1.5, speed: 1400, direction: 185, spread: 3, gravity: 0, wind: 0, turbulence: 0,
      lifetime: 1.2, color: "#CFE3FF", color2: "#FFFFFF", opacity: 0.5, softness: 0, glow: 0, flicker: 0,
      trail: 0.035, emitter: "area" } },
  // A field of falling light streaks with depth in one layer: far ones small, slow, short and dim,
  // near ones larger, faster, longer, brighter and glowing. Defaults from the streak-field study's
  // final three rain planes merged (far 1600 at 220 px/s, mid 450 at 420, near 70 at 800, trail
  // 0.45 to 0.5 s, #1C9E70 far to #D4FFE9 near); variation 0.8 spreads one plane across all three.
  streaks: { label: "Streaks", shape: "dot", colorMode: "random", maxCount: 2000, size: [0.5, 16],
    lifeJitter: 0.25, sizeJitter: 0.5, speedJitter: 0.25, depth: [0.5, 1.2], parallax: [0.55, 1.1], depthAlpha: 0.45,
    fade: [0.05, 0.05], sizeOverLife: [1, 1], flickerHz: [1, 3], wanderHz: [0.3, 0.8],
    // Where variation 1 takes this look's depth ranges (other looks use DEEP_FIELD). From the
    // study's planes against the middle one (420 px/s): far 220 (0.52), near 800 (1.9); far
    // brightness 0.55 is the far plane's opacity 0.7 times rain's mean depth fade (about 0.78).
    // shade 1 (a guess tuned by eye) lifts the middle streaks toward color2, as the study's
    // bright middle plane (#38F0A8 at 0.8) did; shade 2 left them the dim far color.
    deep: { parallax: [0.52, 1.9], depthAlpha: 0.6, depth: [0.6, 1.5], shade: 1 },
    // count and opacity raised after the first re-run (900 and 0.75 read sparser than the reference).
    // haze 0.12 (a guess tuned by eye on the streak-field re-run): at 0.3 the blurred copy's 8x
    // alpha gain clipped where streaks cluster and left dark holes between, a blotchy pattern the
    // reference's even mist does not have; 0.12 keeps a faint bloom without the blotches.
    defaults: { count: 1400, size: 2.5, speed: 420, direction: 180, spread: 0, gravity: 0, wind: 0, turbulence: 0,
      lifetime: 4, color: "#1C9E70", color2: "#D4FFE9", opacity: 0.9, softness: 0.3, glow: 0.6, flicker: 0.15,
      trail: 0.45, emitter: "area", variation: 0.8, haze: 0.12 } },
  bokeh: { label: "Bokeh", shape: "dot", profile: "bokeh", colorMode: "pick", maxCount: 300, size: [4, 400],
    lifeJitter: 0.4, sizeJitter: 0.9, speedJitter: 0.6, depth: [0.5, 1.3], parallax: [0.6, 1.1], depthAlpha: 0.55,
    fade: [0.3, 0.3], sizeOverLife: [1, 1], flickerHz: [0.2, 0.6], wanderHz: [0.05, 0.2],
    defaults: { count: 30, size: 90, speed: 14, direction: 0, spread: 360, gravity: 0, wind: 0, turbulence: 25,
      lifetime: 8, color: "#FFC27A", color2: "#7FD0FF", opacity: 0.45, softness: 0.25, glow: 0, flicker: 0.2,
      trail: 0, emitter: "area" } },
  fog: { label: "Fog", shape: "blob", profile: "fog", colorMode: "random", maxCount: 64, size: [50, 4000],
    lifeJitter: 0.3, sizeJitter: 0.5, speedJitter: 0.5, depth: [0.8, 1.2], parallax: [0.6, 1.1], depthAlpha: 0.7,
    fade: [0.3, 0.3], sizeOverLife: [0.85, 1.2], flickerHz: [0.1, 0.3], wanderHz: [0.03, 0.12],
    aspect: [1.6, 2.6], tilt: 12,
    defaults: { count: 14, size: 700, speed: 20, direction: 90, spread: 30, wind: 0, turbulence: 40,
      lifetime: 14, color: "#D9DFE6", color2: "#B4BECA", opacity: 0.18, flicker: 0 } },
  "light-leaks": { label: "Light Leaks", shape: "blob", profile: "leak", colorMode: "random", maxCount: 16, size: [50, 4000],
    lifeJitter: 0.35, sizeJitter: 0.4, speedJitter: 0.5, depth: [0.85, 1.15], parallax: [0.7, 1.1], depthAlpha: 0.8,
    fade: [0.35, 0.45], sizeOverLife: [0.7, 1.3], flickerHz: [0.15, 0.4], wanderHz: [0.04, 0.15],
    aspect: [1.2, 2], tilt: 40,
    defaults: { count: 4, size: 1100, speed: 60, direction: 90, spread: 40, wind: 0, turbulence: 60,
      lifetime: 5, color: "#FF5A1F", color2: "#FFC94D", opacity: 0.75, flicker: 0.2 } },
});

function lookParameters(look) {
  const d = look.defaults, dots = look.shape === "dot";
  return {
    count: number("Count", d.count, 0, look.maxCount, 1, "", { integer: true }),
    size: number("Size", d.size, look.size[0], look.size[1], 0.5, "px"),
    speed: number("Speed", d.speed, 0, 3000, 1, "px/s"),
    direction: number("Direction", d.direction, -720, 720, 1, "deg"),
    spread: number("Spread", d.spread, 0, 360, 1, "deg"),
    ...(dots ? { gravity: number("Gravity", d.gravity, -3000, 3000, 10, "px/s2") } : {}),
    wind: number("Wind", d.wind, -2000, 2000, 1, "px/s"),
    turbulence: number("Turbulence", d.turbulence, 0, 400, 1, "px"),
    lifetime: number("Lifetime", d.lifetime, 0.1, 60, 0.1, "s", { animatable: false }),
    color: color("Color", d.color),
    color2: color("Color 2", d.color2),
    opacity: number("Opacity", d.opacity, 0, 1, 0.01),
    ...(dots ? {
      softness: number("Softness", d.softness, 0, 1, 0.01),
      glow: number("Glow", d.glow, 0, 1, 0.01),
    } : {}),
    flicker: number("Flicker", d.flicker, 0, 1, 0.01),
    ...(dots ? {
      trail: number("Trail", d.trail, 0, 0.5, 0.005, "s"),
      // How far each particle's depth spreads its size, speed, trail length, brightness, glow and
      // color (color far, color2 near): 0 the look's own small jitter, 1 a deep field in one layer.
      // Optional on looks without their own default, so saved effects draw as before (a missing
      // value draws as 0, particlesAt). A new effect starts at NEW_VARIATION (`created`).
      variation: number("Variation", d.variation ?? NEW_VARIATION, 0, 1, 0.01, "", d.variation === undefined ? { optional: true, created: true } : {}),
      // A soft blurred copy of the particles under them: the haze that blooms where streaks
      // cluster. Optional the same way.
      haze: number("Haze", d.haze ?? 0, 0, 1, 0.01, "", d.haze === undefined ? { optional: true } : {}),
      // Lines between particles closer than `links` px (a constellation; the particles are its
      // nodes). Off unless set. Width 1.5 and opacity 0.55 are the streak-field study's hand-drawn links.
      links: number("Links", 0, 0, 1200, 1, "px", { optional: true }),
      linkWidth: number("Link width", 1.5, 0.25, 12, 0.25, "px", { optional: true }),
      linkOpacity: number("Link opacity", 0.55, 0, 1, 0.01, "", { optional: true }),
      emitter: { type: "enum", label: "Emitter", default: d.emitter, options: EMITTERS, animatable: false },
      originX: number("Origin X", d.originX ?? 0.5, 0, 1, 0.01),
      originY: number("Origin Y", d.originY ?? 0.5, 0, 1, 0.01),
    } : {}),
    prewarm: { type: "boolean", label: "Prewarm", default: true, animatable: false },
    seed: number("Seed", 1, 0, 999999, 1, "", { integer: true, animatable: false }),
    loop: number("Loop", 0, 0, 60, 0.1, "s", { animatable: false }),
  };
}

// ---- Reading a setting at another moment of the effect (its birth, or along its life) ----
// The same rule as engine/effects/animation.js: a ranged effect moves from `from` to `to` over its
// duration with its easing; before its start it holds `from`, after its end it holds `to`.
function track(fields, frame, key) {
  const field = fields[key], current = frame.parameters[key];
  const operation = frame.operation;
  if (!operation?.to || !(operation.duration > 0)) return { constant: true, value: current, at: () => current, low: current, high: current };
  const b = operation.to[key] ?? field.default, a = operation.from?.[key] ?? b;
  if (a === b) return { constant: true, value: b, at: () => b, low: b, high: b };
  const easing = operation.easing ?? "linear", intensity = operation.intensity ?? 50, duration = operation.duration;
  const at = (tau) => clamp(a + (b - a) * easingAt(easing, clamp(tau, 0, duration) / duration, intensity), field.min, field.max);
  let low = Math.min(a, b), high = Math.max(a, b);
  // An easing may overshoot; a few samples bound the values it reaches.
  for (let index = 1; index < 64; index += 1) {
    const value = at((index / 64) * duration);
    low = Math.min(low, value); high = Math.max(high, value);
  }
  return { constant: false, at, low, high };
}

// The distance travelled is the integral of velocity. With steady settings it has a closed form;
// when speed, direction, wind or gravity animate, it is summed on a fixed 1/60 s grid that is
// aligned to the effect's own clock, so the same moment always gives the same answer.
function motion(tracks, from, to) {
  const { speed, direction, wind, gravity } = tracks;
  if (speed.constant && direction.constant && wind.constant && gravity.constant) {
    const sx = speed.value * Math.sin(direction.value * RADIANS), sy = speed.value * Math.cos(direction.value * RADIANS);
    const w = wind.value, g = gravity.value;
    return { A: (t) => sx * t, B: (t) => sy * t, W: (t) => w * t, G: (t) => g * t, GG: (t) => 0.5 * g * t * t };
  }
  const step = Math.max(STEP, (to - from) / MAX_STEPS);
  const start = Math.floor(from / step) * step;
  const count = Math.ceil((to - start) / step) + 2;
  const series = (fn) => Float64Array.from({ length: count }, (_, index) => fn(start + index * step));
  const ys = { A: series((t) => speed.at(t) * Math.sin(direction.at(t) * RADIANS)),
    B: series((t) => speed.at(t) * Math.cos(direction.at(t) * RADIANS)), W: series(wind.at), G: series(gravity.at) };
  const sums = {};
  for (const key of ["A", "B", "W", "G"]) {
    const y = ys[key], sum = new Float64Array(count);
    for (let index = 1; index < count; index += 1) sum[index] = sum[index - 1] + 0.5 * step * (y[index - 1] + y[index]);
    sums[key] = sum;
  }
  // GG is the integral of G (the velocity gravity has added since the table's start).
  const gg = new Float64Array(count);
  for (let index = 1; index < count; index += 1) gg[index] = gg[index - 1] + 0.5 * step * (sums.G[index - 1] + sums.G[index]);
  const locate = (t) => {
    const position = clamp((t - start) / step, 0, count - 1.000001);
    const index = Math.floor(position);
    return [index, position - index];
  };
  const integral = (key) => (t) => {
    const [index, fraction] = locate(t), y = ys[key];
    const yt = y[index] + fraction * (y[index + 1] - y[index]);
    return sums[key][index] + 0.5 * step * fraction * (y[index] + yt);
  };
  const G = integral("G");
  return { A: integral("A"), B: integral("B"), W: integral("W"), G,
    GG: (t) => { const [index, fraction] = locate(t); return gg[index] + 0.5 * step * fraction * (sums.G[index] + G(t)); } };
}

function hex(value) { return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16)); }
function mixColor(a, b, t) {
  const left = hex(a), right = hex(b);
  return `#${left.map((channel, index) => Math.round(lerp(channel, right[index], t)).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/**
 * Work out every visible particle of one generator at the frame's time. Returns plain numbers
 * so tests can check positions; renderParticles turns them into SVG.
 * frame: { parameters, time, operation?, bounds: {width, height} } as effects receive it.
 */
export function particlesAt(key, frame) {
  const plain = PARTICLE_LOOKS[key];
  if (!plain) throw new RangeError(`Unknown particle generator "${String(key)}"`);
  const fields = PARTICLE_FIELDS[key];
  const p = frame.parameters;
  // Variation widens the look's depth ranges toward a deep field (end points are guesses tuned
  // by eye on the streak-field study: far streaks at 0.45 size, 0.25 speed and 0.35 brightness;
  // the builder's 0.3 size and 0.25 brightness left the far plane too faint to read next to the
  // reference, whose far columns are dim but clearly there).
  const variation = plain.shape === "dot" ? clamp(Number.isFinite(p.variation) ? p.variation : plain.defaults.variation ?? 0, 0, 1) : 0;
  const deep = { ...DEEP_FIELD, parallax: [DEEP_FIELD.parallax[0], plain.parallax[1]], ...plain.deep };
  const look = variation > 0 ? { ...plain, speedJitter: lerp(plain.speedJitter, deep.speedJitter, variation),
    depth: [lerp(plain.depth[0], deep.depth[0], variation), lerp(plain.depth[1], deep.depth[1], variation)],
    parallax: [lerp(plain.parallax[0], deep.parallax[0], variation), lerp(plain.parallax[1], deep.parallax[1], variation)],
    depthAlpha: lerp(plain.depthAlpha, deep.depthAlpha, variation) } : plain;
  const width = frame.bounds.width, height = frame.bounds.height;
  let ticks = Math.round((Number.isFinite(frame.time) ? frame.time : 0) * CLOCK_TICKS);
  const dots = look.shape === "dot";
  const t = Object.fromEntries(["count", "size", "speed", "direction", "spread", "wind", "turbulence", "glow", "trail", "originX", "originY"]
    .map((name) => [name, fields[name] ? track(fields, frame, name) : { constant: true, value: 0, at: () => 0, low: 0, high: 0 }]));
  t.gravity = dots ? track(fields, frame, "gravity") : { constant: true, value: 0, at: () => 0, low: 0, high: 0 };
  const lifetime = p.lifetime, loop = p.loop, seed = p.seed;
  const emitter = dots ? p.emitter : "area";
  const prewarm = p.prewarm || loop > 0;
  // A loop whose birth and motion settings hold still starts again from 0 every loop, so its
  // frames repeat exactly (a Lottie export stores each distinct frame once).
  if (loop > 0 && Object.values(t).every((item) => item.constant)) {
    const period = Math.max(1, Math.round(loop * CLOCK_TICKS));
    ticks = ((ticks % period) + period) % period;
  }
  const s = ticks / CLOCK_TICKS;
  const slots = Math.max(0, Math.round(t.count.high));
  if (!slots || width < 1 || height < 1) return { particles: [], shape: look.shape, slots: 0 };
  const maxAge = lifetime * (1 + look.lifeJitter);
  const move = motion(t, s - maxAge - STEP, s + STEP);

  // Area particles wrap around the box plus this margin, so one leaving an edge comes back in on
  // the other side while it is fully out of sight. The margin is fixed for the whole effect.
  const sizeScale = Math.max(1, look.sizeJitter / 2 + 1) * look.depth[1] * Math.max(...look.sizeOverLife);
  const glowScale = dots ? 2 + 4 * t.glow.high : 1;
  const aspect = look.aspect ? look.aspect[1] : 1;
  const radiusLimit = 0.5 * t.size.high * sizeScale * Math.max(glowScale, aspect);
  const fastest = t.speed.high * (1 + look.speedJitter / 2) * look.parallax[1] + Math.max(Math.abs(t.wind.low), Math.abs(t.wind.high)) +
    Math.max(Math.abs(t.gravity.low), Math.abs(t.gravity.high)) * maxAge;
  const margin = Math.ceil(radiusLimit + t.trail.high * (1 + 0.6 * variation) * fastest + 1);

  const particles = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const slotBase = hashBase(seed, slot, 0x51ed);
    let life = lifetime * (1 + look.lifeJitter * (2 * random(slotBase, 0) - 1));
    let lives = 0;
    if (loop > 0) { lives = Math.max(1, Math.round(loop / life)); life = loop / lives; }
    const x = s / life + random(slotBase, 1);
    const cycle = Math.floor(x), fraction = x - cycle;
    const age = fraction * life, birth = s - age;
    if (!prewarm && birth < 0) continue;
    if (slot >= Math.round(t.count.at(birth))) continue;
    const base = hashBase(seed, slot, lives ? ((cycle % lives) + lives) % lives : cycle);
    // With variation most particles sit far back and few come near, as in a real field (the
    // study's three planes held 1600 far, 450 mid and 70 near streaks).
    const depth = variation > 0 ? random(base, 0) ** (1 + 1.5 * variation) : random(base, 0);
    const parallax = lerp(look.parallax[0], look.parallax[1], depth);
    const speedFactor = (1 - look.speedJitter / 2 + look.speedJitter * random(base, 2)) * parallax;
    const sizeFactor = (1 - look.sizeJitter / 2 + look.sizeJitter * random(base, 1)) * lerp(look.depth[0], look.depth[1], depth);
    const turn = t.spread.at(birth) * RADIANS * (random(base, 3) - 0.5);
    const cosTurn = Math.cos(turn), sinTurn = Math.sin(turn);
    // With variation each streak's trail is its own length (0.4 to 1.6 of trail at variation 1).
    const trailShare = variation > 0 ? 1 + variation * (1.2 * random(base, 14) - 0.6) : 1;
    // With variation each particle wraps with its own margin (its own trail at its own speed):
    // one shared margin sized for the fastest, longest streak left most slow far streaks off
    // screen (a field of 2600 showed about 40% of them at 1080p). Only looks with their own `deep`
    // ranges (streaks) wrap this way, so a saved rain or dust layer with variation keeps its positions.
    const wrap = variation > 0 && plain.deep ? Math.ceil(radiusLimit + t.trail.high * trailShare * (t.speed.high * speedFactor +
      parallax * Math.max(Math.abs(t.wind.low), Math.abs(t.wind.high)) + Math.max(Math.abs(t.gravity.low), Math.abs(t.gravity.high)) * maxAge) + 1) : margin;
    const wrapX = width + 2 * wrap, wrapY = height + 2 * wrap;

    // How far a particle born at `at` would drift over its life with that moment's settings.
    const drift = (at) => {
      const speed = t.speed.at(at), direction = t.direction.at(at) * RADIANS;
      return [(speed * Math.sin(direction) + t.wind.at(at)) * life,
        -speed * Math.cos(direction) * life + 0.5 * t.gravity.at(at) * life * life];
    };
    // Where it was born.
    let x0, y0;
    const birthRadius = 0.5 * t.size.at(birth) * sizeFactor * look.sizeOverLife[0] * (dots ? 2 + 4 * t.glow.at(birth) : aspect);
    if (!dots) {
      // Blobs are too big to wrap. Their paths are centred on the box instead: a blob is born
      // half its life's drift upstream, so it is over the box in the middle of its life.
      const [driftX, driftY] = drift(birth);
      x0 = (random(base, 10) * 1.2 - 0.1) * width - driftX / 2;
      y0 = (random(base, 11) * 1.2 - 0.1) * height - driftY / 2;
    } else if (emitter === "area") {
      x0 = -wrap + random(base, 10) * wrapX; y0 = -wrap + random(base, 11) * wrapY;
    } else if (emitter === "point") {
      const spot = 0.5 * t.size.at(birth) * Math.sqrt(random(base, 10)), angle = TAU * random(base, 11);
      x0 = t.originX.at(birth) * width + spot * Math.cos(angle); y0 = t.originY.at(birth) * height + spot * Math.sin(angle);
    } else {
      // Widen the edge against the expected sideways drift so the field stays evenly filled.
      const [driftX, driftY] = drift(birth);
      if (emitter === "bottom" || emitter === "top") {
        const low = Math.min(0, -driftX) - birthRadius, high = width + Math.max(0, -driftX) + birthRadius;
        x0 = low + random(base, 10) * (high - low);
        y0 = emitter === "bottom" ? height + birthRadius : -birthRadius;
      } else {
        const low = Math.min(0, -driftY) - birthRadius, high = height + Math.max(0, -driftY) + birthRadius;
        y0 = low + random(base, 10) * (high - low);
        x0 = emitter === "right" ? width + birthRadius : -birthRadius;
      }
    }

    // Where it is at time `at` (birth <= at <= s): launch flow, wind, gravity and its own wander.
    const turbulence = p.turbulence * parallax;
    const wanderHz = lerp(look.wanderHz[0], look.wanderHz[1], random(base, 7));
    const phaseX = TAU * random(base, 5), phaseY = TAU * random(base, 6);
    const A0 = move.A(birth), B0 = move.B(birth), W0 = move.W(birth), G0 = move.G(birth), GG0 = move.GG(birth);
    const position = (at) => {
      const dA = move.A(at) - A0, dB = move.B(at) - B0, ageAt = at - birth;
      let px = x0 + speedFactor * (cosTurn * dA + sinTurn * dB) + parallax * (move.W(at) - W0);
      let py = y0 - speedFactor * (cosTurn * dB - sinTurn * dA) + (move.GG(at) - GG0 - G0 * ageAt);
      if (turbulence > 0) {
        const wave = TAU * wanderHz * ageAt;
        px += turbulence * (Math.sin(wave + phaseX) - Math.sin(phaseX) + 0.5 * (Math.sin(1.7 * wave + phaseY) - Math.sin(phaseY)));
        py += turbulence * (Math.sin(1.3 * wave + phaseY) - Math.sin(phaseY) + 0.5 * (Math.sin(2.1 * wave + phaseX) - Math.sin(phaseX)));
      }
      return [px, py];
    };
    let [hx, hy] = position(s);
    let tail = null;
    const trail = p.trail * trailShare;
    if (dots && trail > 0 && age > 0) tail = position(Math.max(birth, s - trail));
    if (dots && emitter === "area") {
      const shiftX = Math.floor((hx + wrap) / wrapX) * wrapX, shiftY = Math.floor((hy + wrap) / wrapY) * wrapY;
      hx -= shiftX; hy -= shiftY;
      if (tail) tail = [tail[0] - shiftX, tail[1] - shiftY];
    }

    // How it looks now.
    const lifeShare = age / life;
    const envelope = smoothstep(0, look.fade[0], lifeShare) * (1 - smoothstep(1 - look.fade[1], 1, lifeShare));
    const flickerHz = lerp(look.flickerHz[0], look.flickerHz[1], random(base, 9));
    const twinkle = 1 - p.flicker * (0.5 + 0.5 * Math.sin(TAU * flickerHz * age + TAU * random(base, 8)));
    const alpha = p.opacity * envelope * lerp(look.depthAlpha, 1, depth) * twinkle;
    if (alpha < MIN_ALPHA) continue;
    const radius = 0.5 * p.size * sizeFactor * lerp(look.sizeOverLife[0], look.sizeOverLife[1], lifeShare);
    // "age": color -> color2 over the life; "pick": mostly one or the other; "random": any mix.
    const pick = random(base, 4);
    const own = look.colorMode === "age" ? lifeShare : look.colorMode === "pick" ? (pick < 0.5 ? pick * 0.4 : 0.6 + (pick - 0.5) * 0.8) : pick;
    // With variation only the nearest particles lean to color2 (a pale core); the rest keep color.
    const shade = variation > 0 && look.colorMode !== "age" ? lerp(own, depth ** deep.shade, variation) : own;
    const tone = Math.round(clamp(shade, 0, 1) * (COLOR_STEPS - 1));
    const reach = dots ? radius * (p.glow > 0 ? 2 + 4 * p.glow : 1) : radius * lerp(look.aspect[0], look.aspect[1], random(base, 12));
    const left = Math.min(hx, tail?.[0] ?? hx) - reach, right = Math.max(hx, tail?.[0] ?? hx) + reach;
    const top = Math.min(hy, tail?.[1] ?? hy) - reach, bottom = Math.max(hy, tail?.[1] ?? hy) + reach;
    if (right < 0 || bottom < 0 || left > width || top > height) continue;
    particles.push({ slot, depth, x: hx, y: hy, tail, radius, alpha, tone,
      // With variation only the nearer particles glow (none in the far third).
      ...(variation > 0 && dots ? { glow: p.glow * lerp(1, smoothstep(0.35, 1, depth), variation) } : {}),
      ...(dots ? {} : { aspect: lerp(look.aspect[0], look.aspect[1], random(base, 12)),
        tilt: look.tilt * (2 * random(base, 13) - 1) }) });
  }
  // Far particles first, so near ones are drawn over them.
  particles.sort((a, b) => a.depth - b.depth || a.slot - b.slot);
  return { particles, shape: look.shape, slots };
}

// ---- Drawing ----
const PROFILES = {
  // [offset, opacity] stops; `inner` (1 - softness) marks where the solid core ends.
  dot: (inner) => inner >= 0.999 ? null : [[0, 1], [inner, 1], [inner + (1 - inner) * 0.35, 0.55], [inner + (1 - inner) * 0.7, 0.18], [1, 0]],
  bokeh: (inner) => [[0, 0.62], [inner * 0.85, 0.8], [inner * 0.97, 1], [inner + (1 - inner) * 0.5, 0.35], [1, 0]],
  glow: () => [[0, 1], [0.15, 0.6], [0.4, 0.2], [1, 0]],
  fog: () => [[0, 1], [0.3, 0.8], [0.6, 0.35], [0.85, 0.08], [1, 0]],
  leak: () => [[0, 1], [0.25, 0.85], [0.55, 0.4], [0.8, 0.1], [1, 0]],
};

function gradient(id, colorValue, stops) {
  return `<radialGradient id="${id}">${stops.map(([offset, opacity]) =>
    `<stop offset="${fmtAlpha(offset)}" stop-color="${colorValue}" stop-opacity="${fmtAlpha(opacity)}"/>`).join("")}</radialGradient>`;
}

// A particle joins at most this many neighbors (nearest first), so a dense field draws a web,
// not a solid mesh. A guess: the study's hand-drawn constellation had 1 to 3 lines per node.
const MAX_LINKS = 3;

/** Lines between particles closer than p.links px, faded over the last 30% of that distance. */
export function linkLines(particles, p, tones) {
  const distance = Number.isFinite(p.links) ? p.links : 0;
  if (!(distance > 0) || particles.length < 2) return [];
  const width = Number.isFinite(p.linkWidth) ? p.linkWidth : 1.5;
  const opacity = Number.isFinite(p.linkOpacity) ? p.linkOpacity : 0.55;
  // A grid of cells one link long, so each particle only checks its own and the 8 cells around it.
  const cells = new Map();
  const cellOf = (item) => `${Math.floor(item.x / distance)},${Math.floor(item.y / distance)}`;
  particles.forEach((item, index) => { const key = cellOf(item); if (!cells.has(key)) cells.set(key, []); cells.get(key).push(index); });
  const pairs = [];
  particles.forEach((a, i) => {
    const cx = Math.floor(a.x / distance), cy = Math.floor(a.y / distance);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (const j of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
      if (j <= i) continue;
      const length = Math.hypot(particles[j].x - a.x, particles[j].y - a.y);
      if (length < distance) pairs.push([length, i, j]);
    }
  });
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const used = new Array(particles.length).fill(0), lines = [];
  for (const [length, i, j] of pairs) {
    if (used[i] >= MAX_LINKS || used[j] >= MAX_LINKS) continue;
    used[i] += 1; used[j] += 1;
    const a = particles[i], b = particles[j];
    // The square root of the dimmer end's own brightness share: a line fades in and out with its
    // nodes, but a mid-bright pair still draws a clear line (linear, a dust pair at about 0.45 drew
    // the line at 0.25, fainter than the study's 0.55 path; the root is a guess tuned on that re-run).
    const share = Math.sqrt(clamp(Math.min(a.alpha, b.alpha) / Math.max(p.opacity, 0.001), 0, 1));
    const alpha = opacity * share * (1 - smoothstep(0.7 * distance, distance, length));
    if (alpha < MIN_ALPHA) continue;
    lines.push(`<path d="M${fmt(a.x)} ${fmt(a.y)}L${fmt(b.x)} ${fmt(b.y)}" stroke="${tones[Math.max(a.tone, b.tone)]}" stroke-width="${fmt(width)}" stroke-linecap="round" stroke-opacity="${fmtAlpha(alpha)}" fill="none"/>`);
  }
  return lines;
}

/** The SVG for one frame of a generator: the layer's own paint, then its particles, clipped to the box. */
export function renderParticles(key, frame) {
  const look = PARTICLE_LOOKS[key];
  const { particles } = particlesAt(key, frame);
  const p = frame.parameters;
  const tones = Array.from({ length: COLOR_STEPS }, (_, index) => mixColor(p.color, p.color2, index / (COLOR_STEPS - 1)));
  const ids = new Map();
  const paint = (kind, tone, stops) => {
    const name = `${kind}-${tone}`;
    if (!ids.has(name)) {
      const id = String(frame.helpers.id(`particles-${kind}`));
      if (!/^[\w.:-]{1,4096}$/.test(id)) throw new TypeError("Effect helper IDs for particles must be plain names.");
      frame.helpers.defs.push(gradient(id, tones[tone], stops));
      ids.set(name, `url(#${id})`);
    }
    return ids.get(name);
  };
  const parts = [];
  if (look.shape === "blob") {
    const stops = PROFILES[look.profile]();
    for (const item of particles) {
      const rx = item.radius * item.aspect, ry = item.radius;
      parts.push(`<ellipse cx="${fmt(item.x)}" cy="${fmt(item.y)}" rx="${fmt(rx)}" ry="${fmt(ry)}" transform="rotate(${fmt(item.tilt)} ${fmt(item.x)} ${fmt(item.y)})" fill="${paint(look.profile, item.tone, stops)}" fill-opacity="${fmtAlpha(item.alpha)}"/>`);
    }
  } else {
    const inner = 1 - p.softness;
    const stops = (look.profile === "bokeh" ? PROFILES.bokeh : PROFILES.dot)(inner);
    parts.push(...linkLines(particles, p, tones));
    const glowStops = PROFILES.glow();
    for (const item of particles) {
      const r = item.radius, alpha = item.alpha, glow = item.glow ?? p.glow;
      if (glow > 0) parts.push(`<circle cx="${fmt(item.x)}" cy="${fmt(item.y)}" r="${fmt(r * (2 + 4 * glow))}" fill="${paint("glow", item.tone, glowStops)}" fill-opacity="${fmtAlpha(alpha * glow * 0.8)}"/>`);
      const length = item.tail ? Math.hypot(item.x - item.tail[0], item.y - item.tail[1]) : 0;
      if (length >= 0.5) {
        // A streak: a thin, faint tail half and a full-width head half, with round ends.
        const midX = (item.x + item.tail[0]) / 2, midY = (item.y + item.tail[1]) / 2;
        const colorValue = tones[item.tone], width = 2 * r * (1 - 0.5 * p.softness);
        if (p.softness > 0) parts.push(`<path d="M${fmt(item.tail[0])} ${fmt(item.tail[1])}L${fmt(item.x)} ${fmt(item.y)}" stroke="${colorValue}" stroke-width="${fmt(2 * r * (1 + p.softness))}" stroke-linecap="round" stroke-opacity="${fmtAlpha(alpha * 0.3 * p.softness)}" fill="none"/>`);
        parts.push(`<path d="M${fmt(item.tail[0])} ${fmt(item.tail[1])}L${fmt(midX)} ${fmt(midY)}" stroke="${colorValue}" stroke-width="${fmt(width * 0.6)}" stroke-linecap="round" stroke-opacity="${fmtAlpha(alpha * 0.4)}" fill="none"/>`);
        parts.push(`<path d="M${fmt(midX)} ${fmt(midY)}L${fmt(item.x)} ${fmt(item.y)}" stroke="${colorValue}" stroke-width="${fmt(width)}" stroke-linecap="round" stroke-opacity="${fmtAlpha(alpha)}" fill="none"/>`);
      } else {
        const fill = stops ? paint(look.profile === "bokeh" ? "bokeh" : "dot", item.tone, stops) : tones[item.tone];
        parts.push(`<circle cx="${fmt(item.x)}" cy="${fmt(item.y)}" r="${fmt(r)}" fill="${fill}" fill-opacity="${fmtAlpha(alpha)}"/>`);
      }
    }
  }
  const haze = look.shape === "dot" && Number.isFinite(p.haze) ? clamp(p.haze, 0, 1) : 0;
  if (haze > 0 && parts.length) {
    // The particles once, in defs, drawn twice: blurred and brightened (the haze), then sharp.
    // Blur 14 px is about the study's glow radii (18 on the middle plane, 10 on the near one).
    const group = String(frame.helpers.id("particles-field")), blur = String(frame.helpers.id("particles-haze"));
    const { x = 0, y = 0, width, height } = frame.bounds;
    frame.helpers.defs.push(`<g id="${group}">${parts.join("")}</g>`,
      `<filter id="${blur}" filterUnits="userSpaceOnUse" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="14"/><feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 ${fmt(8 * haze)} 0"/></filter>`);
    return clipEffect(frame, `${frame.content}<g aria-hidden="true" pointer-events="none"><use href="#${group}" filter="url(#${blur})"/><use href="#${group}"/></g>`);
  }
  const markup = `${frame.content}<g aria-hidden="true" pointer-events="none">${parts.join("")}</g>`;
  return clipEffect(frame, markup);
}

export const PARTICLE_FIELDS = Object.freeze(Object.fromEntries(Object.entries(PARTICLE_LOOKS)
  .map(([key, look]) => [key, lookParameters(look)])));

// Catalog definitions (engine/effects/catalog.js freezes them). Ranged: they run for the whole scene
// by default and their settings can move from `from` to `to` over the effect's duration.
export const PARTICLE_EFFECTS = Object.freeze(Object.entries(PARTICLE_LOOKS).map(([key, look]) => ({
  key, label: look.label, group: "Generate", kind: "ranged",
  render: (frame) => renderParticles(key, frame), parameters: PARTICLE_FIELDS[key],
})));
