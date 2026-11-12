// Where the scene's own background shows between two full-frame shots: frames where the pictures
// (and plates) drawn cover less than half of the frame, with a cover before and after. A fact for
// check's answer and look's review, never a rule or a finding. A stretch where words or a shape come
// on is a card made on the background, not a gap.
//
// Why: a flash was deleted but its fade-in stayed, so the shot before hid at 8.0 s and the shot after
// faded in from 0 at 8.06 s: three frames of the near-white background (brightness 230 of 255) ran
// between two dark shots, and no check saw it because each layer was valid alone.
//
// Cover at a point of the frame is 1 - the product of (1 - opacity) over the layers drawn there, as the
// frame is composited (normal blend); the frame's cover is the mean over a grid of points. Under HALF
// is "bare": the background is the main thing seen. A layer is placed by its world matrix (groups,
// camera pushes, slides and tilts count), so a shot sliding in beside another is not a gap.
import { enabledAnimations } from "../animationEnabled.js";
import { flattenAnimations } from "../animationTree.js";
import { evaluateLayer } from "../animation.js";
import { inverse, layerMatrix, multiply, pivotOf, point, IDENTITY } from "../geometry.js";
import { hiddenRanges, isVisibilityOperation, visibleByOperations } from "../visibilityOps.js";

// Cover under this is a bare frame. A guess: at half, the background shows as much as the shots.
const HALF = 0.5;
// A shot counts as whole once one layer is this opaque and covers WIDE of the frame.
const WHOLE = 0.99;
const WIDE = 0.9;
// How far ahead (s) the whole shot is looked for after the gap; a fade longer than this is not one.
const LOOK_AHEAD = 2;
// The grid the frame's cover is measured on (cell centers).
const COLUMNS = 16;
const ROWS = 9;
const round = (value, places = 3) => Number(value.toFixed(places));
const TYPES = new Set(["video", "image", "rectangle"]);

/** The layers that can cover the frame: pictures and fills drawn normally, not masks or masked. */
function candidates(scene) {
  const all = scene.layers ?? [];
  const byId = new Map(all.map((layer) => [layer.id, layer]));
  const chain = (layer) => {
    const parents = [];
    for (let parent = byId.get(layer.parentId); parent && !parents.includes(parent) && parents.length < 12; parent = byId.get(parent.parentId)) parents.push(parent);
    return parents;
  };
  return all.filter((layer) => TYPES.has(layer.type) && layer.enabled !== false && !layer.isMask
    && (layer.blendMode ?? "normal") === "normal" && !layer.mask && !layer.maskId)
    .map((layer) => ({ layer, parents: chain(layer) }))
    .filter(({ parents }) => parents.every((parent) => parent.enabled !== false && !parent.isMaskGroup && !parent.mask && !parent.maskId));
}

// Layers that are no picture of a shot but are drawn: a card's words or shapes made for the stretch.
const UNSEEN = new Set(["audio", "group", "component"]);

/**
 * Whether a layer that is not a covering picture (text, a shape, a path) comes on inside the
 * stretch from frame `first` and is off again at frame `end` (the next picture's): then the
 * background there is a card made for that stretch, not a gap. Words that come on with the next
 * shot and stay over it belong to that shot, so they do not count.
 */
function cardIn(scene, first, end, fps, edge = null) {
  const on = (layer, frame) => layer.visible !== false && visibleByOperations(layer.animations ?? [], frame / fps);
  const middle = Math.round((first + end - 1) / 2);
  // The scene's first stretch: words already on from the first frame are its title. Its last: words
  // that come on in it are its end card (the picture before it has no `off` frame to compare).
  return (scene.layers ?? []).some((layer) => !TYPES.has(layer.type) && !UNSEEN.has(layer.type) && layer.enabled !== false
    && on(layer, middle) && (edge === "start" || (!on(layer, first - 1) && (edge === "end" || !on(layer, end)))));
}

/** Whether a layer has no animation but Show and Hide (its state is then its own, read cheaply). */
const plainLayer = (layer) => flattenAnimations(layer.animations ?? []).every(isVisibilityOperation);

/**
 * One entry as drawn at `time`: {layer, state, opacity, matrix} with opacity the product down the
 * groups and matrix the box-to-frame matrix through them, or null when it (or a group above it) is
 * hidden or clear. `states` caches the evaluated layers of one time.
 */
function worldOf({ layer, parents, plain }, time, states) {
  const stateOf = (item) => {
    if (!states.has(item)) {
      if (plain.get(item)) states.set(item, { ...item, visible: visibleByOperations(item.animations, time) });
      else states.set(item, evaluateLayer(item, time));
    }
    return states.get(item);
  };
  const state = stateOf(layer);
  if (state.visible === false || layer.visible === false) return null;
  let opacity = Number.isFinite(state.opacity) ? state.opacity : 1;
  let matrix = IDENTITY;
  for (const parent of [...parents].reverse()) {
    const parentState = stateOf(parent);
    if (parentState.visible === false || parent.visible === false) return null;
    opacity *= Number.isFinite(parentState.opacity) ? parentState.opacity : 1;
    matrix = multiply(matrix, layerMatrix(parentState));
  }
  opacity = Math.min(1, Math.max(0, opacity));
  if (opacity <= 0) return null;
  return { layer, state, opacity, matrix: multiply(matrix, layerMatrix(state)) };
}

/**
 * The layers as drawn at `time`: [{layer, opacity, share}] with opacity the product down the groups
 * and share the part (0 to 1) of the grid the layer's box covers. Layers not drawn are left out.
 */
function drawn(entries, time, grid) {
  const states = new Map();
  const result = [];
  for (const entry of entries) {
    const world = worldOf(entry, time, states);
    if (!world) continue;
    const { layer, opacity, state } = world;
    const back = inverse(world.matrix);
    if (!back) continue;
    const width = state.width ?? 0, height = state.height ?? 0;
    const covered = [];
    for (let index = 0; index < grid.length; index += 1) {
      const [px, py] = grid[index];
      const lx = back[0] * px + back[2] * py + back[4], ly = back[1] * px + back[3] * py + back[5];
      if (lx >= 0 && lx <= width && ly >= 0 && ly <= height) covered.push(index);
    }
    if (covered.length) result.push({ layer, opacity, covered });
  }
  return result;
}

/** The frame as composited at `time`: {cover, shown: [{layer, opacity, share}]}. */
function frameAt(entries, time, grid) {
  const left = new Float64Array(grid.length).fill(1);
  const shown = drawn(entries, time, grid);
  for (const { opacity, covered } of shown) for (const index of covered) left[index] *= 1 - opacity;
  const cover = 1 - left.reduce((sum, value) => sum + value, 0) / grid.length;
  return { cover, shown: shown.map(({ layer, opacity, covered }) => ({ layer, opacity, share: covered.length / grid.length })) };
}

/** The candidates with the table of which layers carry no animation but Show and Hide. */
function withPlain(found) {
  const plain = new Map();
  for (const { layer, parents } of found) for (const item of [layer, ...parents]) if (!plain.has(item)) plain.set(item, plainLayer(item));
  return found.map((entry) => ({ ...entry, plain }));
}

/** The points the frame's cover is measured at (cell centers of a COLUMNS by ROWS grid). */
function gridOf(scene) {
  const grid = [];
  for (let row = 0; row < ROWS; row += 1) for (let column = 0; column < COLUMNS; column += 1) grid.push([((column + 0.5) / COLUMNS) * scene.width, ((row + 0.5) / ROWS) * scene.height]);
  return grid;
}

/**
 * The stretches where the frame is bare between two covered stretches:
 * [{start, end, frames, cover, before: {layer, time}, after: {layer, time}, whole, background}].
 * start is the first bare frame's time, end the time of the first covered frame after it, cover the
 * lowest cover in the stretch (0 to 1), before and after the layer that covered most just outside it,
 * whole the time the shot after is fully opaque and wide (end when it already is). Times are scene seconds.
 */
export function bareGaps(scene, { fps = 30, edges = false } = {}) {
  const found = candidates(scene);
  if (found.length < (edges ? 1 : 2) || !(scene.duration > 0) || !(fps > 0)) return [];
  const entries = withPlain(found);
  const grid = gridOf(scene);
  const frames = Math.round(scene.duration * fps);
  const at = (k) => frameAt(entries, Math.min(k, frames - 1) / fps, grid);
  const strongest = (frame) => frame.shown.reduce((best, entry) => (entry.opacity * entry.share > best.score ? { score: entry.opacity * entry.share, layer: entry.layer } : best), { score: 0, layer: null }).layer;
  const isWhole = (frame) => frame.shown.some(({ opacity, share }) => opacity >= WHOLE && share >= WIDE);
  const gaps = [];
  let previous = null;
  let open = null;
  for (let k = 0; k <= frames; k += 1) {
    const frame = at(k);
    const bare = frame.cover < HALF;
    if (edges && k === 0 && bare) open = { first: 0, cover: frame.cover, before: null, edge: "start" };
    else if (bare && !open && previous && !previous.bare) open = { first: k, cover: frame.cover, before: strongest(previous.frame) };
    else if (bare && open) open.cover = Math.min(open.cover, frame.cover);
    else if (!bare && open && cardIn(scene, open.first, k, fps, open.edge)) open = null;
    // The first stretch of a shot that fades in from the first frame is a fade from the background, not a gap.
    else if (!bare && open?.edge === "start" && fadesIn(strongest(frame), 0, fps)) open = null;
    else if (!bare && open) {
      let whole = k;
      while (whole < frames && whole - k < LOOK_AHEAD * fps && !isWhole(at(whole))) whole += 1;
      gaps.push({ start: round(open.first / fps), end: round(k / fps), frames: k - open.first, cover: round(open.cover),
        before: open.before ? { layer: open.before, time: round((open.first - 1) / fps) } : null, after: { layer: strongest(frame), time: round(k / fps) },
        whole: round(Math.min(whole, frames) / fps), background: background(scene), ...(open.edge ? { edge: open.edge } : {}) });
      open = null;
    }
    previous = { frame, bare };
  }
  // Still bare at the last frame: the scene's last stretch, unless its last picture fades out into it
  // or words come on in it.
  if (edges && open && !open.edge && open.before && !fadesOut(open.before, open.first / fps, fps) && !cardIn(scene, open.first, frames, fps, "end"))
    gaps.push({ start: round(open.first / fps), end: round(frames / fps), frames: frames - open.first, cover: round(open.cover),
      before: { layer: open.before, time: round((open.first - 1) / fps) }, after: null, whole: round(frames / fps), background: background(scene), edge: "end" });
  return gaps;
}

const background = (scene) => (typeof scene.background === "string" && scene.backgroundEnabled !== false ? scene.background : null);

// Whether `layer` has a fade that takes its opacity up to full from a lower value, starting at the first frame.
const fadesIn = (layer, at, fps) => enabledAnimations(flattenAnimations(layer?.animations ?? []))
  .some((animation) => animation.from?.opacity < 1 && animation.to?.opacity === 1 && Math.abs((animation.start ?? 0) - at) <= 1.5 / fps);
// Whether `layer` has a fade down that is still running at `time` (its end is at or after it).
const fadesOut = (layer, time, fps) => enabledAnimations(flattenAnimations(layer?.animations ?? []))
  .some((animation) => animation.to?.opacity < 1 && (animation.from?.opacity ?? 1) > animation.to.opacity && (animation.start ?? 0) + (animation.duration ?? 0) >= time - 1.5 / fps);

/** The animation of `layer` (top level or in a group) a call would change, as {id, kind, start, duration}. */
function ownAnimations(layer) {
  return enabledAnimations(flattenAnimations(layer.animations ?? []));
}

/**
 * The calls that close `gap`: the shot before stays until the shot after is whole (its Hide moves to
 * gap.whole), or the shot after starts at full opacity (its fade-in is deleted). Each is null when
 * the layers have no such animation to change. Animation ids are the document's.
 */
export function closeGap(gap, fps = 30) {
  const frame = 1.5 / fps;
  // The scene's last stretch: the last picture stays to the end (its Hide moves there), or the scene
  // ends where the picture does. Its first: the first picture's Show moves to the first frame.
  if (gap.edge === "end") {
    const hide = ownAnimations(gap.before.layer).find((animation) => animation.kind === "hide" && Math.abs(animation.start - gap.start) <= frame);
    return { extend: hide ? { layer: gap.before.layer, animation: hide.id, start: gap.end } : null, full: null, shorten: hide ? hide.start : gap.start };
  }
  if (gap.edge === "start") {
    const show = ownAnimations(gap.after.layer).filter((animation) => animation.kind === "show" && animation.start > 0 && animation.start <= gap.end + frame).at(-1);
    return { extend: null, full: null, earlier: show ? { layer: gap.after.layer, animation: show.id, start: 0 } : null };
  }
  const hide = ownAnimations(gap.before.layer).find((animation) => animation.kind === "hide" && Math.abs(animation.start - gap.start) <= frame);
  const own = ownAnimations(gap.after.layer);
  const found = own.find((animation) => animation.from?.opacity !== undefined && animation.from.opacity < 1 && animation.to?.opacity === 1
    && Math.abs((animation.start ?? 0) - gap.start) <= LOOK_AHEAD);
  // Without its fade the shot after must still be hidden on the shot before's last frame (its own
  // Show keeps it off), else deleting the fade would draw it over that shot.
  const fade = found && !visibleByOperations(own.filter((animation) => animation !== found), gap.before.time) ? found : null;
  return {
    extend: hide ? { layer: gap.before.layer, animation: hide.id, start: gap.whole } : null,
    full: fade ? { layer: gap.after.layer, animation: fade.id } : null,
  };
}

/**
 * The picture and fill layers drawn whole (opaque, wide) at `time` in the scene: what covers the
 * frame there. Used to find the layers that end where the scene ends (sceneLength.js).
 */
export function fullFrameLayers(scene, time) {
  const entries = withPlain(candidates(scene));
  if (!entries.length || !(scene.width > 0) || !(scene.height > 0)) return [];
  return frameAt(entries, time, gridOf(scene)).shown.filter(({ opacity, share }) => opacity >= WHOLE && share >= WIDE).map(({ layer }) => layer);
}

// A strip under this many px is rounding, not a gap.
const STRIP_PX = 2;
// A picture that covers this share of the frame is read as meant to fill it; a smaller one is an
// inset or a card made on the background. A starting guess, not a measured value.
const FILLS = 0.8;
const SAMPLES = 5;

/** The longest stretch {start, end} (s) in which the Hide and Show operations leave `layer` shown. */
function shownSpan(layer, duration) {
  if (layer.visible === false) return null;
  let best = null;
  let from = 0;
  for (const range of [...hiddenRanges(layer.animations ?? [], duration), { start: duration, end: duration }]) {
    if (range.start > from + 1e-6 && (!best || range.start - from > best.end - best.start)) best = { start: from, end: range.start };
    from = Math.max(from, range.end);
  }
  return best;
}

/**
 * The full-frame pictures (video, image) that leave a strip of the frame uncovered for their whole
 * shot: [{layer, start, end, strips: {left, right, top, bottom} in px, scale, shift}]. A picture
 * counts when it covers FILLS of the frame at every sample of its longest shown stretch, is not
 * turned, and nothing else (another picture or a plate) covers the strip. A strip on two opposite
 * sides is an inset frame, not a slip. strips holds the least seen over the shot; scale is
 * {factor, scaleX, scaleY} that covers the frame about the layer's pivot (null when no scale up
 * to 3 does), shift {x?, y?} the position that covers it by moving alone (null when it cannot).
 * `ids` limits the layers looked at.
 */
export function bareStrips(scene, { fps = 30, ids = null } = {}) {
  const found = candidates(scene);
  const wanted = found.filter(({ layer }) => (layer.type === "video" || layer.type === "image") && (!ids || ids.has(layer.id)));
  if (!wanted.length || !(scene.duration > 0) || !(scene.width > 0) || !(scene.height > 0)) return [];
  const entries = withPlain(found);
  const { width: W, height: H } = scene;
  const results = [];
  for (const entry of entries.filter((item) => wanted.some(({ layer }) => layer === item.layer))) {
    const span = shownSpan(entry.layer, scene.duration);
    if (!span || (span.end - span.start) * fps < 3) continue;
    const others = entries.filter((item) => item !== entry);
    const samples = [];
    let ok = true;
    for (let index = 0; index < SAMPLES && ok; index += 1) {
      const time = span.start + ((span.end - span.start - 1 / fps) * index) / (SAMPLES - 1);
      const world = worldOf(entry, time, new Map());
      if (!world || world.opacity < 0.5) { ok = false; break; }
      const [a, b, c, d, e, f] = world.matrix;
      const width = world.state.width ?? 0, height = world.state.height ?? 0;
      // A mirrored picture (scaleX or scaleY below 0) is measured too: its box runs the other way.
      if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || !(Math.abs(a) > 0) || !(Math.abs(d) > 0) || !(width > 0) || !(height > 0)) { ok = false; break; }
      const box = { x0: Math.min(e, e + a * width), x1: Math.max(e, e + a * width), y0: Math.min(f, f + d * height), y1: Math.max(f, f + d * height) };
      const share = (Math.min(W, box.x1) - Math.max(0, box.x0)) * (Math.min(H, box.y1) - Math.max(0, box.y0)) / (W * H);
      if (!(share >= FILLS)) { ok = false; break; }
      const raw = { left: Math.max(0, box.x0), right: Math.max(0, W - box.x1), top: Math.max(0, box.y0), bottom: Math.max(0, H - box.y1) };
      // A strip another picture or a plate covers is not bare.
      const probes = { left: [[raw.left / 2, H / 2]], right: [[W - raw.right / 2, H / 2]], top: [[W / 2, raw.top / 2]], bottom: [[W / 2, H - raw.bottom / 2]] };
      const strips = {};
      for (const side of Object.keys(raw)) {
        if (raw[side] < STRIP_PX) { strips[side] = 0; continue; }
        const left = drawn(others, time, probes[side]).reduce((product, item) => product * (item.covered.length ? 1 - item.opacity : 1), 1);
        strips[side] = 1 - left >= HALF ? 0 : raw[side];
      }
      samples.push({ strips, box, world, time });
    }
    if (!ok || !samples.length) continue;
    const least = Object.fromEntries(["left", "right", "top", "bottom"].map((side) => [side, Math.min(...samples.map((sample) => sample.strips[side]))]));
    const shown = Object.fromEntries(Object.entries(least).filter(([, px]) => px >= STRIP_PX).map(([side, px]) => [side, Math.round(px)]));
    if (!Object.keys(shown).length || (shown.left && shown.right) || (shown.top && shown.bottom)) continue;
    // The scale and the shift are worked out on the sample with the smallest strip.
    const best = samples.reduce((one, other) => (Math.max(...Object.values(other.strips)) < Math.max(...Object.values(one.strips)) ? other : one));
    const { box, world } = best;
    const pivot = point(world.matrix, ...pivotOf(world.state));
    const need = (lo, hi, size, at) => Math.max(1, lo > 0 ? (at > lo ? at / (at - lo) : Infinity) : 1, hi < size ? (hi > at ? (size - at) / (hi - at) : Infinity) : 1);
    const factor = Math.max(need(box.x0, box.x1, W, pivot.x), need(box.y0, box.y1, H, pivot.y));
    const layer = entry.layer;
    const shift = {};
    if (box.x1 - box.x0 >= W - 1e-6) { if (box.x0 > 0) shift.x = round(layer.x - box.x0, 1); else if (box.x1 < W) shift.x = round(layer.x + (W - box.x1), 1); }
    if (box.y1 - box.y0 >= H - 1e-6) { if (box.y0 > 0) shift.y = round(layer.y - box.y0, 1); else if (box.y1 < H) shift.y = round(layer.y + (H - box.y1), 1); }
    const movable = (box.x1 - box.x0 >= W - 1e-6 || (box.x0 <= 0 && box.x1 >= W)) && (box.y1 - box.y0 >= H - 1e-6 || (box.y0 <= 0 && box.y1 >= H));
    results.push({
      layer, start: round(span.start), end: round(span.end), strips: shown,
      scale: !entry.parents.length && Number.isFinite(factor) && factor <= 3 ? { factor: round(factor, 2), scaleX: round((layer.scaleX ?? 1) * factor, 3), scaleY: round((layer.scaleY ?? 1) * factor, 3) } : null,
      shift: !entry.parents.length && movable && Object.keys(shift).length ? shift : null,
    });
  }
  return results;
}
