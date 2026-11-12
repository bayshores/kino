// Paint splatter and ink splash shapes, made as ordinary path data, so a splat is a plain path
// layer afterward: fill, strokes, roughen, draw-on, a scale pop and blend modes all work on it,
// and every field stays editable.
//
//   splatterPath({style, seed, count, spread, angle, streaks, drips, width, height}) -> SVG path data
//   style    "splat" (round blot, arms all around), "splash" (thrown along angle: stretched
//            body, drops and streaks in a cone), "drip" (blot with runs downward) or "spray"
//            (a small blot in a mist of fine dots)                                  ("splat")
//   seed     0..9999: which splat; the same seed draws the same shape                    (0)
//   count    satellite drops, 0..80 (spray draws 6 times as many fine dots)             (12)
//   spread   0..1: how far the drops reach from the body toward the box edge           (0.6)
//   angle    degrees, the direction a splash is thrown and its streaks run (0 = right)   (0)
//   streaks  thin tapered streaks out of the body, 0..12     (splat 2, splash 6, drip and spray 0)
//   drips    runs down from the body, 0..12                           (drip 4, the others 0)
//   width, height: the layer's box; the shape fills it (drops reach the edge at spread 1).
//
// Where the shape comes from: GAPS item 11 (contest-a f858-878, fan-fast f150). On contest-a
// p875 the splats are a round body with a wavy rim and a few short pointed arms, and drops
// around it that get smaller with distance; the largest body is about 130 px across with drops
// out to about 150 px from its middle, so the body radius is 0.42 of the reach (measured on the
// frame). fan-fast f150 shows dark splashes thrown one way, long and thin. Everything else (arm
// count, drop sizes, streak taper) is a guess tuned by eye on those frames.
import { serializePath } from "./vectorPath.js";

export const SPLATTER_STYLES = ["splat", "splash", "drip", "spray"];
export const SPLATTER_DEFAULTS = Object.freeze({ style: "splat", seed: 0, count: 12, spread: 0.6, angle: 0 });
const STYLE_EXTRAS = { splat: { streaks: 2, drips: 0 }, splash: { streaks: 6, drips: 0 }, drip: { streaks: 0, drips: 4 }, spray: { streaks: 0, drips: 0 } };
const KEYS = ["style", "seed", "count", "spread", "angle", "streaks", "drips"];
const RANGES = { seed: [0, 9999], count: [0, 80], spread: [0, 1], angle: [-360, 360], streaks: [0, 12], drips: [0, 12] };
// A splat with no size given: a square box (a guess; the path layer's own 320 x 180 box would
// squash it).
export const SPLATTER_SIZE = 360;
const BODY = 0.42;
const TAU = Math.PI * 2;

// mulberry32: a small seeded random source, the same numbers for the same seed.
function random(seed) {
  let a = (seed * 2654435761 + 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A closed outline through `points`, as Catmull-Rom curves, turning the same way as every other
// part so overlapping parts fill as one shape.
function smooth(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  const list = area < 0 ? [...points].reverse() : points;
  const n = list.length, at = (i) => list[(i + n) % n];
  const segments = list.map((_, i) => {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    return { c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], end: [...p2] };
  });
  return { start: [...list[0]], segments, closed: true };
}

// A wavy round edge: a few sine waves with seeded phases, -1..1.
function wobble(rand, waves) {
  const parts = waves.map(([k, amount]) => ({ k, amount, phase: rand() * TAU }));
  const total = parts.reduce((sum, part) => sum + part.amount, 0) || 1;
  return (theta) => parts.reduce((sum, { k, amount, phase }) => sum + amount * Math.sin(k * theta + phase), 0) / total;
}

function drop(rand, center, radius, direction, stretch) {
  const edge = wobble(rand, [[2, 1], [3, 0.6], [5, 0.3]]);
  const along = [Math.cos(direction), Math.sin(direction)], across = [-along[1], along[0]];
  const points = [];
  for (let i = 0; i < 18; i += 1) {
    const theta = (i / 18) * TAU, r = radius * (1 + 0.12 * edge(theta));
    const a = Math.cos(theta) * r * stretch, b = Math.sin(theta) * r;
    points.push([center[0] + along[0] * a + across[0] * b, center[1] + along[1] * a + across[1] * b]);
  }
  return smooth(points);
}

// A thin streak from `from` along `direction`, tapering to a point.
function streak(from, direction, length, width) {
  const along = [Math.cos(direction), Math.sin(direction)], across = [-along[1], along[0]];
  const left = [], right = [];
  for (let i = 0; i <= 6; i += 1) {
    const t = i / 6, half = width * Math.pow(1 - t, 1.3) + width * 0.06;
    const c = [from[0] + along[0] * length * t, from[1] + along[1] * length * t];
    left.push([c[0] + across[0] * half, c[1] + across[1] * half]);
    right.push([c[0] - across[0] * half, c[1] - across[1] * half]);
  }
  return smooth([...left, ...right.reverse()]);
}

function bodyOutline(rand, style, radius, angle, arms, stretch) {
  const edge = wobble(rand, [[2, 0.5], [3, 1], [4, 0.6], [6, 0.5], [9, 0.3], [13, 0.2]]);
  const along = [Math.cos(angle), Math.sin(angle)], across = [-along[1], along[0]];
  const points = [];
  for (let i = 0; i < 240; i += 1) {
    const theta = (i / 240) * TAU;
    let r = radius * (1 + 0.1 * edge(theta));
    for (const arm of arms) {
      const gap = Math.abs(((theta - arm.angle + Math.PI * 3) % TAU) - Math.PI);
      // A round splat's arms end in round tips (contest-a p875: bulges, no needles); a thrown
      // splash's arms taper to points (fan-fast f150: jagged shards).
      if (gap < arm.width) r += arm.length * (style === "splash" ? Math.pow(1 - gap / arm.width, 2.2) : Math.pow(0.5 + 0.5 * Math.cos((Math.PI * gap) / arm.width), 1.6));
    }
    const a = Math.cos(theta - angle) * r * stretch, b = Math.sin(theta - angle) * r / Math.sqrt(stretch);
    points.push([along[0] * a + across[0] * b, along[1] * a + across[1] * b]);
  }
  return smooth(points);
}

/** The fields a `splatter` shorthand takes, checked: a plain Error names the bad one. */
export function splatterOptions(given = {}) {
  if (given === true) return { ...SPLATTER_DEFAULTS };
  if (typeof given === "string") given = { style: given };
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new Error(`splatter is true, a style (${SPLATTER_STYLES.join(", ")}) or {${KEYS.join(", ")}}.`);
  const extra = Object.keys(given).filter((key) => !KEYS.includes(key));
  if (extra.length) throw new Error(`splatter has no ${extra.join(", ")}; it takes ${KEYS.join(", ")} (color is the layer's fill).`);
  const style = given.style ?? SPLATTER_DEFAULTS.style;
  if (!SPLATTER_STYLES.includes(style)) throw new Error(`splatter style is ${SPLATTER_STYLES.map((name) => `"${name}"`).join(", ")}.`);
  const options = { ...SPLATTER_DEFAULTS, ...STYLE_EXTRAS[style], style };
  for (const key of Object.keys(RANGES)) {
    if (given[key] === undefined) continue;
    const [min, max] = RANGES[key];
    if (!(typeof given[key] === "number" && Number.isFinite(given[key]) && given[key] >= min && given[key] <= max)) throw new Error(`splatter ${key} is a number from ${min} to ${max}.`);
    options[key] = given[key];
  }
  return options;
}

/** SVG path data for a splatter that fills a width x height box (see the top of this file). */
export function splatterPath(given = {}, width = SPLATTER_SIZE, height = SPLATTER_SIZE) {
  const { style, seed, count, spread, angle: degrees, streaks, drips } = splatterOptions(given);
  const rand = random(Math.round(seed) + 1);
  const angle = (degrees * Math.PI) / 180;
  const thrown = style === "splash";
  // A splash's body is thin and long: fan-fast f150's ink marks are about 4 to 6 times as long as
  // they are wide (measured on the frame); stretch 2.4 with the narrower radius gives about 4.
  const radius = style === "spray" ? BODY * 0.35 : style === "drip" ? BODY * 0.9 : thrown ? BODY * 0.55 : BODY;
  const reach = radius + spread * (1 - radius) * 0.95;
  // Thrown splats aim near the angle; a round splat aims anywhere.
  const aim = () => thrown ? angle + (rand() + rand() + rand() - 1.5) * 0.7 : rand() * TAU;
  const arms = style === "spray" ? [] : Array.from({ length: thrown ? 7 : 5 + Math.floor(rand() * 4) }, () =>
    ({ angle: aim(), length: radius * (thrown ? 0.3 + 0.8 * rand() : 0.12 + 0.45 * Math.pow(rand(), 1.5)), width: thrown ? 0.12 + 0.18 * rand() : 0.24 + 0.26 * rand() }));
  const stretch = thrown ? 2.4 : 1;
  const contours = [bodyOutline(rand, style, radius, angle, arms, stretch)];
  const tipOf = (theta, distance) => {
    const a = Math.cos(theta - angle) * distance * stretch, b = Math.sin(theta - angle) * distance / Math.sqrt(stretch);
    return [Math.cos(angle) * a - Math.sin(angle) * b, Math.sin(angle) * a + Math.cos(angle) * b];
  };
  // A round drop just past the end of every other longer arm.
  arms.filter((arm) => arm.length > radius * 0.3 && rand() < 0.6)
    .forEach((arm) => contours.push(drop(rand, tipOf(arm.angle, radius + arm.length * 0.95 + radius * 0.06), radius * (0.06 + 0.05 * rand()), arm.angle, 1.2)));
  // Satellite drops: smaller the farther out (t 0 at the body's edge, 1 at the reach).
  const dots = style === "spray" ? count * 6 : count;
  for (let i = 0; i < dots; i += 1) {
    const theta = aim(), t = style === "spray" ? Math.pow(rand(), 0.7) : Math.pow(rand(), 0.85);
    // A thrown splash's drops land past its stretched body, farther the wider the spread.
    const near = thrown ? radius * stretch * 1.05 : radius * 1.15, far = thrown ? radius * stretch + spread * 1.1 : reach;
    const distance = near + (far - near) * t;
    const size = style === "spray" ? 0.006 + 0.022 * (1 - t) * rand() : (0.075 - 0.05 * t) * (0.45 + 0.55 * rand());
    contours.push(drop(rand, [Math.cos(theta) * distance, Math.sin(theta) * distance], size, theta, 1 + (thrown ? 1.2 : 0.4) * t));
  }
  for (let i = 0; i < streaks; i += 1) {
    const theta = thrown ? angle + (rand() - 0.5) * 0.5 : aim();
    const from = tipOf(theta, radius * 0.7);
    const length = (reach - radius * 0.4) * (0.5 + 0.5 * rand()) * (thrown ? 1.25 : 1);
    contours.push(streak(from, theta, length, radius * (0.05 + 0.05 * rand())));
  }
  for (let i = 0; i < drips; i += 1) {
    const x = (rand() * 2 - 1) * radius * 0.7, top = Math.sqrt(Math.max(0, radius * radius - x * x)) * 0.8;
    const run = (1 - top) * (0.35 + 0.6 * rand()), half = radius * (0.05 + 0.05 * rand());
    const points = [[x - half, top - radius * 0.2], [x - half * 0.9, top + run * 0.6], [x - half * 1.3, top + run]];
    for (let k = 1; k < 8; k += 1) { const a = Math.PI - (k / 8) * Math.PI; points.push([x + Math.cos(a) * half * 1.3, top + run + Math.sin(a) * half * 1.3]); }
    points.push([x + half * 1.3, top + run], [x + half * 0.9, top + run * 0.6], [x + half, top - radius * 0.2]);
    contours.push(smooth(points));
  }
  // A thrown splash reaches past the unit box ahead of its body: the whole splat is moved and
  // shrunk (never stretched) to fit the box, so it never draws outside the layer.
  const all = contours.flatMap(({ start, segments }) => [start, ...segments.flatMap(({ c1, c2, end }) => [c1, c2, end])]);
  const low = [Math.min(...all.map(([x]) => x)), Math.min(...all.map(([, y]) => y))], high = [Math.max(...all.map(([x]) => x)), Math.max(...all.map(([, y]) => y))];
  const fit = Math.min(1, 1.96 / Math.max(high[0] - low[0], high[1] - low[1]));
  const shift = [(high[0] + low[0]) / 2, (high[1] + low[1]) / 2].map((middle, i) => (high[i] - low[i]) * fit > 1.96 || Math.abs(middle) * fit + (high[i] - low[i]) * fit / 2 > 0.98 ? middle : 0);
  // From the unit box (-1..1 each way) to the layer's box.
  const box = ([x, y]) => [Math.round((width / 2 + (x - shift[0]) * fit * width / 2) * 100) / 100, Math.round((height / 2 + (y - shift[1]) * fit * height / 2) * 100) / 100];
  return serializePath(contours.map(({ start, segments }) => ({ start: box(start), closed: true,
    segments: segments.map(({ c1, c2, end }) => ({ c1: box(c1), c2: box(c2), end: box(end) })) })));
}

/**
 * Layer properties with a `splatter` shorthand (true, a style name or {style, seed, count, spread,
 * angle, streaks, drips}) replaced by the path it draws. The box is the properties' width and
 * height, else `size` (the layer's own on an update), else SPLATTER_SIZE square. A new splat
 * with no paint given is ink black (a guess: ink is the commonest splat). Throws a plain Error.
 */
export function withSplatter(properties, size = null, { isNew = false } = {}) {
  const { splatter, ...rest } = properties;
  if (splatter === undefined || splatter === null || splatter === false) return rest;
  const width = typeof rest.width === "number" && rest.width > 0 ? rest.width : size?.width ?? SPLATTER_SIZE;
  const height = typeof rest.height === "number" && rest.height > 0 ? rest.height : size?.height ?? (size ? SPLATTER_SIZE : width);
  const painted = ["fill", "color", "colour", "fillColor"].some((key) => rest[key] !== undefined);
  return { ...(isNew ? { width, height } : {}), ...(isNew && !painted ? { fill: "#111111" } : {}), ...rest, path: splatterPath(splatter, width, height) };
}
