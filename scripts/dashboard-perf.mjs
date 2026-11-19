#!/usr/bin/env node
// Measures what the kino desktop app's page costs when nothing plays: the main-thread time a
// second while idle, and the main-thread time one agent call adds (a status, then an edit), from
// a Chrome trace. Hand-run, not part of npm test. Build first (npm run build); the window is
// invisible, silent and uses its own profile.
//
//   node scripts/dashboard-perf.mjs --data <data folder> [--seconds 10] [--calls 20] [--json out.json]
//
// --data is a kino data folder (MOTION_DATA_DIR) whose agent/current.json opens the project to
// measure. Use a copy, never the owner's: the edits move its first layer.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const args = { seconds: "10", calls: "20", size: "1440x900" };
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.data) throw new Error("Give --data <kino data folder>.");
const [width, height] = args.size.split("x").map(Number);
const project = JSON.parse(await readFile(path.join(args.data, "agent", "current.json"), "utf8")).project;

const profile = await mkdtemp(path.join(tmpdir(), "kino-perf-profile-"));
const app = await electron.launch({ executablePath: require("electron"), args: [root, `--user-data-dir=${profile}`],
  env: { ...process.env, MOTION_DATA_DIR: path.resolve(args.data) } });
const results = {};
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.setFocusable(false); w.blur(); w.setOpacity(0); w.setIgnoreMouseEvents(true); w.webContents.setAudioMuted(true);
      w.setContentSize(size.width, size.height);
    }
  }, { width, height });
  await page.waitForSelector(".stage", { timeout: 60_000 });
  await page.waitForTimeout(6000);
  const { origin, ownerToken } = JSON.parse(await readFile(path.join(profile, "runtime.json"), "utf8"));
  const call = async (verb, body) => {
    const response = await fetch(`${origin}/api/agent/${verb}`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Kino-Owner": ownerToken, "x-kino-session": "perf-1" },
      body: JSON.stringify({ client: "perf", project, ...body }) });
    if (response.status !== 200) throw new Error(`${verb} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    await response.arrayBuffer();
  };
  const cdp = await page.context().newCDPSession(page);
  // The main thread's task time, in ms, while `work` runs.
  const traced = async (work) => {
    const threads = new Map();
    const tasks = [];
    const collect = ({ value }) => {
      for (const event of value) {
        if (event.ph === "M" && event.name === "thread_name") threads.set(`${event.pid}:${event.tid}`, event.args.name);
        else if (event.ph === "X" && event.name === "ThreadControllerImpl::RunTask") tasks.push([`${event.pid}:${event.tid}`, (event.dur ?? 0) / 1000]);
      }
    };
    cdp.on("Tracing.dataCollected", collect);
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.start", { categories: "toplevel", transferMode: "ReportEvents" });
    await work();
    await cdp.send("Tracing.end");
    await done;
    cdp.off("Tracing.dataCollected", collect);
    const main = [...threads].find(([, name]) => name === "CrRendererMain")?.[0];
    return tasks.filter(([thread]) => thread === main).reduce((sum, [, ms]) => sum + ms, 0);
  };
  const seconds = Number(args.seconds), calls = Number(args.calls);
  const idle = await traced(() => page.waitForTimeout(seconds * 1000));
  results.idleMsASecond = idle / seconds;
  // Each call waits for the page to settle (600 ms), so one call's follow-up work is all counted;
  // the idle cost of that wait is taken off.
  const perCall = async (verb, body) => {
    const total = await traced(async () => { for (let i = 0; i < calls; i++) { await call(verb, body(i)); await page.waitForTimeout(600); } });
    return (total - results.idleMsASecond * 0.6 * calls) / calls;
  };
  results.statusMs = await perCall("status", () => ({}));
  results.editMs = await perCall("edit", (i) => ({ ops: [{ op: "update_layer", layer: "L1", properties: { opacity: 0.5 + (i % 2) * 0.5 } }] }));
} finally {
  await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
if (args.json) await writeFile(args.json, JSON.stringify(results));
const round = (value) => Math.round(value * 10) / 10;
console.log(`page main thread: idle ${round(results.idleMsASecond)} ms a second; one status ${round(results.statusMs)} ms; one edit ${round(results.editMs)} ms`);
