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

// ---------------------------------------------------------------- burned-in text of any clip
// backend/footage/burned-text.mjs reads the lettering on a clip's frames (Apple Vision, a Mac only)
// and keeps on its record burnedText {version, read, marks, subtitles}; burnedTextFacts sorts the
// lines it read. Marks found here sit beside the finder scan's footage.marks: the check's
// burned_text fact (rules/footage.js) reads both kinds.

/** A line whose middle sits this low (fraction of the picture's height) or lower is subtitle-low. */
export const SUBTITLE_LOW = 0.72;
/** ... and whose middle is within this distance across of the picture's middle. */
export const SUBTITLE_CENTER = 0.15;
/** A mark: the same words in one place on at least this share of the frames read (2 frames at least). */
export const MARK_FRAMES = 0.5;
/** Two boxes are one place when their middles are this close (fraction of the picture). */
const SAME_PLACE = 0.04;

const middleOf = ([x, y, w, h]) => [x + w / 2, y + h / 2];
const plainWords = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const round3 = (value) => Math.round(value * 1000) / 1000;
const union = (a, b) => {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};

/** True for a line low and near the middle across: where a burned-in subtitle sits. */
export function subtitleLow(box) {
  const [cx, cy] = middleOf(box);
  return cy >= SUBTITLE_LOW && Math.abs(cx - 0.5) <= SUBTITLE_CENTER;
}

/** "top-left", "top", "bottom-right", ... for a box of fractions (thirds). */
export function cornerName(box) {
  const [cx, cy] = middleOf(box);
  const third = (value) => (value < 1 / 3 ? 0 : value < 2 / 3 ? 1 : 2);
  return [["top", "", "bottom"][third(cy)], ["left", "", "right"][third(cx)]].filter(Boolean).join("-") || "middle";
}

/**
 * Sorts the lines read on a clip's frames. frames: [{t (file seconds), lines: [{box, s}] (box:
 * fractions from the top left)}]. A mark is the same words (case and marks ignored) in one place on
 * MARK_FRAMES of the frames read (2 at least), not subtitle-low: a site name or a logo's letters.
 * A subtitle is a subtitle-low line; neighbor frames with the same words join into one stretch, so
 * a subtitle that changes with the speech gives one stretch per line said. Answers {read (frames),
 * marks: [{where, box, words, frames}], subtitles: [{from, to, box, words}]} (from and to: the first
 * and last frame read showing it, file seconds; boxes rounded to 0.001).
 */
export function burnedTextFacts(frames = []) {
  const read = frames.filter((frame) => Array.isArray(frame?.lines));
  const places = [];
  const subtitles = [];
  for (const frame of read) {
    const low = frame.lines.filter((line) => Array.isArray(line?.box) && subtitleLow(line.box) && plainWords(line.s));
    for (const line of frame.lines) {
      if (!Array.isArray(line?.box) || line.box.length !== 4 || subtitleLow(line.box)) continue;
      const words = plainWords(line.s);
      if (!words) continue;
      const [cx, cy] = middleOf(line.box);
      const place = places.find((entry) => entry.words === words && Math.hypot(entry.at[0] - cx, entry.at[1] - cy) <= SAME_PLACE);
      if (place) { place.box = union(place.box, line.box); if (place.last !== frame.t) { place.frames += 1; place.last = frame.t; } }
      else places.push({ words, said: String(line.s).trim().slice(0, 60), at: [cx, cy], box: [...line.box], frames: 1, last: frame.t });
    }
    if (!low.length) continue;
    const words = low.map((line) => String(line.s).trim()).join(" ").slice(0, 120);
    const box = low.map((line) => line.box).reduce(union);
    const open = subtitles.at(-1);
    if (open && open.key === plainWords(words) && open.next === frame.t) { open.to = frame.t; open.box = union(open.box, box); }
    else subtitles.push({ key: plainWords(words), from: frame.t, to: frame.t, box, words });
    subtitles.at(-1).next = read[read.indexOf(frame) + 1]?.t;
  }
  const need = Math.max(2, MARK_FRAMES * read.length);
  const marks = places.filter((place) => place.frames >= need).sort((a, b) => b.frames - a.frames)
    .map((place) => ({ where: cornerName(place.box), box: place.box.map(round3), words: place.said, frames: place.frames }));
  return { read: read.length, marks, subtitles: subtitles.map(({ from, to, box, words }) => ({ from: round3(from), to: round3(to), box: box.map(round3), words })) };
}

/**
 * What a crop (cropPast's answer, scene pixels) costs a subject box ([x, y, w, h] fractions of the
 * file): the share of the subject's area that falls outside the frame, 0 to 1 (rounded to 0.01).
 */
export function subjectLost(fit, frame, subject) {
  if (!fit || !Array.isArray(subject) || subject.length !== 4 || !(subject[2] > 0 && subject[3] > 0)) return null;
  const left = Math.max(subject[0], -fit.x / fit.width), top = Math.max(subject[1], -fit.y / fit.height);
  const right = Math.min(subject[0] + subject[2], (frame.width - fit.x) / fit.width), bottom = Math.min(subject[1] + subject[3], (frame.height - fit.y) / fit.height);
  const kept = Math.max(0, right - left) * Math.max(0, bottom - top);
  return Math.round((1 - kept / (subject[2] * subject[3])) * 100) / 100;
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
