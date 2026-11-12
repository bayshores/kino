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
import { inverse, layerMatrix, multiply, IDENTITY } from "../geometry.js";
import { isVisibilityOperation, visibleByOperations } from "../visibilityOps.js";

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
function cardIn(scene, first, end, fps) {
  const on = (layer, frame) => layer.visible !== false && visibleByOperations(layer.animations ?? [], frame / fps);
  return (scene.layers ?? []).some((layer) => !TYPES.has(layer.type) && !UNSEEN.has(layer.type) && layer.enabled !== false
    && !on(layer, first - 1) && on(layer, Math.round((first + end - 1) / 2)) && !on(layer, end));
}

/** Whether a layer has no animation but Show and Hide (its state is then its own, read cheaply). */
const plainLayer = (layer) => flattenAnimations(layer.animations ?? []).every(isVisibilityOperation);

/**
 * The layers as drawn at `time`: [{layer, opacity, share}] with opacity the product down the groups
 * and share the part (0 to 1) of the grid the layer's box covers. Layers not drawn are left out.
 */
function drawn(entries, time, grid) {
  const states = new Map();
  const stateOf = (layer, plain) => {
    if (!states.has(layer)) {
      let state = layer;
      if (plain) state = visibleByOperations(layer.animations, time) ? { ...layer, visible: true } : { ...layer, visible: false };
      else state = evaluateLayer(layer, time);
      states.set(layer, state);
    }
    return states.get(layer);
  };
  const result = [];
  for (const { layer, parents, plain } of entries) {
    const state = stateOf(layer, plain.get(layer));
    if (state.visible === false || layer.visible === false) continue;
    let opacity = Number.isFinite(state.opacity) ? state.opacity : 1;
    let matrix = IDENTITY;
    let hidden = false;
    for (const parent of [...parents].reverse()) {
      const parentState = stateOf(parent, plain.get(parent));
      if (parentState.visible === false || parent.visible === false) { hidden = true; break; }
      opacity *= Number.isFinite(parentState.opacity) ? parentState.opacity : 1;
      matrix = multiply(matrix, layerMatrix(parentState));
    }
    opacity = Math.min(1, Math.max(0, opacity));
    if (hidden || opacity <= 0) continue;
    const back = inverse(multiply(matrix, layerMatrix(state)));
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

/**
 * The stretches where the frame is bare between two covered stretches:
 * [{start, end, frames, cover, before: {layer, time}, after: {layer, time}, whole, background}].
 * start is the first bare frame's time, end the time of the first covered frame after it, cover the
 * lowest cover in the stretch (0 to 1), before and after the layer that covered most just outside it,
 * whole the time the shot after is fully opaque and wide (end when it already is). Times are scene seconds.
 */
export function bareGaps(scene, { fps = 30 } = {}) {
  const found = candidates(scene);
  if (found.length < 2 || !(scene.duration > 0) || !(fps > 0)) return [];
  const plain = new Map();
  for (const { layer, parents } of found) for (const item of [layer, ...parents]) if (!plain.has(item)) plain.set(item, plainLayer(item));
  const entries = found.map((entry) => ({ ...entry, plain }));
  const grid = [];
  for (let row = 0; row < ROWS; row += 1) for (let column = 0; column < COLUMNS; column += 1) grid.push([((column + 0.5) / COLUMNS) * scene.width, ((row + 0.5) / ROWS) * scene.height]);
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
    if (bare && !open && previous && !previous.bare) open = { first: k, cover: frame.cover, before: strongest(previous.frame) };
    else if (bare && open) open.cover = Math.min(open.cover, frame.cover);
    else if (!bare && open && cardIn(scene, open.first, k, fps)) open = null;
    else if (!bare && open) {
      let whole = k;
      while (whole < frames && whole - k < LOOK_AHEAD * fps && !isWhole(at(whole))) whole += 1;
      gaps.push({ start: round(open.first / fps), end: round(k / fps), frames: k - open.first, cover: round(open.cover),
        before: { layer: open.before, time: round((open.first - 1) / fps) }, after: { layer: strongest(frame), time: round(k / fps) },
        whole: round(Math.min(whole, frames) / fps), background: typeof scene.background === "string" && scene.backgroundEnabled !== false ? scene.background : null });
      open = null;
    }
    previous = { frame, bare };
  }
  return gaps;
}

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
