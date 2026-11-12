// Burned-in marks: a channel logo, a site name or a copyright line drawn into a found clip's own
// pixels, in a corner or along an edge, for most of the clip. The footage finder's scan finds them
// (backend/footage-finder/score.mjs scanMarks) and the import keeps them on the clip's record as
// footage.marks [{where, box: [x, y, w, h] as fractions of the file}]. Two things read them here,
// plain math with no file or screen access:
//   cropPast     the layer box (x, y, width, height) that draws the clip with every mark outside the
//                frame: one zoom, the window pushed against the marks' sides (import answer, check fix)
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

/**
 * The layer box that draws a clip with every mark outside the frame. marks: [{box}] (fractions of the
 * file); frame: {width, height} of the scene; file: {width, height} of the clip. Each mark is cut off
 * on its cheapest side (the side nearest it); the zoom is the least that keeps the visible window
 * clear of all of them and still covers the frame, and the window sits centered in what is left.
 * Answers {x, y, width, height (whole pixels, the layer's box), cut: {left, right, top, bottom} (% of
 * the file taken off each side), zoom (against the file covering the frame)}, or null when no marks
 * or a mark is too far from every edge to cut off (CUT_MOST).
 */
export function cropPast(marks = [], frame, file) {
  const boxes = marks.map((mark) => mark?.box).filter((box) => Array.isArray(box) && box.length === 4);
  if (!boxes.length || !(frame?.width > 0 && frame?.height > 0 && file?.width > 0 && file?.height > 0)) return null;
  const cuts = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const [x, y, w, h] of boxes) {
    const options = { left: x + w, right: 1 - x, top: y + h, bottom: 1 - y };
    const side = Object.keys(options).reduce((best, next) => (options[next] < options[best] ? next : best));
    if (options[side] > CUT_MOST) return null;
    cuts[side] = Math.max(cuts[side], options[side]);
  }
  const roomX = 1 - cuts.left - cuts.right;
  const roomY = 1 - cuts.top - cuts.bottom;
  const cover = Math.max(frame.width / file.width, frame.height / file.height);
  // Pixels the file is drawn at per file pixel: the window (frame over drawn size) must fit the room.
  const scale = Math.max(cover, frame.width / (file.width * roomX), frame.height / (file.height * roomY));
  const width = file.width * scale;
  const height = file.height * scale;
  const windowX = frame.width / width;
  const windowY = frame.height / height;
  const left = cuts.left + (roomX - windowX) / 2;
  const top = cuts.top + (roomY - windowY) / 2;
  return {
    x: Math.round(-left * width), y: Math.round(-top * height), width: Math.round(width), height: Math.round(height),
    cut: { left: percent(left), right: percent(1 - left - windowX), top: percent(top), bottom: percent(1 - top - windowY) },
    zoom: Math.round((scale / cover) * 100) / 100,
  };
}
