#!/usr/bin/env node
// Builds a judge packet for one MP4 (evals/taste/README.md).
//
//   node evals/taste/packet.mjs <video.mp4> [--out <folder>] [--no-words]
//
// The packet folder (default evals/taste/packets/<12 hex of the file's hash>) holds a 540p copy
// with no metadata, overview sheets at 2 fps, strips at 12 fps around every cut, and facts.json:
// loudness (measured, not changed), a short-term loudness curve every 0.5 s, cuts, motion facts,
// the beat grid, song sections and a transcript with word times when whisper is installed.
// source.json (the original path) stays beside it; the judge never sees it.
// One ffmpeg runs at a time.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { cutsFrom, lineLevels, motionFacts, parseEbur128, parseFrameMetadata, shortTermCurve, stripTimes } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERVIEW_TILE = 320; // long side of an overview frame
const STRIP_TILE = 240; // long side of a strip frame
const SHEET_WIDTH = 1500; // sheets stay under the 1568 px the model reads without shrinking
const STRIPS_PER_SHEET = 5;

function run(command, args, { stdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { if (stdout) out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${command} failed (${code}): ${err.slice(-600)}`))));
  });
}

const ffmpeg = (args) => run("ffmpeg", ["-nostdin", "-hide_banner", "-y", ...args]);

/** A video's packet id: the first 12 hex characters of its SHA-256. */
export async function hashOf(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").slice(0, 12);
}

async function probe(file) {
  const { out } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", file], { stdout: true });
  const info = JSON.parse(out);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const [num, den] = String(video?.r_frame_rate ?? "30/1").split("/").map(Number);
  return { duration: Number(info.format.duration), width: video?.width, height: video?.height, fps: Math.round((num / (den || 1)) * 100) / 100,
    audio: info.streams.some((stream) => stream.codec_type === "audio") };
}

/** A frame size with long side `long`, even numbers, in the video's shape. */
function tileSize(width, height, long) {
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  return width >= height ? { w: long, h: even((long * height) / width) } : { w: even((long * width) / height), h: long };
}

/** Draws frames into one labeled sheet: rows of [label, files]. */
async function drawSheet(rows, tile, columns, outFile) {
  const labelHeight = 18;
  const lines = rows.map((row) => Math.ceil(row.files.length / columns));
  const height = rows.reduce((sum, row, i) => sum + labelHeight + lines[i] * tile.h, 0);
  const canvas = createCanvas(columns * tile.w, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#111";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "13px sans-serif";
  let y = 0;
  for (const [i, row] of rows.entries()) {
    context.fillStyle = "#eee";
    context.fillText(row.label, 4, y + 13);
    y += labelHeight;
    for (const [n, file] of row.files.entries()) {
      const image = await loadImage(file.path);
      const x = (n % columns) * tile.w, top = y + Math.floor(n / columns) * tile.h;
      context.drawImage(image, x, top, tile.w, tile.h);
      if (file.tag) {
        context.fillStyle = "rgba(0,0,0,0.6)";
        context.fillRect(x, top, 46, 16);
        context.fillStyle = file.cut ? "#ffd84a" : "#fff";
        context.fillText(file.tag, x + 3, top + 12);
      }
    }
    y += lines[i] * tile.h;
  }
  await writeFile(outFile, canvas.toBuffer("image/jpeg", 82));
}

async function framesIn(folder) {
  return (await readdir(folder)).filter((name) => name.endsWith(".jpg")).sort().map((name) => path.join(folder, name));
}

/** Transcript lines "from-to: word@start ..." split at pauses over 0.6 s; "~" marks words heard unclearly. */
function transcriptLines(words) {
  const lines = [];
  let line = null;
  for (const word of words) {
    if (!line || word.start - line.end > 0.6) { line = { start: word.start, end: word.end, words: [] }; lines.push(line); }
    const text = word.unclear || /^\(unclear\)$/.test(word.text.trim()) ? "~" : `${word.text.trim()}@${word.start}`;
    if (text !== "~" || line.words.at(-1) !== "~") line.words.push(text);
    line.end = word.end;
  }
  return lines.map((entry) => ({ start: entry.start, end: entry.end, text: entry.words.join(" ") }));
}

async function soundFacts(file, duration, { words, curve = null }) {
  const facts = { beats: null, sections: null, transcript: null, notes: [] };
  try {
    const { decodeMono } = await import("../../backend/audio-analysis.mjs");
    const { analyzeBeats } = await import("../../engine/beatDetection.js");
    const { songShape } = await import("../../backend/song-shape.mjs");
    const { samples, sampleRate } = await decodeMono(file);
    const beats = analyzeBeats(samples, sampleRate);
    facts.beats = { bpm: beats.bpm, confidence: beats.confidence, first: beats.beats[0] ?? null, count: beats.beats.length, ...(beats.note ? { note: beats.note } : {}) };
    const shape = songShape(samples, sampleRate, { bpm: beats.bpm });
    facts.sections = { sections: shape.sections, features: shape.features };
  } catch (error) {
    facts.notes.push(`no beat grid or song sections: ${error.message.split("\n")[0]}`);
  }
  if (words) {
    try {
      const { transcribeFile, whisperSetup } = await import("../../backend/speech/transcribe.mjs");
      const result = await transcribeFile(file, whisperSetup());
      const lines = transcriptLines(result.words.filter((word) => word.end <= duration + 0.5));
      facts.transcript = { model: result.model, lines: lines.map((line) => `${line.start.toFixed(2)}-${line.end.toFixed(2)}: ${line.text}`) };
      if (curve) {
        facts.voiceOverMusic = lineLevels(curve, lines.filter((line) => line.text.replace(/[~\s]/g, "")))
          .map((entry) => ({ t: entry.t, words: entry.text.split(" ").slice(0, 4).map((word) => word.split("@")[0]).join(" "), line: entry.line, before: entry.before, over: entry.over }));
      }
    } catch (error) {
      facts.notes.push(`no transcript: ${error.message.split("\n")[0]}`);
    }
  }
  return facts;
}

export async function buildPacket(source, { out = null, words = true } = {}) {
  const id = await hashOf(source);
  const folder = out ?? path.join(HERE, "packets", id);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const original = await probe(source);
  const video = path.join(folder, "video.mp4");
  // 540 px on the short side, metadata stripped, loudness left as it is.
  const scale = original.width >= original.height ? "scale=-2:540" : "scale=540:-2";
  await ffmpeg(["-i", source, "-map_metadata", "-1", "-map", "0:v:0", "-map", "0:a:0?", "-vf", `${scale},setsar=1`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", video]);
  const info = await probe(video);
  const duration = info.duration;

  // One pass on a small copy: scene scores and luma per frame.
  const metadataFile = path.join(folder, "frames.txt");
  await ffmpeg(["-i", video, "-an", "-vf", `scale=160:-2,signalstats,scdet=t=10,metadata=mode=print:file=${metadataFile.replace(/([:\\'])/g, "\\$1")}`, "-f", "null", "-"]);
  const frames = parseFrameMetadata(await readFile(metadataFile, "utf8"));
  await rm(metadataFile, { force: true });
  const cuts = cutsFrom(frames);
  const strips = stripTimes(cuts, duration);
  const motion = motionFacts(frames, cuts);

  // Loudness, measured only.
  let loudness = null, curve = null;
  if (info.audio) {
    const { err } = await ffmpeg(["-i", video, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
    const parsed = parseEbur128(err);
    curve = parsed.curve;
    loudness = { integrated: parsed.integrated, range: parsed.range, truePeak: parsed.truePeak, shortTerm: shortTermCurve(parsed.curve, duration, 0.5) };
  }

  // Pictures.
  const temp = await mkdtemp(path.join(tmpdir(), "kino-taste-"));
  const sheets = { overview: [], strips: [] };
  try {
    const overviewTile = tileSize(info.width, info.height, OVERVIEW_TILE);
    const columns = Math.max(1, Math.floor(SHEET_WIDTH / overviewTile.w));
    const rowsPerSheet = Math.max(1, Math.floor(1100 / overviewTile.h));
    await mkdir(path.join(temp, "o"));
    await ffmpeg(["-i", video, "-an", "-vf", `fps=2,scale=${overviewTile.w}:${overviewTile.h}`, "-q:v", "4", path.join(temp, "o", "%05d.jpg")]);
    const overview = (await framesIn(path.join(temp, "o"))).map((file, n) => ({ path: file, t: n * 0.5, tag: `${(n * 0.5).toFixed(1)}s` }));
    const perSheet = columns * rowsPerSheet;
    for (let start = 0; start < overview.length; start += perSheet) {
      const part = overview.slice(start, start + perSheet);
      const name = `overview-${String(sheets.overview.length + 1).padStart(2, "0")}.jpg`;
      await drawSheet([{ label: `2 fps, ${part[0].t.toFixed(1)} to ${part.at(-1).t.toFixed(1)} s, left to right, top to bottom`, files: part }], overviewTile, columns, path.join(folder, name));
      sheets.overview.push({ file: name, from: part[0].t, to: part.at(-1).t });
    }

    if (strips.length) {
      const stripTile = tileSize(info.width, info.height, STRIP_TILE);
      const stripColumns = Math.max(1, Math.floor(SHEET_WIDTH / stripTile.w));
      await mkdir(path.join(temp, "s"));
      await ffmpeg(["-i", video, "-an", "-vf", `fps=12,scale=${stripTile.w}:${stripTile.h}`, "-q:v", "4", path.join(temp, "s", "%05d.jpg")]);
      const all = await framesIn(path.join(temp, "s"));
      const at = (t) => all[Math.min(all.length - 1, Math.round(t * 12))];
      for (let start = 0; start < strips.length; start += STRIPS_PER_SHEET) {
        const part = strips.slice(start, start + STRIPS_PER_SHEET);
        const rows = part.map((strip) => ({
          label: `cut${strip.cuts.length > 1 ? "s" : ""} at ${strip.cuts.map((t) => t.toFixed(2)).join(", ")} s (12 fps, ${strip.from.toFixed(2)} to ${strip.to.toFixed(2)} s; yellow = first frame after a cut)`,
          files: strip.times.map((t) => ({ path: at(t), tag: t.toFixed(2), cut: strip.cuts.some((cut) => t >= cut && t - cut < 1 / 12) })),
        }));
        const name = `strips-${String(sheets.strips.length + 1).padStart(2, "0")}.jpg`;
        await drawSheet(rows, stripTile, stripColumns, path.join(folder, name));
        sheets.strips.push({ file: name, cuts: part.flatMap((strip) => strip.cuts) });
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  const sound = info.audio ? await soundFacts(video, duration, { words, curve }) : { notes: ["no audio track"] };
  const facts = {
    duration: Math.round(duration * 100) / 100,
    size: `${info.width}x${info.height}`,
    sourceFps: original.fps,
    loudness,
    cuts,
    motion,
    ...sound,
    sheets,
  };
  await writeFile(path.join(folder, "facts.json"), JSON.stringify(facts, null, 1));
  await writeFile(path.join(folder, "source.json"), JSON.stringify({ source: path.resolve(source), id, builtAt: new Date().toISOString() }, null, 1));
  return { id, folder, facts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const source = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--out");
  if (!source) {
    console.error("usage: node evals/taste/packet.mjs <video.mp4> [--out <folder>] [--no-words]");
    process.exit(2);
  }
  const outIndex = args.indexOf("--out");
  const { id, folder, facts } = await buildPacket(source, { out: outIndex >= 0 ? args[outIndex + 1] : null, words: !args.includes("--no-words") });
  console.log(JSON.stringify({ id, folder, duration: facts.duration, cuts: facts.cuts.length, sheets: facts.sheets.overview.length + facts.sheets.strips.length,
    loudness: facts.loudness && { integrated: facts.loudness.integrated, range: facts.loudness.range, truePeak: facts.loudness.truePeak }, notes: facts.notes }));
}
