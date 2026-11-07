// Hand-run: measures the built-in music's drops with the rule in backend/sound-library.mjs
// (musicDrop) and prints old and new values. Never plays audio: FFmpeg's ebur128 meters each file.
//   node scripts/sound-library-measure.mjs <folder> [--write] [id ...]
// <folder> keeps the downloads (checked against the catalog's SHA-256) for the next run; --write
// puts the new drops into assets/sound-library.json. One FFmpeg at a time.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { CATALOG_FILE, musicDrop } from "../backend/sound-library.mjs";

const [folder, ...rest] = process.argv.slice(2);
if (!folder) { console.error("usage: node scripts/sound-library-measure.mjs <folder> [--write] [id ...]"); process.exit(1); }
const write = rest.includes("--write");
const only = rest.filter((arg) => arg !== "--write");
mkdirSync(folder, { recursive: true });

let text = readFileSync(CATALOG_FILE, "utf8");
const catalog = JSON.parse(text);
for (const track of catalog.music.filter((entry) => !only.length || only.includes(entry.id))) {
  const file = path.join(folder, `${track.id}.mp3`);
  if (!existsSync(file)) {
    const response = await fetch(track.url);
    if (!response.ok) { console.log(`${track.id}: download answered ${response.status}`); continue; }
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== track.sha256) { console.log(`${track.id}: SHA-256 differs, skipped`); continue; }
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const level = (value) => (value === "-inf" ? -120 : Number(value));
  const curve = [...run.stderr.matchAll(/t:\s*([\d.]+)\s.*?M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)/g)].map(([, t, m, s]) => [Number(t), level(s), level(m)]);
  const drop = musicDrop(curve);
  console.log(`${track.id}: ${track.drop ?? "none"} -> ${drop ?? "none"}`);
  if (write && drop !== track.drop) {
    const at = text.indexOf(`"id":"${track.id}"`);
    const field = text.indexOf('"drop":', at);
    const close = text.indexOf(",", field);
    text = `${text.slice(0, field)}"drop":${drop}${text.slice(close)}`;
  }
}
if (write) writeFileSync(CATALOG_FILE, text);
