// The footage finder's scan, part 2: measure the 360p copy (scan.mjs) and rank its shots.
// 1. For each downloaded stretch: its shots (shot-detection.mjs findShots), what moves, where the
//    faces, text and the eye's place (saliency) are and how bright it is; each shot keeps its mean
//    light and one face box (else one saliency box) with its share of the frame (subjectOf)
//    (footage/analyze.mjs measureFootage, as compose
//    measures clips: 4 frames a second, -threads 2), what stays in place across cuts (a channel
//    logo, a burned-in watermark: measure/fingerprint.mjs persistentElements), and one still in
//    the middle of each shot.
// 2. The stills go through the injected image embedder (SigLIP, look-embed.mjs); `want` through
//    its text half, so each shot gets a match against the agent's visual words.
// 3. The pure half (scanMarks, shotFacts, mergeAlike, rankShots): small text that sits in one
//    place near an edge on 40% of the shots of the whole scan or more (a channel logo, a copyright
//    line, read however the OCR spells it) is a mark: said once, never counted as text. Subtitles
//    and captions are never marks. Neighbors 0.95 or more alike
//    join into one shot (a held picture the cut finder split), then shots rank on motion, faces
//    and clean frames. Dark shots, shots full of text, shots with burned-in subtitles (a line at
//    the bottom center) and shots under 0.4 s go last; a logo fixed within one stretch costs a
//    little. Drawn footage (the stills read closer to "an anime screenshot or a cartoon" than to
//    "a photo") is not ranked by faces: the face detector is made for photos. `match` is a
//    z-score among this scan's shots and counts only when the best clean shot (no dark, text,
//    subtitles or short flag) reaches matchBar: 2, or more in a long scan of photos, where noise alone
//    tops 2; otherwise the answer says there is no visual match, how close the best came, or that
//    the image model did not run.
// Times: yt-dlp cuts each stretch without re-encoding, so its file starts at the keyframe before
// the stretch. The probe's length minus the stretch's length is that lead-in, taken off each time.
// 4. Saves <data>/footage/scans/<id>.json and one sheet (<id>.jpg, the best 12 stills of this scan,
//    4 by 3), then removes the 360p copy. At most 300 files or 200 MB of scans: the oldest unused
//    go first; a scan the caller keeps (noted or imported) stays. A scan of the same video again
//    adds its shots to the saved ones (numberShots), and all of them are matched to the newest
//    `want` together (their saved vectors), so one ranking and one match z-score population;
//    marks, drawn, model and the sheet are the newest scan's.
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeVector, dot, encodeVector, normalize } from "../music-embed.mjs";
import { persistentElements } from "../measure/fingerprint.mjs";
import { heavyDecodeSlot } from "../process-slots.mjs";
import { removeTempFolder } from "../temp-folders.mjs";
import { WHOLE_MAX_SECONDS } from "./scan.mjs";

/**
 * 2: marks, subtitles and drawn footage. 3: each shot's figure (whole-body box) and how it moves
 * (still, subject, camera). 4: the subject mask's figure on drawn footage, and figure null when
 * read and not found. 5: figure by "body" or "mask", and a mask over MASK_NO_FIGURE of the
 * picture is no figure (maskCover). A saved scan of another version is scanned again.
 */
export const SCAN_VERSION = 5;
/** A shot whose picture moves slower than this (frame widths a second, flow) is still. */
export const STILL_SPEED = 0.02;
/** A moving shot is a camera move when the frame's median flow is at least this share of its mean. */
export const CAMERA_SHARE = 0.5;
/** A shot shorter than this is too short to cut to. */
export const SHORT_SECONDS = 0.4;
/** Neighbor shots at least this alike (SigLIP cosine) are one shot. */
export const SAME_SHOT = 0.95;
/** The best shot's match z-score must reach at least this for match to count and show (matchBar). */
export const MATCH_SHOWN = 2;
/** A shot this dark on average (0 to 1) is a dark shot. */
export const DARK_LUMA = 0.12;
/** A shot with text in this share of its frames (a title card, subtitles) is a text shot. */
export const TEXT_SHARE = 0.5;
/** A shot with a bottom-center line (burned-in subtitles) in this share of its frames is a subtitles shot. */
export const SUBTITLE_SHARE = 0.15;
/** Text in one place on this share of the shots that were read (3 at least) is a mark (OCR misses a logo on some). */
export const MARK_SHARE = 0.4;
/** Footage is drawn when this share of its stills reads closer to the first of DRAWN_PROMPTS. */
export const DRAWN_SHARE = 0.6;
export const DRAWN_PROMPTS = ["an anime screenshot or a cartoon", "a photo"];
/** Stills on the sheet, and its grid. */
export const SHEET_SHOTS = 12;
export const SHEET_COLUMNS = 4;
export const SHEET_ROWS = 3;
const STILL_WIDTH = 320;
/** The scans folder's caps. */
export const SCAN_FILES_MOST = 300;
export const SCAN_BYTES_MOST = 200 * 1024 * 1024;

const round1 = (value) => Math.round(value * 10) / 10;
const round3 = (value) => Math.round(value * 1000) / 1000;
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
// A speed (frame widths a second) or a frame difference (0 to 1) as 0 to 100: half way at about
// a slow pan (0.1 frame widths a second) or a 3% change from frame to frame.
const motionScore = (speed, scale) => Math.round(100 * (1 - Math.exp(-speed / scale)));

// ---- the pure half ------------------------------------------------------------------------

// The middle of a box [x, y, w, h], and whether it lies inside another box (with some slack).
const centerIn = (box, other) => {
  const cx = box[0] + box[2] / 2;
  const cy = box[1] + box[3] / 2;
  return cx >= other[0] - 0.03 && cx <= other[0] + other[2] + 0.03 && cy >= other[1] - 0.03 && cy <= other[1] + other[3] + 0.03;
};

// A burned-in subtitle: a line whose middle sits low and near the middle across.
const isSubtitle = (box) => box[1] + box[3] / 2 >= 0.72 && Math.abs(box[0] + box[2] / 2 - 0.5) <= 0.12;

/** Where a box sits, in thirds: "top-left", "top", "top-right", "left", "middle", ..., "bottom-right". */
export function placeName(box) {
  const third = (value) => (value < 1 / 3 ? 0 : value < 2 / 3 ? 1 : 2);
  const row = ["top", "", "bottom"][third(box[1] + box[3] / 2)];
  const col = ["left", "", "right"][third(box[0] + box[2] / 2)];
  return [row, col].filter(Boolean).join("-") || "middle";
}

// The grid scanMarks counts text on: cells of 1/24 of the frame.
const MARK_CELLS = 24;
/** A line counts toward a mark only when it is logo-sized: at most this wide and high. */
export const MARK_LINE_MOST = [0.25, 0.1];
/** A mark is at most this wide and high (its grid cells, so a little more than a line). */
export const MARK_MOST = [0.375, 0.25];
/** A mark lies within this distance of one frame edge (a corner or a strip along an edge). */
export const MARK_EDGE = 0.2;
// Where burned-in subtitles sit (x, y, w, h): no mark reaches into it.
const SUBTITLE_BAND = [0.25, 0.65, 0.5, 0.35];

// True when a mark's group box is logo-sized, near an edge and clear of the subtitle band.
// One grid cell of slack, as a group's box is rounded out to whole cells.
function markLike([x, y, w, h]) {
  const slack = 1 / MARK_CELLS;
  if (w > MARK_MOST[0] + 1e-9 || h > MARK_MOST[1] + 1e-9) return false;
  const nearEdge = x + w <= MARK_EDGE + slack || x >= 1 - MARK_EDGE - slack || y + h <= MARK_EDGE + slack || y >= 1 - MARK_EDGE - slack;
  const [bx, by, bw, bh] = SUBTITLE_BAND;
  const inBand = x < bx + bw && x + w > bx && y < by + bh && y + h > by;
  return nearEdge && !inBand;
}

/**
 * The marks of a whole scan: text that stays in one place across shots, however the OCR read it
 * (a logo over a moving picture comes out as "TOHO", "TOH" or "TO", its boxes a different size
 * each time). shotLines: one entry a shot, the boxes ([x, y, w, h], fractions) of every text line
 * read in it, or null when its text was not read. Only logo-sized lines (MARK_LINE_MOST) count: a
 * grid cell such a line touched in MARK_SHARE of the read shots (3 at least) is marked, and
 * touching marked cells make one mark. A mark is small, near an edge and clear of the subtitle
 * band at the bottom center, so captions and subtitles on most shots stay text. Answers
 * [{where, box, share}], share being the most shots any of its cells was seen in, as a part of
 * the read shots.
 */
export function scanMarks(shotLines = []) {
  const read = shotLines.filter((lines) => Array.isArray(lines));
  const seen = new Array(MARK_CELLS * MARK_CELLS).fill(0);
  const cellOf = (value) => Math.max(0, Math.min(MARK_CELLS - 1, Math.floor(value * MARK_CELLS)));
  for (const lines of read) {
    const touched = new Set();
    for (const box of lines) {
      if (box[2] > MARK_LINE_MOST[0] || box[3] > MARK_LINE_MOST[1]) continue;
      for (let row = cellOf(box[1]); row <= cellOf(box[1] + box[3]); row += 1)
        for (let col = cellOf(box[0]); col <= cellOf(box[0] + box[2]); col += 1) touched.add(row * MARK_CELLS + col);
    }
    for (const cell of touched) seen[cell] += 1;
  }
  const need = Math.max(3, MARK_SHARE * read.length);
  const on = seen.map((count) => count >= need);
  const marks = [];
  const done = new Set();
  for (let start = 0; start < on.length; start += 1) {
    if (!on[start] || done.has(start)) continue;
    const stack = [start];
    const group = [];
    done.add(start);
    while (stack.length) {
      const cell = stack.pop();
      group.push(cell);
      const row = Math.floor(cell / MARK_CELLS), col = cell % MARK_CELLS;
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          const [r, c] = [row + dr, col + dc];
          const next = r * MARK_CELLS + c;
          if (r >= 0 && r < MARK_CELLS && c >= 0 && c < MARK_CELLS && on[next] && !done.has(next)) { done.add(next); stack.push(next); }
        }
      }
    }
    const rows = group.map((cell) => Math.floor(cell / MARK_CELLS)), cols = group.map((cell) => cell % MARK_CELLS);
    const box = [Math.min(...cols) / MARK_CELLS, Math.min(...rows) / MARK_CELLS, (Math.max(...cols) - Math.min(...cols) + 1) / MARK_CELLS, (Math.max(...rows) - Math.min(...rows) + 1) / MARK_CELLS];
    if (!markLike(box)) continue;
    marks.push({ where: placeName(box), box: box.map(round3), share: round3(Math.max(...group.map((cell) => seen[cell])) / read.length) });
  }
  return marks.sort((a, b) => b.share - a.share);
}

/**
 * True when the stills (normalized vectors) are drawn: DRAWN_SHARE of them read closer to
 * drawnVector ("an anime screenshot or a cartoon") than to photoVector ("a photo").
 */
export function isDrawn(vectors = [], drawnVector, photoVector) {
  const known = vectors.filter(Boolean);
  if (!known.length || !drawnVector || !photoVector) return false;
  return known.filter((vector) => dot(drawnVector, vector) > dot(photoVector, vector)).length / known.length >= DRAWN_SHARE;
}

/**
 * How a shot moves, from the flow of its frames (after the first): "still" under STILL_SPEED,
 * "camera" when the frame's median flow (camera) is CAMERA_SHARE of the mean or more (a pan, a
 * push, a tracking shot), else "subject" (something moves over a still frame). null without flow.
 */
export function movingOf(frames) {
  const flowing = frames.filter((sample) => Number.isFinite(sample.motion));
  if (!flowing.length) return null;
  const speed = mean(flowing.map((sample) => sample.motion));
  if (speed < STILL_SPEED) return "still";
  const camera = mean(flowing.map((sample) => sample.camera).filter((value) => Number.isFinite(value)));
  if (camera === null) return null;
  return camera >= CAMERA_SHARE * speed ? "camera" : "subject";
}

/**
 * One shot's facts from measureFootage samples ({t, luma, change, motion, camera, faces, people,
 * text}), with start and end in the same (file) seconds: {motion 0 to 100, face 0 to 100 or null
 * when faces were not measured, luma 0 to 1, text (share of frames with text that is no fixed
 * element or mark), subs (share of frames with such a line at the bottom center), logo (share of
 * frames showing a fixed text element that is no mark), subject (face, else saliency box), figure
 * (the largest whole-body box, subjectOf), mask (the same from the subject mask's boxes; the scan
 * uses it on drawn footage only, drawnFigure), moving (movingOf)}. figure and mask are null when
 * read and not found, undefined when not read. persistent: persistentElements'
 * answer for this stretch; marks: scanMarks' answer for the whole scan.
 */
export function shotFacts(start, end, samples = [], persistent = [], marks = []) {
  let inside = samples.filter((sample) => sample.t >= start - 0.01 && sample.t < end);
  if (!inside.length && samples.length) {
    const middle = (start + end) / 2;
    inside = [samples.reduce((best, sample) => (Math.abs(sample.t - middle) < Math.abs(best.t - middle) ? sample : best))];
  }
  // The first frame's change measures the cut into the shot, not its motion.
  const moving = inside.length > 1 ? inside.slice(1) : inside;
  const speeds = moving.map((sample) => sample.motion).filter((value) => Number.isFinite(value));
  const changes = moving.map((sample) => sample.change).filter((value) => Number.isFinite(value));
  const motion = speeds.length ? motionScore(mean(speeds), 0.15) : changes.length ? motionScore(mean(changes), 0.04) : 0;
  const faceFrames = inside.filter((sample) => Array.isArray(sample.faces));
  const face = faceFrames.length ? Math.round((100 * faceFrames.filter((sample) => sample.faces.length > 0).length) / faceFrames.length) : null;
  const fixed = persistent.filter((element) => element.kind === "text").map((element) => element.box);
  const textFrames = inside.filter((sample) => Array.isArray(sample.text));
  const share = (test) => (textFrames.length ? round3(textFrames.filter(test).length / textFrames.length) : 0);
  // A subtitle-like line is never a mark, even when a mark's box takes its middle in.
  const isMark = (line) => !isSubtitle(line.box) && marks.some((mark) => centerIn(line.box, mark.box));
  const isFixed = (line) => !isMark(line) && fixed.some((box) => centerIn(line.box, box));
  const loose = (line) => !isMark(line) && !isFixed(line);
  return {
    motion,
    face,
    luma: round3(mean(inside.map((sample) => sample.luma).filter((value) => Number.isFinite(value))) ?? 0),
    text: share((sample) => sample.text.some(loose)),
    subs: share((sample) => sample.text.some((line) => loose(line) && isSubtitle(line.box))),
    logo: share((sample) => sample.text.some(isFixed)),
    subject: subjectOf(inside, "faces", "face") ?? subjectOf(inside, "saliency", "saliency"),
    salient: subjectOf(inside, "saliency", "saliency"),
    figure: figureOf(inside),
    mask: figureOf(inside, "foreground"),
    moving: movingOf(moving),
  };
}

/**
 * A figure is the shot's when Vision found a whole body on at least this share of the frames it
 * read. On drawn footage it finds one on 1 or 2 of 20 frames (measured on 4 stair clips), a
 * sighting the shot's framing should not rest on.
 */
export const FIGURE_SEEN = 0.25;

/**
 * The shot's figure (subjectOf over the `key` boxes: people, the body detector's; foreground, the
 * subject mask's) with seen (its share of the frames read), or null. undefined when no frame of
 * the shot read `key`.
 */
function figureOf(samples, key = "people") {
  const read = samples.filter((sample) => Array.isArray(sample[key]));
  if (!read.length) return undefined;
  const seen = read.filter((sample) => sample[key].length).length / read.length;
  const figure = seen >= FIGURE_SEEN ? subjectOf(read, key, "figure") : null;
  // The mask's median share of the picture's pixels (kino-measure's cover), where it was measured.
  const covers = key === "foreground" ? read.map((sample) => sample.cover).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const cover = covers.length ? { cover: round3(covers[Math.floor((covers.length - 1) / 2)]) } : {};
  return figure ? { ...figure, seen: round3(seen), ...cover } : null;
}

/**
 * A mask covering this share of the picture's pixels or more, with no body found, is read as no
 * figure. A starting guess from the 5 drawn stair clips (2026-11-12): 0.79 on the 0.5 s opening
 * frame with no figure (a round hatch, on 3 clips); 0.26 to 0.34 on figure close-ups, 0.49 to 0.67
 * on a very close face, 0.57 to 0.64 on legs on stairs. One example above the line, so it moves
 * when more drawn clips are measured.
 */
export const MASK_NO_FIGURE = 0.75;

/**
 * The figure a drawn shot gets: the body detector's (by "body") when it saw one, else the subject
 * mask's (by "mask"). Measured on the 5 drawn stair clips: bodies on 0 to 6 of 7 to 21 frames
 * read, the mask on 6 to 21 (every frame but a black one). The mask boxes whatever stands out, so
 * live footage keeps the body detector alone. A mask over MASK_NO_FIGURE of the picture is no
 * figure: null, with the shot's maskCover kept so the line says why. undefined when neither was
 * read on the shot.
 */
export function drawnFigure(shot) {
  if (shot.figure) return { ...shot.figure, by: "body" };
  if (shot.mask && !(shot.mask.cover >= MASK_NO_FIGURE)) return { ...shot.mask, by: "mask" };
  if (shot.mask) return null;
  return shot.figure === null || shot.mask === null ? null : undefined;
}

/**
 * The drawn step of a scan, on one shot (shotFacts' answer): faces do not rank (the face detector
 * is made for photos; measured on the 5 drawn stair clips it found a face on 0 of 79 frames), the
 * subject is where the eye goes, the figure is drawnFigure's, and maskCover (percent) is kept when
 * a mask too large to be a figure was read instead.
 */
export function drawnShot(shot) {
  shot.face = null;
  shot.subject = shot.salient ?? null;
  shot.figure = drawnFigure(shot);
  if (shot.figure === null && shot.mask?.cover >= MASK_NO_FIGURE) shot.maskCover = Math.round(shot.mask.cover * 100);
  return shot;
}

/**
 * Where a shot's subject is: in each frame that found one, its largest box ([x, y, w, h] of the
 * frame) under `key` (faces, or saliency: where the eye goes); of those, the median-sized one, a
 * box one frame really had. Answers {kind, box, share (the box's part of the frame)} or null.
 */
export function subjectOf(samples, key, kind) {
  const largest = samples.map((sample) => sample[key])
    .filter((boxes) => Array.isArray(boxes) && boxes.length)
    .map((boxes) => boxes.reduce((best, box) => (box[2] * box[3] > best[2] * best[3] ? box : best)))
    .sort((a, b) => a[2] * a[3] - b[2] * b[3]);
  if (!largest.length) return null;
  const box = largest[Math.floor((largest.length - 1) / 2)].map((value) => round3(Math.max(0, Math.min(1, value))));
  return { kind, box, share: round3(box[2] * box[3]) };
}

/**
 * Joins neighbor shots (one ends where the next starts) whose vectors (Float32Array) are SAME_SHOT
 * alike or more into one: the first's start, the last's end, facts averaged by length, the longer
 * one's still and vector. Shots are in time order. Answers {shots, repeats (how many were joined)}.
 */
export function mergeAlike(shots) {
  const out = [];
  let repeats = 0;
  for (const shot of shots) {
    const last = out.at(-1);
    if (last && Math.abs(last.end - shot.start) < 0.05 && last.vector && shot.vector && dot(last.vector, shot.vector) >= SAME_SHOT) {
      const a = last.end - last.start;
      const b = shot.end - shot.start;
      const blend = (key) => {
        const [x, y] = [last[key], shot[key]].map((value) => (Number.isFinite(value) ? value : null));
        return x === null || y === null ? x ?? y : round3((x * a + y * b) / (a + b));
      };
      const longer = b > a ? shot : last;
      out[out.length - 1] = {
        ...last, end: shot.end, still: longer.still, vector: longer.vector,
        subject: longer.subject ?? last.subject ?? shot.subject ?? null, salient: longer.salient ?? last.salient ?? shot.salient ?? null,
        // A figure found wins; else null when either was read (none found), else unread (undefined).
        figure: [longer.figure, last.figure, shot.figure].find(Boolean) ?? (last.figure === null || shot.figure === null ? null : undefined), moving: longer.moving ?? last.moving ?? shot.moving ?? null,
        maskCover: longer.maskCover ?? last.maskCover ?? shot.maskCover,
        motion: Math.round(blend("motion")), face: last.face === null && shot.face === null ? null : Math.round(blend("face")),
        luma: blend("luma"), text: blend("text"), subs: blend("subs"), logo: blend("logo"),
      };
      repeats += 1;
    } else out.push({ ...shot });
  }
  return { shots: out, repeats };
}

/** z-scores of numbers (0 when they are all the same). */
function zScores(values) {
  const middle = mean(values) ?? 0;
  const spread = Math.sqrt(mean(values.map((value) => (value - middle) ** 2)) ?? 0);
  return values.map((value) => (spread > 1e-9 ? (value - middle) / spread : 0));
}

/**
 * The z-score the best of `count` match z-scores must reach to count. Among N shots that match
 * nothing, the best z-score is about sqrt(2 ln N) (2.6 for 150 shots), so a long scan needs more
 * than MATCH_SHOWN. A few shots cannot reach 2 at all (the most is sqrt(N - 1)), so then 90% of
 * that most is enough. Drawn footage keeps MATCH_SHOWN: one show's frames share their style and
 * cast, so a character there recurs in many shots, and the more shots share a subject the lower
 * each one's z-score (about sqrt((1 - p) / p) for a share p: 1.7 at a quarter of the shots).
 */
export function matchBar(count, { drawn = false } = {}) {
  if (count < 3) return Infinity;
  return Math.min(drawn ? MATCH_SHOWN : Math.max(MATCH_SHOWN, Math.sqrt(2 * Math.log(count))), 0.9 * Math.sqrt(count - 1));
}

/**
 * The match step of a ranking, for shots of one population (every shot of a scan, or of every
 * scan of a video when a rescan joins them): shots with {vector (normalized, or null), flags,
 * base (the score without a match)}. Answers {matches (z-score of each shot's closeness to
 * `wantVector` among these shots, null without a vector or a want), scores (base plus 10 a
 * z-score, the boost only when matchShown), matchShown (the best clean shot, one without text,
 * subtitles or short (a logo or dark tag is clean), reaches matchBar), matchBest, matchBar}.
 */
export function matchShots(shots, { wantVector = null, drawn = false } = {}) {
  const closeness = wantVector ? shots.map((shot) => (shot.vector ? dot(wantVector, shot.vector) : null)) : [];
  const known = closeness.filter((value) => value !== null);
  const z = zScores(known);
  let next = 0;
  const matches = shots.map((_, index) => (wantVector && closeness[index] !== null ? round1(z[next++]) : null));
  // A title card that spells the searched name can match best, and a short shot sorts last and is
  // too short to import: only clean shots decide.
  // A dark shot decides too (cleanShot): the night scene a person asked for is often all dark shots,
  // and without them the match was never shown (.scratch/ceiling/trace-run6.md, 18 dark shots).
  const clean = matches.filter((value, index) => value !== null && cleanShot(shots[index]));
  const bar = matchBar(known.length, { drawn });
  const matchBest = clean.length ? Math.max(...clean) : null;
  const matchShown = matchBest !== null && matchBest >= bar;
  const scores = shots.map((shot, index) => round1(shot.base + (matchShown && matches[index] !== null ? 10 * matches[index] : 0)));
  return { matches, scores, matchShown, matchBest, matchBar: Number.isFinite(bar) ? round1(bar) : null };
}

/**
 * The shots best first, each with {flags, base, score, match}. flags: "text", "subtitles",
 * "short" (these go last), "logo" (a small cost), "dark" (a tag: kept in its place). base: the
 * score before any match. match and score: matchShots'. Answers {shots, matchShown, matchBest (that best z-score, or null),
 * matchBar, skipped: {dark, text, subtitles, short}}.
 */
export function rankShots(shots, { wantVector = null, drawn = false } = {}) {
  const skipped = { dark: 0, text: 0, subtitles: 0, short: 0 };
  const rows = shots.map((shot) => {
    const flags = [];
    if (shot.luma < DARK_LUMA) flags.push("dark");
    if (shot.text >= TEXT_SHARE) flags.push("text");
    else if (shot.subs >= SUBTITLE_SHARE) flags.push("subtitles");
    if (shot.end - shot.start < SHORT_SECONDS) flags.push("short");
    // A dark shot is tagged, not skipped (TAG_ONLY).
    for (const flag of flags) if (flag !== "dark") skipped[flag] += 1;
    if (shot.logo >= TEXT_SHARE) flags.push("logo");
    const base = round3(0.5 * shot.motion + 0.3 * (shot.face ?? 0) + 20 * (1 - shot.text) - (flags.includes("logo") ? 10 : 0));
    return { ...shot, flags, base };
  });
  const { matches, scores, matchShown, matchBest, matchBar: bar } = matchShots(rows, { wantVector, drawn });
  const ranked = rows.map((row, index) => ({ ...row, score: scores[index], match: matches[index] }));
  ranked.sort(compareShots);
  return { shots: ranked, matchShown, matchBest, matchBar: bar, skipped };
}

// ---- files ----------------------------------------------------------------------------------

const SCAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Flags that tag a shot without moving it after the clean ones: a logo is a small cost, and a dark
 * shot is kept in its place and said so (run 6's scan put 18 dark shots last, among them the night
 * climb the person asked for, .scratch/ceiling/trace-run6.md and b/result.md friction 12). Dark
 * footage can be lifted; it is never dropped for darkness alone.
 */
const TAG_ONLY = new Set(["logo", "dark"]);
/** True when a shot has no flag but a tag (logo, dark): a clean shot. */
export const cleanShot = (shot) => (shot.flags ?? []).every((flag) => TAG_ONLY.has(flag));
/** A shot of these flags goes after the clean ones. */
const isLast = (shot) => !cleanShot(shot);
/** Clean shots first, then best score, then earliest. */
const compareShots = (a, b) => Number(isLast(a)) - Number(isLast(b)) || b.score - a.score || a.start - b.start;

/** A new shot is a saved shot's when they overlap by at least this share of the shorter one. */
export const SAME_RANGE = 0.5;
/** Two shot ranges that share no more than this many seconds do not overlap. */
const TOUCH_SECONDS = 0.1;
const overlapOf = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

/**
 * Numbers a scan's shots (each {start, end}) against the shots a saved scan of the same video
 * already shows (known, each {n, start, end}). A shot that overlaps a known shot by SAME_RANGE of
 * the shorter one (the most overlap first, each known number once) is that shot: it keeps the
 * number, and its range is the two ranges joined (a shot a window edge cut is found whole by the
 * next window, and its code stays). When that joined range would overlap another shot, known or
 * new (a shot the new scan splits: the larger part, the first when equal, keeps the code), the shot keeps its own
 * range, so no two codes list the same footage. The others are new: they count on from the
 * largest known number, in time order (1, 2, 3 ... in a first scan), so no number is reused or
 * shifted. Answers [{n, start, end}] in the order of `shots`; each range holds its shot's range.
 */
export function numberShots(known = [], shots = []) {
  const pairs = [];
  shots.forEach((shot, index) => known.forEach((old, at) => {
    const overlap = overlapOf(shot, old);
    const shorter = Math.min(shot.end - shot.start, old.end - old.start);
    if (overlap > 0 && shorter > 0 && overlap / shorter >= SAME_RANGE) pairs.push({ index, at, overlap });
  }));
  pairs.sort((a, b) => b.overlap - a.overlap || a.index - b.index || a.at - b.at);
  const out = new Array(shots.length).fill(null);
  const used = new Set();
  for (const { index, at } of pairs) {
    if (out[index] || used.has(at)) continue;
    const old = known[at];
    const joined = { start: Math.min(shots[index].start, old.start), end: Math.max(shots[index].end, old.end) };
    const clear = (range) => shots.every((other, i) => i === index || overlapOf(range, other) <= TOUCH_SECONDS)
      && known.every((other, i) => i === at || overlapOf(range, other) <= TOUCH_SECONDS);
    const range = clear(joined) ? joined : { start: shots[index].start, end: shots[index].end };
    out[index] = { n: old.n, ...range };
    used.add(at);
  }
  let next = Math.max(0, ...known.map((old) => old.n)) + 1;
  shots.map((shot, index) => index).filter((index) => !out[index]).sort((a, b) => shots[a].start - shots[b].start)
    .forEach((index) => { out[index] = { n: next++, start: shots[index].start, end: shots[index].end }; });
  return out;
}

/** The folder saved scans live in. */
export const scansFolder = (dataRoot) => path.join(dataRoot, "footage", "scans");

function scanPath(dataRoot, id, extension) {
  if (!SCAN_ID.test(String(id ?? ""))) throw new Error(`"${id}" is not a scan id.`);
  return path.join(scansFolder(dataRoot), `${id}.${extension}`);
}

/** A saved scan, or null. Reading it marks it used, so the cap removes it last. */
export async function readScan(dataRoot, id) {
  const file = scanPath(dataRoot, id, "json");
  let scan;
  try { scan = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  const now = new Date();
  await utimes(file, now, now).catch(() => {});
  return scan;
}

/**
 * A saved scan ranked again for other `want` words, from the vectors it saved: no download, no new
 * scan (found-shared: a second project that wants other words of the same video reuses the scan).
 * Answers the new scan (also saved), or null when it cannot: no saved scan of this version, or
 * words to match but no image model then (embed) or no saved vectors.
 */
export async function rematchScan(dataRoot, id, want, { embed = null } = {}) {
  const saved = await readScan(dataRoot, id);
  if (!saved || saved.version !== SCAN_VERSION || !Array.isArray(saved.shots)) return null;
  const words = String(want ?? "").trim();
  let wantVector = null;
  if (words) {
    if (!embed || !saved.model || !saved.shots.some((shot) => shot.vector)) return null;
    const [vector] = (await embed.text([words])) ?? [];
    if (!vector) return null;
    wantVector = normalize(vector);
  }
  const rows = saved.shots.map((shot) => ({ ...shot, flags: shot.flags ?? [], base: shot.base ?? shot.score ?? 0, vector: shot.vector ? decodeVector(shot.vector) : null }));
  const answer = matchShots(rows, { wantVector, drawn: Boolean(saved.drawn) });
  const shots = saved.shots.map((shot, index) => ({ ...shot, flags: rows[index].flags, base: rows[index].base, match: answer.matches[index], score: answer.scores[index] })).sort(compareShots);
  const scan = { ...saved, want: words, matchShown: answer.matchShown, matchBest: answer.matchBest, matchBar: answer.matchBar, shots };
  const file = scanPath(dataRoot, id, "json");
  await writeFile(`${file}.part`, JSON.stringify(scan));
  await rename(`${file}.part`, file);
  return scan;
}

/** A saved scan's sheet (the jpg of its best stills, scan.sheet names their shots), or null. */
export async function readScanSheet(dataRoot, id) {
  try { return await readFile(scanPath(dataRoot, id, "jpg")); } catch { return null; }
}

/**
 * Keeps the scans folder within maxFiles and maxBytes: whole scans (the .json and its sheet) go,
 * the least recently used first; ids in `keep` (noted or imported) never go. Answers the ids removed.
 */
export async function pruneScans(dataRoot, { keep = [], maxFiles = SCAN_FILES_MOST, maxBytes = SCAN_BYTES_MOST } = {}) {
  const folder = scansFolder(dataRoot);
  let names;
  try { names = await readdir(folder); } catch { return []; }
  const scans = new Map();
  for (const name of names) {
    const id = name.replace(/\.(json|jpg)$/, "");
    if (id === name || !SCAN_ID.test(id)) continue;
    const facts = await stat(path.join(folder, name)).catch(() => null);
    if (!facts) continue;
    const scan = scans.get(id) ?? { id, files: [], bytes: 0, used: 0 };
    scan.files.push(name);
    scan.bytes += facts.size;
    if (name.endsWith(".json")) scan.used = facts.mtimeMs;
    scans.set(id, scan);
  }
  let files = [...scans.values()].reduce((sum, scan) => sum + scan.files.length, 0);
  let bytes = [...scans.values()].reduce((sum, scan) => sum + scan.bytes, 0);
  const kept = new Set(keep);
  const removed = [];
  for (const scan of [...scans.values()].sort((a, b) => a.used - b.used)) {
    if (files <= maxFiles && bytes <= maxBytes) break;
    if (kept.has(scan.id)) continue;
    await Promise.all(scan.files.map((name) => rm(path.join(folder, name), { force: true })));
    files -= scan.files.length;
    bytes -= scan.bytes;
    removed.push(scan.id);
  }
  return removed;
}

// ---- FFmpeg (the default tools; tests pass their own) ----------------------------------------

/** Most times one select expression holds. */
export const STILLS_PER_PASS = 200;

/**
 * The select expressions that pick one still at each time (the first frame at or after it), at most
 * `most` times each. ffmpeg's expression parser refuses a sum of 99 or more terms written as
 * a+b+c+..., (measured: 98 pass), because a flat sum nests one level deeper per term. Terms
 * joined as a balanced tree of parentheses nest only log2(n) levels (1000 terms passed), and a
 * pass takes at most `most` of them. Answers [{from (index of its first time), pick}].
 */
export function stillPicks(times, most = STILLS_PER_PASS) {
  const tree = (terms) => (terms.length === 1 ? terms[0] : `(${tree(terms.slice(0, terms.length >> 1))}+${tree(terms.slice(terms.length >> 1))})`);
  const passes = [];
  for (let from = 0; from < times.length; from += most) {
    const terms = times.slice(from, from + most).map((time) => `lt(prev_pts*TB\\,${round3(time)})*gte(t\\,${round3(time)})`);
    passes.push({ from, pick: tree(terms) });
  }
  return passes;
}

// One still per time: the first frame at or after each time, in as many passes as stillPicks gives
// (one ffmpeg at a time). The stills are numbered by their time's place in `times`.
export async function stillsAt(file, times, folder, { signal } = {}) {
  if (!times.length) return [];
  const { runMediaTool } = await import("../media-probe.mjs");
  await mkdir(folder, { recursive: true });
  for (const { from, pick } of stillPicks(times)) {
    await heavyDecodeSlot(() => runMediaTool("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-threads", "2", "-i", file, "-an", "-sn", "-dn",
      "-vf", `select='${pick}',scale=${STILL_WIDTH}:-2:flags=area`, "-fps_mode", "vfr", "-q:v", "4", "-start_number", String(from),
      path.join(folder, "%03d.jpg")], { signal }));
  }
  const names = new Set(await readdir(folder));
  return times.map((_, index) => {
    const name = `${String(index).padStart(3, "0")}.jpg`;
    return names.has(name) ? path.join(folder, name) : null;
  });
}

// The sheet: the stills in order, 4 by 3, each fitted into 320x180.
async function sheetOf(stills, out, { signal } = {}) {
  const { runMediaTool } = await import("../media-probe.mjs");
  const folder = `${out}.parts`;
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  try {
    await Promise.all(stills.map((still, index) => copyFile(still, path.join(folder, `${String(index).padStart(2, "0")}.jpg`))));
    await heavyDecodeSlot(() => runMediaTool("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-framerate", "1", "-start_number", "0",
      "-i", path.join(folder, "%02d.jpg"), "-vf",
      `scale=${STILL_WIDTH}:180:force_original_aspect_ratio=decrease,pad=${STILL_WIDTH}:180:(ow-iw)/2:(oh-ih)/2,tile=${SHEET_COLUMNS}x${SHEET_ROWS}`,
      "-frames:v", "1", "-q:v", "4", out], { signal }));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function defaultTools() {
  const [{ probeMedia }, { findShots }, { measureFootage }] = await Promise.all([
    import("../media-probe.mjs"), import("../shot-detection.mjs"), import("../footage/analyze.mjs"),
  ]);
  return { probe: probeMedia, findShots, measure: measureFootage, stills: stillsAt, sheet: sheetOf };
}

/** The progress line while a scan measures: the first scan downloads the image model. */
export function measuringLine({ modelReady = true } = {}) {
  return modelReady
    ? "Measuring the shots (motion, faces, text) and looking at one still a shot."
    : "Measuring the shots. The first scan also downloads the image model (about 100 MB) once, so it takes longer.";
}

/**
 * Measures and ranks a downloaded scan copy (downloadScanCopy's {folder, files: [{start, end,
 * file}]}), saves it as `id` and removes the copy, whatever happens. options: dataRoot, want (the
 * agent's visual words), embed ({images(files), text(prompts)}, look-embed.mjs; null skips
 * matching and merging), title, keep (scan ids the cap leaves alone), onProgress(text),
 * modelReady (false: the progress line says the model downloads), signal, tools (tests).
 * Answers the saved scan.
 */
export async function scanFootage(id, copy, { dataRoot, want = "", embed = null, title = "", keep = [], onProgress, modelReady, signal, tools } = {}) {
  try {
    const use = tools ?? await defaultTools();
    onProgress?.(measuringLine({ modelReady }));
    const stretches = [];
    const vision = { faces: false, text: false, flow: false, people: false, foreground: false };
    let count = 0;
    for (const window of copy.files) {
      const facts = await use.probe(window.file, { signal });
      const span = window.end - window.start;
      const duration = facts.duration > 0 ? facts.duration : span;
      // The lead-in before window.start (the file starts at the keyframe before it); 0 when the
      // file is no longer than the stretch (a stretch that reached the video's end early).
      const lead = Math.max(0, duration - span);
      const { shots } = await use.findShots(window.file, { duration, signal, maxSeconds: WHOLE_MAX_SECONDS });
      const measured = await use.measure(window.file, { width: facts.width, height: facts.height, duration, signal, events: false, subjects: true });
      for (const key of Object.keys(vision)) vision[key] ||= measured.vision?.[key] === true;
      const samples = measured.samples ?? [];
      const cuts = shots.slice(1).map((shot) => shot.start);
      const persistent = persistentElements(samples.map((sample) => ({ t: sample.t, text: sample.text, stats: {} })), cuts);
      const stills = await use.stills(window.file, shots.map((shot) => (shot.start + shot.end) / 2), path.join(copy.folder, `stills-${count}`), { signal });
      count += shots.length;
      stretches.push({ at: window.start - lead, shots, samples, persistent, stills });
    }
    // Marks are read across the whole scan: a logo on every shot is one fact, said once.
    const linesOf = (shot, samples) => {
      const read = samples.filter((sample) => sample.t >= shot.start - 0.01 && sample.t < shot.end && Array.isArray(sample.text));
      return read.length ? read.flatMap((sample) => sample.text.map((line) => line.box)) : null;
    };
    const marks = scanMarks(stretches.flatMap(({ shots, samples }) => shots.map((shot) => linesOf(shot, samples))));
    const all = stretches.flatMap(({ at, shots, samples, persistent, stills }) => shots.map((shot, index) => ({
      start: round3(Math.max(0, at + shot.start)), end: round3(at + shot.end),
      ...shotFacts(shot.start, shot.end, samples, persistent, marks), still: stills[index] ?? null,
    })));
    // Every still through the embedder at once; `want` and the drawn-or-photo words through its text half.
    const withStill = all.filter((shot) => shot.still);
    const looked = embed && withStill.length ? await embed.images(withStill.map((shot) => shot.still)) : null;
    withStill.forEach((shot, index) => { shot.vector = looked?.vectors?.[index] ? decodeVector(looked.vectors[index]) : null; });
    const words = String(want ?? "").trim();
    const prompts = looked ? [words || null, ...DRAWN_PROMPTS].filter(Boolean) : [];
    const texts = embed && prompts.length ? await embed.text(prompts) ?? [] : [];
    const wantVector = words && looked ? texts[0] ?? null : null;
    const [drawnVector, photoVector] = texts.slice(words ? 1 : 0).map((vector) => (vector ? normalize(vector) : null));
    // The face detector is made for photos: on drawn footage it reads nothing, so faces do not rank.
    const drawn = isDrawn(withStill.map((shot) => shot.vector), drawnVector, photoVector);
    // There the subject is where the eye goes (saliency), never a face box, and the figure is the
    // subject mask's when the body detector (made for photos) found none.
    for (const shot of all) {
      if (drawn) drawnShot(shot);
      delete shot.salient;
      delete shot.mask;
    }
    const { shots: joined, repeats } = mergeAlike(all);
    const ranked = rankShots(joined, { wantVector: wantVector ? normalize(wantVector) : null, drawn });
    // Shot numbers (numberShots): time order in a first scan; a shot already numbered keeps its
    // number and time range, a later scan's new shots count on from the largest number.
    const before = await readScan(dataRoot, id);
    const numbered = numberShots(before?.shots ?? [], ranked.shots);
    const number = new Map(ranked.shots.map((shot, index) => [shot, numbered[index].n]));
    const folder = scansFolder(dataRoot);
    await mkdir(folder, { recursive: true });
    const best = ranked.shots.filter((shot) => shot.still).slice(0, SHEET_SHOTS);
    let sheet = [];
    if (best.length) {
      try {
        await use.sheet(best.map((shot) => shot.still), scanPath(dataRoot, id, "jpg"), { signal });
        sheet = best.map((shot) => number.get(shot));
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    const rows = ranked.shots.map((shot, index) => ({
      n: numbered[index].n, start: numbered[index].start, end: numbered[index].end, motion: shot.motion, face: shot.face,
      match: shot.match, score: shot.score, base: shot.base, flags: shot.flags,
      // Every shot keeps its mean light (0 to 1) and where its subject is, so a listing can be
      // narrowed by them (library footage filter, actions.mjs) without looking at each still.
      ...(Number.isFinite(shot.luma) ? { luma: shot.luma } : {}),
      ...(shot.subject ? { subject: shot.subject } : {}),
      // The figure (whole-body box, or on drawn footage by "body" or "mask"; maskCover, the percent
      // of the picture a mask too large to be a figure covered, beside a null one) and how the
      // shot moves: the framing filters (actions.mjs). null: figures were read and none was found;
      // left out: not read (a shot kept from an older scan has no figure key either).
      ...(shot.figure ? { figure: { box: shot.figure.box, share: shot.figure.share, seen: shot.figure.seen, ...(shot.figure.by ? { by: shot.figure.by } : {}) } }
        : shot.figure === null ? { figure: null, ...(Number.isFinite(shot.maskCover) ? { maskCover: shot.maskCover } : {}) } : {}),
      ...(shot.moving ? { moving: shot.moving } : {}),
      ...(shot.vector ? { vector: encodeVector(shot.vector) } : {}),
    }));
    // The shots of earlier scans stay under their numbers, and every shot of the video is then
    // matched to the newest `want` together (their saved vectors), so no shot keeps the match or
    // score of another scan's words. An older save without a base keeps its score as the base.
    const taken = new Set(rows.map((row) => row.n));
    const together = [...rows, ...(before?.shots ?? []).filter((shot) => !taken.has(shot.n))]
      .map((row) => ({ ...row, flags: row.flags ?? [], base: row.base ?? row.score ?? 0 }));
    // (This scan's shots, the first of `together`, match on their exact vectors, not the saved halves.)
    const answer = matchShots(together.map((row, index) => ({ ...row, vector: index < rows.length ? ranked.shots[index].vector ?? null : decodeVector(row.vector) })),
      { wantVector: wantVector ? normalize(wantVector) : null, drawn });
    const shotsOf = together.map((row, index) => ({ ...row, match: answer.matches[index], score: answer.scores[index] }));
    shotsOf.sort(compareShots);
    const skipped = { dark: 0, text: 0, subtitles: 0, short: 0 };
    for (const shot of shotsOf) for (const flag of shot.flags) if (flag in skipped && flag !== "dark") skipped[flag] += 1;
    const windows = [...(before?.windows ?? []), ...copy.files.map((window) => ({ start: window.start, end: window.end }))]
      .filter((window, index, list) => list.findIndex((other) => other.start === window.start && other.end === window.end) === index);
    const scan = {
      version: SCAN_VERSION, id, title, want: words, scannedAt: new Date().toISOString(),
      windows,
      vision: Object.fromEntries(Object.entries(vision).map(([key, value]) => [key, value || before?.vision?.[key] === true])),
      model: looked?.model ?? null, drawn, marks, matchShown: answer.matchShown,
      matchBest: answer.matchBest, matchBar: answer.matchBar,
      skipped: { ...skipped, repeats: repeats + (Number.isFinite(before?.skipped?.repeats) ? before.skipped.repeats : 0) },
      sheet,
      shots: shotsOf,
    };
    const file = scanPath(dataRoot, id, "json");
    await writeFile(`${file}.part`, JSON.stringify(scan));
    await rename(`${file}.part`, file);
    await pruneScans(dataRoot, { keep: [...keep, id] });
    return scan;
  } finally {
    await removeTempFolder(copy.folder);
  }
}
