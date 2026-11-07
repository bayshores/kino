#!/usr/bin/env node
// Measures live playback in the kino desktop app (Electron): plays the open project's scene in
// real time and prints, per 5 s of scene time, the new pictures shown a second, the display
// frames a second, the worst wait between two new pictures, and the video seeks, plus the
// per-frame SVG parse cost, how many video frames were captured as pictures, and the pictures the
// preview cache's segment videos showed; then the five worst waits, garbage collection time and
// main-thread time (from a Chrome trace). Hand-run, not
// part of npm test. Build first (npm run build); the app is muted and uses its own profile.
//
//   node scripts/playback-perf.mjs --data <data folder> [--seconds 84] [--size 1440x900] [--json out.json]
//
// --data is a kino data folder (MOTION_DATA_DIR) whose agent/current.json opens the project to
// measure. Use a copy (store.json with only that project, media symlinked), never the owner's.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const args = { seconds: "84", size: "1440x900" };
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.data) throw new Error("Give --data <kino data folder>.");
const [width, height] = args.size.split("x").map(Number);

const profile = await mkdtemp(path.join(tmpdir(), "kino-perf-profile-"));
const app = await electron.launch({ executablePath: require("electron"), args: [root, `--user-data-dir=${profile}`],
  env: { ...process.env, MOTION_DATA_DIR: path.resolve(args.data) } });
const TRACED = new Set(["MinorGC", "MajorGC", "ThreadControllerImpl::RunTask", "FireAnimationFrame"]);
const trace = [];
let rec;
try {
  const page = await app.firstWindow();
  const mute = (size) => app.evaluate(({ BrowserWindow }, size) => {
    for (const w of BrowserWindow.getAllWindows()) { w.webContents.setAudioMuted(true); if (size) w.setContentSize(size.width, size.height); }
  }, size);
  await mute({ width, height });
  await page.waitForSelector(".stage", { timeout: 60_000 });
  await page.waitForTimeout(6000);
  await mute();
  await page.evaluate(() => {
    const rec = window.__playbackPerf = { frames: [], seeks: [], rates: 0, captures: 0, parse: [], cached: [] };
    // Pictures the preview cache's segment videos put on screen (previewCache.jsx).
    const watchSegment = (video) => {
      if (video.perfWatched) return;
      video.perfWatched = true;
      const count = (now) => { if (video.style.visibility === "visible") rec.cached.push(now); video.requestVideoFrameCallback(count); };
      video.requestVideoFrameCallback(count);
    };
    const watchAll = () => { for (const video of document.querySelectorAll("video[data-preview-segment]")) watchSegment(video); };
    watchAll();
    new MutationObserver(watchAll).observe(document.body, { subtree: true, childList: true });
    let changed = false;
    new MutationObserver(() => { changed = true; }).observe(document.querySelector(".stage"), { subtree: true, childList: true, attributes: true, characterData: true });
    const loop = (now) => {
      rec.frames.push([now, document.querySelector(".stage-timecode")?.textContent ?? "", changed]);
      changed = false;
      if (!rec.stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    document.addEventListener("seeking", (event) => rec.seeks.push([performance.now(), event.target.dataset?.mediaLayerId ?? "?"]), true);
    document.addEventListener("ratechange", () => { rec.rates += 1; }, true);
    const create = URL.createObjectURL;
    URL.createObjectURL = (blob) => { rec.captures += 1; return create.call(URL, blob); };
    const parse = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function (text, type) {
      const start = performance.now(); const result = parse.call(this, text, type);
      rec.parse.push([start, performance.now() - start, text.length]); return result;
    };
    rec.started = performance.now();
  });
  // Trace the page's main thread: garbage collection, tasks and animation frames.
  const cdp = await page.context().newCDPSession(page);
  const threads = new Map();
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const event of value) {
      if (event.ph === "M" && event.name === "thread_name") threads.set(`${event.pid}:${event.tid}`, event.args.name);
      else if (event.ph === "X" && TRACED.has(event.name)) trace.push([`${event.pid}:${event.tid}`, event.name, event.ts / 1000, (event.dur ?? 0) / 1000]);
    }
  });
  const traced = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.start", { categories: "toplevel,devtools.timeline,v8", transferMode: "ReportEvents" });
  await page.keyboard.press(" ");
  await page.waitForTimeout(Number(args.seconds) * 1000);
  await page.keyboard.press(" ");
  rec = await page.evaluate(() => { window.__playbackPerf.stop = true; return window.__playbackPerf; });
  await cdp.send("Tracing.end");
  await traced;
  const main = [...threads].find(([, name]) => name === "CrRendererMain")?.[0];
  rec.trace = trace.filter(([thread]) => thread === main);
} finally {
  await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
if (args.json) await writeFile(args.json, JSON.stringify(rec));

// The stage's timecode is minutes:seconds:frames at 30 fps.
const seconds = (code) => { const [m, s, f] = code.split(" ")[0].split(":").map(Number); return m * 60 + s + f / 30; };
const frames = rec.frames.filter(([at, code]) => at >= rec.started && code); // no timecode: playback over
const sceneAt = (at) => { let found = frames[0]; for (const frame of frames) { if (frame[0] > at) break; found = frame; } return seconds(found[1]); };
const rows = {};
let previous = null, lastNew = null;
for (const [at, code] of frames) {
  const row = (rows[Math.floor(seconds(code) / 5) * 5] ??= { wall: 0, pictures: 0, displays: 0, worst: 0, seeks: 0, parse: 0, parses: 0, cached: 0 });
  if (previous && at - previous[0] < 2000) row.wall += at - previous[0];
  row.displays += 1;
  if (previous && code !== previous[1]) { row.pictures += 1; if (lastNew !== null) row.worst = Math.max(row.worst, at - lastNew); lastNew = at; }
  previous = [at, code];
}
for (const [at] of rec.seeks) if (at >= rec.started) rows[Math.floor(sceneAt(at) / 5) * 5].seeks += 1;
for (const at of rec.cached) if (at >= rec.started) { const row = rows[Math.floor(sceneAt(at) / 5) * 5]; if (row) row.cached += 1; }
for (const [at, ms] of rec.parse) if (at >= rec.started) { const row = rows[Math.floor(sceneAt(at) / 5) * 5]; row.parse += ms; row.parses += 1; }
console.log("scene s  pictures/s  display/s  worst wait ms  seeks  svg parse ms/frame  cached pictures/s");
for (const [start, row] of Object.entries(rows).sort((a, b) => a[0] - b[0])) {
  const wall = row.wall / 1000 || 1;
  console.log(`${String(start).padStart(3)}-${String(+start + 5).padEnd(3)} ${(row.pictures / wall).toFixed(1).padStart(9)} ${(row.displays / wall).toFixed(0).padStart(10)} ${row.worst.toFixed(0).padStart(14)} ${String(row.seeks).padStart(6)} ${(row.parse / Math.max(1, row.parses)).toFixed(2).padStart(19)} ${(row.cached / wall).toFixed(1).padStart(18)}`);
}
console.log(`video frames captured as pictures: ${rec.captures}; playback rate changes: ${rec.rates}`);

// Whole run: pictures a second, five worst waits, garbage collection and main-thread time.
const waits = [];
let pictures = 0;
for (let i = 1, last = null; i < frames.length; i++) {
  if (frames[i][1] === frames[i - 1][1]) continue;
  pictures += 1;
  if (last !== null) waits.push([frames[i][0] - last, seconds(frames[i][1])]);
  last = frames[i][0];
}
const wall = (frames.at(-1)[0] - frames[0][0]) / 1000;
waits.sort((a, b) => b[0] - a[0]);
const total = (name) => rec.trace.filter((event) => event[1] === name).reduce((sum, event) => sum + event[3], 0);
const gc = { minor: total("MinorGC"), major: total("MajorGC") };
console.log(`pictures/s ${(pictures / wall).toFixed(1)} over ${wall.toFixed(1)} s`);
console.log(`worst waits ms (at scene s): ${waits.slice(0, 5).map(([ms, at]) => `${ms.toFixed(0)} (${at.toFixed(1)})`).join(", ")}`);
console.log(`garbage collection ms: ${(gc.minor + gc.major).toFixed(0)} (minor ${gc.minor.toFixed(0)}, major ${gc.major.toFixed(0)}); longest ${Math.max(0, ...rec.trace.filter((event) => event[1].endsWith("GC")).map((event) => event[3])).toFixed(0)}`);
console.log(`main thread ms a picture: animation frames ${(total("FireAnimationFrame") / Math.max(1, pictures)).toFixed(1)}, all tasks ${(total("ThreadControllerImpl::RunTask") / Math.max(1, pictures)).toFixed(1)}`);
