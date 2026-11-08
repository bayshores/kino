// The 2D camera: the transform of a group that puts a region of one of its
// layers at a spot in the frame. The `frame` op (backend/agent/blocks.mjs) animates the group to
// it, as a cut (an instant step, a stepped punch-in) or an eased move.
import { inverse, layerMatrix, multiply, parentMatrix, pivotOf, point, worldMatrix } from "./geometry.js";
import { hasTilt, tiltPivot, tiltProjector } from "./tilt.js";

const round = (value, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * The group values {x, y, scaleX, scaleY} that show `rect` ([x, y, w, h] in % of `layer`'s own
 * box) at `to`: "center" fits the region into the frame (all of it shows, centered), [x, y, w]
 * puts the region's center at x, y and makes it w wide (all three in % of the frame).
 * `layer` is drawn with `geometry` (its measured box, for auto-sized text); `group` is one of
 * its parents and must not be rotated or skewed. Values are in the group's parent's space.
 * `evaluate` gives a layer's state at the framing's time: a layer tilted then (rotateX, rotateY,
 * as ui-plane makes) has the region's corners projected through its perspective (engine/tilt.js),
 * so the region as seen on the plane is what fills the frame.
 */
export function frameTransform({ group, layer, geometry = layer, layers, rect, to = "center", frame, evaluate = (value) => value }) {
  if (group.rotation || group.skewX || group.skewY) throw new Error(`frame needs an unrotated group; ${group.name || group.id} is rotated or skewed.`);
  const groupWorld = worldMatrix(group, layers);
  const fromGroup = inverse(groupWorld);
  if (!fromGroup) throw new Error(`${group.name || group.id} is scaled to zero.`);
  const [rx, ry, rw, rh] = rect.map((value) => value / 100);
  const unit = [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]];
  const state = evaluate(layer);
  let corners;
  if (hasTilt(state)) {
    // On the plane (the layer's own scale and turn first), tilted about its middle in its
    // parent's space, then into the group's space (both as they are at that time).
    const plane = { ...state, width: geometry.width, height: geometry.height };
    const pivot = tiltPivot(plane);
    const project = tiltProjector(plane);
    const toGroup = multiply(inverse(worldMatrix(group, layers, evaluate)) ?? fromGroup, parentMatrix(layer, layers, evaluate));
    corners = unit.map(([u, v]) => {
      const flat = point(layerMatrix(plane), u * plane.width, v * plane.height);
      const [x, y] = project(flat.x - pivot.x, flat.y - pivot.y);
      return point(toGroup, pivot.x + x, pivot.y + y);
    });
  } else {
    // The region's corners in the group's own space (whatever the group's x, y and scale now).
    const relative = multiply(fromGroup, worldMatrix(geometry, layers));
    corners = unit.map(([u, v]) => point(relative, u * geometry.width, v * geometry.height));
  }
  const left = Math.min(...corners.map((corner) => corner.x)), right = Math.max(...corners.map((corner) => corner.x));
  const top = Math.min(...corners.map((corner) => corner.y)), bottom = Math.max(...corners.map((corner) => corner.y));
  const width = right - left, height = bottom - top;
  if (width < 1e-6 || height < 1e-6) throw new Error("rect has no size on the layer.");
  // Where the region goes on screen and how big it is there (frame pixels).
  const target = to === "center"
    ? { x: frame.width / 2, y: frame.height / 2, scale: Math.min(frame.width / width, frame.height / height) }
    : { x: (to[0] / 100) * frame.width, y: (to[1] / 100) * frame.height, scale: ((to[2] / 100) * frame.width) / width };
  // Into the group's parent's space (a camera group is usually at the top, where this is the frame).
  const parent = parentMatrix(group, layers);
  const toParent = inverse(parent);
  if (!toParent) throw new Error(`${group.name || group.id}'s parent is scaled to zero.`);
  const spot = point(toParent, target.x, target.y);
  const scale = target.scale / Math.hypot(parent[0], parent[1]);
  // The group scales about its own center, so its x, y is where that center lands, less half its size.
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  // A group with an anchor scales about that point instead (geometry.js pivotOf).
  if (Array.isArray(group.anchor)) {
    const [px, py] = pivotOf(group);
    return { x: round(spot.x - scale * center.x - px + scale * px, 2), y: round(spot.y - scale * center.y - py + scale * py, 2),
      scaleX: round(scale), scaleY: round(scale) };
  }
  return {
    x: round(spot.x - scale * center.x - group.width / 2 + (scale * group.width) / 2, 2),
    y: round(spot.y - scale * center.y - group.height / 2 + (scale * group.height) / 2, 2),
    scaleX: round(scale),
    scaleY: round(scale),
  };
}

// ---- drift: the scene camera never stands still ----------------------------------------------
// A scene with `drift` {dir, speed} gets a slow camera move over every hold longer than
// DRIFT_HOLD seconds where nothing animates (calm launch films move 2 to 4% a second through
// every shot, or slide a held card diagonally). It is drawn, not saved: expandComponents wraps the
// scene's top layers in a drift group, like the frame op's camera group, with the moves on it.
// Planned stills (scene.rests) are skipped. New scenes made by agents get DRIFT_DEFAULT; a scene
// without `drift` (every older project) is drawn as before.
export const DRIFT_DEFAULT = Object.freeze({ dir: "auto", speed: 0.02 });
export const DRIFT_DIRS = ["auto", "in", "left", "right", "up", "down"];
// Motion templates are still for 36 ms at most (median), so a hold
// of half a second already drifts.
export const DRIFT_HOLD = 0.5;
// The fastest a frame corner may travel (a share of the frame diagonal a second): the checker's
// slow push (SLOW_PUSH.speed in engine/quality/rules/motion.js) is let off up to this.
const DRIFT_CORNER = 0.04;
// Each hold is one steady linear push. The camera never goes further from
// where the layers were placed than DRIFT_SPAN s of drift, a 12% slide of the frame diagonal or
// a 24% push: a hold that would pass that drifts back (the next holds return toward rest), and
// a hold longer than the span drifts out and back in eased legs.
const DRIFT_SPAN = 6;
const DRIFT_SLIDE = 0.12;
const DRIFT_PUSH = 0.24;
const LEG_EASE = [0.37, 0, 0.63, 1];

/** Checks a scene's drift: absent or false (off), or {dir, speed}. Returns the clean value. */
export function normalizeDrift(value, path, fail) {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) fail(path, 'must be false or {dir, speed}, such as {dir:"auto", speed:0.02}');
  const dir = value.dir ?? DRIFT_DEFAULT.dir;
  const speed = value.speed ?? DRIFT_DEFAULT.speed;
  if (!DRIFT_DIRS.includes(dir)) fail(`${path}.dir`, `must be one of ${DRIFT_DIRS.join(", ")}`);
  if (typeof speed !== "number" || !(speed >= 0.01 && speed <= 0.04)) fail(`${path}.speed`, "must be a share of the frame diagonal a second, from 0.01 to 0.04");
  return { dir, speed };
}

const flattenTimed = (list, offset = 0) => (Array.isArray(list) ? list : []).flatMap((item) => !item || item.enabled === false ? []
  : item.kind === "composed" ? flattenTimed(item.animations, offset + (item.start ?? 0)) : [{ ...item, start: (item.start ?? 0) + offset }]);

/**
 * The scene's holds to drift through: [start, end] spans over DRIFT_HOLD s where no enabled
 * animation runs (a loop or a perpetual layer moves the whole time) and outside its rests.
 * `windowOf(layer, animation)` is [start, end] of one animation (engine/blocks/timing.js).
 */
export function driftHolds(scene, windowOf) {
  const busy = [];
  for (const layer of scene.layers ?? []) {
    if (layer.type === "audio") continue;
    if (layer.perpetual === true) return [];
    for (const animation of flattenTimed(layer.animations)) {
      if (animation.behavior?.loop && typeof animation.behavior.loop === "object") return [];
      busy.push(windowOf(layer, animation));
    }
  }
  for (const animation of flattenTimed(scene.backgroundAnimations)) busy.push([animation.start, animation.start + (animation.duration ?? 0)]);
  for (const rest of scene.rests ?? []) busy.push([rest.at, rest.until]);
  busy.sort((a, b) => a[0] - b[0]);
  const holds = [];
  let free = 0;
  for (const [start, end] of busy) {
    if (start - free > DRIFT_HOLD) holds.push([free, start]);
    free = Math.max(free, end);
  }
  if (scene.duration - free > DRIFT_HOLD) holds.push([free, scene.duration]);
  return holds.map(([start, end]) => [round(start, 3), round(end, 3)]);
}

/**
 * The drift group's animations for `holds`: each hold moves the camera at a steady speed, one
 * linear leg (or eased legs that turn back when the hold is longer than the span), and the
 * camera stays where a leg ends. `u` (seconds of drift away from rest) stays within the span, so
 * a run of holds goes out and back instead of carrying the layers ever further. `cover` is true
 * when a layer reaches the frame's edge: the slide then comes with just enough push that no
 * edge shows. The seed picks the diagonal.
 */
export function driftAnimations(holds, { width, height, dir = "auto", speed = 0.02, cover = true, seed = 1, id = "drift" }) {
  const diagonal = Math.hypot(width, height);
  const sign = [seed % 2 ? 1 : -1, Math.floor(seed / 2) % 2 ? 1 : -1];
  const unit = { auto: [(sign[0] * width) / diagonal, (sign[1] * height) / diagonal], in: [0, 0], left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  // m: the slide (px a second); p: the push (scale a second).
  let m = dir === "in" ? 0 : speed * diagonal;
  let p = dir === "in" ? 2 * speed : cover ? Math.max((2 * m * Math.abs(unit[0])) / width, (2 * m * Math.abs(unit[1])) / height) : 0;
  const corner = m + (p * diagonal) / 2;
  if (corner > DRIFT_CORNER * diagonal) { const cut = (DRIFT_CORNER * diagonal) / corner; m *= cut; p *= cut; }
  const span = Math.min(DRIFT_SPAN, m > 0 ? (DRIFT_SLIDE * diagonal) / m : Infinity, p > 0 ? DRIFT_PUSH / p : Infinity);
  const pose = (u) => ({ x: round(unit[0] * m * u, 2), y: round(unit[1] * m * u, 2), scaleX: round(1 + p * u), scaleY: round(1 + p * u) });
  const animations = [];
  let u = 0;
  for (const [start, end] of holds) {
    const legs = Math.max(1, Math.ceil((end - start) / span - 1e-9));
    const leg = (end - start) / legs;
    for (let index = 0; index < legs; index += 1) {
      const from = pose(u);
      // Out while there is room within the span, else back toward rest.
      u = u + leg <= span + 1e-9 ? u + leg : Math.max(0, u - leg);
      animations.push({
        id: `${id}.drift-${animations.length + 1}`, name: "Drift", kind: "custom", start: round(start + index * leg), duration: round(leg),
        easing: legs > 1 ? LEG_EASE : "linear", unit: "layer", stagger: 0, order: "forward", from, to: pose(u),
      });
    }
  }
  return animations;
}

// Screen-fixed overlays stay put while the picture drifts (a corner badge once slid off the
// frame's edge): a status-line badge, caption-words, and the captions op's
// group (each page a group holding a caption text).
const FIXED_MOVES = new Set(["status-line", "caption-words"]);
export function screenFixed(layer, layers) {
  if (FIXED_MOVES.has(layer.move?.name)) return true;
  if (layer.type !== "group") return false;
  const pages = layers.filter((entry) => entry.parentId === layer.id);
  return pages.length > 0 && pages.every((page) => layers.some((entry) => entry.parentId === page.id && entry.role === "caption"));
}

/**
 * The scene as drawn with its drift: its top layers inside a drift group (the camera) that
 * moves through each hold. Screen-fixed overlays are left out; the layers between them each get
 * a drift group with the same moves, so the stack order stays as it was. A scene without drift,
 * or with no hold, comes back as it was.
 */
export function withDrift(scene, { windowOf, makeGroup = (fields) => fields }) {
  if (!scene.drift || !(scene.layers ?? []).length) return scene;
  const holds = driftHolds(scene, windowOf);
  if (!holds.length) return scene;
  const { width, height } = scene;
  const ids = new Set(scene.layers.map((layer) => layer.id));
  let id = `${scene.id}-drift`;
  for (let number = 2; ids.has(id); number += 1) id = `${scene.id}-drift-${number}`;
  const tops = scene.layers.filter((layer) => !ids.has(layer.parentId));
  const fixed = new Set(tops.filter((layer) => screenFixed(layer, scene.layers)));
  // Runs of drifting top layers, split where a fixed overlay sits between them.
  const runs = [];
  let open = false;
  for (const layer of tops) {
    if (fixed.has(layer)) { open = false; continue; }
    if (!open) runs.push([]);
    runs.at(-1).push(layer);
    open = true;
  }
  if (!runs.length) return scene;
  const moving = runs.flat();
  const cover = moving.some((layer) => layer.type !== "audio" && (layer.x <= 1 || layer.y <= 1 || layer.x + layer.width >= width - 1 || layer.y + layer.height >= height - 1));
  let seed = 0;
  for (const char of String(scene.id)) seed = (seed * 31 + char.codePointAt(0)) % 9973;
  const groupOf = new Map();
  const groups = runs.map((run, index) => {
    let runId = index ? `${id}-${index + 1}` : id;
    for (let number = 2; index && ids.has(runId); number += 1) runId = `${id}-${index + 1}-${number}`;
    const animations = driftAnimations(holds, { width, height, ...scene.drift, cover, seed, id: runId });
    const group = makeGroup({ id: runId, name: "Drift", sceneCamera: true, x: 0, y: 0, width, height, animations });
    for (const layer of run) groupOf.set(layer, group);
    return group;
  });
  const firsts = new Map(runs.map((run, index) => [run[0], groups[index]]));
  // Each drift group goes just before its first layer (one group with no overlay: first of all).
  const layers = fixed.size ? [] : [groups[0]];
  for (const layer of scene.layers) {
    if (fixed.size && firsts.has(layer)) layers.push(firsts.get(layer));
    layers.push(groupOf.has(layer) ? { ...layer, parentId: groupOf.get(layer).id } : layer);
  }
  return { ...scene, layers };
}
