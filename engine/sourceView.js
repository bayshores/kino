// Footage seen from its source: which part of a video file's frame a scene shows (the crop), and
// the subject boxes an agent marks on that frame. look {mode:"source"} draws both on the whole
// source frame (backend/agent/look.mjs); mark_subject (backend/agent/blocks.mjs) writes the boxes.
//
// Every box and crop is in % of the source frame: x and y from its top-left corner, so a box is
// the same at any size the file is drawn. A video layer keeps its boxes as
//   subjectBoxes: { src, boxes: [{ at, box: [x, y, w, h], by: "agent" }] }
// where `at` is seconds into the file (not the scene), so a box stays on its moment of the
// footage when the clip is moved or sped up. `src` is the file the boxes were marked on: after
// replace_media they belong to another file and are not used. A box may also carry `part`
// (1-30 characters, "eyes"): a deliberate part crop such as an eye strip.
import { evaluateLayer } from "./animation.js";
import { inverse, point, worldMatrix } from "./geometry.js";

export const MAX_SUBJECT_BOXES = 600;
// A box belongs to the source frame within this many seconds of its `at`.
export const SAME_MOMENT = 0.02;
// A box may reach this far past the frame's edge (rounding); it is pulled back to the edge.
const EDGE_SLACK = 0.05;

const round = (value, places) => Number(value.toFixed(places));

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

/**
 * A box as kino keeps it: [x, y, w, h] rounded to 0.1 %, or null when it is not a box inside the
 * frame (four numbers, x and y 0 or more, w and h above 0, x + w and y + h at most 100).
 */
export function subjectBox(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((number) => typeof number === "number" && Number.isFinite(number))) return null;
  let [x, y, w, h] = value.map((number) => round(number, 1));
  if (x < 0 || y < 0 || !(w > 0) || !(h > 0) || x + w > 100 + EDGE_SLACK || y + h > 100 + EDGE_SLACK) return null;
  w = Math.min(w, round(100 - x, 1));
  h = Math.min(h, round(100 - y, 1));
  return w > 0 && h > 0 ? [x, y, w, h] : null;
}

/** Checks a layer's subjectBoxes (model.js): the field as kept, or an error naming what is wrong. */
export function normalizeSubjectBoxes(value, path, layerType) {
  if (layerType !== "video") fail(path, "only a video layer has subject boxes");
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be {src, boxes: [{at, box, by}]}");
  if (typeof value.src !== "string" || !value.src || value.src.length > 2048) fail(`${path}.src`, "must be the file the boxes were marked on");
  if (!Array.isArray(value.boxes) || value.boxes.length > MAX_SUBJECT_BOXES) fail(`${path}.boxes`, `must be a list of at most ${MAX_SUBJECT_BOXES} boxes`);
  const boxes = value.boxes.map((entry, index) => {
    const label = `${path}.boxes[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(label, "must be {at, box, by}");
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at) || entry.at < 0) fail(`${label}.at`, "must be seconds into the file, 0 or more");
    const box = subjectBox(entry.box);
    if (!box) fail(`${label}.box`, "must be [x, y, w, h] in % of the source frame: x and y 0 or more, w and h above 0, x + w and y + h at most 100");
    if (entry.by !== "agent") fail(`${label}.by`, 'must be "agent"');
    const part = entry.part;
    if (part !== undefined && (typeof part !== "string" || part.length < 1 || part.length > 30)) fail(`${label}.part`, "must be 1-30 characters naming the part marked (eyes)");
    return { at: round(entry.at, 3), box, by: "agent", ...(part ? { part } : {}) };
  });
  return { src: value.src, boxes: boxes.sort((a, b) => a.at - b.at) };
}

export const MAX_ASK_SHOWS = 200;

/**
 * Checks a video layer's askShows: { src, marks: [{ at, what }] }, the frames the agent says show
 * what the person asked for (mark_subject {shows}). Evidence for ask_unmet only: it is kept apart
 * from subjectBoxes, which crop rules and frame_shot read, so naming a thing in the background
 * never moves the crop off the face.
 */
export function normalizeAskShows(value, path, layerType) {
  if (layerType !== "video") fail(path, "only a video layer has askShows");
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be {src, marks: [{at, what}]}");
  if (typeof value.src !== "string" || !value.src || value.src.length > 2048) fail(`${path}.src`, "must be the file the marks were made on");
  if (!Array.isArray(value.marks) || value.marks.length > MAX_ASK_SHOWS) fail(`${path}.marks`, `must be a list of at most ${MAX_ASK_SHOWS} marks`);
  const marks = value.marks.map((entry, index) => {
    const label = `${path}.marks[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(label, "must be {at, what}");
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at) || entry.at < 0) fail(`${label}.at`, "must be seconds into the file, 0 or more");
    if (typeof entry.what !== "string" || entry.what.length < 1 || entry.what.length > 30) fail(`${label}.what`, "must be 1-30 characters naming what of the ask the frame shows");
    return { at: round(entry.at, 3), what: entry.what };
  });
  return { src: value.src, marks: marks.sort((a, b) => a.at - b.at) };
}

/** The layer's boxes on its current file at `sourceTime` (file seconds), within SAME_MOMENT. */
export function boxesAt(layer, sourceTime) {
  const set = layer.subjectBoxes;
  if (!set || set.src !== layer.src) return [];
  return set.boxes.filter((entry) => Math.abs(entry.at - sourceTime) <= SAME_MOMENT + 1e-9);
}

/** The share (0–1) of `box` ([x, y, w, h]) inside `bounds` ([x0, y0, x1, y1]). */
export function insideShare(box, bounds) {
  const [x, y, w, h] = box;
  const width = Math.max(0, Math.min(x + w, bounds[2]) - Math.max(x, bounds[0]));
  const height = Math.max(0, Math.min(y + h, bounds[3]) - Math.max(y, bounds[1]));
  return w > 0 && h > 0 ? (width * height) / (w * h) : 0;
}

// The picture's rectangle inside the layer's box ("contain" when the file's size is known).
function pictureRect(at, source) {
  const scale = source?.width > 0 && source?.height > 0 ? Math.min(at.width / source.width, at.height / source.height) : null;
  return scale
    ? { width: source.width * scale, height: source.height * scale, x: (at.width - source.width * scale) / 2, y: (at.height - source.height * scale) / 2 }
    : { width: at.width, height: at.height, x: 0, y: 0 };
}

/**
 * Where a subject box ([x, y, w, h] in % of the source frame) is drawn on the scene at time `t`:
 * {x0, y0, x1, y1} in scene pixels (the box around its four corners), or null when the layer has
 * no size. overlay_covers_subject reads it.
 */
export function subjectOnScene(scene, layer, t, box, source = null) {
  const evaluate = (item) => evaluateLayer(item, t);
  const at = evaluate(layer);
  if (!(at.width > 0) || !(at.height > 0)) return null;
  const matrix = worldMatrix(layer, scene.layers ?? [], evaluate);
  const picture = pictureRect(at, source);
  const [x, y, w, h] = box;
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    .map(([px, py]) => point(matrix, picture.x + (px / 100) * picture.width, picture.y + (py / 100) * picture.height));
  const xs = corners.map((corner) => corner.x), ys = corners.map((corner) => corner.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Which part of the source frame the scene shows at scene time `t`: { quad, bounds, covers }.
 * quad is the scene's four corners (top-left, top-right, bottom-right, bottom-left) on the source
 * frame in % (they can lie outside 0–100 where the scene shows past the footage), bounds the
 * box around them clamped to the frame ([x0, y0, x1, y1]), and covers the share of the scene
 * the footage fills. A video is drawn inside its layer's box at its own shape (centred, as the
 * renderer's "contain" does), so `source` ({width, height} of the file) places the picture in the
 * box; without it the picture fills the box. Returns null when the layer has no size.
 */
export function cropOnSource(scene, layer, t, source = null) {
  const evaluate = (item) => evaluateLayer(item, t);
  const at = evaluate(layer);
  const matrix = worldMatrix(layer, scene.layers ?? [], evaluate);
  const back = inverse(matrix);
  if (!back || !(at.width > 0) || !(at.height > 0)) return null;
  const picture = pictureRect(at, source);
  const toSource = (x, y) => {
    const local = point(back, x, y);
    return [((local.x - picture.x) / picture.width) * 100, ((local.y - picture.y) / picture.height) * 100];
  };
  const quad = [[0, 0], [scene.width, 0], [scene.width, scene.height], [0, scene.height]].map(([x, y]) => toSource(x, y));
  const clamp = (value) => Math.min(100, Math.max(0, value));
  const xs = quad.map(([x]) => x), ys = quad.map(([, y]) => y);
  const bounds = [clamp(Math.min(...xs)), clamp(Math.min(...ys)), clamp(Math.max(...xs)), clamp(Math.max(...ys))];
  // The picture's corners on the scene, clipped to the scene: the share of the scene it fills.
  const corners = [[0, 0], [picture.width, 0], [picture.width, picture.height], [0, picture.height]]
    .map(([x, y]) => point(matrix, picture.x + x, picture.y + y));
  const covers = Math.min(1, polygonArea(clipToBox(corners, scene.width, scene.height)) / (scene.width * scene.height));
  return { quad: quad.map(([x, y]) => [round(x, 2), round(y, 2)]), bounds: bounds.map((value) => round(value, 2)), covers: round(covers, 3) };
}

// Sutherland–Hodgman: the part of a convex polygon ([{x, y}]) inside 0–width × 0–height.
function clipToBox(polygon, width, height) {
  const edges = [
    [(p) => p.x >= 0, (a, b) => a.x / (a.x - b.x)],
    [(p) => p.x <= width, (a, b) => (a.x - width) / (a.x - b.x)],
    [(p) => p.y >= 0, (a, b) => a.y / (a.y - b.y)],
    [(p) => p.y <= height, (a, b) => (a.y - height) / (a.y - b.y)],
  ];
  let points = polygon;
  for (const [inside, share] of edges) {
    const kept = [];
    points.forEach((current, index) => {
      const previous = points[(index + points.length - 1) % points.length];
      const along = (a, b) => { const s = share(a, b); return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s }; };
      if (inside(current)) {
        if (!inside(previous)) kept.push(along(previous, current));
        kept.push(current);
      } else if (inside(previous)) kept.push(along(previous, current));
    });
    points = kept;
    if (!points.length) return [];
  }
  return points;
}

function polygonArea(points) {
  let twice = 0;
  points.forEach((current, index) => {
    const next = points[(index + 1) % points.length];
    twice += current.x * next.y - next.x * current.y;
  });
  return Math.abs(twice) / 2;
}
