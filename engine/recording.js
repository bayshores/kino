// Screen recordings as data: the compact copy of a kino recording's event log that a video layer
// keeps (layer.recording), and the edit decisions made from it: zoom ranges that follow the
// clicks, a spring-smoothed cursor that lands on every click, typing runs and when the cursor
// hides. Plain data in, plain data out. Times are seconds of the recording's video, positions are
// points from the captured region's top-left (y down). The folder format is kino-recorder's.
import { round } from "./numbers.js";

export const RECORDING_VERSION = 1;
export const MAX_MOVES = 6000;
export const MAX_ITEMS = 2000;
export const MAX_CURSOR_SAMPLES = 3600;
// A thinned path stays this close (points) to every sample it drops.
const THIN_TOLERANCE = 0.75;
const BUTTONS = new Set(["left", "right", "other"]);
const SOURCES = new Set(["agent", "person", "unknown"]);
// The pointer moving this far between a press and its release makes the press a drag.
const DRAG_DISTANCE = 4;

const time = (value) => round(value, 2);
const point = (value) => round(value, 1);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

// ---- compacting -----------------------------------------------------------------------------

// The kind of a typed character (kino keeps kinds, not text).
function keyKind(key) {
  if (typeof key !== "string" || !key) return "other";
  if (key.length !== 1) return key;
  if (/\p{L}/u.test(key)) return "letter";
  if (/\p{N}/u.test(key)) return "digit";
  if (key === " ") return "space";
  if (/\p{P}|\p{S}/u.test(key)) return "punctuation";
  return "other";
}

// Distance from p to the straight line between a and b at p's time.
function offLine(a, b, p) {
  const span = b[0] - a[0];
  const share = span > 0 ? (p[0] - a[0]) / span : 0;
  return Math.hypot(a[1] + (b[1] - a[1]) * share - p[1], a[2] + (b[2] - a[2]) * share - p[2]);
}

/**
 * Drops samples ([t, x, y, ...]) the straight line between their kept neighbors already passes
 * within `tolerance` points of. Samples whose 4th value (the cursor shape) differs are kept.
 */
export function thinPath(samples, tolerance = THIN_TOLERANCE) {
  if (samples.length < 3) return samples.slice();
  const kept = [samples[0]];
  let anchor = 0;
  let end = 2;
  while (end < samples.length) {
    let fits = samples[end][3] === samples[anchor][3];
    for (let index = anchor + 1; fits && index < end; index += 1)
      fits = samples[index][3] === samples[anchor][3] && offLine(samples[anchor], samples[end], samples[index]) <= tolerance;
    // Long straight runs are checked in pieces, so thinning stays fast.
    if (fits && end - anchor < 240) { end += 1; continue; }
    anchor = end - 1;
    kept.push(samples[anchor]);
    end = anchor + 2;
  }
  kept.push(samples[samples.length - 1]);
  return kept;
}

// At most `most` items, evenly picked (the first and last kept).
function evenly(items, most) {
  if (items.length <= most) return items;
  const picked = [];
  for (let index = 0; index < most; index += 1) picked.push(items[Math.round((index * (items.length - 1)) / (most - 1))]);
  return picked;
}

/**
 * The compact copy of a recording a video layer keeps: `meta` is recording.json, `events` the
 * parsed lines of events.jsonl. Typed characters are never kept, only their kinds.
 */
export function compactRecording(meta, events) {
  const frame = [point(meta.frame?.width ?? 0), point(meta.frame?.height ?? 0)];
  const duration = round(Math.max(0, meta.duration ?? 0), 3);
  const late = duration + 0.5;
  const sorted = (events ?? [])
    .filter((event) => event && finite(event.t) && event.t >= 0 && event.t <= late)
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.t - b.event.t || a.index - b.index)
    .map(({ event }) => event);
  const shapes = [];
  const shapeIndex = (cursor) => {
    const name = meta.cursors?.[cursor]?.shape ?? "arrow";
    let index = shapes.indexOf(name);
    if (index < 0) { index = shapes.length; shapes.push(name); }
    return index;
  };
  const raw = [];
  const clicks = [], drags = [], keys = [], marks = [], carets = [], scrolls = [];
  const pressed = new Map();
  let shape = null;
  let last = null;
  for (const event of sorted) {
    const at = event.t;
    if (event.type === "move" && finite(event.x) && finite(event.y)) {
      if (event.cursor !== undefined) shape = shapeIndex(event.cursor);
      shape ??= shapeIndex(undefined);
      // The recorder writes a move only when something changed: a long gap means the pointer
      // stood still until just before this move, so the path holds there instead of drifting.
      if (last && at - last[0] > 0.05) raw.push([at - 1 / 60, last[1], last[2], last[3]]);
      last = [at, event.x, event.y, shape];
      raw.push(last);
    } else if (event.type === "down" && finite(event.x) && finite(event.y)) {
      const button = BUTTONS.has(event.button) ? event.button : "left";
      clicks.push([time(at), point(event.x), point(event.y), button, SOURCES.has(event.source) ? event.source : "unknown"]);
      pressed.set(button, { at, x: event.x, y: event.y, far: 0 });
    } else if (event.type === "up") {
      const button = BUTTONS.has(event.button) ? event.button : "left";
      const press = pressed.get(button);
      pressed.delete(button);
      if (press && (press.far > DRAG_DISTANCE || Math.hypot((event.x ?? press.x) - press.x, (event.y ?? press.y) - press.y) > DRAG_DISTANCE))
        drags.push([time(press.at), time(at)]);
    } else if (event.type === "key") {
      const shortcut = event.shortcut === true;
      const kind = shortcut ? [...(Array.isArray(event.mods) ? event.mods : []), String(event.key ?? "other")].join("+") : keyKind(event.key);
      keys.push([time(at), kind.slice(0, 32), shortcut ? 1 : 0]);
    } else if (event.type === "mark" && typeof event.label === "string") {
      marks.push([time(at), event.label.slice(0, 120)]);
    } else if (event.type === "caret" && [event.x, event.y, event.width, event.height].every(finite)) {
      carets.push([time(at), point(event.x), point(event.y), point(event.width), point(event.height)]);
    } else if (event.type === "scroll" && finite(event.x) && finite(event.y)) {
      scrolls.push([time(at), point(event.x), point(event.y)]);
    }
    if (event.type === "move" && pressed.size)
      for (const press of pressed.values()) press.far = Math.max(press.far, Math.hypot(event.x - press.x, event.y - press.y));
  }
  let tolerance = THIN_TOLERANCE;
  let moves = thinPath(raw, tolerance);
  while (moves.length > MAX_MOVES && tolerance < 64) { tolerance *= 2; moves = thinPath(raw, tolerance); }
  moves = evenly(moves, MAX_MOVES).map(([t, x, y, index]) => [time(t), point(x), point(y), index]);
  // Rounding can put two samples on one time; the later wins.
  moves = moves.filter((sample, index) => index === moves.length - 1 || moves[index + 1][0] > sample[0]);
  return {
    version: RECORDING_VERSION, frame, scale: meta.scale > 0 ? meta.scale : 1, duration,
    moves, shapes: shapes.length ? shapes : ["arrow"],
    clicks: evenly(clicks, MAX_ITEMS), drags: evenly(drags, MAX_ITEMS), keys: evenly(keys, MAX_ITEMS),
    marks: evenly(marks, MAX_ITEMS), carets: evenly(carets, MAX_ITEMS), scrolls: evenly(scrolls, MAX_ITEMS),
  };
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function tuples(value, path, most, check) {
  if (!Array.isArray(value) || value.length > most) fail(path, `must be a list of at most ${most} entries`);
  value.forEach((entry, index) => {
    if (!Array.isArray(entry) || !check(entry)) fail(`${path}[${index}]`, "has the wrong shape");
  });
  return value.map((entry) => entry.slice());
}

const numbers = (count) => (entry) => entry.length === count && entry.every(finite);

/** Checks a video layer's recording (model.js) and returns a clean copy. */
export function normalizeRecording(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be a compact recording");
  if (value.version !== RECORDING_VERSION) fail(`${path}.version`, `must be ${RECORDING_VERSION}`);
  if (!Array.isArray(value.frame) || value.frame.length !== 2 || !value.frame.every((side) => finite(side) && side > 0)) fail(`${path}.frame`, "must be [width, height] in points");
  if (!finite(value.scale) || value.scale <= 0 || value.scale > 8) fail(`${path}.scale`, "must be pixels per point (0 to 8)");
  if (!finite(value.duration) || value.duration < 0) fail(`${path}.duration`, "must be seconds");
  if (!Array.isArray(value.shapes) || !value.shapes.length || value.shapes.length > 64 || !value.shapes.every((name) => typeof name === "string" && name.length <= 32))
    fail(`${path}.shapes`, "must be a list of cursor shape names");
  const shapes = value.shapes.length;
  return {
    version: RECORDING_VERSION, frame: value.frame.slice(), scale: value.scale, duration: value.duration,
    moves: tuples(value.moves, `${path}.moves`, MAX_MOVES, (entry) => entry.length === 4 && entry.every(finite) && Number.isInteger(entry[3]) && entry[3] >= 0 && entry[3] < shapes),
    shapes: value.shapes.slice(),
    clicks: tuples(value.clicks, `${path}.clicks`, MAX_ITEMS, (entry) => entry.length === 5 && entry.slice(0, 3).every(finite) && BUTTONS.has(entry[3]) && SOURCES.has(entry[4])),
    drags: tuples(value.drags, `${path}.drags`, MAX_ITEMS, numbers(2)),
    keys: tuples(value.keys, `${path}.keys`, MAX_ITEMS, (entry) => entry.length === 3 && finite(entry[0]) && typeof entry[1] === "string" && entry[1].length <= 32 && (entry[2] === 0 || entry[2] === 1)),
    marks: tuples(value.marks, `${path}.marks`, MAX_ITEMS, (entry) => entry.length === 2 && finite(entry[0]) && typeof entry[1] === "string" && entry[1].length <= 120),
    carets: tuples(value.carets, `${path}.carets`, MAX_ITEMS, numbers(5)),
    scrolls: tuples(value.scrolls, `${path}.scrolls`, MAX_ITEMS, numbers(3)),
  };
}

// ---- reading the path -----------------------------------------------------------------------

/** The recorded pointer position [x, y] at `t` (straight between samples, held past the ends). */
export function positionAt(rec, t) {
  const path = rec.moves;
  if (!path?.length) return [rec.frame[0] / 2, rec.frame[1] / 2];
  if (t <= path[0][0]) return [path[0][1], path[0][2]];
  const last = path[path.length - 1];
  if (t >= last[0]) return [last[1], last[2]];
  let low = 0, high = path.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (path[middle][0] <= t) low = middle; else high = middle;
  }
  const a = path[low], b = path[high];
  const share = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
  return [a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share];
}

// ---- auto zoom ------------------------------------------------------------------------------

// The points the camera follows inside [start, end]: the pointer (kept when 10 points from the
// last kept one) and every click; from the first caret on, the caret's center instead.
function focusPoints(rec, start, end) {
  const inside = (t) => t >= start && t <= end;
  const caretFrom = rec.carets.find((caret) => inside(caret[0]))?.[0] ?? Infinity;
  const points = [];
  let kept = null;
  // At a click, its own place (the pointer sample may come a frame later).
  const at = rec.clicks.find(([t]) => t === start);
  const before = at ? [at[1], at[2]] : positionAt(rec, start);
  points.push({ t: start, x: before[0], y: before[1] });
  kept = before;
  for (const [t, x, y] of rec.moves) {
    if (!inside(t) || t >= caretFrom) continue;
    if (Math.hypot(x - kept[0], y - kept[1]) < 10) continue;
    kept = [x, y];
    points.push({ t, x, y });
  }
  for (const [t, x, y] of rec.clicks) if (inside(t) && t < caretFrom) points.push({ t, x, y });
  for (const [t, x, y, width, height] of rec.carets) if (inside(t)) points.push({ t, x: x + width / 2, y: y + height / 2 });
  return points.sort((a, b) => a.t - b.t);
}

// Greedy groups whose box fits `limit` (half the zoomed view); each gets its dwell-weighted center.
function groupCenters(points, limit, end) {
  const groups = [];
  let group = null;
  for (const entry of points) {
    if (group) {
      const box = { left: Math.min(group.left, entry.x), right: Math.max(group.right, entry.x), top: Math.min(group.top, entry.y), bottom: Math.max(group.bottom, entry.y) };
      if (box.right - box.left <= limit[0] && box.bottom - box.top <= limit[1]) { Object.assign(group, box); group.points.push(entry); continue; }
    }
    group = { left: entry.x, right: entry.x, top: entry.y, bottom: entry.y, points: [entry] };
    groups.push(group);
  }
  return groups.map((found, index) => {
    const until = index + 1 < groups.length ? groups[index + 1].points[0].t : end;
    let weight = 0, x = 0, y = 0;
    found.points.forEach((entry, at) => {
      const next = at + 1 < found.points.length ? found.points[at + 1].t : until;
      const dwell = Math.max(0.001, next - entry.t);
      weight += dwell; x += entry.x * dwell; y += entry.y * dwell;
    });
    return { t: found.points[0].t, x: x / weight, y: y / weight };
  });
}

/** `center` moved so a view of `view` points around it stays inside the frame. */
export function clampFocus(center, view, frame) {
  const keep = (value, half, side) => (half * 2 >= side ? side / 2 : Math.min(side - half, Math.max(half, value)));
  return { x: keep(center.x, view[0] / 2, frame[0]), y: keep(center.y, view[1] / 2, frame[1]) };
}

/**
 * Zoom ranges made from the clicks (and from marks with no click within 1 s): each click zooms
 * from `lead` s before it to `hold` s after it, ranges closer than `mergeGap` s join, clicks in the
 * last `edge` s are left out and every range ends `endGap` s before the end. Each range:
 * {start, end, level, focus: [{t, x, y}]}, the camera's center from each time on.
 */
export function autoZooms(rec, { level = 2, lead = 0.3, hold = 2.5, mergeGap = 2.5, edge = 1, endGap = 0.8, marks = true } = {}) {
  // Clicks outside a window or area recording are not in the picture: no zoom.
  const anchors = rec.clicks.filter(([, x, y]) => inPicture(rec, x, y)).map(([t]) => t);
  if (marks) for (const [t] of rec.marks) if (!rec.clicks.some(([at]) => Math.abs(at - t) <= 1)) anchors.push(t);
  const ranges = anchors
    .filter((t) => t < rec.duration - edge)
    .map((t) => ({ start: Math.max(0, t - lead), anchor: t, end: Math.min(t + hold, rec.duration - endGap) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous.end + mergeGap >= range.start) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const view = [rec.frame[0] / level, rec.frame[1] / level];
  const limit = [view[0] / 2, view[1] / 2];
  return merged.map((range) => {
    // The zoom aims at the first click, not where the pointer was `lead` before it: an agent's
    // pointer often jumps to the click.
    const centers = groupCenters(focusPoints(rec, range.anchor, range.end), limit, range.end);
    const focus = [];
    centers.forEach((center, index) => {
      const at = clampFocus(center, view, rec.frame);
      const entry = { t: round(index === 0 ? range.start : center.t, 3), x: point(at.x), y: point(at.y) };
      const previous = focus.at(-1);
      if (previous && Math.hypot(previous.x - entry.x, previous.y - entry.y) < 1) return;
      focus.push(entry);
    });
    return { start: round(range.start, 3), end: round(range.end, 3), level, focus };
  });
}

// ---- springs --------------------------------------------------------------------------------

// One 1 ms step of a spring pulling x toward target. Clamped: when it would overshoot, the
// damping rises to critical, so it never passes the target.
function springStep(state, target, stiffness, damping, mass, dt) {
  const dx = state.x - target;
  let c = damping;
  if (state.v * dx < 0 && Math.abs(state.v) > Math.abs(dx) * Math.sqrt(stiffness / mass)) c = Math.max(damping, 2 * Math.sqrt(stiffness * mass));
  state.v += ((-dx * stiffness - state.v * c) / mass) * dt;
  state.x += state.v * dt;
}

// The clamped spring's step response from 0 to 1 at 1 ms steps, until it is within SETTLED of
// the target and nearly still: the last half percent of a move is not seen.
const SETTLED = 0.005;
function stepResponse(stiffness, damping, mass) {
  const state = { x: 0, v: 0 };
  const values = [0];
  for (let index = 0; index < 20_000; index += 1) {
    springStep(state, 1, stiffness, damping, mass, 0.001);
    values.push(state.x);
    if (Math.abs(1 - state.x) < SETTLED && Math.abs(state.v) < SETTLED * 10) break;
  }
  return values;
}

/** Seconds the clamped spring takes to settle on its target. */
export function springSeconds(stiffness = 125, damping = 12, mass = 1.5) {
  return (stepResponse(stiffness, damping, mass).length - 1) / 1000;
}

// y of the cubic bezier (0,0) p1 p2 (1,1) at x.
export function bezierAt([x1, y1, x2, y2], x) {
  const along = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
  let low = 0, high = 1;
  for (let index = 0; index < 40; index += 1) {
    const middle = (low + high) / 2;
    if (along(x1, x2, middle) < x) low = middle; else high = middle;
  }
  return along(y1, y2, (low + high) / 2);
}

/**
 * The cubic bezier [x1, y1, x2, y2] that best fits the clamped spring's step response over its
 * settle time (springSeconds), so a kino animation of that length eases like the spring.
 */
export function springEase(stiffness = 125, damping = 12, mass = 1.5) {
  const values = stepResponse(stiffness, damping, mass);
  const last = values.length - 1;
  const samples = Array.from({ length: 41 }, (_, index) => {
    const x = index / 40;
    return [x, Math.min(1, values[Math.round(x * last)] / values[last])];
  });
  const error = (curve) => samples.reduce((sum, [x, y]) => sum + (bezierAt(curve, x) - y) ** 2, 0);
  let best = [0.2, 0.6, 0.3, 1];
  let score = error(best);
  for (let size = 0.2; size > 0.0005; size /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let index = 0; index < 4; index += 1) for (const sign of [-1, 1]) {
        const curve = best.slice();
        curve[index] = Math.min(1, Math.max(0, curve[index] + sign * size));
        const next = error(curve);
        if (next < score - 1e-12) { best = curve; score = next; improved = true; }
      }
    }
  }
  return best.map((value) => round(value, 3));
}

/** The worst gap between springEase's curve and the spring itself (0 to 1 of the move). */
export function springEaseError(stiffness = 125, damping = 12, mass = 1.5) {
  const values = stepResponse(stiffness, damping, mass);
  const curve = springEase(stiffness, damping, mass);
  const last = values.length - 1;
  let worst = 0;
  for (let index = 0; index <= 100; index += 1) worst = Math.max(worst, Math.abs(bezierAt(curve, index / 100) - Math.min(1, values[Math.round((index / 100) * last)] / values[last])));
  return worst;
}

// ---- the drawn cursor -----------------------------------------------------------------------

// The raw path with shakes taken out: a wobble that goes under 6 points away and comes back
// within 1 point in 0.5 s, with no click inside, stays where it started.
function steadyPath(rec) {
  const path = rec.moves.map((sample) => sample.slice());
  for (let index = 0; index < path.length; index += 1) {
    const from = path[index];
    let back = -1;
    let wobbled = false;
    for (let next = index + 1; next < path.length && path[next][0] - from[0] <= 0.5; next += 1) {
      const away = Math.hypot(path[next][1] - from[1], path[next][2] - from[2]);
      if (away > 6) break;
      if (away > 1) wobbled = true;
      else if (wobbled) back = next;
    }
    if (back < 0 || rec.clicks.some(([t]) => t > from[0] && t < path[back][0])) continue;
    for (let next = index + 1; next < back; next += 1) { path[next][1] = from[1]; path[next][2] = from[2]; }
    index = back - 1;
  }
  return path;
}

function simulateCursor(rec, path, { stiffness, damping, mass, step }) {
  const steady = { ...rec, moves: path };
  const clicks = rec.clicks.map(([t, x, y]) => ({ t, x, y })).sort((a, b) => a.t - b.t);
  const end = Math.max(rec.duration, path.at(-1)?.[0] ?? 0);
  const [startX, startY] = positionAt(steady, 0);
  const sx = { x: startX, v: 0 }, sy = { x: startY, v: 0 };
  const out = [[0, startX, startY]];
  const dt = 0.001;
  let nextOut = step;
  let clickIndex = 0;
  let resetAt = 0;
  const total = Math.round(end / dt);
  for (let index = 1; index <= total; index += 1) {
    const t = index * dt;
    const [tx, ty] = positionAt(steady, t);
    springStep(sx, tx, stiffness, damping, mass, dt);
    springStep(sy, ty, stiffness, damping, mass, dt);
    // At a click the drawn cursor must be on the click: a smooth offset grows over the 0.3 s
    // before, and the spring goes on from the click.
    while (clickIndex < clicks.length && clicks[clickIndex].t <= t + 1e-9) {
      const click = clicks[clickIndex];
      clickIndex += 1;
      const error = [click.x - sx.x, click.y - sy.x];
      if (Math.hypot(error[0], error[1]) > 2) {
        const from = Math.max(resetAt, click.t - 0.3);
        for (let back = out.length - 1; back >= 0 && out[back][0] >= from; back -= 1) {
          const sample = out[back];
          const share = (sample[0] - from) / Math.max(1e-6, click.t - from);
          const weight = share * share * (3 - 2 * share);
          sample[1] += error[0] * weight;
          sample[2] += error[1] * weight;
        }
      }
      sx.x = click.x; sy.x = click.y;
      resetAt = click.t;
      out.push([click.t, click.x, click.y]);
    }
    if (t + 1e-9 >= nextOut) {
      if (t > out.at(-1)[0] + 1e-9) out.push([t, sx.x, sy.x]);
      nextOut += step;
    }
  }
  return out;
}

/**
 * The cursor kino draws: the recorded path without shakes, followed by a clamped spring, on
 * every click at the click's time. [[t, x, y]] at `step` s, thinned (0.75 points), at most 3600
 * samples (a longer recording gets a longer step).
 */
export function smoothCursor(rec, { stiffness = 125, damping = 12, mass = 1.5, step = 1 / 60 } = {}) {
  if (!rec.moves?.length) return [];
  const path = steadyPath(rec);
  let size = step;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const samples = simulateCursor(rec, path, { stiffness, damping, mass, step: size });
    const thin = thinPath(samples).map(([t, x, y]) => [round(t, 3), point(x), point(y)]);
    if (thin.length <= MAX_CURSOR_SAMPLES) return thin;
    size *= 2;
  }
  return evenly(thinPath(simulateCursor(rec, path, { stiffness, damping, mass, step: size })), MAX_CURSOR_SAMPLES).map(([t, x, y]) => [round(t, 3), point(x), point(y)]);
}

// ---- typing ---------------------------------------------------------------------------------

/** Runs of typing (keys that are not shortcuts, at most `gap` s apart) lasting `minSeconds`: [{start, end, keys}]. */
export function typingRuns(rec, { minSeconds = 1.5, gap = 0.6, minRate = 2 } = {}) {
  const times = rec.keys.filter((key) => key[2] === 0).map(([t]) => t).sort((a, b) => a - b);
  const runs = [];
  let run = null;
  for (const t of times) {
    if (run && t - run.end <= gap) { run.end = t; run.keys += 1; continue; }
    run = { start: t, end: t, keys: 1 };
    runs.push(run);
  }
  return runs.filter((found) => found.end - found.start >= minSeconds && found.keys / (found.end - found.start) >= minRate)
    .map((found) => ({ start: round(found.start, 3), end: round(found.end, 3), keys: found.keys }));
}

/**
 * When the cursor hides for typing: from the first of 3 keys typed within 1.8 s until the
 * pointer next moves over 4 points (or clicks), or the end. [{start, end}].
 */
/** Whether recording point (x, y) is inside the recorded picture (a window or area recording's pointer can leave it). */
export const inPicture = (rec, x, y) => x >= 0 && y >= 0 && x <= rec.frame[0] && y <= rec.frame[1];

export function cursorHidden(rec) {
  const keys = rec.keys.filter((key) => key[2] === 0).map(([t]) => t).sort((a, b) => a - b);
  const ranges = [];
  let index = 0;
  while (index + 2 < keys.length) {
    if (keys[index + 2] - keys[index] > 1.8) { index += 1; continue; }
    const start = keys[index];
    const [hx, hy] = positionAt(rec, keys[index + 2]);
    const moved = rec.moves.find(([t, x, y]) => t > keys[index + 2] && Math.hypot(x - hx, y - hy) > 4)?.[0] ?? Infinity;
    const clicked = rec.clicks.find(([t]) => t > keys[index + 2])?.[0] ?? Infinity;
    const end = Math.min(moved, clicked, rec.duration);
    ranges.push({ start: round(start, 3), end: round(end, 3) });
    while (index < keys.length && keys[index] <= end) index += 1;
  }
  // A window or area recording: the pointer also hides while it is outside the picture.
  const outside = ([, x, y]) => !inPicture(rec, x, y);
  rec.moves.forEach((move, at) => {
    if (!outside(move) || (at > 0 && outside(rec.moves[at - 1]))) return;
    const back = rec.moves.slice(at + 1).find((next) => !outside(next))?.[0] ?? rec.duration;
    ranges.push({ start: round(move[0], 3), end: round(back, 3), outside: true });
  });
  ranges.sort((a, b) => a.start - b.start);
  const joined = [];
  for (const range of ranges) {
    const last = joined.at(-1);
    if (last && range.start <= last.end) Object.assign(last, { end: Math.max(last.end, range.end), outside: last.outside || range.outside });
    else joined.push({ ...range });
  }
  return joined;
}
