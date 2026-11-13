// ⌘D and the Inspector's Duplicate buttons: copies of the selected layers.
//
// How it works, step by step (`duplicateSelection`):
// 1. Copy the layers with the same code as Option-drag and paste (layerClipboard.js
//    `duplicateLayers`). The copies go directly above the originals, in the same groups.
//    A selected group is copied with everything inside it. A mask and the layer it masks are
//    copied together, and the copied mask masks the copied layer, so the scene still draws.
//    When a copy can't work, it throws an Error that says why and nothing changes. For
//    example, a mask group's mask selected on its own: its copy would mask a layer that the
//    original doesn't mask.
// 2. Move each copied top layer DUPLICATE_OFFSET scene pixels right and down, so the copy
//    shows next to the original. arrange.js `moveLayerByWorldDelta` does the move, so a copy
//    inside a rotated or scaled group still moves right and down on the canvas, and its
//    animated x and y values move with it: the copy animates like the original, just offset.
// 3. Name every copied layer "<name> copy".
// The document passed in is never changed.
//
// `duplicateRepeated` (the agent's duplicate_layers with count) makes up to 50 real copies in a
// line, a grid or a ring, Cavalry-duplicator style, each a normal layer that every check, look
// and export sees exactly. Copy n is named "<name> n+1" (the original is 1), and its animations
// may start n * stagger seconds later.
//
// With `at` (seconds) copy n shows at the n-th time instead: every time of the copy (animations,
// footage play time, a component's clock, play windows) moves by at[n-1] minus the selection's
// first time, and copies sit in place unless an offset or layout is given. `vary` gives each
// place (the original and its copies, in time order) its own value of a layer field.
import { moveLayerByWorldDelta } from "./arrange.js";
import { flattenAnimations, mapAnimationTree } from "./animationTree.js";
import { duplicateLayers, rebaseValues } from "./layerClipboard.js";
import { hasMediaPlay } from "./playback.js";
import { selectionBox, transformTargets } from "./multiTransform.js";

/** How far (in scene pixels, right and down) each copy lands from its original. */
export const DUPLICATE_OFFSET = 24;
const NAME_SUFFIX = " copy";
const MAX_NAME_LENGTH = 256; // the longest layer name model.js accepts

const label = (layer) => `“${layer.name || layer.id}”`;

/** A copied layer's name: "<name> copy", shortened so it still fits in a layer name. */
export function copyName(name) {
  return `${String(name ?? "").slice(0, MAX_NAME_LENGTH - NAME_SUFFIX.length)}${NAME_SUFFIX}`;
}

/**
 * Duplicates the given layers of one scene (see the steps above). Returns { document, rootIds }:
 * the next document and the IDs of the copied top layers, which the editor selects. `ids` and
 * `names` (Maps from an original layer's ID) give chosen copies their ID and name, so the agent's
 * later operations in the same edit can name them (translate.mjs copyNames). Throws an
 * Error that says why when the layers can't be duplicated; the document is then unchanged.
 */
export function duplicateSelection(document, sceneId, layerIds, offset = DUPLICATE_OFFSET, { dy = offset, name = copyName, ids, names } = {}) {
  const dx = offset;
  const { document: copied, rootIds, idMap } = duplicateLayers(document, sceneId, layerIds, { ids });
  const originalOf = new Map([...idMap].map(([original, copy]) => [copy, original]));
  const scene = copied.scenes.find((item) => item.id === sceneId);
  const copyIds = new Set(idMap.values());
  const rootSet = new Set(rootIds);

  // Each copied top layer sits in an original group (or at the top level), which doesn't move,
  // so every move is measured against the scene's layers as the paste left them.
  const moves = new Map();
  for (const layer of scene.layers) {
    if (!rootSet.has(layer.id)) continue;
    let move;
    try {
      move = moveLayerByWorldDelta(layer, scene.layers, dx, dy);
    } catch {
      throw new Error(`Can't duplicate ${label(layer)}: its copy would be outside the supported position range.`);
    }
    if (move) moves.set(layer.id, move); // null: its group is scaled to zero, so it stays put
  }

  const layers = scene.layers.map((layer) => {
    if (!copyIds.has(layer.id)) return layer;
    const move = moves.get(layer.id);
    const placed = move ? { x: move.x, y: move.y, animations: move.animations } : {};
    return { ...layer, ...placed, name: names?.get(originalOf.get(layer.id)) ?? name(layer.name) };
  });
  return {
    document: { ...copied, scenes: copied.scenes.map((item) => (item.id === sceneId ? { ...item, layers } : item)) },
    rootIds, copyIds: [...copyIds], originalOf,
  };
}

export const MAX_COPIES = 50;
export const DUPLICATE_LAYOUTS = Object.freeze(["line", "grid", "radial"]);
const MAX_STAGGER = 10;
const round = (value) => Math.round(value * 1000) / 1000 + 0;

function spacingOf(spacing, fallback, label) {
  if (spacing === undefined) return fallback;
  const value = typeof spacing === "number" ? { x: spacing, y: label === "line" ? 0 : spacing } : spacing;
  if (!value || typeof value !== "object" || !Number.isFinite(value.x ?? 0) || !Number.isFinite(value.y ?? 0))
    throw new Error("spacing must be a number of pixels or {x, y}.");
  return { x: value.x ?? 0, y: value.y ?? 0 };
}

/**
 * How far copy n (1..count) moves from the originals, in scene pixels: [[dx, dy], ...].
 * Without a layout each copy steps `offset` right and down from the last. `box` is the
 * originals' box ({width, height}); it sets the default spacing and ring size.
 *   line    in a row, spacing {x, y} apart (default: the box width plus 24 to the right)
 *   grid    rows of `columns` (default about square), spacing apart (default: the box plus 24)
 *   radial  a ring of count + 1 places with the original at the top (12 o'clock), copies going
 *           clockwise; `radius` (default: wide enough that the copies do not touch)
 */
export function copyOffsets({ count, layout, offset = DUPLICATE_OFFSET, spacing, columns, radius }, box = { width: 0, height: 0 }) {
  const copies = Array.from({ length: count }, (_, index) => index + 1);
  const gap = DUPLICATE_OFFSET;
  if (layout === undefined) return copies.map((n) => [n * offset, n * offset]);
  if (layout === "line") {
    const step = spacingOf(spacing, { x: box.width + gap, y: 0 }, "line");
    return copies.map((n) => [round(n * step.x), round(n * step.y)]);
  }
  if (layout === "grid") {
    const step = spacingOf(spacing, { x: box.width + gap, y: box.height + gap }, "grid");
    const across = columns ?? Math.ceil(Math.sqrt(count + 1));
    if (!Number.isInteger(across) || across < 1 || across > MAX_COPIES + 1) throw new Error(`columns must be a whole number from 1 to ${MAX_COPIES + 1}.`);
    return copies.map((n) => [round((n % across) * step.x), round(Math.floor(n / across) * step.y)]);
  }
  if (layout === "radial") {
    const places = count + 1;
    const ring = radius ?? Math.max(50, Math.round((places * Math.max(box.width, box.height) * 1.5) / (2 * Math.PI)));
    if (!Number.isFinite(ring) || ring <= 0) throw new Error("radius must be a number of pixels above 0.");
    // The ring's center is `ring` below the original, so the original sits at angle -90 degrees.
    return copies.map((n) => {
      const angle = -Math.PI / 2 + (n * 2 * Math.PI) / places;
      return [round(ring * Math.cos(angle)), round(ring + ring * Math.sin(angle))];
    });
  }
  throw new Error(`layout must be one of ${DUPLICATE_LAYOUTS.join(", ")}.`);
}

/**
 * `count` copies of the given layers placed by copyOffsets, each copy's animations starting
 * n * stagger seconds after the original's. Returns { document, copyIds }. Throws an Error that
 * says why when the copies can't be made; the document passed in is never changed.
 */
// The layouts each placement field works with (undefined: copies without a layout).
const FIELD_LAYOUTS = { offset: [undefined], spacing: ["line", "grid"], columns: ["grid"], radius: ["radial"] };

export function duplicateRepeated(document, sceneId, layerIds, options = {}, { fonts } = {}) {
  const { layout, stagger = 0, at } = options;
  const count = options.count ?? (Array.isArray(at) ? at.length : 1);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COPIES) throw new Error(`count must be a whole number from 1 to ${MAX_COPIES}.`);
  if (options.withMoves !== undefined && (typeof options.withMoves !== "boolean" || at === undefined))
    throw new Error("withMoves is true or false and goes with at: it copies the animations that recorded moves put on the original (a flash) to the copies at their times.");
  const scene0 = document.scenes.find((item) => item.id === sceneId);
  const timed = at === undefined ? null : copyTimes(scene0, layerIds, at, count, options);
  if (timed && options.offset === undefined && layout === undefined) options = { ...options, offset: 0 }; // in place
  if (typeof stagger !== "number" || !Number.isFinite(stagger) || stagger < 0 || stagger > MAX_STAGGER)
    throw new Error(`stagger must be seconds from 0 to ${MAX_STAGGER} between copies.`);
  if (layout !== undefined && !DUPLICATE_LAYOUTS.includes(layout)) throw new Error(`layout must be one of ${DUPLICATE_LAYOUTS.join(", ")}.`);
  // Nothing is dropped unseen: a field the layout does not use is refused.
  for (const [field, layouts] of Object.entries(FIELD_LAYOUTS)) {
    if (options[field] === undefined || layouts.includes(layout)) continue;
    const uses = layouts.map((item) => (item === undefined ? "no layout" : `layout "${item}"`)).join(" or ");
    throw new Error(`${field} works only with ${uses}${layout ? `, not "${layout}"` : ""}.`);
  }
  const scene = document.scenes.find((item) => item.id === sceneId);
  let box = { width: 0, height: 0 };
  const needsBox = layout === "radial" ? options.radius === undefined : layout !== undefined && options.spacing === undefined;
  if (needsBox) {
    box = selectionBox(transformTargets(scene.layers, layerIds), scene.layers, { scenes: document.scenes, fonts });
    if (!box) throw new Error(`The layers have no measurable box: give ${layout === "radial" ? "radius" : "spacing"}.`);
  }
  const offsets = copyOffsets({ ...options, count }, box);
  // Numbered names only when count is given, so a plain duplicate stays "<name> copy". Copy n
  // takes the n-th number from 2 that no layer in the scene has yet, so names stay unique.
  const numbered = options.count !== undefined || at !== undefined;
  const taken = new Set(scene.layers.map((layer) => layer.name));
  const free = new Map();
  const numberedName = (n) => (name) => {
    const base = String(name ?? "").slice(0, 240);
    if (!free.has(base)) {
      const numbers = [];
      for (let k = 2; numbers.length < count; k += 1) if (!taken.has(`${base} ${k}`)) numbers.push(k);
      free.set(base, numbers);
    }
    return `${base} ${free.get(base)[n - 1]}`;
  };
  // Each copy lands right after its original, so the last copy is made first: the list then
  // reads "<name>, <name> 2, <name> 3".
  let next = document;
  const copies = [];
  const roots = [];
  let report = null;
  for (let n = count; n >= 1; n -= 1) {
    const [dx, dy] = offsets[n - 1];
    const chosen = options.copies?.[n - 1];
    const result = duplicateSelection(next, sceneId, layerIds, dx, { dy, name: numbered ? numberedName(n) : copyName, ids: chosen?.ids, names: chosen?.names });
    const delay = timed ? round(timed.at[n - 1] - timed.first) : round(n * stagger);
    if (timed || delay !== 0) {
      const sceneBefore = next.scenes.find((item) => item.id === sceneId);
      const originals = new Map(result.copyIds.map((copyId) => [copyId, sceneBefore.layers.find((layer) => layer.id === result.originalOf.get(copyId))?.animations]));
      const placed = delayLayers(result.document, sceneId, new Set(result.copyIds), delay, { timed: !!timed, withMoves: options.withMoves === true, originals });
      next = placed.document;
      // Every copy's sorting counts: a late copy may be cut at the scene's end while an early one is not.
      report = Object.fromEntries(Object.entries(placed.report).map(([key, names]) => [key, [...new Set([...(report?.[key] ?? []), ...names])]]));
    } else next = result.document;
    copies.unshift(result.copyIds);
    roots.unshift(result.rootIds);
  }
  if (options.vary !== undefined) {
    if (!timed) throw new Error("vary works with at: give the times of the copies.");
    next = varyPlaces(next, sceneId, [topSelected(scene0.layers, layerIds), ...roots], [timed.first, ...timed.at], options.vary);
  }
  return { document: next, copyIds: copies.flat(), rootIds: roots.flat(), ...(timed ? { first: timed.first, report } : {}) };
}

// ---- at: copies at chosen times ---------------------------------------------------------------
// The selected layers and everything inside them.
function subtreeOf(layers, layerIds) {
  const ids = new Set(layerIds);
  for (let grew = true; grew;) {
    grew = false;
    for (const layer of layers) if (ids.has(layer.parentId) && !ids.has(layer.id)) { ids.add(layer.id); grew = true; }
  }
  return layers.filter((layer) => ids.has(layer.id));
}

// The selected layers that no other selected layer holds (the roots the copies are made of).
function topSelected(layers, layerIds) {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const chosen = new Set(layerIds);
  const held = (layer) => { for (let up = byId.get(layer.parentId); up; up = byId.get(up.parentId)) if (chosen.has(up.id)) return true; return false; };
  return layerIds.filter((id) => byId.has(id) && !held(byId.get(id)));
}

// Effects (a grade or blur that runs the whole clip, often from 0) and Hides do not say when a
// layer shows: run 8's footage all carried effects at 0 s (measured in its store.json).
const shows = (animation) => Number.isFinite(animation?.start) && animation.kind !== "effect" && animation.kind !== "hide";

/**
 * The time the selection shows: the earliest Show of its layers (what "the original at" means),
 * else the earliest of its animation starts (not effects or Hides), a video's or audio's play time
 * (mediaStart) and a component instance's clock (componentStart). Null when it has none. A custom
 * animation at 0 (a volume line, a move over the whole clip) does not say when a layer shows, so
 * a layer with a Show is read by its Show.
 */
export function selectionStart(layers) {
  const shown = [];
  for (const layer of layers)
    for (const animation of flattenAnimations(layer.animations ?? []))
      if (animation?.kind === "show" && animation.keeps === undefined && Number.isFinite(animation.start)) shown.push(animation.start);
  if (shown.length) return Math.min(...shown);
  const times = [];
  for (const layer of layers) {
    for (const animation of flattenAnimations(layer.animations ?? [])) if (shows(animation)) times.push(animation.start);
    if (hasMediaPlay(layer)) times.push(Number.isFinite(layer.mediaStart) ? layer.mediaStart : 0);
    if (layer.type === "component" && Number.isFinite(layer.componentStart)) times.push(layer.componentStart);
  }
  return times.length ? Math.min(...times) : null;
}

function copyTimes(scene, layerIds, at, count, options) {
  if (!Array.isArray(at) || !at.length || at.length > MAX_COPIES || !at.every((time) => Number.isFinite(time) && time >= 0))
    throw new Error(`at must list 1 to ${MAX_COPIES} times in seconds (or cues), one per copy.`);
  // A copy placed after the end would never be seen.
  const past = at.find((time) => Number.isFinite(scene?.duration) && time >= scene.duration);
  if (past !== undefined) throw new Error(`at ${past} s is past the scene's end (${scene.duration} s): give a time inside the scene, or make the scene longer first.`);
  if (options.count !== undefined && options.count !== at.length) throw new Error(`at lists ${at.length} time${at.length === 1 ? "" : "s"}, count says ${options.count}: drop count or make them match.`);
  if (options.stagger !== undefined) throw new Error("at and stagger are two timings: give at (a time per copy) or stagger (seconds between copies), not both.");
  const layers = subtreeOf(scene.layers, layerIds);
  const moved = layers.find((layer) => layer.move);
  if (moved) throw new Error(`${label(moved)} was made by move ${moved.move.name}: a move rebuilds its own parts, so send {op:"move", name:"${moved.move.name}", at} again for each place.`);
  const first = selectionStart(layers);
  if (first === null) {
    const name = layers.find((layer) => layerIds.includes(layer.id)) ?? layers[0];
    throw new Error(`give ${label(name)} a Show, an animation or a play time first, so its copies have a time to move.`);
  }
  return { first, at: at.slice(0, count) };
}

// The document with every time of the named layers `delay` seconds later: animation starts, the
// play time of videos and audio, a component's clock and play windows (the four time fields
// speech.js rippleScene moves), so a footage or component copy plays at its own time.
// A Hide or Show pushed past the scene's end stops at the end: it draws the same, and the saved
// point stays inside the scene (add_animation refuses one past it).
// With `timed` (a copy at a chosen time) the animations are also sorted, and `report` says how:
// whole-scene animations stay whole (cut at the scene's end), the animations a recorded move put
// on the original stay on the original unless `withMoves`, and a moved animation that would start
// past the scene's end is dropped or, when it only runs past it, cut at the end.
const WHOLE_EDGE = 0.05;
const spansScene = (animation, end) => Number.isFinite(animation?.start) && Number.isFinite(animation?.duration)
  && animation.start <= WHOLE_EDGE && animation.start + animation.duration >= end - WHOLE_EDGE;
// The animations a recorded move (scene.moves) put on a layer carry the move's ID in front of
// theirs ("impact-accent.impact-flash-up"). Its Hide and Show points stay: they say when it shows.
const fromMove = (animation, moveIds) => typeof animation?.id === "string" && animation.kind !== "show" && animation.kind !== "hide"
  && moveIds.some((id) => animation.id.startsWith(`${id}.`));
const animationLabel = (animation) => animation.name || animation.effect || animation.kind;

// A copy's animations have fresh IDs, so `originals` (copy ID to the list of its original's
// animations, in the same order) says which ones a recorded move made.
export function delayLayers(document, sceneId, ids, delay, { timed = false, withMoves = false, originals = new Map() } = {}) {
  const scene = document.scenes.find((item) => item.id === sceneId);
  const end = scene?.duration ?? Infinity;
  const moveIds = (scene?.moves ?? []).map((entry) => entry.id).filter((id) => typeof id === "string");
  const report = { moved: new Set(), whole: new Set(), left: new Set(), cut: new Set() };
  const later = (animation) => {
    if (typeof animation?.start !== "number") return animation;
    const start = round(Math.max(0, animation.start + delay));
    const point = animation.kind === "hide" || animation.kind === "show";
    return { ...animation, start: point ? Math.min(start, end) : start };
  };
  // The animation for the copy, or null to leave it on the original only.
  const place = (animation, index, layer) => {
    if (!timed || typeof animation?.start !== "number") return later(animation);
    const label = animationLabel(animation);
    if (!withMoves && fromMove(originals.get(layer.id)?.[index] ?? animation, moveIds)) { report.left.add(label); return null; }
    if (spansScene(animation, end)) {
      report.whole.add(label);
      const duration = round(Math.min(animation.duration, end - animation.start));
      if (duration >= animation.duration) return animation;
      report.cut.add(`${label} to ${end} s`);
      return { ...animation, duration };
    }
    const moved = later(animation);
    const point = animation.kind === "hide" || animation.kind === "show";
    if (!point && moved.start >= end) { report.cut.add(`${label} dropped (it would start at ${moved.start} s, past the end)`); return null; }
    report.moved.add(label);
    if (point && animation.start + delay > end + 1e-6) report.cut.add(`${label} to ${end} s`);
    if (!point && Number.isFinite(moved.duration) && moved.start + moved.duration > end) {
      report.cut.add(`${label} to ${end} s`);
      return { ...moved, duration: round(Math.max(0.001, end - moved.start)) };
    }
    return moved;
  };
  const shifted = (layer) => {
    const next = { ...layer };
    if (Array.isArray(layer.animations)) next.animations = layer.animations.map((animation, index) => place(animation, index, layer)).filter(Boolean);
    if (hasMediaPlay(layer)) next.mediaStart = round(Math.max(0, (Number.isFinite(layer.mediaStart) ? layer.mediaStart : 0) + delay));
    if (layer.type === "component" && Number.isFinite(layer.componentStart)) next.componentStart = round(Math.max(0, layer.componentStart + delay));
    if (Array.isArray(layer.playbackWindows))
      next.playbackWindows = layer.playbackWindows.map((window) => ({ ...window, start: round(Math.max(0, window.start + delay)), end: round(Math.max(0, window.end + delay)) }));
    return next;
  };
  const next = { ...document, scenes: document.scenes.map((item) => item.id !== sceneId ? item : {
    ...item, layers: item.layers.map((layer) => (ids.has(layer.id) ? shifted(layer) : layer)),
  }) };
  return { document: next, report: Object.fromEntries(Object.entries(report).map(([key, set]) => [key, [...set]])) };
}

// ---- vary: one value per place ----------------------------------------------------------------
// Fields vary leaves alone: what makes a layer itself, its place in the tree and its timing.
const FIXED_FIELDS = new Set(["id", "type", "name", "parentId", "animations", "move", "recipe", "componentSceneId", "mediaStart", "componentStart", "playbackWindows"]);
const HEX = /^#[0-9a-f]{6}$/i;

function mixHex(a, b, t) {
  const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => Math.round(channel(a, at) + (channel(b, at) - channel(a, at)) * t).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The values of one vary key for `places` places in time order: two numbers step evenly
 * (rounded to 3 decimals), two #rrggbb colors step evenly in RGB, and a list of exactly `places`
 * values gives one per place.
 */
export function varyValues(key, values, places) {
  if (!Array.isArray(values)) throw new Error(`vary.${key} must be a list: [first, last] or one value per place (${places}).`);
  if (values.length === places) return values;
  if (values.length === 2) {
    const [a, b] = values;
    if (Number.isFinite(a) && Number.isFinite(b)) return Array.from({ length: places }, (_, i) => round(a + ((b - a) * i) / (places - 1)));
    if (HEX.test(a) && HEX.test(b)) return Array.from({ length: places }, (_, i) => mixHex(a, b, i / (places - 1)));
  }
  throw new Error(`vary.${key} needs 2 numbers or 2 #rrggbb colors (first to last), or ${places} values, one per place (the original and ${places - 1} cop${places === 2 ? "y" : "ies"}).`);
}

// Sets each place's value on its root layers. `rootsByPlace[0]` is the original; places run in
// time order, so the original takes the first value only when it shows first. A key that
// rebaseValues moves (scale, opacity, x, y, rotation, ...) takes the layer's animations along,
// so a grow ends at the copy's own scale.
function varyPlaces(document, sceneId, rootsByPlace, times, vary) {
  if (!vary || typeof vary !== "object" || Array.isArray(vary) || !Object.keys(vary).length) throw new Error("vary is {field: [first, last]} or {field: [one value per place]}.");
  const order = times.map((time, index) => ({ time, index })).sort((a, b) => a.time - b.time || a.index - b.index);
  const rank = new Map(order.map((place, position) => [place.index, position]));
  const lists = Object.entries(vary).map(([key, values]) => {
    if (FIXED_FIELDS.has(key)) throw new Error(`vary cannot change ${key}.`);
    return [key, varyValues(key, values, times.length)];
  });
  const valueFor = new Map();
  rootsByPlace.forEach((ids, place) => { for (const id of ids) valueFor.set(id, Object.fromEntries(lists.map(([key, list]) => [key, list[rank.get(place)]]))); });
  return { ...document, scenes: document.scenes.map((scene) => scene.id !== sceneId ? scene : {
    ...scene, layers: scene.layers.map((layer) => {
      const values = valueFor.get(layer.id);
      if (!values) return layer;
      const source = Object.fromEntries(Object.keys(values).map((key) => [key, layer[key]]));
      const rebase = (animation) => ({ ...animation, ...(animation.from ? { from: rebaseValues(animation.from, source, values) } : {}), ...(animation.to ? { to: rebaseValues(animation.to, source, values) } : {}) });
      return { ...layer, ...values, ...(Array.isArray(layer.animations) ? { animations: mapAnimationTree(layer.animations, rebase) } : {}) };
    }),
  }) };
}
