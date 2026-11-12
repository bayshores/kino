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
 * The layer box that draws a clip with every mark outside the frame. marks: [{box}] (fractions of the
 * file); frame: {width, height} of the scene; file: {width, height} of the clip. Each mark is cut off
 * on one side; every choice of sides is tried and the one needing the least zoom wins (then the least
 * cut), so a tall window on a wide clip slides past a corner mark instead of zooming. The window sits
 * as near the file's center as the cuts allow, so a centered framing moves as little as it can.
 * Answers {x, y, width, height (whole pixels, the layer's box), cut: {left, right, top, bottom} (% of
 * the file taken off each side), zoom (against the file covering the frame)}, or null when no marks
 * or a mark is too far from every edge to cut off (CUT_MOST).
 */
export function cropPast(marks = [], frame, file) {
  const boxes = marks.map((mark) => mark?.box).filter((box) => Array.isArray(box) && box.length === 4).slice(0, MARKS_TRIED);
  if (!boxes.length || !(frame?.width > 0 && frame?.height > 0 && file?.width > 0 && file?.height > 0)) return null;
  const cover = Math.max(frame.width / file.width, frame.height / file.height);
  const options = boxes.map(([x, y, w, h]) => ({ left: x + w, right: 1 - x, top: y + h, bottom: 1 - y }));
  // The window for one choice of cuts: the least scale whose window (frame over drawn size) fits the room.
  const place = (cuts) => {
    const scale = Math.max(cover, frame.width / (file.width * (1 - cuts.left - cuts.right)), frame.height / (file.height * (1 - cuts.top - cuts.bottom)));
    const windowX = frame.width / (file.width * scale);
    const windowY = frame.height / (file.height * scale);
    return { scale, windowX, windowY, cuts, total: cuts.left + cuts.right + cuts.top + cuts.bottom,
      left: clamp(0.5 - windowX / 2, cuts.left, 1 - cuts.right - windowX), top: clamp(0.5 - windowY / 2, cuts.top, 1 - cuts.bottom - windowY) };
  };
  let best = null;
  const choose = (index, cuts) => {
    if (index === boxes.length) {
      const fit = place(cuts);
      if (!best || fit.scale < best.scale - 1e-9 || (Math.abs(fit.scale - best.scale) <= 1e-9 && fit.total < best.total)) best = fit;
      return;
    }
    for (const side of SIDES) {
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
