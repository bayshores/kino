// The general wipe a reveal draws when it has any wipe field (reveal.js): a straight edge at any
// angle (linear), an ellipse in the box's proportions (radial) or a circle (iris) growing from a
// center, or a sweep around that center (clock). Each shape is a field f over the layer's box,
// 0 where the wipe starts and 1 where it ends; a point shows while f is behind the edge. softness
// is the soft edge's width in f (percent), and an edge band of edgeColor rides just ahead of the
// picture, edgeWidth px wide (degrees for a clock), its front soft.
import { wipeSettings } from "./reveal.js";

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const fmt = (value) => String(Math.round(finite(value) * 10000) / 10000);
const CLOCK_STEPS = 24;

/** The shape's field over a width × height box: its kind, center and travel length in px. */
export function wipeField(width, height, reveal) {
  const s = wipeSettings(reveal);
  const w = Math.max(1e-6, width), h = Math.max(1e-6, height);
  const cx = s.centerX * w, cy = s.centerY * h;
  const corners = [[0, 0], [w, 0], [0, h], [w, h]];
  if (s.shape === "linear") {
    const radians = s.angle * Math.PI / 180;
    const u = [Math.cos(radians), Math.sin(radians)];
    const along = corners.map(([x, y]) => x * u[0] + y * u[1]);
    const m0 = Math.min(...along), m1 = Math.max(...along);
    return { ...s, w, h, u, m0, length: Math.max(1e-6, m1 - m0) };
  }
  if (s.shape === "radial") {
    const k = Math.max(1e-6, ...corners.map(([x, y]) => Math.hypot((x - cx) / w, (y - cy) / h)));
    return { ...s, w, h, cx, cy, k, length: k * Math.max(w, h) };
  }
  const reach = Math.max(1e-6, ...corners.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  return { ...s, w, h, cx, cy, reach, length: s.shape === "clock" ? 360 : reach };
}

/** f at one point of the box (tests and checks). */
export function wipeFieldAt(field, x, y) {
  if (field.shape === "linear") return (x * field.u[0] + y * field.u[1] - field.m0) / field.length;
  if (field.shape === "radial") return Math.hypot((x - field.cx) / field.w, (y - field.cy) / field.h) / field.k;
  if (field.shape === "iris") return Math.hypot(x - field.cx, y - field.cy) / field.reach;
  const turn = (Math.atan2(y - field.cy, x - field.cx) * 180 / Math.PI - field.angle) / 360;
  return turn - Math.floor(turn);
}

/** Where the picture's edge and the front sit in f at a reveal's progress. With a band, the picture
 *  meets it hard, the band is solid for its width and its front fades over the softness. */
export function wipeEdges(field, progress, softness) {
  const feather = softness / 100;
  const band = field.edgeWidth / field.length;
  const front = progress * (1 + feather + band);
  return { feather, band, front, picture: band > 0 ? front - band - feather : front };
}

const gray = (visible) => {
  const n = Math.round(255 * Math.max(0, Math.min(1, visible)));
  return `rgb(${n},${n},${n})`;
};

function polygonMarkup(points, fill) {
  if (points.length < 3) return "";
  return `<path d="M${points.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}z" fill="${fill}"/>`;
}

// The box cut to the side of a straight edge that shows: p·u <= m0 + edge × length.
function halfPlane(field, edge) {
  const limit = field.m0 + edge * field.length;
  const box = [[0, 0], [field.w, 0], [field.w, field.h], [0, field.h]];
  const side = ([x, y]) => x * field.u[0] + y * field.u[1] - limit;
  const out = [];
  for (let i = 0; i < box.length; i++) {
    const a = box[i], b = box[(i + 1) % box.length], sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function wedge(field, from, to, fill) {
  const a = Math.max(0, from), b = Math.min(1, to);
  if (b <= a) return "";
  const radius = field.reach * 1.5 + 2;
  if (b - a >= 1) return `<circle cx="${fmt(field.cx)}" cy="${fmt(field.cy)}" r="${fmt(radius)}" fill="${fill}"/>`;
  const point = (share) => {
    const radians = (field.angle + share * 360) * Math.PI / 180;
    return [field.cx + Math.cos(radians) * radius, field.cy + Math.sin(radians) * radius];
  };
  const [x0, y0] = point(a), [x1, y1] = point(b);
  return `<path d="M${fmt(field.cx)} ${fmt(field.cy)}L${fmt(x0)} ${fmt(y0)}A${fmt(radius)} ${fmt(radius)} 0 ${b - a > 0.5 ? 1 : 0} 1 ${fmt(x1)} ${fmt(y1)}z" fill="${fill}"/>`;
}

// Mask content that shows f < edge, fading over feather; with invert, it shows the rest.
function fieldMarkup(field, edge, feather, invert, defs, id) {
  const fill = (visible) => gray(invert ? 1 - visible : visible);
  const box = (paint) => `<rect x="0" y="0" width="${fmt(field.w)}" height="${fmt(field.h)}" fill="${paint}"/>`;
  let out = invert ? box(fill(0)) : "";
  if (edge <= 0) return out;
  if (field.shape === "clock") {
    if (feather <= 0) return out + wedge(field, 0, edge, fill(1));
    // Nested wedges from the start, widest (dimmest) first: each step's edge lies over the next
    // step's paint, so no background shows through a seam between side-by-side wedges.
    for (let i = CLOCK_STEPS - 1; i >= 0; i--)
      out += wedge(field, 0, edge - feather + feather * (i + 1) / CLOCK_STEPS, fill(1 - (i + 0.5) / CLOCK_STEPS));
    return out + wedge(field, 0, edge - feather, fill(1));
  }
  if (feather <= 0) {
    if (field.shape === "linear") return out + polygonMarkup(halfPlane(field, edge), fill(1));
    const rx = field.shape === "radial" ? edge * field.k * field.w : edge * field.reach;
    const ry = field.shape === "radial" ? edge * field.k * field.h : edge * field.reach;
    return `${out}<ellipse cx="${fmt(field.cx)}" cy="${fmt(field.cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}" fill="${fill(1)}"/>`;
  }
  const gradient = id();
  const stops = (low) => `<stop offset="${fmt(low)}" stop-color="${fill(1)}"/><stop offset="1" stop-color="${fill(0)}"/>`;
  if (field.shape === "linear") {
    const at = (share) => (field.m0 + share * field.length);
    const [ux, uy] = field.u;
    defs.push(`<linearGradient id="${gradient}" gradientUnits="userSpaceOnUse" spreadMethod="pad" x1="${fmt(ux * at(edge - feather))}" y1="${fmt(uy * at(edge - feather))}" x2="${fmt(ux * at(edge))}" y2="${fmt(uy * at(edge))}">${stops(0)}</linearGradient>`);
  } else {
    const sx = field.shape === "radial" ? edge * field.k * field.w : edge * field.reach;
    const sy = field.shape === "radial" ? edge * field.k * field.h : edge * field.reach;
    defs.push(`<radialGradient id="${gradient}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" spreadMethod="pad" gradientTransform="translate(${fmt(field.cx)} ${fmt(field.cy)}) scale(${fmt(sx)} ${fmt(sy)})">${stops(Math.max(0, (edge - feather) / edge))}</radialGradient>`);
  }
  return out + box(`url(#${gradient})`);
}

// origin moves the box (a repeated layer's wipe covers every copy: render.js revealAttributes).
const shift = (origin, content) => origin.x || origin.y ? `<g transform="translate(${fmt(origin.x)} ${fmt(origin.y)})">${content}</g>` : content;
const maskTag = (id, field, content, origin) =>
  `<mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="${fmt(origin.x)}" y="${fmt(origin.y)}" width="${fmt(field.w)}" height="${fmt(field.h)}" style="mask-type:luminance">${shift(origin, content)}</mask>`;

/** The mask attribute and, with an edge band, a function that adds the band over the content.
 *  progress is strictly between 0 and 1 here. */
export function generalReveal(width, height, reveal, defs, id, origin = { x: 0, y: 0 }) {
  const field = wipeField(width, height, reveal);
  const { feather, band, front, picture } = wipeEdges(field, reveal.progress, reveal.softness);
  const maskId = id("wipe-mask");
  defs.push(maskTag(maskId, field, fieldMarkup(field, front, feather, false, defs, () => id("wipe-gradient")), origin));
  const attribute = ` mask="url(#${maskId})"`;
  if (band <= 0) return { attribute, band: null };
  // The band is the layer's own drawing (its alpha) in edgeColor, from the picture's edge to the front.
  const bandMask = id("wipe-band");
  defs.push(maskTag(bandMask, field, fieldMarkup(field, picture, 0, true, defs, () => id("wipe-gradient")), origin));
  return { attribute, band(content) {
    const contentId = id("wipe-content"), alpha = id("wipe-alpha");
    defs.push(`<mask id="${alpha}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000" mask-type="alpha"><use href="#${contentId}"/></mask>`);
    return `<g id="${contentId}">${content}</g><g mask="url(#${alpha})"><g mask="url(#${bandMask})"><rect x="${fmt(origin.x)}" y="${fmt(origin.y)}" width="${fmt(field.w)}" height="${fmt(field.h)}" fill="${reveal.edgeColor ?? "#FFFFFF"}"/></g></g>`;
  } };
}
