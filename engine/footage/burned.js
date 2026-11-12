// Burned-in marks: a channel logo, a site name or a copyright line drawn into a found clip's own
// pixels, in a corner or along an edge, for most of the clip. The footage finder's scan finds them
// (backend/footage-finder/score.mjs scanMarks) and the import keeps them on the clip's record as
// footage.marks [{where, box: [x, y, w, h] as fractions of the file}]. Two things read them here,
// plain math with no file or screen access:
//   cropPast     the layer box (x, y, width, height) that draws the clip with every mark outside the
//                frame: the least zoom over every choice of sides, the window kept near the center
//                (import answer, check fix)
//   markSpan     the words for where a mark sits ("2 to 18% across, 3 to 9% down")
// The check rule that names a layer still showing a mark is burned_in_mark (rules/footage.js).

/** A mark is "still shown" when at least this share of its box is inside the frame (a guess: half). */
export const MARK_SEEN = 0.5;
/** ... for at least this long (seconds): a mark crossing the frame in a move is not seen (a guess). */
export const MARK_SECONDS = 0.3;
/** cropPast gives up when a mark would need more than this share of the file cut off (a mark mid-frame). */
export const CUT_MOST = 0.45;

const percent = (value) => Math.round(value * 100) + 0; // + 0 turns -0 into 0

/** "2 to 18% across, 3 to 9% down" for a box of fractions [x, y, w, h]. */
export function markSpan(box) {
  const [x, y, w, h] = box;
  return `${percent(x)} to ${percent(x + w)}% across, ${percent(y)} to ${percent(y + h)}% down`;
}

/** cropPast tries every side for at most this many marks (4^n choices); a scan finds a few at most. */
const MARKS_TRIED = 6;
const SIDES = ["left", "right", "top", "bottom"];
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * How far (fraction of the file's width) a scan's mark box is widened on each side across before a
 * crop is aimed past it. The scan finds a mark from the text lines it reads, on a grid of 1/24
 * (backend/footage-finder/score.mjs), so a logo's icon beside its name is missed: measured on a
 * found clip of run 6, the mark box began at 4.2% across while the logo's icon began at 1.0%
 * (one grid cell, 1/24, covers it). Height is not padded: the same frame's logo ended at 9.7% down
 * inside a box to 12.5%.
 */
export const MARK_PAD = 1 / 24;

/** A mark box [x, y, w, h] (fractions) widened by MARK_PAD across, inside the file. */
export function paddedMark([x, y, w, h], pad = MARK_PAD) {
  const left = Math.max(0, x - pad), right = Math.min(1, x + w + pad);
  return [left, y, right - left, h];
}

/**
 * The most zoom (against the file covering the frame) kino gives to crop a mark out before it offers
 * the other ways instead (shift the crop away from the corner, or a soft cover): a guess, past it a
 * drawn clip loses detail and the shot's framing changes a lot. Changeable per call (zoomMost).
 */
export const MARK_ZOOM_MOST = 1.35;

/**
 * The layer box that draws a clip with every mark outside the frame. marks: [{box}] (fractions of the
 * file); frame: {width, height} of the scene; file: {width, height} of the clip. Each mark (widened by
 * MARK_PAD across) is cut off on one side; every choice of sides is tried and the one needing the
 * least zoom wins (then the least cut), so a tall window on a wide clip slides past a corner mark
 * instead of zooming. The window sits as near `center` ([x, y] fractions of the file, default its
 * middle) as the cuts allow, so a framing moves as little as it can; `scale` is the least scale
 * (default: covering the frame), so a crop already zoomed keeps its zoom. `sides` limits the sides
 * tried (["left", "right"] slides the window away without cutting the top).
 * Answers {x, y, width, height (whole pixels, the layer's box), cut: {left, right, top, bottom} (% of
 * the file taken off each side), zoom (against the file covering the frame)}, or null when no marks
 * or a mark is too far from every edge to cut off (CUT_MOST).
 */
export function cropPast(marks = [], frame, file, { center = [0.5, 0.5], scale: least = 0, sides = SIDES, pad = MARK_PAD } = {}) {
  const boxes = marks.map((mark) => mark?.box).filter((box) => Array.isArray(box) && box.length === 4).slice(0, MARKS_TRIED).map((box) => paddedMark(box, pad));
  if (!boxes.length || !(frame?.width > 0 && frame?.height > 0 && file?.width > 0 && file?.height > 0)) return null;
  const cover = Math.max(frame.width / file.width, frame.height / file.height);
  const floor = Math.max(cover, least || 0);
  const options = boxes.map(([x, y, w, h]) => ({ left: x + w, right: 1 - x, top: y + h, bottom: 1 - y }));
  // The window for one choice of cuts: the least scale whose window (frame over drawn size) fits the room.
  const place = (cuts) => {
    const scale = Math.max(floor, frame.width / (file.width * (1 - cuts.left - cuts.right)), frame.height / (file.height * (1 - cuts.top - cuts.bottom)));
    const windowX = frame.width / (file.width * scale);
    const windowY = frame.height / (file.height * scale);
    return { scale, windowX, windowY, cuts, total: cuts.left + cuts.right + cuts.top + cuts.bottom,
      left: clamp(center[0] - windowX / 2, cuts.left, 1 - cuts.right - windowX), top: clamp(center[1] - windowY / 2, cuts.top, 1 - cuts.bottom - windowY) };
  };
  let best = null;
  const choose = (index, cuts) => {
    if (index === boxes.length) {
      const fit = place(cuts);
      if (!best || fit.scale < best.scale - 1e-9 || (Math.abs(fit.scale - best.scale) <= 1e-9 && fit.total < best.total)) best = fit;
      return;
    }
    for (const side of sides) {
      if (options[index][side] > CUT_MOST) continue;
      choose(index + 1, { ...cuts, [side]: Math.max(cuts[side], options[index][side]) });
    }
  };
  choose(0, { left: 0, right: 0, top: 0, bottom: 0 });
  if (!best) return null;
  const { scale, windowX, windowY, left, top } = best;
  const width = file.width * scale;
  const height = file.height * scale;
  return {
    x: Math.round(-left * width), y: Math.round(-top * height), width: Math.round(width), height: Math.round(height),
    cut: { left: percent(left), right: percent(1 - left - windowX), top: percent(top), bottom: percent(1 - top - windowY) },
    zoom: Math.round((scale / cover) * 100) / 100,
  };
}

/**
 * The other one-call ways out of a mark a crop cannot take out (it would cut the subject or zoom past
 * MARK_ZOOM_MOST): never hide or drop the clip, repair it. `name` is the layer's name; `box` its
 * layer box now (scene pixels). Words with two ready calls: (1) the crop shifted across, away from
 * the mark's corner (cutting a side, never the top or bottom), and (2) a soft cover over the mark: a
 * rectangle the size of the mark on screen, blurred so its edges melt into the picture, its fill
 * the color beside the mark (look {mode:"source"} shows it).
 */
export function markWays(name, marks, frame, file, box) {
  const plain = JSON.stringify(String(name));
  const ways = [];
  const shifted = cropPast(marks, frame, file, { sides: ["left", "right"] });
  if (shifted) ways.push(`shift the crop away from the corner: edit {"ops":[{"op":"update_layer","layer":${plain},"properties":{"x":${shifted.x},"y":${shifted.y},"width":${shifted.width},"height":${shifted.height}}}]} (${shifted.zoom}x)`);
  const mark = marks.find((entry) => Array.isArray(entry?.box) && entry.box.length === 4);
  if (mark && box?.width > 0 && box?.height > 0) {
    const [x, y, w, h] = paddedMark(mark.box);
    const left = Math.max(0, Math.round(box.x + x * box.width)), top = Math.max(0, Math.round(box.y + y * box.height));
    const right = Math.min(frame.width, Math.round(box.x + (x + w) * box.width)), bottom = Math.min(frame.height, Math.round(box.y + (y + h) * box.height));
    if (right > left && bottom > top)
      ways.push(`a soft cover: edit {"ops":[{"op":"add_layer","layerType":"rectangle","name":${JSON.stringify(`${name} mark cover`)},"properties":{"x":${left},"y":${top},"width":${right - left},"height":${bottom - top},"fill":"<the color beside the mark>","blur":${Math.max(4, Math.round((bottom - top) / 4))}}}]} (set its time to ${name}'s)`);
  }
  return ways.length ? `Other ways: ${ways.join("; or ")}.` : "Other ways: a clean clip (library {topic:\"footage\"} lists them first).";
}
