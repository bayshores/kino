// Staggering: giving several selected animations, or several selected layers' animations, start
// times a fixed delay apart, so they play one after another like a cascade.
//
// Select animations, choose Stagger and set the Delay in seconds: the starts of the selected
// animations are set a uniform delay apart. kino's choices for the order, where the first one
// starts and what happens when the cascade doesn't fit in the scene are below and in
// COMPATIBILITY.md.
//
// Words used here:
// - An "item" is one thing that takes one place in the cascade. It is either one animation, or
//   one layer with all of its animations (and the animations of the layers inside it, for a
//   group). A layer's animations move together as a block: they keep their own timing relative
//   to each other.
//   An item is { key, label, position, parts }: `parts` are its animations as
//   { layerId, animationId, start, duration, length } (duration null for a Hide or Show, which
//   is a point in time), and `position` is where it first shows in the Timeline (its first
//   row). `length` is how long the animation plays: its duration, plus for a text animation by
//   letter, word or line the per-unit stagger before its last unit starts (0 for a Hide or
//   Show). That per-unit stagger is the animation's own `stagger` property, a different thing
//   from this command. A Change text (textChange.js) has the seconds of its effects as its
//   duration and plays until its last effect ends.
// - The "order" says which item goes first:
//   - "timeline": the Timeline's rows, top row first (the scene's layer order, with each
//     layer's animations in its own order);
//   - "reverse": the Timeline's rows, bottom row first;
//   - "selection": the order the items were selected in (the order of the list given);
//   - "center": the items in the middle of the Timeline order go first, then the ones next to
//     them on both sides, and so on outward; items equally far from the middle start together
//     (so two items from the center always start together, whatever the delay);
//   - "random": a shuffle of the Timeline order. The same `seed` always gives the same shuffle,
//     so an undo and redo, or the same MCP call, gives the same result.
//
// The rules:
// - The first item starts where the earliest of all the items starts now. Each next place in
//   the order starts `delay` seconds after the one before ("center" gives items equally far
//   from the middle the same place).
// - Each animation keeps its duration. A block moves as a whole, so its first animation starts
//   at the block's place.
// - Nothing may end after the scene's end (which is never after MAX_TIME), counting a text
//   animation's last letter, word or line. When the delay is too long for that, the stagger is
//   refused with a message that names the longest delay that fits, instead of shrinking the
//   delay or squashing an animation without saying so.
// - Times are rounded to the millisecond, the timeline's precision.
//
// staggerPlan returns changes as [{ layerId, animationId, patch: { start } }], the list App.jsx
// changeAnimations saves in one commit (one undo step), and operations.js stagger_animations
// applies. Plain functions, no React or DOM, so they can be tested.
import { MAX_TIME } from "./model.js";
import { animationOrder } from "./animationSelection.js";
import { animationPlaybackLength } from "./playback.js";
import { secondsLeft } from "./timeLimits.js";
import { isVisibilityOperation } from "./visibilityOps.js";
import { isTextChange, textChangeEffectSeconds, textChangeLength, unitsWithoutFonts } from "./textChange.js";
import { totalUnitDelay } from "./textTiming.js";
import { animationTreeEntries, isComposedAnimation } from "./animationTree.js";

const STAGGER_ORDERS = Object.freeze(["timeline", "reverse", "selection", "center", "random"]);

/** The largest seed a random stagger takes (seeds are whole numbers from 0). */
const MAX_STAGGER_SEED = 4294967295;

// The shortest animation the document accepts (model.js refuses a duration of 0).
const SHORTEST_SECONDS = 0.001;
// Times closer than this are the same time (floating-point sums such as 0.1 + 0.2).
const TOLERANCE = 1e-9;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const roundMs = (value) => Math.round(value * 1000) / 1000;
const floorMs = (value) => Math.floor(value * 1000 + TOLERANCE) / 1000;

/** Seconds as people read them: at most three decimals, no trailing zeros ("0.35 s"). */
function formatStaggerSeconds(value) {
  return `${roundMs(value)} s`;
}

// How long an animation plays: playback.js counts a text animation's last letter, word or line
// with the fonts, the same way the preview, the exports and the scene's playback length do.
function playLength(layer, animation, duration, fonts) {
  if (duration === null) return 0;
  let length;
  try {
    length = animationPlaybackLength(layer, { ...animation, duration }, fonts);
  } catch {
    const units = layer.type === "text" && animation.unit && animation.unit !== "layer" ? unitsWithoutFonts(layer, animation.unit) : 1;
    length = duration + totalUnitDelay(animation, Math.max(1, units));
  }
  return Math.max(duration, finite(length, duration));
}

// One animation as a part of an item. `fonts` lays text out (stagger.js items take them from
// their callers; left out, the editor's fonts are used).
function partOf(layer, animation, fonts) {
  if (isComposedAnimation(animation)) {
    const length = animationPlaybackLength(layer, animation, fonts);
    return { layerId: layer.id, animationId: animation.id, start: animation.start, duration: length, length };
  }
  // A Change text keeps its timing in its effects; it plays until the last one ends.
  if (isTextChange(animation)) {
    return {
      layerId: layer.id,
      animationId: animation.id,
      start: Math.max(0, finite(animation.start)),
      duration: textChangeEffectSeconds(animation),
      length: textChangeLength(layer, animation, fonts),
    };
  }
  const duration = isVisibilityOperation(animation)
    ? null
    : Math.max(SHORTEST_SECONDS, finite(animation.duration, SHORTEST_SECONDS));
  return {
    layerId: layer.id,
    animationId: animation.id,
    start: Math.max(0, finite(animation.start)),
    duration,
    length: playLength(layer, animation, duration, fonts),
  };
}

// Where each animation shows in the Timeline: its row number, top row 0.
function rowNumbers(layers) {
  return new Map(animationOrder(layers).map((id, index) => [id, index]));
}

function itemPosition(parts, rows) {
  return Math.min(...parts.map((part) => rows.get(part.animationId) ?? Infinity));
}

// The layer and every layer inside it (for a group), in the scene's layer order.
function layerAndInside(layers, layerId) {
  const inside = new Set([layerId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const layer of layers)
      if (inside.has(layer.parentId) && !inside.has(layer.id)) {
        inside.add(layer.id);
        grew = true;
      }
  }
  return layers.filter((layer) => inside.has(layer.id));
}

/** The parts of one layer's block: its animations and those of the layers inside it. */
function layerBlockParts(layers = [], layerId, fonts) {
  return layerAndInside(layers, layerId).flatMap((layer) =>
    (Array.isArray(layer.animations) ? layer.animations : []).map((animation) => partOf(layer, animation, fonts)),
  );
}

// A small seeded random number generator (mulberry32): the same seed always gives the same
// numbers, from 0 (included) to 1 (excluded).
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Each item's place in the cascade: [{ item, slot }], first slot first. Slot 0 starts first,
 * slot 1 one delay later, and so on. Only "center" gives two items the same slot.
 */
function staggerSlots(items = [], order = "timeline", seed = 1) {
  const listed = items.map((item, index) => ({ item, index }));
  const byTimeline = [...listed].sort((a, b) => a.item.position - b.item.position || a.index - b.index);
  if (order === "selection") return listed.map(({ item }, slot) => ({ item, slot }));
  if (order === "reverse") return byTimeline.reverse().map(({ item }, slot) => ({ item, slot }));
  if (order === "center") {
    const middle = (byTimeline.length - 1) / 2;
    return byTimeline
      .map(({ item }, index) => ({ item, slot: Math.floor(Math.abs(index - middle)) }))
      .sort((a, b) => a.slot - b.slot);
  }
  if (order === "random") {
    const shuffled = [...byTimeline];
    const random = seededRandom(seed);
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    return shuffled.map(({ item }, slot) => ({ item, slot }));
  }
  return byTimeline.map(({ item }, slot) => ({ item, slot }));
}

// How long a part plays (parts made elsewhere may leave `length` out).
const partLength = (part) => part.length ?? part.duration ?? 0;

// Where a block starts and how long it plays, from its first start to its last end.
function blockSpan(parts) {
  const start = Math.min(...parts.map((part) => part.start));
  const end = Math.max(...parts.map((part) => part.start + partLength(part)));
  return { start, length: end - start };
}

/** A problem with the stagger's settings, as a sentence, or null when they can be used. */
function staggerSettingsProblem({ delay, order = "timeline", seed = 1 } = {}) {
  if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0 || delay > MAX_TIME)
    return `The stagger delay must be a number of seconds from 0 to ${MAX_TIME}.`;
  if (!STAGGER_ORDERS.includes(order)) return `The stagger order must be one of ${STAGGER_ORDERS.join(", ")}.`;
  // Only a random order uses the seed, so a seed kept from an earlier Random stagger can't
  // block another order.
  if (order === "random" && (!Number.isInteger(seed) || seed < 0 || seed > MAX_STAGGER_SEED))
    return `The stagger seed must be a whole number from 0 to ${MAX_STAGGER_SEED}.`;
  return null;
}

/**
 * The stagger of `items` with these settings, in a scene `sceneDuration` seconds long.
 * Returns { changes, problem, longestDelay, lastStart, places, itemCount }:
 * - changes: [{ layerId, animationId, patch: { start } }] for every animation whose start
 *   changes (empty when the items already stand this way, or when there is a problem);
 * - problem: null, or a sentence saying why nothing can change;
 * - longestDelay: the longest delay, rounded down to the millisecond, that keeps every item
 *   within the scene, or null when even a delay of 0 doesn't fit;
 * - lastStart: when the last slot starts (null when there is a problem);
 * - places: how many different start times the slots give (fewer than itemCount when items
 *   share a slot, as in "center"; null when there is a problem), and itemCount: how many
 *   items there are.
 */
export function staggerPlan(items = [], { delay, order = "timeline", seed = 1, sceneDuration } = {}) {
  const refused = (problem, longestDelay = null) => ({ changes: [], problem, longestDelay, lastStart: null, places: null, itemCount: items.length });
  const settingsProblem = staggerSettingsProblem({ delay, order, seed });
  if (settingsProblem) return refused(settingsProblem);
  if (items.length < 2) return refused("Select two or more animations, or two or more layers with animations, to stagger.");
  const sceneEnd = Math.min(MAX_TIME, Math.max(0, finite(sceneDuration, MAX_TIME)));
  const slots = staggerSlots(items, order, seed).map(({ item, slot }) => ({ item, slot, ...blockSpan(item.parts) }));
  const base = Math.min(...slots.map((entry) => entry.start));

  // The longest delay that keeps every item's end at the scene's end or earlier.
  let longestDelay = Infinity;
  for (const { slot, length } of slots) {
    const room = sceneEnd - base - length;
    if (room < -TOLERANCE) {
      longestDelay = null;
      break;
    }
    if (slot > 0) longestDelay = Math.min(longestDelay, floorMs(room / slot));
  }
  if (longestDelay !== null) longestDelay = Math.min(MAX_TIME, Math.max(0, longestDelay));

  const tooLate = slots.find(({ slot, length }) => base + slot * delay + length > sceneEnd + TOLERANCE);
  if (tooLate) {
    const end = base + tooLate.slot * delay + tooLate.length;
    const what = `“${tooLate.item.label}” would end at ${formatStaggerSeconds(end)}, after the scene ends at ${formatStaggerSeconds(sceneEnd)}`;
    if (longestDelay === null || tooLate.slot === 0)
      return refused(`${what}, even without a delay. Make the scene longer or the animations shorter.`, longestDelay);
    return refused(`With a ${formatStaggerSeconds(delay)} delay, ${what}. The longest delay that fits is ${formatStaggerSeconds(longestDelay)}.`, longestDelay);
  }

  const changes = [];
  for (const { item, slot, start: blockStart } of slots) {
    const shift = roundMs(base + slot * delay) - blockStart;
    for (const part of item.parts) {
      // Rounding to the millisecond never pushes an animation (or its last text unit) past the
      // scene's end, or its end past the document's time limit.
      const latest = Math.min(Math.max(0, sceneEnd - partLength(part)), secondsLeft(part.duration ?? 0));
      const start = Math.min(Math.max(0, roundMs(part.start + shift)), latest);
      if (Math.abs(start - part.start) > TOLERANCE)
        changes.push({ layerId: part.layerId, animationId: part.animationId, patch: { start } });
    }
  }
  const lastSlot = Math.max(...slots.map((entry) => entry.slot));
  return {
    changes,
    problem: null,
    longestDelay,
    lastStart: roundMs(base + lastSlot * delay),
    places: delay === 0 ? 1 : lastSlot + 1,
    itemCount: items.length,
  };
}

/**
 * The items of an apply_operations stagger_animations call. Each entry of `entries` is
 * - an animation ID, or { animationId } or { layerId, animationId } (which also checks the
 *   layer): one animation;
 * - { layerId } alone: that layer's block, with the animations of the layers inside it.
 * Throws an Error that says what is wrong: an empty or too long list, an entry of another
 * shape, an animation or layer that is not found, a layer without animations, or an animation
 * that two entries name (also through a group).
 */
export function operationStaggerItems(layers = [], entries, fonts) {
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 5000)
    throw new Error("stagger_animations needs items: an array of 2 to 5000 animation IDs, { layerId, animationId } pairs, or { layerId } layers.");
  const rows = rowNumbers(layers);
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const owners = new Map();
  for (const layer of layers)
    for (const { animation } of animationTreeEntries(layer.animations)) owners.set(animation.id, { layer, animation });
  const claimed = new Set();
  return entries.map((entry) => {
    const object = entry && typeof entry === "object" && !Array.isArray(entry);
    let item;
    if (typeof entry === "string" || (object && entry.animationId !== undefined)) {
      const id = object ? entry.animationId : entry;
      if (typeof id !== "string" || (object && entry.layerId !== undefined && typeof entry.layerId !== "string"))
        throw new Error("stagger_animations items must be animation IDs, { layerId, animationId } pairs, or { layerId } layers, as strings.");
      const found = owners.get(id);
      if (!found || (object && entry.layerId !== undefined && found.layer.id !== entry.layerId))
        throw new Error(object && entry.layerId !== undefined ? `Animation ${id} was not found on layer ${entry.layerId}.` : `Animation ${id} was not found.`);
      const parts = [partOf(found.layer, found.animation, fonts)];
      item = { key: id, label: `${found.layer.name} · ${found.animation.name}`, position: itemPosition(parts, rows), parts };
    } else if (object && typeof entry.layerId === "string") {
      const layer = byId.get(entry.layerId);
      if (!layer) throw new Error(`Layer ${entry.layerId} was not found.`);
      const parts = layerBlockParts(layers, layer.id, fonts);
      if (!parts.length) throw new Error(`Layer ${layer.id} has no animations to stagger (nor do the layers inside it).`);
      item = { key: `layer:${layer.id}`, label: layer.name, position: itemPosition(parts, rows), parts };
    } else {
      throw new Error("stagger_animations items must be animation IDs, { layerId, animationId } pairs, or { layerId } layers, as strings.");
    }
    for (const part of item.parts) {
      const owner = owners.get(part.animationId);
      const ids = owner ? animationTreeEntries([owner.animation]).map(({ animation }) => animation.id) : [part.animationId];
      for (const id of ids) {
        if (claimed.has(id)) throw new Error(`stagger_animations lists animation ${id} more than once (directly or through a layer or group).`);
        claimed.add(id);
      }
    }
    return item;
  });
}
