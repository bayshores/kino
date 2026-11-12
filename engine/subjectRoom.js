// Type around a subject: place {layers, around} sets a word or line in the free room beside,
// above, below or split around a marked subject (a mark_subject box, or a cut_out copy's measured
// subjectBox), sized down to that room when it is too big, so every letter stays readable. A word
// set behind a cut-out reads wrong when the subject covers letters (dm2 study: a two-word payoff
// behind a head, two letters hidden, never shown whole). Boxes here are {x0, y0, x1, y1} in scene
// pixels; letters are measured glyph by glyph, not by the layer's box.
import { geometryOf, moveLayerByWorldDelta } from "./arrange.js";
import { point, worldMatrix } from "./geometry.js";
import { glyphDrawBounds, layoutText } from "./textLayout.js";

export const AROUND_SIDES = Object.freeze(["left", "right", "above", "below", "split"]);

const area = (box) => Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
const overlap = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const union = (boxes) => ({ x0: Math.min(...boxes.map((box) => box.x0)), y0: Math.min(...boxes.map((box) => box.y0)), x1: Math.max(...boxes.map((box) => box.x1)), y1: Math.max(...boxes.map((box) => box.y1)) });

/** Each drawn letter of a text layer as {x0, y0, x1, y1, at} in scene pixels (at: its character index). */
export function letterBoxes(layer, layers, scenes = [], fonts) {
  const geometry = geometryOf(layer, scenes, fonts);
  const layout = layoutText(geometry, fonts);
  const matrix = worldMatrix(geometry, layers);
  const boxes = [];
  for (const line of layout.lines) {
    for (const glyph of line.glyphs) {
      const bounds = glyphDrawBounds({ ...glyph, x: glyph.x + line.x, y: glyph.y + line.y });
      if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) continue;
      const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) => point(matrix, x, y));
      const xs = corners.map((corner) => corner.x), ys = corners.map((corner) => corner.y);
      boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), at: line.start + glyph.start });
    }
  }
  return boxes;
}

/** The share (0-1) of the letters' area inside the subject's box. */
export function coveredShare(letters, subject) {
  const total = letters.reduce((sum, box) => sum + area(box), 0);
  return total > 0 ? letters.reduce((sum, box) => sum + overlap(box, subject), 0) / total : 0;
}

/**
 * The room clear of the subject (a gap away) inside `bounds` (the safe area), on each side:
 * {left, right, above, below}, each {x0, y0, x1, y1} or null when there is none.
 */
export function subjectRoom(bounds, subject, gap) {
  const room = {
    left: { x0: bounds.x0, y0: bounds.y0, x1: Math.min(bounds.x1, subject.x0 - gap), y1: bounds.y1 },
    right: { x0: Math.max(bounds.x0, subject.x1 + gap), y0: bounds.y0, x1: bounds.x1, y1: bounds.y1 },
    above: { x0: bounds.x0, y0: bounds.y0, x1: bounds.x1, y1: Math.min(bounds.y1, subject.y0 - gap) },
    below: { x0: bounds.x0, y0: Math.max(bounds.y0, subject.y1 + gap), x1: bounds.x1, y1: bounds.y1 },
  };
  for (const side of Object.keys(room)) if (room[side].x1 - room[side].x0 < 1 || room[side].y1 - room[side].y0 < 1) room[side] = null;
  return room;
}

/** "left 620×980, right 620×980, above none, below none": the room as an answer reads it. */
export function roomLine(room) {
  return ["left", "right", "above", "below"].map((side) => `${side} ${room[side] ? `${Math.round(room[side].x1 - room[side].x0)}×${Math.round(room[side].y1 - room[side].y0)}` : "none"}`).join(", ");
}

const clamp = (value, low, high) => (high < low ? low : Math.min(high, Math.max(low, value)));
const sizeOf = (box) => ({ width: box.x1 - box.x0, height: box.y1 - box.y0 });

// Where the ink box goes on one side (the shortest move into that side's room: text already
// clear of the subject stays put, text over it stops a gap from it) and how much it must shrink
// to fit that room (1 when it fits).
function sideSpot(side, ink, room) {
  if (!room) return null;
  const { width, height } = sizeOf(ink);
  const space = sizeOf(room);
  const scale = Math.min(space.width / width, space.height / height);
  const fit = Math.min(1, scale);
  const w = width * fit, h = height * fit;
  const cx = (ink.x0 + ink.x1) / 2, cy = (ink.y0 + ink.y1) / 2;
  const x0 = clamp(cx - w / 2, room.x0, room.x1 - w), y0 = clamp(cy - h / 2, room.y0, room.y1 - h);
  return { side, scale, target: { x0, y0, x1: x0 + w, y1: y0 + h } };
}

/**
 * Picks where text goes around a subject. `ink` is the text's letter box, `gaps` the ways to split
 * it at a word gap ([{at, left, right}] with each part's letter box), `bounds` the safe area.
 * `side` forces one; without it the choice keeps the most size (whole text over a split unless
 * the split keeps 5% more), then the shortest move. Returns {side, scale, target} or, for a split,
 * {side:"split", scale, at, left, right} with each part's target box; scale under 1 is how much
 * the type shrinks to fit. room is the free room on each side.
 */
export function planAround({ ink, gaps = [], subject, bounds, gap, side }) {
  const room = subjectRoom(bounds, subject, gap);
  const whole = ["left", "right", "above", "below"].map((name) => sideSpot(name, ink, room[name])).filter(Boolean);
  const splits = room.left && room.right ? gaps.map((cut) => {
    const left = sideSpot("left", cut.left, room.left);
    const right = sideSpot("right", cut.right, room.right);
    const scale = Math.min(left.scale, right.scale);
    // One size for both parts: each part's box is shrunk by the smaller scale; one baseline.
    const fit = Math.min(1, scale);
    const height = Math.max(cut.left.y1 - cut.left.y0, cut.right.y1 - cut.right.y0) * fit;
    const y0 = clamp((ink.y0 + ink.y1) / 2 - height / 2, bounds.y0, bounds.y1 - height);
    const lw = (cut.left.x1 - cut.left.x0) * fit, rw = (cut.right.x1 - cut.right.x0) * fit;
    return { side: "split", at: cut.at, scale,
      left: { x0: subject.x0 - gap - lw, y0, x1: subject.x0 - gap, y1: y0 + height },
      right: { x0: subject.x1 + gap, y0, x1: subject.x1 + gap + rw, y1: y0 + height } };
  }) : [];
  const moved = (option) => {
    const box = option.target ?? union([option.left, option.right]);
    return Math.hypot((box.x0 + box.x1 - ink.x0 - ink.x1) / 2, (box.y0 + box.y1 - ink.y0 - ink.y1) / 2);
  };
  const keep = (option) => Math.min(1, option.scale);
  const rank = (options) => [...options].sort((a, b) => keep(b) - keep(a) || moved(a) - moved(b))[0] ?? null;
  let chosen;
  if (side === "split") chosen = rank(splits);
  else if (side) chosen = whole.find((option) => option.side === side) ?? null;
  else {
    const best = rank(whole), split = rank(splits);
    chosen = split && (!best || keep(split) > keep(best) + 0.05) ? split : best;
  }
  return { chosen, room };
}

/**
 * Moves (and, when the room is smaller, shrinks) text layers around a subject box, in place on
 * `scene.layers`. options: fonts, scenes, gap, bounds (the safe area, {x0, y0, x1, y1}), side,
 * least (the smallest font size kept), split(layer, at) (makes the second part of a split: a
 * copy of the layer right above it holding the text after `at`; it returns the new layer).
 * Returns {side, scale, before, after, room, sizes, splitId}: before and after are the letters'
 * share inside the subject box. Throws an Error with the room when the side asked has none.
 */
export function placeAroundSubject(scene, layers, subject, options) {
  const { fonts, scenes = [], gap, bounds, least = 1 } = options;
  const lettersOf = (list) => list.flatMap((layer) => letterBoxes(layer, scene.layers, scenes, fonts));
  const move = (layer, dx, dy) => {
    const moved = moveLayerByWorldDelta(layer, scene.layers, dx, dy);
    if (moved) Object.assign(layer, { x: moved.x, y: moved.y, animations: moved.animations });
  };
  const moveTo = (list, target) => {
    const ink = union(lettersOf(list));
    for (const layer of list) move(layer, target.x0 - ink.x0, target.y0 - ink.y0);
  };
  const letters = lettersOf(layers);
  if (!letters.length) throw new Error(`${layers.map((layer) => layer.id).join(", ")} draws no letters to place.`);
  const before = coveredShare(letters, subject);
  const ink = union(letters);
  // A split needs one layer of one line with a word gap.
  const only = layers.length === 1 && layers[0].type === "text" && !/\n/.test(layers[0].text ?? "") && !layers[0].textStyleRanges?.length ? layers[0] : null;
  const gaps = [];
  if (only && options.split) {
    for (const match of only.text.matchAll(/\s+/g)) {
      const at = match.index, end = at + match[0].length;
      const left = letters.filter((box) => box.at < at), right = letters.filter((box) => box.at >= end);
      if (left.length && right.length) gaps.push({ at, end, left: union(left), right: union(right) });
    }
  }
  if (options.side === "split" && !gaps.length) throw new Error(`side "split" needs one text layer with a word gap on one line; ${layers.map((layer) => layer.id).join(", ")} has none.`);
  const { chosen, room } = planAround({ ink, gaps, subject, bounds, gap, side: options.side });
  if (!chosen) throw new Error(`No room ${options.side ?? "around the subject"} inside the safe area (room ${roomLine(room)}).`);
  // Shrink to the room, never under `least` (then the type is placed at that size and the receipt
  // shows the share still inside the subject box).
  const sizes = layers.map((layer) => layer.fontSize);
  const smallest = Math.min(...layers.map((layer) => layer.fontSize ?? least));
  const scale = Math.max(Math.min(1, chosen.scale), Math.min(1, least / smallest));
  if (scale < 1) {
    const center = { x: (ink.x0 + ink.x1) / 2, y: (ink.y0 + ink.y1) / 2 };
    for (const layer of layers) {
      const own = union(letterBoxes(layer, scene.layers, scenes, fonts));
      const was = { x: (own.x0 + own.x1) / 2, y: (own.y0 + own.y1) / 2 };
      layer.fontSize = Math.max(1, Math.floor(layer.fontSize * scale));
      if (layer.textResize !== "width-height") layer.width = Math.ceil(layer.width * scale);
      if (!layer.textResize || layer.textResize === "fixed") layer.height = Math.ceil(layer.height * scale);
      const now = union(letterBoxes(layer, scene.layers, scenes, fonts));
      move(layer, center.x + (was.x - center.x) * scale - (now.x0 + now.x1) / 2, center.y + (was.y - center.y) * scale - (now.y0 + now.y1) / 2);
    }
  }
  let splitId = null, placed = layers;
  if (chosen.side === "split") {
    const cut = gaps.find((item) => item.at === chosen.at);
    const second = options.split(only, cut.end);
    only.text = only.text.slice(0, cut.at);
    second.text = second.text.slice(cut.end);
    splitId = second.id;
    // Each part hugs the subject on its side, on one baseline (the first part's top).
    const leftInk = union(lettersOf([only])), rightInk = union(lettersOf([second]));
    const dy = chosen.left.y0 - Math.min(leftInk.y0, rightInk.y0);
    move(only, subject.x0 - gap - leftInk.x1, dy);
    move(second, subject.x1 + gap - rightInk.x0, dy);
    placed = [only, second];
  } else {
    const now = union(lettersOf(layers));
    const spot = sideSpot(chosen.side, now, room[chosen.side]);
      // Pulled inside the bounds when the floor size still does not fit the room.
    const { width, height } = sizeOf(now);
    moveTo(layers, { x0: clamp(spot.target.x0, bounds.x0, bounds.x1 - width), y0: clamp(spot.target.y0, bounds.y0, bounds.y1 - height) });
  }
  const after = coveredShare(lettersOf(placed), subject);
  return { side: chosen.side, scale, before, after, room, sizes, splitId };
}
