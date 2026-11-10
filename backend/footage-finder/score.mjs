// The footage finder's scan, part 2: measure the 360p copy (scan.mjs) and rank its shots.
// 1. For each downloaded stretch: its shots (shot-detection.mjs findShots), what moves, where the
//    faces and text are and how bright it is (footage/analyze.mjs measureFootage, as compose
//    measures clips: 4 frames a second, -threads 2), what stays in place across cuts (a channel
//    logo, a burned-in watermark: measure/fingerprint.mjs persistentElements), and one still in
//    the middle of each shot.
// 2. The stills go through the injected image embedder (SigLIP, look-embed.mjs); `want` through
//    its text half, so each shot gets a match against the agent's visual words.
// 3. The pure half (shotFacts, mergeAlike, rankShots): neighbors 0.95 or more alike join into one
//    shot (a held picture the cut finder split), then shots rank on motion, faces and clean
//    frames. Dark shots, shots full of text or subtitles and shots under 0.4 s go last; a fixed
//    logo costs a little. `match` is a z-score among this scan's shots and counts only when the
//    best one is 2 or more; otherwise the answer says there is no visual match.
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

export const SCAN_VERSION = 1;
/** A shot shorter than this is too short to cut to. */
export const SHORT_SECONDS = 0.4;
/** Neighbor shots at least this alike (SigLIP cosine) are one shot. */
export const SAME_SHOT = 0.95;
/** The best shot's match z-score must reach this for match to count and show. */
export const MATCH_SHOWN = 2;
/** A shot this dark on average (0 to 1) is a dark shot. */
export const DARK_LUMA = 0.12;
/** A shot with text in this share of its frames (a title card, subtitles) is a text shot. */
export const TEXT_SHARE = 0.5;
/** Stills on the sheet, and its grid. */
export const SHEET_SHOTS = 12;
const SHEET_COLUMNS = 4;
const SHEET_ROWS = 3;
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

/**
 * One shot's facts from measureFootage samples ({t, luma, change, motion, faces, text}), with
 * start and end in the same (file) seconds: {motion 0 to 100, face 0 to 100 or null when faces
 * were not measured, luma 0 to 1, text (share of frames with text that is no fixed element),
 * logo (share of frames showing a fixed text element)}. persistent: persistentElements' answer.
 */
export function shotFacts(start, end, samples = [], persistent = []) {
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
  const isFixed = (line) => fixed.some((box) => centerIn(line.box, box));
  return {
    motion,
    face,
    luma: round3(mean(inside.map((sample) => sample.luma).filter((value) => Number.isFinite(value))) ?? 0),
    text: share((sample) => sample.text.some((line) => !isFixed(line))),
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
      const blend = (key) => (last[key] === null || shot[key] === null ? last[key] ?? shot[key] : round3((last[key] * a + shot[key] * b) / (a + b)));
      const longer = b > a ? shot : last;
      out[out.length - 1] = {
        ...last, end: shot.end, still: longer.still, vector: longer.vector,
        motion: Math.round(blend("motion")), face: last.face === null && shot.face === null ? null : Math.round(blend("face")),
        luma: blend("luma"), text: blend("text"), logo: blend("logo"),
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
 * The shots best first, each with {flags, score, match}. flags: "dark", "text", "short" (these
 * go last), "logo" (a small cost). match: the z-score of the shot's closeness to `wantVector`
 * among these shots (null without one); it adds to the score only when matchShown (the best is
 * MATCH_SHOWN or more). Answers {shots, matchShown, skipped: {dark, text, short}}.
 */
export function rankShots(shots, { wantVector = null } = {}) {
  const closeness = wantVector ? shots.map((shot) => (shot.vector ? dot(wantVector, shot.vector) : null)) : [];
  const known = closeness.filter((value) => value !== null);
  const z = zScores(known);
  let next = 0;
  const matches = closeness.map((value) => (value === null ? null : round1(z[next++])));
  const matchShown = known.length >= 3 && Math.max(...matches.filter((value) => value !== null)) >= MATCH_SHOWN;
  const skipped = { dark: 0, text: 0, short: 0 };
  const rows = shots.map((shot, index) => {
    const flags = [];
    if (shot.luma < DARK_LUMA) flags.push("dark");
    if (shot.text >= TEXT_SHARE) flags.push("text");
    if (shot.end - shot.start < SHORT_SECONDS) flags.push("short");
    for (const flag of flags) skipped[flag] += 1;
    if (shot.logo >= TEXT_SHARE) flags.push("logo");
    const match = wantVector ? matches[index] : null;
    const score = round1(0.5 * shot.motion + 0.3 * (shot.face ?? 0) + 20 * (1 - shot.text)
      + (matchShown && match !== null ? 10 * match : 0) - (flags.includes("logo") ? 10 : 0));
    const last = flags.some((flag) => flag !== "logo");
    return { ...shot, flags, score, match, last };
  });
  rows.sort((a, b) => Number(a.last) - Number(b.last) || b.score - a.score || a.start - b.start);
  return { shots: rows.map(({ last, ...row }) => row), matchShown, skipped };
}

// ---- files ----------------------------------------------------------------------------------

const SCAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
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

// One still per time in one pass: the first frame at or after each time.
async function stillsAt(file, times, folder, { signal } = {}) {
  if (!times.length) return [];
  const { runMediaTool } = await import("../media-probe.mjs");
  const pick = times.map((time) => `lt(prev_pts*TB\\,${round3(time)})*gte(t\\,${round3(time)})`).join("+");
  await mkdir(folder, { recursive: true });
  await heavyDecodeSlot(() => runMediaTool("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-threads", "2", "-i", file, "-an", "-sn", "-dn",
    "-vf", `select='${pick}',scale=${STILL_WIDTH}:-2:flags=area`, "-fps_mode", "vfr", "-q:v", "4", "-start_number", "0",
    path.join(folder, "%03d.jpg")], { signal }));
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
    const all = [];
    const vision = { faces: false, text: false, flow: false };
    for (const window of copy.files) {
      const facts = await use.probe(window.file, { signal });
      const duration = facts.duration > 0 ? facts.duration : window.end - window.start;
      const { shots } = await use.findShots(window.file, { duration, signal, maxSeconds: WHOLE_MAX_SECONDS });
      const measured = await use.measure(window.file, { width: facts.width, height: facts.height, duration, signal });
      for (const key of Object.keys(vision)) vision[key] ||= measured.vision?.[key] === true;
      const samples = measured.samples ?? [];
      const cuts = shots.slice(1).map((shot) => shot.start);
      const persistent = persistentElements(samples.map((sample) => ({ t: sample.t, text: sample.text, stats: {} })), cuts);
      const stills = await use.stills(window.file, shots.map((shot) => (shot.start + shot.end) / 2), path.join(copy.folder, `stills-${all.length}`), { signal });
      shots.forEach((shot, index) => {
        all.push({
          start: round3(window.start + shot.start), end: round3(window.start + shot.end),
          ...shotFacts(shot.start, shot.end, samples, persistent), still: stills[index] ?? null,
        });
      });
    }
    // Every still through the embedder at once; `want` through its text half.
    const withStill = all.filter((shot) => shot.still);
    const looked = embed && withStill.length ? await embed.images(withStill.map((shot) => shot.still)) : null;
    withStill.forEach((shot, index) => { shot.vector = looked?.vectors?.[index] ? decodeVector(looked.vectors[index]) : null; });
    const words = String(want ?? "").trim();
    const wantVector = embed && words ? (await embed.text([words]))?.[0] ?? null : null;
    const { shots: joined, repeats } = mergeAlike(all);
    const ranked = rankShots(joined, { wantVector: wantVector ? normalize(wantVector) : null });
    // Shot numbers follow time, so F1.37 comes before F1.38 in the video.
    const order = [...ranked.shots].sort((a, b) => a.start - b.start);
    const number = new Map(order.map((shot, index) => [shot, index + 1]));
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
    const scan = {
      version: SCAN_VERSION, id, title, want: words, scannedAt: new Date().toISOString(),
      windows: copy.files.map((window) => ({ start: window.start, end: window.end })),
      vision, model: looked?.model ?? null, matchShown: ranked.matchShown,
      skipped: { ...ranked.skipped, repeats },
      sheet,
      shots: ranked.shots.map((shot) => ({
        n: number.get(shot), start: shot.start, end: shot.end, motion: shot.motion, face: shot.face,
        match: shot.match, score: shot.score, flags: shot.flags,
        ...(shot.vector ? { vector: encodeVector(shot.vector) } : {}),
      })),
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
