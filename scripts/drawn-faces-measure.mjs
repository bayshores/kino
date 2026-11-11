#!/usr/bin/env node
// Hand-run measurement: which face detector finds faces in drawn footage well enough for kino to
// frame drawn shots itself (design F6: ship at recall 0.8 or more at IoU 0.3).
//
// Not part of npm test and not a kino dependency. Detectors other than Apple Vision are loaded from
// a private folder given with --modules (a node_modules folder with @huggingface/transformers), and
// the cascade runs through the system's Python OpenCV, so kino's package.json never changes.
//
// Labels file (JSON): {stills:[{id, file, faces:[{box:[x, y, w, h], whole}]}]}, boxes as fractions
// of the picture, top-left origin (the same shape Vision boxes come back in from kino-measure).
//
// Usage:
//   node scripts/drawn-faces-measure.mjs sheets --labels <labels.json> --out <folder>
//     Writes labeling sheets: 4 stills side by side with a 10% grid, one FFmpeg at a time.
//   node scripts/drawn-faces-measure.mjs measure --labels <labels.json> --out <folder>
//       [--detectors vision,owlv2,cascade] [--helper <kino-measure>] [--modules <node_modules>]
//       [--models <cache folder>] [--cascade <xml>] [--dtype q8] [--prompts "a face|a drawn face"]
//     Runs each detector over every still, writes <out>/detections-<detector>.json and
//     <out>/scores.json, and prints a table of recall and precision at IoU 0.3.
//   node scripts/drawn-faces-measure.mjs rescore --labels <labels.json> --detections <owlv2 json>
//     Scores saved OWLv2 boxes again (after a label fix) with the same rows measure prints: each
//     score threshold, the best box per still, big boxes dropped, and the IoU cut moved.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ffmpegCommand } from "../backend/media-probe.mjs";
import { helperSession, measureHelperPath } from "../backend/measure/measure.mjs";

const IOU_MATCH = 0.3;
const RECALL_GATE = 0.8;
const OWL_MODEL = "Xenova/owlv2-base-patch16-ensemble";
const OWL_THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.3];
const IOU_SWEEP = [0.2, 0.25, 0.35, 0.5];
const MAX_SMALL_BOX_AREA = 0.5;
// Vision jobs in kino-measure.swift: 8 saliency boxes, 16 face boxes.
const JOB_SALIENCY = 8;
const JOB_FACES = 16;

function options(argv) {
  const [mode, ...rest] = argv;
  const named = {};
  for (let index = 0; index < rest.length; index += 2) named[rest[index].replace(/^--/, "")] = rest[index + 1];
  return { mode, ...named };
}

/** Width and height from a PNG's header (bytes 16 to 23), so no decoder is needed to size it. */
export function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy one-to-one matching, best IoU first: a detection counts for at most one labeled face. */
export function matchCounts(truth, found, iouMatch = IOU_MATCH) {
  const pairs = [];
  truth.forEach((face, t) => found.forEach((box, f) => { const score = iou(face, box); if (score >= iouMatch) pairs.push({ t, f, score }); }));
  pairs.sort((a, b) => b.score - a.score);
  const usedTruth = new Set(), usedFound = new Set();
  for (const pair of pairs) {
    if (usedTruth.has(pair.t) || usedFound.has(pair.f)) continue;
    usedTruth.add(pair.t); usedFound.add(pair.f);
  }
  return { hits: usedTruth.size, matchedTruth: usedTruth, falseFound: found.length - usedFound.size };
}

/**
 * Every OWLv2 row the result report uses, all from the saved boxes. Besides the plain score
 * thresholds it scores three checks on how narrow a pass is: the best box per still only, boxes
 * over half the picture dropped (a big box matches any close-up), and the IoU cut moved at the
 * gate threshold (labels are only accurate to about 5%).
 */
export function owlRows(stills, owl, loadSeconds) {
  const name = `OWLv2 ${owl.dtype} "${owl.prompts.join('" + "')}"`;
  const seconds = meanSeconds(owl, stills);
  const row = (detector, boxesOf, iouMatch) => ({ detector, seconds, loadSeconds, ...(iouMatch ? { iou: iouMatch } : {}), ...score(stills, boxesOf, iouMatch) });
  const above = (threshold) => (still) => owl[still.id].boxes.filter((box) => box.s >= threshold);
  const rows = [];
  for (const threshold of OWL_THRESHOLDS) rows.push(row(`${name} score>=${threshold}`, (still) => above(threshold)(still).map((box) => box.box)));
  for (const threshold of OWL_THRESHOLDS.slice(0, 2)) {
    const best = (still) => above(threshold)(still).sort((a, b) => b.s - a.s).slice(0, 1).map((box) => box.box);
    rows.push(row(`${name} top box per still only, score>=${threshold}`, best));
  }
  for (const threshold of OWL_THRESHOLDS) {
    const small = (still) => above(threshold)(still).map((box) => box.box).filter((box) => box[2] * box[3] <= MAX_SMALL_BOX_AREA);
    rows.push(row(`${name} boxes over half the picture dropped, score>=${threshold}`, small));
  }
  for (const iouMatch of IOU_SWEEP) rows.push(row(`${name} score>=${OWL_THRESHOLDS[0]} at IoU ${iouMatch}`, (still) => above(OWL_THRESHOLDS[0])(still).map((box) => box.box), iouMatch));
  return rows;
}

/** Recall over all labeled faces and over whole faces only, precision over every box found. */
export function score(stills, boxesOf, iouMatch = IOU_MATCH) {
  let faces = 0, whole = 0, hits = 0, wholeHits = 0, found = 0, wrong = 0;
  for (const still of stills) {
    const truth = still.faces.map((face) => face.box);
    const boxes = boxesOf(still);
    const { hits: hit, matchedTruth, falseFound } = matchCounts(truth, boxes, iouMatch);
    faces += truth.length; hits += hit; found += boxes.length; wrong += falseFound;
    still.faces.forEach((face, index) => { if (face.whole) { whole += 1; if (matchedTruth.has(index)) wholeHits += 1; } });
  }
  const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  const recall = ratio(hits, faces);
  return { faces, hits, recall, wholeFaces: whole, wholeHits, wholeRecall: ratio(wholeHits, whole), found, wrong, precision: ratio(found - wrong, found), meetsGate: recall != null && recall >= RECALL_GATE };
}

function decodeBgra(file, { width, height }) {
  const made = spawnSync(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-vf", `scale=${width}:${height},format=bgra`, "-f", "rawvideo", "pipe:1"], { maxBuffer: width * height * 4 + 1024 });
  if (made.status !== 0) throw new Error(`FFmpeg could not decode ${file}`);
  return made.stdout;
}

/** Apple Vision through kino-measure: faces (job 16) and saliency (job 8), one still at a time. */
async function runVision(stills, helperArg) {
  const helper = helperArg || await measureHelperPath({ fromSource: true });
  if (!helper) throw new Error("no kino-measure helper (macOS with the Swift compiler needed)");
  const results = {};
  // One helper per picture size (it is started with a fixed size); each still waits for its answer
  // before the next is sent, so the time is Vision's time for that still, not the helper's start.
  const bySize = new Map();
  for (const still of stills) {
    const size = pngSize(still.file);
    const key = `${size.width}x${size.height}`;
    if (!bySize.has(key)) bySize.set(key, { size, stills: [] });
    bySize.get(key).stills.push(still);
  }
  for (const { size, stills: group } of bySize.values()) {
    let resolveAnswer = null;
    const session = helperSession(helper, { ...size, onAnswer: (answer) => resolveAnswer?.(answer) });
    for (const still of group) {
      const bgra = decodeBgra(still.file, size);
      const answered = new Promise((resolve) => { resolveAnswer = resolve; });
      const started = performance.now();
      await session.send(JOB_FACES | JOB_SALIENCY, bgra);
      const answer = await answered;
      const seconds = (performance.now() - started) / 1000;
      results[still.id] = { faces: answer.faces ?? [], saliency: answer.saliency ?? [], seconds, errors: answer.errors };
    }
    const { error } = await session.finish();
    if (error) throw new Error(`kino-measure stopped: ${error}`);
  }
  return results;
}

/** OWLv2 zero-shot boxes through transformers.js, kept with scores so thresholds can be compared. */
async function runOwl(stills, { modules, models, dtype = "q8", prompts }) {
  if (!modules) throw new Error("--modules <node_modules folder with @huggingface/transformers> is needed");
  const entry = path.join(modules, "@huggingface", "transformers", "dist", "transformers.node.mjs");
  const { pipeline, env, RawImage } = await import(pathToFileURL(entry).href);
  if (models) env.cacheDir = models;
  const loadStart = performance.now();
  const detector = await pipeline("zero-shot-object-detection", OWL_MODEL, { dtype });
  const loadSeconds = (performance.now() - loadStart) / 1000;
  const results = { loadSeconds, dtype, prompts };
  for (const still of stills) {
    const image = await RawImage.read(still.file);
    const started = performance.now();
    const output = await detector(image, prompts, { threshold: Math.min(...OWL_THRESHOLDS), percentage: true });
    const seconds = (performance.now() - started) / 1000;
    const boxes = output.map(({ score: confidence, label, box }) => ({ s: Math.round(confidence * 1000) / 1000, label, box: [box.xmin, box.ymin, box.xmax - box.xmin, box.ymax - box.ymin].map((value) => Math.round(value * 1000) / 1000) }));
    results[still.id] = { boxes, seconds };
  }
  return results;
}

// The cascade runs in the system Python's OpenCV with the settings its README gives.
const CASCADE_PY = `
import cv2, json, sys, time
cascade = cv2.CascadeClassifier(sys.argv[1])
out = {}
for item in json.loads(sys.stdin.read()):
    image = cv2.imread(item["file"], cv2.IMREAD_COLOR)
    h, w = image.shape[:2]
    started = time.perf_counter()
    gray = cv2.equalizeHist(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
    seconds = time.perf_counter() - started
    out[item["id"]] = {"faces": [[round(x / w, 3), round(y / h, 3), round(fw / w, 3), round(fh / h, 3)] for (x, y, fw, fh) in faces], "seconds": seconds}
print(json.dumps(out))
`;

function runCascade(stills, xml) {
  if (!xml) throw new Error("--cascade <xml> is needed");
  const made = spawnSync("python3", ["-I", "-c", CASCADE_PY, xml], { input: JSON.stringify(stills.map(({ id, file }) => ({ id, file }))), encoding: "utf8", maxBuffer: 1 << 24 });
  if (made.status !== 0) throw new Error(`the cascade could not run: ${made.stderr.trim().split("\n").at(-1)}`);
  return JSON.parse(made.stdout);
}

function meanSeconds(results, stills) {
  const times = stills.map((still) => results[still.id]?.seconds).filter((value) => value != null);
  return times.length ? Math.round((times.reduce((sum, value) => sum + value, 0) / times.length) * 1000) / 1000 : null;
}

async function measure(opts) {
  const { stills } = JSON.parse(readFileSync(opts.labels, "utf8"));
  const detectors = (opts.detectors ?? "vision,owlv2,cascade").split(",");
  mkdirSync(opts.out, { recursive: true });
  // Baseline: one box over the whole picture. Close-ups match it at IoU 0.3, so a detector's
  // recall means something only where it beats this row.
  const rows = [{ detector: "Whole picture (baseline, no detector)", seconds: 0, ...score(stills, () => [[0, 0, 1, 1]]) }];
  if (detectors.includes("vision")) {
    const vision = await runVision(stills, opts.helper);
    writeFileSync(path.join(opts.out, "detections-vision.json"), JSON.stringify(vision, null, 1));
    const seconds = meanSeconds(vision, stills);
    rows.push({ detector: "Apple Vision faces (job 16)", seconds, ...score(stills, (still) => vision[still.id].faces) });
    rows.push({ detector: "Apple Vision saliency (job 8)", seconds, ...score(stills, (still) => vision[still.id].saliency) });
  }
  if (detectors.includes("cascade")) {
    const cascade = runCascade(stills, opts.cascade);
    writeFileSync(path.join(opts.out, "detections-cascade.json"), JSON.stringify(cascade, null, 1));
    rows.push({ detector: "LBP cascade (OpenCV)", seconds: meanSeconds(cascade, stills), ...score(stills, (still) => cascade[still.id].faces) });
  }
  if (detectors.includes("owlv2")) {
    const prompts = (opts.prompts ?? "a face").split("|");
    const owl = await runOwl(stills, { modules: opts.modules, models: opts.models, dtype: opts.dtype, prompts });
    const name = `detections-owlv2-${owl.dtype}.json`;
    writeFileSync(path.join(opts.out, name), JSON.stringify(owl, null, 1));
    rows.push(...owlRows(stills, owl, Math.round(owl.loadSeconds * 10) / 10));
  }
  const scoresFile = path.join(opts.out, "scores.json");
  let saved = [];
  try { saved = JSON.parse(readFileSync(scoresFile, "utf8")); } catch { /* first run */ }
  const kept = saved.filter((row) => !rows.some((fresh) => fresh.detector === row.detector));
  writeFileSync(scoresFile, JSON.stringify([...kept, ...rows], null, 1));
  console.log("detector | faces | hits | recall | whole recall | boxes | wrong | precision | s/image | gate 0.8");
  for (const row of rows) console.log([row.detector, row.faces, row.hits, row.recall, `${row.wholeHits}/${row.wholeFaces} ${row.wholeRecall}`, row.found, row.wrong, row.precision, row.seconds, row.meetsGate ? "meets" : "below"].join(" | "));
}

/** Labeling sheets: 4 stills side by side, a grid line every 10% of each still. */
function sheets(opts) {
  const { stills } = JSON.parse(readFileSync(opts.labels, "utf8"));
  mkdirSync(opts.out, { recursive: true });
  for (let start = 0; start < stills.length; start += 4) {
    const group = stills.slice(start, start + 4);
    const { width, height } = pngSize(group[0].file);
    const inputs = group.flatMap((still) => ["-i", still.file]);
    const scaled = group.map((_, index) => `[${index}]scale=${width}:${height},format=rgb24[s${index}]`).join(";");
    const stack = group.map((_, index) => `[s${index}]`).join("") + (group.length > 1 ? `hstack=${group.length}` : "null");
    const grid = `drawgrid=w=${width / 10}:h=${height / 10}:t=1:c=yellow@0.7`;
    const out = path.join(opts.out, `sheet-${group[0].id}-${group.at(-1).id}.png`);
    const made = spawnSync(ffmpegCommand(), ["-hide_banner", "-nostdin", "-v", "error", "-y", ...inputs, "-filter_complex", `${scaled};${stack},${grid}`, "-frames:v", "1", out]);
    if (made.status !== 0) throw new Error(`FFmpeg could not make ${out}: ${made.stderr}`);
    console.log(out);
  }
}

/** Scores a saved OWLv2 detections file against (possibly corrected) labels without running it again. */
function rescoreOwl(opts) {
  const { stills } = JSON.parse(readFileSync(opts.labels, "utf8"));
  const owl = JSON.parse(readFileSync(opts.detections, "utf8"));
  console.log("detector | faces | hits | recall | whole recall | boxes | wrong | precision | s/image | gate 0.8");
  for (const row of owlRows(stills, owl, null)) console.log([row.detector, row.faces, row.hits, row.recall, `${row.wholeHits}/${row.wholeFaces} ${row.wholeRecall}`, row.found, row.wrong, row.precision, row.seconds, row.meetsGate ? "meets" : "below"].join(" | "));
}

const opts = options(process.argv.slice(2));
if (opts.mode === "sheets") sheets(opts);
else if (opts.mode === "rescore") rescoreOwl(opts);
else if (opts.mode === "measure") await measure(opts);
else console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).join("\n"));
