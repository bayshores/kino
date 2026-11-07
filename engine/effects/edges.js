// Edge fill, mirror and kaleidoscope: effects that repeat the layer's own picture.
// - edge-fill mirrors (or tiles) the picture past its edges, so a shake, spin or zoom-out never
//   shows an empty edge. Put it before a blur or a move that would uncover the edge.
// - mirror reflects one side of a line onto the other.
// - kaleidoscope repeats one wedge around a centre, every other wedge mirrored.
// Each piece is a copy of the layer (an SVG <use>), clipped where needed. Where two pieces meet,
// the piece drawn first reaches a pixel and a half past the joint (BLEED_PIXELS), so the next
// piece's soft edge lands on picture, not on the empty background, and no dark line shows along
// the joint. (Adding exactly touching pieces with plus-lighter was tried first: it leaves bright
// dots where shape corners touch a joint, because the browser's corner coverage does not add up.)
import { layerPixelScale } from "./motionBlurs.js";
import { clipEffect, copiesEffect, copySource } from "./svg.js";

export const MAX_EDGE_FILL_EXTEND = 3;
export const MAX_KALEIDOSCOPE_SEGMENTS = 32;
export const BLEED_PIXELS = 1.5; // scene pixels a lower piece reaches past each joint

const number = (label, value, min, max, step, unit = "", extra = {}) =>
  ({ type: "number", label, default: value, min, max, step, unit, ...extra });
const center = (axis) => number(`Center ${axis}`, 0.5, -1, 2, 0.01, "layer fraction");

export const EDGE_EFFECTS = [
  { key: "edge-fill", label: "Edge Fill", group: "Distortion", kind: "ranged", render: renderEdgeFill,
    parameters: {
      mode: { type: "enum", label: "Mode", default: "mirror", options: [["mirror", "Mirror"], ["tile", "Tile"]] },
      extend: number("Extend", 0.5, 0, MAX_EDGE_FILL_EXTEND, 0.05, "layer sizes"),
    } },
  { key: "mirror", label: "Mirror", group: "Distortion", kind: "ranged", render: renderMirror,
    parameters: {
      angle: number("Angle", 0, -360, 360, 1, "°"),
      centerX: center("X"), centerY: center("Y"),
    } },
  { key: "kaleidoscope", label: "Kaleidoscope", group: "Distortion", kind: "ranged", render: renderKaleidoscope,
    parameters: {
      segments: number("Segments", 6, 2, MAX_KALEIDOSCOPE_SEGMENTS, 1, "", { integer: true }),
      angle: number("Angle", 0, -3600, 3600, 1, "°"),
      centerX: center("X"), centerY: center("Y"),
    } },
];

const FIELDS = new Map(EDGE_EFFECTS.map((effect) => [effect.key, effect.parameters]));

function read(frame, effectKey, key) {
  const field = FIELDS.get(effectKey)[key];
  const value = frame.parameters?.[key] ?? field.default;
  if (field.type === "enum") {
    if (!field.options.some(([option]) => option === value))
      throw new RangeError(`${effectKey}.${key} must be ${field.options.map(([option]) => option).join(" or ")}.`);
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < field.min || value > field.max || (field.integer && !Number.isInteger(value)))
    throw new RangeError(`${effectKey}.${key} must be ${field.integer ? "an integer" : "a number"} from ${field.min} to ${field.max}.`);
  return value;
}

function fmt(value) {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

const matrix = (values) => `matrix(${values.map(fmt).join(" ")})`;
// The matrix that applies `second` first, then `first`.
const multiply = ([a, b, c, d, e, f], [g, h, i, j, k, l]) =>
  [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
const IDENTITY = [1, 0, 0, 1, 0, 0];

// A clipped copy of the layer placed by `placement`. The clipped group also holds a transparent
// point at the scene's centre (clipSentinel, as render.js does for its own clips): resvg stops
// the whole process when a clipped group lies entirely outside the picture, as a far edge-fill
// cell can. Resvg can still stop on an edge fill whose layer paints past its box when a spin
// blur turns those cells by about 15° or more; exports draw every effect with Chromium, so that
// markup is never given to resvg (backend/raster-policy.mjs).
function clippedCopy(frame, clipId, source, placement = IDENTITY) {
  return `<g clip-path="url(#${clipId})">${frame.helpers.clipSentinel?.(placement) ?? ""}${source}</g>`;
}

function paintOf(frame) {
  const box = frame.paintBounds ?? frame.bounds;
  return { ...box, width: Math.max(0.001, box.width), height: Math.max(0.001, box.height) };
}

function clipPathFor(frame, kind, d) {
  const id = frame.helpers.id(kind);
  frame.helpers.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${d}"/></clipPath>`);
  return id;
}

function rectPath({ x, y, width, height }) {
  return `M${fmt(x)} ${fmt(y)}H${fmt(x + width)}V${fmt(y + height)}H${fmt(x)}Z`;
}

// edge-fill: the layer box is one cell of a grid that reaches `extend` layer sizes past each
// edge. In mirror mode every other cell is flipped, so the picture continues smoothly across each
// edge; in tile mode every cell is the same picture. Paint that spills past the box (a stroke, an
// earlier effect) is cut at the cell edge. The other cells are drawn first, each grown about its
// own centre by the bleed; the layer's own cell goes last, at its exact place.
export function renderEdgeFill(frame) {
  const mode = read(frame, "edge-fill", "mode");
  const extend = read(frame, "edge-fill", "extend");
  if (extend === 0) return frame.content;
  const { x, y, width: w, height: h } = frame.bounds;
  if (!(w > 0) || !(h > 0)) return frame.content;
  const reach = Math.ceil(extend);
  const paint = paintOf(frame);
  const spills = paint.x < x - 1e-6 || paint.y < y - 1e-6 || paint.x + paint.width > x + w + 1e-6 || paint.y + paint.height > y + h + 1e-6;
  const source = copySource(frame);
  const cellClip = spills ? clipPathFor(frame, "edge-cell", rectPath(frame.bounds)) : null;
  const piece = (placement) => spills ? clippedCopy(frame, cellClip, source, placement) : source;
  const bleed = BLEED_PIXELS / layerPixelScale(frame);
  // Along one axis: the piece is grown about the layer's middle, then moved into cell i (which
  // starts at origin + i·size); odd cells are flipped in mirror mode.
  const axis = (i, origin, size) => {
    const grow = (size + 2 * bleed) / size, middle = origin + size / 2, grown = middle - grow * middle;
    return (mode === "mirror" && Math.abs(i) % 2 === 1)
      ? [-grow, -grown + 2 * origin + (i + 1) * size] : [grow, grown + i * size];
  };
  const pieces = [];
  for (let row = -reach; row <= reach; row += 1) {
    for (let column = -reach; column <= reach; column += 1) {
      if (row === 0 && column === 0) continue;
      const [sx, tx] = axis(column, x, w), [sy, ty] = axis(row, y, h);
      const placement = [sx, 0, 0, sy, tx, ty];
      pieces.push(`<g transform="${matrix(placement)}">${piece(placement)}</g>`);
    }
  }
  pieces.push(piece(IDENTITY));
  const extended = { x: x - extend * w, y: y - extend * h, width: w * (1 + 2 * extend), height: h * (1 + 2 * extend) };
  return copiesEffect(frame, clipEffect(frame, `<g>${pieces.join("")}</g>`, extended));
}

function lineReflection(cx, cy, degrees) {
  // Reflection across the line through (cx, cy) whose direction is `degrees`.
  const radians = 2 * degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  return [cos, sin, sin, -cos, cx - cos * cx - sin * cy, cy - sin * cx + cos * cy];
}

function rotation(cx, cy, degrees) {
  const radians = degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

function centerPoint(frame, effectKey) {
  const { x, y, width, height } = frame.bounds;
  return [x + width * read(frame, effectKey, "centerX"), y + height * read(frame, effectKey, "centerY")];
}

function reachFrom(box, cx, cy) {
  return Math.max(...[[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height]].map(([px, py]) => Math.hypot(px - cx, py - cy))) * 1.5 + 1;
}

// A wedge from the centre between two directions (degrees, from < to, at most 180 apart), drawn
// as a polygon out past `radius` so it covers everything in those directions. With `bleed` > 0
// both straight edges move outward by that distance (a half-plane simply moves by it).
function wedgePath(cx, cy, from, to, radius, bleed = 0) {
  const steps = Math.max(1, Math.ceil((to - from) / 30));
  const far = radius / Math.cos(Math.PI / 180 * (to - from) / steps / 2) + bleed;
  const rad = Math.PI / 180, start = from * rad, end = to * rad;
  // Outward normals of the start and end edges (the inside lies between the two directions).
  const [sx, sy] = [bleed * Math.sin(start), -bleed * Math.cos(start)];
  const [ex, ey] = [-bleed * Math.sin(end), bleed * Math.cos(end)];
  const points = [[cx, cy]];
  if (bleed > 0) points.push([cx + sx, cy + sy]);
  for (let step = 0; step <= steps; step += 1) {
    const angle = (from + (to - from) * step / steps) * rad;
    const [nx, ny] = step === 0 ? [sx, sy] : step === steps ? [ex, ey] : [0, 0];
    points.push([cx + nx + far * Math.cos(angle), cy + ny + far * Math.sin(angle)]);
  }
  if (bleed > 0) points.push([cx + ex, cy + ey]);
  return `M${points.map(([px, py]) => `${fmt(px)} ${fmt(py)}`).join("L")}Z`;
}

// mirror: keeps the side of the line on the left of its direction (angle 0 is a vertical line
// that keeps the left half, 90 a horizontal line that keeps the top half) and reflects it onto the
// other side. The reflection goes first and reaches the bleed past the line; the kept half goes on
// top with its exact edge. The result stays inside the layer's painted area.
export function renderMirror(frame) {
  const angle = read(frame, "mirror", "angle");
  const [cx, cy] = centerPoint(frame, "mirror");
  const paint = paintOf(frame), radius = reachFrom(paint, cx, cy);
  const bleed = BLEED_PIXELS / layerPixelScale(frame);
  // The line runs along angle + 90°; the kept half lies on the side angle + 180° points to.
  const keep = clipPathFor(frame, "mirror-half", wedgePath(cx, cy, angle + 90, angle + 270, radius));
  const wide = clipPathFor(frame, "mirror-half", wedgePath(cx, cy, angle + 90, angle + 270, radius, bleed));
  const source = copySource(frame);
  const reflection = lineReflection(cx, cy, angle + 90);
  const reflected = `<g transform="${matrix(reflection)}">${clippedCopy(frame, wide, source, reflection)}</g>`;
  return copiesEffect(frame, clipEffect(frame, `<g>${reflected}${clippedCopy(frame, keep, source)}</g>`, paint));
}

// kaleidoscope: the wedge of the picture from `angle` to angle + 180/segments degrees, and its
// mirror image beside it, repeated `segments` times around the centre. Each wedge reaches the
// bleed past both of its edges and covers the soft edge of the one before. The result stays inside
// the layer's painted area; put edge-fill first so wedges reaching past the picture are not empty.
export function renderKaleidoscope(frame) {
  const segments = read(frame, "kaleidoscope", "segments");
  const angle = read(frame, "kaleidoscope", "angle");
  const [cx, cy] = centerPoint(frame, "kaleidoscope");
  const paint = paintOf(frame), radius = reachFrom(paint, cx, cy);
  const bleed = BLEED_PIXELS / layerPixelScale(frame);
  const sector = 360 / segments, half = sector / 2;
  const wedge = clipPathFor(frame, "kaleidoscope-wedge", wedgePath(cx, cy, angle, angle + half, radius, bleed));
  const source = copySource(frame);
  const reflection = lineReflection(cx, cy, angle + half);
  const pieces = [];
  for (let index = 0; index < segments; index += 1) {
    const turn = rotation(cx, cy, index * sector), mirrored = multiply(turn, reflection);
    pieces.push(`<g transform="${matrix(turn)}">${clippedCopy(frame, wedge, source, turn)}</g>`,
      `<g transform="${matrix(mirrored)}">${clippedCopy(frame, wedge, source, mirrored)}</g>`);
  }
  return copiesEffect(frame, clipEffect(frame, `<g>${pieces.join("")}</g>`, paint));
}
