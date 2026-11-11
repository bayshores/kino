// The footage finder's scan, part 2: measure the 360p copy (scan.mjs) and rank its shots.
// 1. For each downloaded stretch: its shots (shot-detection.mjs findShots), what moves, where the
//    faces and text are and how bright it is (footage/analyze.mjs measureFootage, as compose
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
// 4. Saves <data>/footage/scans/<id>.json and one sheet (<id>.jpg, the best 12 stills, 4 by 3),
//    then removes the 360p copy. At most 300 files or 200 MB of scans: the oldest unused go
//    first; a scan the caller keeps (noted or imported) stays.
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeVector, dot, encodeVector, normalize } from "../music-embed.mjs";
import { persistentElements } from "../measure/fingerprint.mjs";
import { heavyDecodeSlot } from "../process-slots.mjs";
import { removeTempFolder } from "../temp-folders.mjs";
import { WHOLE_MAX_SECONDS } from "./scan.mjs";

/** 2: marks, subtitles and drawn footage. A saved scan of another version is scanned again. */
export const SCAN_VERSION = 2;
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
 * One shot's facts from measureFootage samples ({t, luma, change, motion, faces, text}), with
 * start and end in the same (file) seconds: {motion 0 to 100, face 0 to 100 or null when faces
 * were not measured, luma 0 to 1, text (share of frames with text that is no fixed element or
 * mark), subs (share of frames with such a line at the bottom center), logo (share of frames
 * showing a fixed text element that is no mark)}. persistent: persistentElements' answer for
 * this stretch; marks: scanMarks' answer for the whole scan.
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
  };
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
 * The shots best first, each with {flags, score, match}. flags: "dark", "text", "subtitles",
 * "short" (these go last), "logo" (a small cost). match: the z-score of the shot's closeness to
 * `wantVector` among these shots (null without one); it adds to the score only when matchShown
 * (the best clean shot, one without dark, text, subtitles or short, reaches matchBar; drawn: the
 * footage is drawn). Answers {shots, matchShown, matchBest (that best z-score, or null),
 * matchBar, skipped: {dark, text, subtitles, short}}.
 */
export function rankShots(shots, { wantVector = null, drawn = false } = {}) {
  const closeness = wantVector ? shots.map((shot) => (shot.vector ? dot(wantVector, shot.vector) : null)) : [];
  const known = closeness.filter((value) => value !== null);
  const z = zScores(known);
  let next = 0;
  const matches = closeness.map((value) => (value === null ? null : round1(z[next++])));
  const skipped = { dark: 0, text: 0, subtitles: 0, short: 0 };
  const flagged = shots.map((shot) => {
    const flags = [];
    if (shot.luma < DARK_LUMA) flags.push("dark");
    if (shot.text >= TEXT_SHARE) flags.push("text");
    else if (shot.subs >= SUBTITLE_SHARE) flags.push("subtitles");
    if (shot.end - shot.start < SHORT_SECONDS) flags.push("short");
    for (const flag of flags) skipped[flag] += 1;
    if (shot.logo >= TEXT_SHARE) flags.push("logo");
    return flags;
  });
  // A title card that spells the searched name can match best, and a short shot sorts last and is
  // too short to import: only clean shots decide.
  const clean = matches.filter((value, index) => value !== null && flagged[index].every((flag) => flag === "logo"));
  const bar = matchBar(known.length, { drawn });
  const matchBest = clean.length ? Math.max(...clean) : null;
  const matchShown = matchBest !== null && matchBest >= bar;
  const rows = shots.map((shot, index) => {
    const flags = flagged[index];
    const match = wantVector ? matches[index] : null;
    const score = round1(0.5 * shot.motion + 0.3 * (shot.face ?? 0) + 20 * (1 - shot.text)
      + (matchShown && match !== null ? 10 * match : 0) - (flags.includes("logo") ? 10 : 0));
    const last = flags.some((flag) => flag !== "logo");
    return { ...shot, flags, score, match, last };
  });
  rows.sort((a, b) => Number(a.last) - Number(b.last) || b.score - a.score || a.start - b.start);
  return { shots: rows.map(({ last, ...row }) => row), matchShown, matchBest, matchBar: Number.isFinite(bar) ? round1(bar) : null, skipped };
}

// ---- files ----------------------------------------------------------------------------------

const SCAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A shot of these flags goes after the clean ones (a logo alone is a small cost, not a reason). */
const isLast = (shot) => (shot.flags ?? []).some((flag) => flag !== "logo");

/** Two shots are one shot for numbering when their time ranges overlap by at least this share of their union. */
export const SAME_RANGE = 0.5;

/**
 * Numbers a scan's shots (each {start, end}) against the shots a saved scan of the same video
 * already shows (known, each {n, start, end}). A shot whose time range overlaps a known shot's
 * (SAME_RANGE of their union, the most overlap first, each known number once) keeps that number
 * and that shot's start and end, so a code shown before points at the same range of the video. The
 * others are new: they count on from the largest known number, in time order (1, 2, 3 ... in a
 * first scan), so no number is reused or shifted. Answers [{n, start, end}] in the order of `shots`.
 */
export function numberShots(known = [], shots = []) {
  const pairs = [];
  shots.forEach((shot, index) => known.forEach((old, at) => {
    const overlap = Math.min(shot.end, old.end) - Math.max(shot.start, old.start);
    const union = Math.max(shot.end, old.end) - Math.min(shot.start, old.start);
    if (overlap > 0 && union > 0 && overlap / union >= SAME_RANGE) pairs.push({ index, at, share: overlap / union });
  }));
  pairs.sort((a, b) => b.share - a.share);
  const out = new Array(shots.length).fill(null);
  const used = new Set();
  for (const { index, at, share } of pairs) {
    if (out[index] || used.has(at)) continue;
    out[index] = { n: known[at].n, start: known[at].start, end: known[at].end, share };
    used.add(at);
  }
  let next = Math.max(0, ...known.map((old) => old.n)) + 1;
  shots.map((shot, index) => index).filter((index) => !out[index]).sort((a, b) => shots[a].start - shots[b].start)
    .forEach((index) => { out[index] = { n: next++, start: shots[index].start, end: shots[index].end }; });
  return out.map(({ n, start, end }) => ({ n, start, end }));
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
async function stillsAt(file, times, folder, { signal } = {}) {
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
    const vision = { faces: false, text: false, flow: false };
    let count = 0;
    for (const window of copy.files) {
      const facts = await use.probe(window.file, { signal });
      const span = window.end - window.start;
      const duration = facts.duration > 0 ? facts.duration : span;
      // The lead-in before window.start (the file starts at the keyframe before it); 0 when the
      // file is no longer than the stretch (a stretch that reached the video's end early).
      const lead = Math.max(0, duration - span);
      const { shots } = await use.findShots(window.file, { duration, signal, maxSeconds: WHOLE_MAX_SECONDS });
      const measured = await use.measure(window.file, { width: facts.width, height: facts.height, duration, signal, events: false });
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
    if (drawn) for (const shot of all) shot.face = null;
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
      match: shot.match, score: shot.score, flags: shot.flags,
      ...(shot.vector ? { vector: encodeVector(shot.vector) } : {}),
    }));
    // The shots of earlier scans stay, as they were shown, under their numbers.
    const taken = new Set(rows.map((row) => row.n));
    const shotsOf = [...rows, ...(before?.shots ?? []).filter((shot) => !taken.has(shot.n))];
    shotsOf.sort((a, b) => Number(isLast(a)) - Number(isLast(b)) || b.score - a.score || a.start - b.start);
    const windows = [...(before?.windows ?? []), ...copy.files.map((window) => ({ start: window.start, end: window.end }))]
      .filter((window, index, list) => list.findIndex((other) => other.start === window.start && other.end === window.end) === index);
    const scan = {
      version: SCAN_VERSION, id, title, want: words, scannedAt: new Date().toISOString(),
      windows,
      vision, model: looked?.model ?? null, drawn, marks, matchShown: ranked.matchShown,
      matchBest: ranked.matchBest, matchBar: ranked.matchBar,
      skipped: { ...ranked.skipped, repeats },
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
