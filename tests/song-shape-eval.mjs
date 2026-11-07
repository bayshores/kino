// Hand-run check of song shapes (not part of npm test): measures a few well-known songs from
// YouTube through kino's soundtrack measure (one at a time), prints the sections, features and
// vocal spans, and draws a spectrogram of each (low band and full range) to compare by eye.
//   node tests/song-shape-eval.mjs [--png <folder>] [youtube ids...]
// The audio is deleted after each song; the PNGs stay in the folder until you delete them.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeBeats } from "../engine/beatDetection.js";
import { decodeMono } from "../backend/audio-analysis.mjs";
import { ffmpegCommand } from "../backend/media-probe.mjs";
import { inspireTools } from "../backend/inspire.mjs";
import { songVocals } from "../backend/song-shape.mjs";
import { createSoundtrack } from "../backend/soundtrack.mjs";

const SONGS = {
  Cl6Rz1Uvi2M: "electronic song 1",
  G9Is3JYoXbA: "house song 1",
  "4NOqDd5USu0": "house song 2",
  SRVxRUJxITY: "electronic song 2",
  "L2_yy-B2eC4": "rap song 1",
};

const args = process.argv.slice(2);
const pngAt = args.indexOf("--png");
const pngFolder = pngAt >= 0 ? path.resolve(args.splice(pngAt, 2)[1]) : null;
const ids = args.length ? args : Object.keys(SONGS);
if (pngFolder) await mkdir(pngFolder, { recursive: true });

const tools = await inspireTools();
const directory = await mkdtemp(path.join(tmpdir(), "kino-song-shape-"));
const ffmpeg = ffmpegCommand();
const soundtrack = createSoundtrack({
  directory, enabled: () => false,
  downloadYouTube: async (id, folder) => {
    const file = await tools.downloadAudio(id, folder);
    if (pngFolder) {
      // Two spectrograms, one after the other: 20 to 400 Hz (kick and bass) and 20 Hz to 11 kHz.
      for (const [name, band] of [["low", "start=20:stop=400"], ["full", "start=20:stop=11000:fscale=log"]]) {
        spawnSync(ffmpeg, ["-v", "error", "-y", "-t", "240", "-i", file, "-lavfi", `showspectrumpic=s=1200x400:legend=1:${band}`, path.join(pngFolder, `${id}-${name}.png`)], { stdio: "inherit" });
      }
    }
    return file;
  },
  decode: (file) => decodeMono(file),
  analyze: (samples, rate) => analyzeBeats(samples, rate),
  vocals: (file, seconds) => songVocals(file, { seconds }),
});

try {
  for (const id of ids) {
    const started = Date.now();
    try {
      const m = await soundtrack.measure({ id: `yt:${id}`, source: "youtube" });
      console.log(`\n${id} ${SONGS[id] ?? ""} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      console.log(`  ${m.seconds}s · ${m.bpm ? Math.round(m.bpm) : "no"} bpm`);
      console.log(`  sections: ${m.sections.map((part) => `${part.kind} ${part.at}s`).join(", ") || "none"}`);
      console.log(`  features: ${JSON.stringify(m.features)}`);
      console.log(`  vocals (${m.vocalsBy}): ${m.vocals.map(([from, to]) => `${from}-${to}`).join(", ") || "none"}`);
    } catch (error) {
      console.log(`\n${id}: ${error.message}`);
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
