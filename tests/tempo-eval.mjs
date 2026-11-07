// Hand-run tempo check (not part of npm test): measures songs with published tempos and reports
// how often kino's beat analysis gets the tempo right.
//
//   node tests/tempo-eval.mjs                  measure every song (downloads what is not cached)
//   node tests/tempo-eval.mjs --module <file>  measure with another copy of engine/beatDetection.js
//   node tests/tempo-eval.mjs --only latch     just the songs whose title has these words
//   node tests/tempo-eval.mjs --clean          delete the cached sound and stop
//
// Each song is downloaded with kino's own YouTube path (yt-dlp, audio only, the first 4 minutes,
// as soundtrack measuring does), one at a time, decoded to mono 22,050 Hz, and the download is
// deleted. The decoded sound is cached as 16-bit samples in .scratch/tempo-eval/ so the analysis
// can be run again quickly; --clean deletes it.
//
// Accuracy1: the tempo is within 4% of the published one. Accuracy2: the same, or within 4% of
// 2x, 1/2x, 3x or 1/3x of it (the right pulse, the wrong octave or meter).
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(root, ".scratch", "tempo-eval");
const RATE = 22_050;
const SECONDS = 240;

// Published tempos, each with the page it was read from.
export const SONGS = [
  // No published tempo found (https://www.last.fm/music/Yxng+Demon lists none): measured, not scored.
  { title: "Yxng Demon - NO SLEEP", id: "hA6_t4oSsJM", genre: "uk garage", bpm: 0, source: "" },
  { title: "Jon Hopkins - Singularity", id: "lkvnpHFajt0", genre: "ambient electronica", bpm: 133, source: "https://songbpm.com/@jon-hopkins/singularity" },
  { title: "Fred again.. - Delilah (pull me out of this)", id: "Cl6Rz1Uvi2M", genre: "house", bpm: 134, source: "https://songbpm.com/@fred-again--/delilah-pull-me-out-of-this-IeyK0OH_vx" },
  { title: "Overmono - So U Kno", id: "SRVxRUJxITY", genre: "uk garage", bpm: 130, source: "https://songbpm.com/@overmono/so-u-kno-GyESyNCxQq" },
  // From Beatport's search snippet for the extended mix; no track page could be opened.
  { title: "Shift K3Y & Drinks On Me - Bittersweet", id: "G9Is3JYoXbA", genre: "uk garage", bpm: 132, source: "https://www.beatport.com/genre/garage-bassline-grime/86/tracks" },
  { title: "FENCHVRCH - Come Closer", id: "4NOqDd5USu0", genre: "uk garage", bpm: 134, source: "https://www.beatport.com/chart/dancefloor-essentials-2025-dance-pop/838754" },
  { title: "Moderat - A New Error", id: "QpxFcMYRV08", genre: "ambient electronica", bpm: 111, source: "https://songbpm.com/@moderat/a-new-error" },
  { title: "Kiasmos - Looped", id: "7tqCc6H51jw", genre: "ambient electronica", bpm: 120, source: "https://songbpm.com/@kiasmos/looped" },
  { title: "Daft Punk - One More Time", id: "A2VpR8HahKc", genre: "house", bpm: 123, source: "https://songbpm.com/@daft-punk/one-more-time-j82rc" },
  { title: "Disclosure - Latch", id: "93ASUImTedo", genre: "house", bpm: 122, source: "https://songbpm.com/@disclosure/latch" },
  { title: "Artful Dodger - Re-Rewind", id: "M0wv_cQv8As", genre: "uk garage", bpm: 130, source: "https://songbpm.com/@artful-dodger/re-rewind-feat--craig-david-uTT8_gIM1L" },
  { title: "Travis Scott - SICKO MODE", id: "d-JBBNg8YKs", genre: "hip hop", bpm: 155, source: "https://songbpm.com/@travis-scott/sicko-mode" },
  { title: "Kendrick Lamar - HUMBLE.", id: "ov4WobPqoSA", genre: "hip hop", bpm: 150, source: "https://songbpm.com/@kendrick-lamar/humble" },
  { title: "The Weeknd - Blinding Lights", id: "fHI8X4OXluQ", genre: "pop", bpm: 171, source: "https://songbpm.com/@the-weeknd/blinding-lights" },
  { title: "Dua Lipa - Levitating", id: "WHuBW3qKm9g", genre: "pop", bpm: 103, source: "https://songbpm.com/@dua-lipa/levitating" },
  { title: "Pendulum - Watercolour", id: "tEPB7uzKuh4", genre: "drum and bass", bpm: 174, source: "https://songbpm.com/@pendulum/watercolour" },
  { title: "Bicep - Glue", id: "A7ZxRs45tTg", genre: "techno", bpm: 130, source: "https://songbpm.com/@bicep/glue" },
  { title: "Billie Eilish - bad guy", id: "YD4utuFiexw", genre: "pop", bpm: 135, source: "https://songbpm.com/@billie-eilish/bad-guy" },
  { title: "Ed Sheeran - Shape of You", id: "nQrwTHTfhto", genre: "pop", bpm: 96, source: "https://songbpm.com/@ed-sheeran/shape-of-you" },
  { title: "Wilkinson - Afterglow", id: "I9QGpHScGug", genre: "drum and bass", bpm: 174, source: "https://songbpm.com/@wilkinson/afterglow" },
  { title: "Four Tet - Baby", id: "i1gVxKhdGPs", genre: "uk garage", bpm: 127, source: "https://songbpm.com/@four-tet/baby" },
  { title: "Charlotte de Witte - Doppler", id: "AS8Q_5knkrg", genre: "techno", bpm: 135, source: "https://songbpm.com/@charlotte-de-witte/doppler-MTkV80Vm-P" },
];

const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const close = (a, b) => Math.abs(a - b) <= 0.04 * b;
export const accuracy1 = (bpm, truth) => bpm != null && close(bpm, truth);
export const accuracy2 = (bpm, truth) => bpm != null && [1, 2, 0.5, 3, 1 / 3].some((factor) => close(bpm, truth * factor));

let tools;
async function soundOf(song) {
  const file = path.join(CACHE, `${slug(song.title)}.s16`);
  try {
    const bytes = await readFile(file);
    const ints = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    return Float32Array.from(ints, (value) => value / 32767);
  } catch { /* not cached yet */ }
  tools ??= await (await import("../backend/inspire.mjs")).inspireTools();
  const { decodeMono } = await import("../backend/audio-analysis.mjs");
  const folder = await mkdtemp(path.join(os.tmpdir(), "kino-tempo-"));
  try {
    const download = await tools.downloadAudio(song.id, folder);
    const { samples } = await decodeMono(download, { sampleRate: RATE });
    const limited = samples.subarray(0, RATE * SECONDS);
    await mkdir(CACHE, { recursive: true });
    const ints = Int16Array.from(limited, (value) => Math.max(-32767, Math.min(32767, Math.round(value * 32767))));
    await writeFile(file, Buffer.from(ints.buffer));
    return limited;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function main(args) {
  if (args.includes("--clean")) {
    await rm(CACHE, { recursive: true, force: true });
    console.log(`deleted ${CACHE}`);
    return;
  }
  if (args.includes("--fetch")) {
    for (const song of SONGS) {
      try { await soundOf(song); console.log(`cached ${song.title}`); }
      catch (error) { console.log(`failed ${song.title}: ${error.message.split("\n")[0]}`); }
    }
    return;
  }
  const moduleAt = args.includes("--module") ? path.resolve(args[args.indexOf("--module") + 1]) : path.join(root, "engine", "beatDetection.js");
  const { analyzeBeats } = await import(pathToFileURL(moduleAt).href);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].toLowerCase() : null;
  const songs = SONGS.filter((song) => !only || song.title.toLowerCase().includes(only));
  let right1 = 0, right2 = 0, count = 0;
  console.log("song | genre | published | measured | alt | confidence | acc1 | acc2");
  for (const song of songs) {
    let samples;
    try { samples = await soundOf(song); }
    catch (error) { console.log(`${song.title} | ${song.genre} | ${song.bpm} | (download failed: ${error.message.split("\n")[0]})`); continue; }
    const started = performance.now();
    const result = analyzeBeats(samples, RATE);
    const ms = Math.round(performance.now() - started);
    const one = accuracy1(result.bpm, song.bpm);
    const two = accuracy2(result.bpm, song.bpm);
    if (song.bpm > 0) { count += 1; right1 += one; right2 += two; }
    console.log(`${song.title} | ${song.genre} | ${song.bpm || "?"} | ${result.bpm ?? "none"} | ${result.alt ?? ""} | ${result.confidence} | ${one ? "yes" : "no"} | ${two ? "yes" : "no"} | ${ms} ms`);
  }
  console.log(`Accuracy1 ${right1}/${count} (${Math.round((100 * right1) / Math.max(1, count))}%) · Accuracy2 ${right2}/${count} (${Math.round((100 * right2) / Math.max(1, count))}%)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
