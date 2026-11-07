// Hold motion: a recipe never sits still while it is read. Once every part has landed,
// the whole group moves slowly until it starts to leave: a small push (2 to 4%, in or out; a
// group that fills the safe area pulls back up to 6%) and a drift, or a parallax drift where nearer parts travel further. It eases in and out, never loops
// or bounces, and stops when the group leaves (or at the end of the scene).
//
// "Visible" is the checker's held_static measure (engine/quality/rules/polish.js): an edge moving 1%
// of the frame diagonal a second (0.4% for a layer filling 30% of the frame). The hold moves its
// fastest layer just fast enough that its quiet start and end last under a second (the least
// that reads as alive, see travelFactor), and keeps each text inside the safe area. The seed picks the kind, the direction and the push, so projects differ.
//
// Every hold animation's ID ends in ".hold": moves (engine/blocks/move.js) start over it.
import { safeArea } from "./formats.js";
import { seeded } from "./build.js";
import { typeFloor } from "./looks.js";
import { easingAt } from "../easing.js";
import { round } from "../numbers.js";

// The shortest hold that gets motion: shorter ones are covered by the entrance and the exit.
export const HOLD_MIN = 1.2;
const SETTLE = 0.1;
// Short holds ease fully in and out; long ones keep a little speed at their ends, so the
// quiet start and end of a long drift stay short.
const EASE = [0.37, 0, 0.63, 1];
const LONG_EASE = [0.3, 0.1, 0.7, 0.9];
// The longest quiet stretch (seconds) left at either end of the hold: with the end of the
// entrance and the start of the exit it stays under held_static's 1.5 s.
const QUIET = 0.9;
// A little more than the least, so rounding and the measure's half-second window never undercut it.
const MARGIN = 1.15;
// The eight directions a group may drift in, as unit steps.
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
const KINDS = ["drift", "drift-out", "parallax"];
const READ_ROLES = new Set(["headline", "subhead", "body", "caption", "cta", "label", "logo", "hero"]);

/**
 * How far (in multiples of `speed` seconds' travel at the checker's threshold, times the hold's
 * length) the fastest edge must move so that no quiet stretch of the eased hold is longer than
 * QUIET: the checker measures speed over half a second, at 30 samples a second.
 */
function travelFactor(length, easing) {
  const fps = 30;
  const lag = fps / 2;
  const count = Math.max(2, Math.round(length * fps));
  const progress = Array.from({ length: count + 1 }, (_, index) => easingAt(easing, index / count));
  const rates = progress.map((value, index) => (value - progress[Math.max(0, index - lag)]) * 2);
  for (let factor = 0.1; factor < 10; factor += 0.05) {
    let run = 0;
    let worst = 0;
    for (const rate of rates) {
      run = rate * factor * length < 1 ? run + 1 : 0;
      worst = Math.max(worst, run);
    }
    if (worst / fps <= QUIET) return factor * MARGIN;
  }
  return 10;
}

const boxOf = (layer) => ({ x0: layer.x, y0: layer.y, x1: layer.x + layer.width, y1: layer.y + layer.height });
const overlaps = (a, b, axis) => (axis === "x" ? a.x0 < b.x1 && b.x0 < a.x1 : a.y0 < b.y1 && b.y0 < a.y1);
const inside = (box, area) => box.x0 >= area.x0 - 0.5 && box.y0 >= area.y0 - 0.5 && box.x1 <= area.x1 + 0.5 && box.y1 <= area.y1 + 0.5;

// Layers whose boxes touch belong together (a text on its card or pill): one cluster each.
function clustersOf(layers) {
  const clusters = [];
  for (const layer of layers) {
    const box = boxOf(layer);
    const joined = clusters.filter((cluster) => cluster.layers.some((other) => overlaps(box, boxOf(other), "x") && overlaps(box, boxOf(other), "y")));
    const merged = { layers: [layer, ...joined.flatMap((cluster) => cluster.layers)] };
    for (const cluster of joined) clusters.splice(clusters.indexOf(cluster), 1);
    clusters.push(merged);
  }
  for (const cluster of clusters) {
    const boxes = cluster.layers.map(boxOf);
    cluster.box = { x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) };
    cluster.size = (cluster.box.x1 - cluster.box.x0) * (cluster.box.y1 - cluster.box.y0);
  }
  return clusters;
}

/**
 * The hold animations for `layers` (a recipe's parts, already placed) from `from` to `to` seconds.
 * Returns a Map of layer ID to {animation, dx, dy} (dx, dy: where the layer ends up, which its exit
 * starts from), or an empty Map when the hold is too short or motion is reduced.
 */
export function holdMotion(layers, { frame, from, to, seed = 1, reduced = false }) {
  const moves = new Map();
  // It starts a moment after the last part lands, so it reads as settling, then drifting.
  from = round(from + SETTLE);
  const length = round(to - from);
  if (reduced || !(length >= HOLD_MIN) || !layers.length) return moves;
  const rng = seeded(seed * 7919 + 17);
  const kind = rng.pick(KINDS);
  let push = round((kind === "drift-out" ? -1 : 1) * rng.between(0.02, 0.04));
  // A push that would grow a text past the headline size would change how it reads (and the
  // checker's timing band for it): such a group pulls back instead.
  const headline = typeFloor(frame).headline;
  if (push > 0 && layers.some((layer) => layer.type === "text" && layer.fontSize < headline && layer.fontSize * (1 + push) >= headline - 0.5)) push = -push;
  const diagonal = Math.hypot(frame.width, frame.height);
  const frameArea = frame.width * frame.height;
  const safeBox = (({ x, y, width, height }) => ({ x0: x, y0: y, x1: x + width, y1: y + height }))(safeArea(frame));
  const frameBox = { x0: 0, y0: 0, x1: frame.width, y1: frame.height };
  const all = clustersOf(layers);
  const group = { x0: Math.min(...all.map((c) => c.box.x0)), y0: Math.min(...all.map((c) => c.box.y0)), x1: Math.max(...all.map((c) => c.box.x1)), y1: Math.max(...all.map((c) => c.box.y1)) };
  const center = { x: (group.x0 + group.x1) / 2, y: (group.y0 + group.y1) / 2 };
  // Parallax: the largest cluster is nearest (travels furthest), the others 60%. Only along an axis
  // where no two clusters sit side by side, so the gaps between them never close.
  const separated = (axis) => all.every((a, i) => all.every((b, j) => i === j || !overlaps(a.box, b.box, axis === "x" ? "y" : "x")));
  let parallaxAxis = kind === "parallax" && all.length > 1 ? (separated("x") ? "x" : separated("y") ? "y" : null) : null;
  const nearest = all.reduce((best, cluster) => (cluster.size > best.size ? cluster : best), all[0]);
  const depthOf = (layer) => (parallaxAxis ? (nearest.layers.includes(layer) ? 1 : 0.6) : 1);
  const directionsFor = () => parallaxAxis ? DIRECTIONS.filter(([x, y]) => (parallaxAxis === "x" ? y === 0 : x === 0)) : DIRECTIONS;
  // Where each layer's box ends after the push (about the group's center) and a drift of `distance`.
  const endBox = (layer, [ux, uy], distance) => {
    const scale = 1 + push;
    const cx = center.x + (layer.x + layer.width / 2 - center.x) * scale + ux * distance * depthOf(layer);
    const cy = center.y + (layer.y + layer.height / 2 - center.y) * scale + uy * distance * depthOf(layer);
    const [w, h] = [layer.width * scale, layer.height * scale];
    return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  };
  // True when no layer leaves the area it started in (texts the safe area, the rest the frame).
  const allowed = (direction, distance) => layers.every((layer) => {
    const start = boxOf(layer);
    const area = (layer.type === "text" || READ_ROLES.has(layer.role)) && inside(start, safeBox) ? safeBox : inside(start, frameBox) ? frameBox : null;
    const end = endBox(layer, direction, distance);
    // A picture flush with a frame edge (a full-width shot) stays flush with it.
    const flushX = Math.abs(start.x0) <= 0.5 || Math.abs(start.x1 - frame.width) <= 0.5;
    const flushY = Math.abs(start.y0) <= 0.5 || Math.abs(start.y1 - frame.height) <= 0.5;
    if (flushX && (Math.abs(end.x0 - start.x0) > 0.5 || Math.abs(end.x1 - start.x1) > 0.5)) return false;
    if (flushY && (Math.abs(end.y0 - start.y0) > 0.5 || Math.abs(end.y1 - start.y1) > 0.5)) return false;
    // A text ends 1 px inside the safe area, so the rounded scale and offset saved never cross it.
    const room = area === safeBox ? 1 : 0;
    return !area || inside(end, { x0: area.x0 + room, y0: area.y0 + room, x1: area.x1 - room, y1: area.y1 - room });
  });
  const easing = length > 3 ? LONG_EASE : EASE;
  const factor = travelFactor(length, easing);
  // True when some layer's edge travels fast enough to read as motion.
  const visible = (direction, distance) => layers.some((layer) => {
    const [a, b] = [boxOf(layer), endBox(layer, direction, distance)];
    const travel = Math.max(Math.abs(a.x0 - b.x0), Math.abs(a.y0 - b.y0), Math.abs(a.x1 - b.x1), Math.abs(a.y1 - b.y1));
    // A text is judged by its letters, which fill less than its box: always the 1% bar.
    const large = layer.type !== "text" && (layer.width * layer.height) / frameArea >= 0.3;
    return travel >= factor * (large ? 0.004 : 0.01) * diagonal * length;
  });
  // A group that fills its room cannot grow: it pulls back instead, or only drifts.
  if (!DIRECTIONS.some((direction) => allowed(direction, 0))) push = -push;
  if (!DIRECTIONS.some((direction) => allowed(direction, 0))) push = 0;
  const shuffle = (list) => {
    const order = [...list];
    for (let index = order.length - 1; index > 0; index -= 1) {
      const other = Math.floor(rng.next() * (index + 1));
      [order[index], order[other]] = [order[other], order[index]];
    }
    return order;
  };
  const step = Math.max(2, Math.round(diagonal * 0.002));
  // The seeded order of directions; the first that moves enough inside its room wins, else the
  // one that gets furthest. A parallax with no room on its axis becomes a plain drift.
  const search = () => {
    let best = null;
    for (const direction of shuffle(directionsFor())) {
      if (!allowed(direction, 0)) continue;
      let distance = 0;
      while (!visible(direction, distance) && allowed(direction, distance + step) && distance < diagonal * 0.2) distance += step;
      const ok = visible(direction, distance);
      if (ok) return { direction, distance, ok };
      if (!best || distance > best.distance) best = { direction, distance, ok };
    }
    return best;
  };
  let chosen = search();
  if (!chosen?.ok && parallaxAxis) {
    parallaxAxis = null;
    chosen = search() ?? chosen;
  }
  // A group that fills the safe area (a chart in a tall frame) has no room to drift: it pulls
  // back further (up to 6%), which both moves its edges and frees room.
  for (const more of [0.045, 0.06]) {
    if (chosen?.ok) break;
    const kept = push;
    push = -more;
    const found = search();
    if (found?.ok) chosen = found;
    else push = kept;
  }
  if (!chosen) return moves;
  const { direction, distance } = chosen;
  for (const layer of layers) {
    const box = endBox(layer, direction, distance);
    const [scaleX, scaleY] = [layer.scaleX ?? 1, layer.scaleY ?? 1];
    const dx = Math.round(box.x0 + (box.x1 - box.x0) / 2 - (layer.x + layer.width / 2));
    const dy = Math.round(box.y0 + (box.y1 - box.y0) / 2 - (layer.y + layer.height / 2));
    const animation = {
      name: "Hold", kind: "custom", start: round(from), duration: length, easing: [...easing], unit: "layer", stagger: 0, order: "forward",
      from: { x: layer.x, y: layer.y, scaleX, scaleY }, to: { x: layer.x + dx, y: layer.y + dy, scaleX: round(scaleX * (1 + push)), scaleY: round(scaleY * (1 + push)) },
    };
    moves.set(layer.id, { animation, dx, dy });
  }
  return moves;
}

// A screenshot pushes in further than a group's hold: a 2 to 4% push on an app screen reads as
// a frozen slide (frozen_screen). It grows by up to 18% about the part that matters.
const SCREEN_PUSH = 1.18;
const SCREEN_LEAST = 1.06;
const SCREEN_EASE = [0.33, 0, 0.25, 1];

/** The center of `region` ([x, y, w, h] in % of the picture) in frame pixels on `layer`. */
export function regionCenter(layer, region) {
  const [x, y, w, h] = region;
  return { x: layer.x + (layer.width * (x + w / 2)) / 100, y: layer.y + (layer.height * (y + h / 2)) / 100 };
}

/**
 * The slow push into a screenshot's region from `from` to `to` seconds: `layer` grows by up to
 * 18% about the region's center (so that part stays put and fills more of the frame), never
 * newly covering a box in `keep` (the words beside it) or leaving `room` (a card it sits on).
 * `shift` {dx, dy}: the group's drift, added to the push (the words and the card drift with it,
 * so `keep` is judged before the drift and `room`, the card's end box, after it).
 * Returns {animation, dx, dy, scale} or null under reduced motion, for a hold under 1.2 s, or
 * when it cannot grow 6%.
 */
export function screenPush(layer, region, { from, to, keep = [], room = null, shift = null, reduced = false }) {
  const length = round(to - from);
  if (reduced || !(length >= HOLD_MIN)) return null;
  const point = regionCenter(layer, region);
  const center = { x: layer.x + layer.width / 2, y: layer.y + layer.height / 2 };
  const boxAt = (scale) => {
    const cx = point.x + (center.x - point.x) * scale;
    const cy = point.y + (center.y - point.y) * scale;
    const [w, h] = [layer.width * scale, layer.height * scale];
    return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  };
  const start = boxOf(layer);
  const hits = (a, b) => overlaps(a, b, "x") && overlaps(a, b, "y");
  const [sx, sy] = [shift?.dx ?? 0, shift?.dy ?? 0];
  const moved = (box) => ({ x0: box.x0 + sx, y0: box.y0 + sy, x1: box.x1 + sx, y1: box.y1 + sy });
  const fits = (scale) => {
    const box = boxAt(scale);
    if (room && !inside(moved(box), room)) return false;
    return keep.every((other) => hits(start, other) || !hits(box, other));
  };
  let scale = SCREEN_PUSH;
  while (scale > SCREEN_LEAST && !fits(scale)) scale = round(scale - 0.01);
  if (!fits(scale)) return null;
  const end = boxAt(scale);
  const dx = Math.round((end.x0 + end.x1) / 2 - center.x + sx);
  const dy = Math.round((end.y0 + end.y1) / 2 - center.y + sy);
  const [scaleX, scaleY] = [layer.scaleX ?? 1, layer.scaleY ?? 1];
  const animation = {
    name: "Screen push", kind: "custom", start: round(from), duration: length, easing: [...SCREEN_EASE], unit: "layer", stagger: 0, order: "forward",
    from: { x: layer.x, y: layer.y, scaleX, scaleY }, to: { x: layer.x + dx, y: layer.y + dy, scaleX: round(scaleX * scale), scaleY: round(scaleY * scale) },
  };
  return { animation, dx, dy, scale };
}
