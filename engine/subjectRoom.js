// Type around a subject: place {layers, around} sets a word or line in the free room beside,
// above, below or split around a marked subject (a mark_subject box, or a cut_out copy's measured
// subjectBox), sized down to that room when it is too big, so every letter stays readable. A word
// set behind a cut-out reads wrong when the subject covers letters (dm2 study: a two-word payoff
// behind a head, two letters hidden, never shown whole). Boxes here are {x0, y0, x1, y1} in scene
// pixels; letters are measured glyph by glyph, not by the layer's box.
import { evaluateLayer } from "./animation.js";
import { geometryOf, moveLayerByWorldDelta } from "./arrange.js";
import { moveLayerByWorldDelta as shiftAt, point, worldMatrix } from "./geometry.js";
import { glyphDrawBounds, layoutText } from "./textLayout.js";

export const AROUND_SIDES = Object.freeze(["left", "right", "above", "below", "split"]);

/**
 * A cut-out's subject box at scene second `t` from its subjectPath ([[t, x0, y0, x1, y1], ...] in
 * shares of its box, by time): straight between the two samples around t, held past the ends.
 * Null when there is no path.
 */
export function sharePathAt(path, t) {
  if (!Array.isArray(path) || !path.length) return null;
  if (t <= path[0][0]) return path[0].slice(1);
  const last = path.at(-1);
  if (t >= last[0]) return last.slice(1);
  const index = path.findIndex((entry) => entry[0] > t);
  const a = path[index - 1], b = path[index], share = (t - a[0]) / (b[0] - a[0]);
  return a.slice(1).map((value, at) => value + (b[at + 1] - value) * share);
}

const area = (box) => Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
const overlap = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const union = (boxes) => ({ x0: Math.min(...boxes.map((box) => box.x0)), y0: Math.min(...boxes.map((box) => box.y0)), x1: Math.max(...boxes.map((box) => box.x1)), y1: Math.max(...boxes.map((box) => box.y1)) });

/**
 * Each drawn letter of a text layer as {x0, y0, x1, y1, at} in scene pixels (at: its character
 * index). With `time`, the layer and its groups are measured where their animations have them
 * then (position keys included); without it, at rest.
 */
export function letterBoxes(layer, layers, scenes = [], fonts, time = null) {
  const timed = Number.isFinite(time);
  const geometry = geometryOf(timed ? evaluateLayer(layer, time) : layer, scenes, fonts);
  const layout = layoutText(geometry, fonts);
  const matrix = worldMatrix(geometry, layers, timed ? (item) => (item === geometry ? item : evaluateLayer(item, time)) : undefined);
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

const keep = (option) => Math.min(1, option.scale);

/**
 * The plan when the text follows a moving subject: a side (or a split) with room at every one of
 * `moments` ([{t, box}]), at the size the tightest moment allows. Returns {side, scale, follow:
 * true, at?} (at: the word gap of a split) or null when no side has room at every moment.
 */
export function planFollow({ ink, gaps = [], moments, bounds, gap, side }) {
  const rooms = moments.map((moment) => subjectRoom(bounds, moment.box, gap));
  const center = (box) => [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
  const options = [];
  for (const name of ["left", "right", "above", "below"]) {
    const spots = rooms.map((room) => sideSpot(name, ink, room[name]));
    if (spots.some((spot) => !spot)) continue;
    const [cx, cy] = center(ink);
    const moved = spots.reduce((sum, spot) => sum + Math.hypot(center(spot.target)[0] - cx, center(spot.target)[1] - cy), 0) / spots.length;
    options.push({ side: name, follow: true, scale: Math.min(...spots.map((spot) => spot.scale)), moved });
  }
  if (rooms.every((room) => room.left && room.right)) {
    for (const cut of gaps) {
      const scale = Math.min(...rooms.map((room) => Math.min(sideSpot("left", cut.left, room.left).scale, sideSpot("right", cut.right, room.right).scale)));
      options.push({ side: "split", follow: true, at: cut.at, scale, moved: 0 });
    }
  }
  const rank = (list) => list.sort((a, b) => keep(b) - keep(a) || a.moved - b.moved)[0] ?? null;
  if (side) return rank(options.filter((option) => option.side === side));
  // As planAround: the whole text over a split unless the split keeps 5% more size.
  const best = rank(options.filter((option) => option.side !== "split")), split = rank(options.filter((option) => option.side === "split"));
  return split && (!best || keep(split) > keep(best) + 0.05) ? split : best;
}

/**
 * Moves (and, when the room is smaller, shrinks) text layers around a subject box, in place on
 * `scene.layers`. options: fonts, scenes, gap, bounds (the safe area, {x0, y0, x1, y1}), side,
 * least (the smallest font size kept), split(layer, at) (makes the second part of a split: a
 * copy of the layer right above it holding the text after `at`; it returns the new layer),
 * time (the scene second the text is measured at: its place then, position keys included) and
 * moments ([{t, box}]: the subject's box at each sampled second the words are on screen; without
 * them `subject` stands for the whole hold) and follow. The text goes where the subject leaves
 * room for the whole hold (the boxes' union); with follow it follows the subject with position
 * keys instead (a "Follow" move between each two moments).
 * Returns {side, follow, keys, scale, before, after, room, sizes, splitId}: before and after are
 * the letters' share inside the subject box at the worst moment ({share, t}). Throws an Error
 * with the room when the side asked has none.
 */
export function placeAroundSubject(scene, layers, subject, options) {
  const { fonts, scenes = [], gap, bounds, least = 1 } = options;
  const time = Number.isFinite(options.time) ? options.time : null;
  const moments = options.moments?.length ? options.moments : [{ t: time, box: subject }];
  const lettersOf = (list, t = time) => list.flatMap((layer) => letterBoxes(layer, scene.layers, scenes, fonts, t));
  const worst = (list) => moments.reduce((most, moment) => {
    const share = coveredShare(lettersOf(list, moment.t), moment.box);
    return share > most.share ? { share, t: moment.t } : most;
  }, { share: 0, t: moments[0].t });
  const move = (layer, dx, dy) => {
    const moved = moveLayerByWorldDelta(layer, scene.layers, dx, dy);
    if (moved) Object.assign(layer, { x: moved.x, y: moved.y, animations: moved.animations });
  };
  const moveTo = (list, target) => {
    const ink = union(lettersOf(list));
    for (const layer of list) move(layer, target.x0 - ink.x0, target.y0 - ink.y0);
  };
  // Placed again: the keys of an earlier follow go, so the text is planned from its own place.
  for (const layer of layers) if (layer.animations?.some(isFollowKey)) layer.animations = layer.animations.filter((animation) => !isFollowKey(animation));
  const letters = lettersOf(layers);
  if (!letters.length) throw new Error(`${layers.map((layer) => layer.id).join(", ")} draws no letters to place.`);
  const before = worst(layers);
  const ink = union(letters);
  const hold = union(moments.map((moment) => moment.box));
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
  const { chosen: still, room } = planAround({ ink, gaps, subject: hold, bounds, gap, side: options.side });
  // Each side's room clear of the whole hold is as large as that side's room at the tightest
  // moment, so following never keeps more size; it keeps the text a gap from the subject at
  // every moment instead of clear of the whole sweep, so it is asked for (follow: true).
  const moving = options.follow && moments.length > 1 ? planFollow({ ink, gaps, moments, bounds, gap, side: options.side }) : null;
  const chosen = moving ?? still;
  if (!chosen) throw new Error(`No room ${options.side ?? "around the subject"} inside the safe area (room ${roomLine(room)}).`);
  // Shrink to the room, never under `least` (then the type is placed at that size and the receipt
  // shows the share still inside the subject box).
  const sizes = layers.map((layer) => layer.fontSize);
  const smallest = Math.min(...layers.map((layer) => layer.fontSize ?? least));
  const scale = Math.max(Math.min(1, chosen.scale), Math.min(1, least / smallest));
  if (scale < 1) {
    const center = { x: (ink.x0 + ink.x1) / 2, y: (ink.y0 + ink.y1) / 2 };
    for (const layer of layers) {
      const own = union(lettersOf([layer]));
      const was = { x: (own.x0 + own.x1) / 2, y: (own.y0 + own.y1) / 2 };
      layer.fontSize = Math.max(1, Math.floor(layer.fontSize * scale));
      if (layer.textResize !== "width-height") layer.width = Math.ceil(layer.width * scale);
      if (!layer.textResize || layer.textResize === "fixed") layer.height = Math.ceil(layer.height * scale);
      const now = union(lettersOf([layer]));
      move(layer, center.x + (was.x - center.x) * scale - (now.x0 + now.x1) / 2, center.y + (was.y - center.y) * scale - (now.y0 + now.y1) / 2);
    }
  }
  // Following: the text first moves to its spot at the first moment, then a "Follow" key a
  // moment keeps each later moment's spot (targetOf(moment, ink then) gives the move it needs).
  let keys = 0;
  const follow = (list, targetOf) => {
    const first = targetOf(moments[0], union(lettersOf(list, moments[0].t)));
    for (const layer of list) move(layer, first.dx, first.dy);
    const shifts = moments.map((moment) => targetOf(moment, union(lettersOf(list, moment.t))));
    for (const layer of list) {
      const spots = moments.map((moment, index) => ({ t: moment.t, ...shiftAt(layer, scene.layers, shifts[index].dx, shifts[index].dy, (item) => evaluateLayer(item, moment.t)) }));
      const steps = spots.slice(1).map((spot, index) => ({
        id: `${layer.id}.around-${index + 1}`, name: FOLLOW, kind: "custom", start: round(spots[index].t), duration: round(spot.t - spots[index].t), easing: "linear",
        unit: "layer", stagger: 0, order: "forward", from: { x: round(spots[index].x), y: round(spots[index].y) }, to: { x: round(spot.x), y: round(spot.y) },
      }));
      layer.animations = [...(layer.animations ?? []), ...steps];
      keys += steps.length;
    }
  };
  let splitId = null, placed = layers;
  if (chosen.side === "split") {
    const cut = gaps.find((item) => item.at === chosen.at);
    const second = options.split(only, cut.end);
    only.text = only.text.slice(0, cut.at);
    second.text = second.text.slice(cut.end);
    splitId = second.id;
    // Each part's box fits its own letters (a fixed width would keep the whole line's box).
    for (const part of [only, second]) {
      const natural = layoutText(geometryOf(part, scenes, fonts), fonts);
      if (part.textResize !== "width-height") part.width = Math.ceil(natural.naturalWidth) + 1;
      if (!part.textResize || part.textResize === "fixed") part.height = Math.ceil(natural.naturalHeight) + 1;
    }
    // Each part hugs the subject on its side, on one baseline (the first part's top).
    const leftInk = union(lettersOf([only])), rightInk = union(lettersOf([second]));
    const top = Math.min(leftInk.y0, rightInk.y0), height = Math.max(leftInk.y1, rightInk.y1) - top;
    const dy = (chosen.left ? chosen.left.y0 : clamp((ink.y0 + ink.y1) / 2 - height / 2, bounds.y0, bounds.y1 - height)) - top;
    if (chosen.follow) {
      for (const part of [only, second]) move(part, 0, dy);
      follow([only], (moment, now) => ({ dx: moment.box.x0 - gap - now.x1, dy: 0 }));
      follow([second], (moment, now) => ({ dx: moment.box.x1 + gap - now.x0, dy: 0 }));
    } else {
      move(only, hold.x0 - gap - leftInk.x1, dy);
      move(second, hold.x1 + gap - rightInk.x0, dy);
    }
    placed = [only, second];
  } else {
    // Pulled inside the bounds when the floor size still does not fit the room.
    const spotIn = (now, space) => {
      const spot = sideSpot(chosen.side, now, space);
      const { width, height } = sizeOf(now);
      return { x0: clamp(spot.target.x0, bounds.x0, bounds.x1 - width), y0: clamp(spot.target.y0, bounds.y0, bounds.y1 - height) };
    };
    if (chosen.follow) {
      follow(layers, (moment, now) => {
        const target = spotIn(now, subjectRoom(bounds, moment.box, gap)[chosen.side]);
        return { dx: target.x0 - now.x0, dy: target.y0 - now.y0 };
      });
    } else moveTo(layers, spotIn(union(lettersOf(layers)), room[chosen.side]));
  }
  const after = worst(placed);
  return { side: chosen.side, follow: Boolean(chosen.follow), keys, scale, before, after, room, sizes, splitId };
}

const FOLLOW = "Follow";
const round = (value) => Math.round(value * 1000) / 1000;
// A key place {around} wrote to follow a subject (its id ends ".around-<n>").
const isFollowKey = (animation) => animation?.name === FOLLOW && /\.around-\d+$/.test(animation.id ?? "");
