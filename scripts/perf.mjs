#!/usr/bin/env node
// npm run perf: how long kino's agent calls and a movie export take on this machine. Hand-run,
// not part of npm test (AGENTS.md, Efficiency rules: a change to the store, the call path or the
// render path reports these numbers before and after).
//
//   node scripts/perf.mjs [--record <json>] [--baseline <json>] [--skip-export] [--skip-calls]
//
// Calls: a real server on a temporary data folder holding 1, 10 and 30 projects of 60 animated
// layers each; the median of 7 status, inspect, check and edit calls on one of them. A call's
// time should not grow with the number of projects.
// Export: a 4 s 1080p MP4 of 12 moving bars and a title, drawn by Resvg, in frames a second.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLayer, createScene } from "../engine/model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const has = (name) => process.argv.includes(name);
const recordPath = path.resolve(arg("--record") ?? path.join(root, ".local/perf/latest.json"));
const baseline = arg("--baseline") ? JSON.parse(await readFile(path.resolve(arg("--baseline")), "utf8")) : null;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;

const SIZES = [1, 10, 30];
const LAYERS = 60;
const RUNS = 7;

async function measureCalls() {
  const { startTestServer } = await import("../backend/media.test.support.mjs");
  const server = await startTestServer();
  const agent = async (verb, body = {}) => {
    const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "perf", ...body }, headers: { "x-kino-session": "perf-1" } });
    const answer = await response.json();
    if (response.status !== 200) throw new Error(`${verb} answered ${response.status}: ${JSON.stringify(answer).slice(0, 300)}`);
    return answer;
  };
  const timed = async (verb, body) => {
    const times = [];
    for (let run = 0; run < RUNS; run++) {
      const started = performance.now();
      await agent(verb, typeof body === "function" ? body(run) : body);
      times.push(performance.now() - started);
    }
    return round(median(times));
  };
  const results = {};
  let made = 0;
  try {
    for (const size of SIZES) {
      for (; made < size; made++) {
        const id = `perf-${made}`;
        await agent("project", { action: "create", id, name: id, width: 1920, height: 1080, duration: 6 });
        await agent("edit", { project: id, ops: Array.from({ length: LAYERS }, (_, index) => ({
          op: "add_layer", layerType: index % 3 ? "rectangle" : "text", name: `layer ${index}`,
          properties: { x: 40 + (index % 10) * 180, y: 60 + Math.floor(index / 10) * 160, width: 160, height: 120,
            ...(index % 3 ? { fill: "#3CC8B4" } : { text: `Line ${index}`, fontSize: 48, fill: "#F0F0F0" }) },
          animations: [{ preset: "preset-fade", start: (index % 12) * 0.2, duration: 0.6 }],
        })) });
      }
      const project = "perf-0";
      await agent("status", { project });
      results[size] = {
        status: await timed("status", { project }),
        inspect: await timed("inspect", { project, targets: ["s1"] }),
        check: await timed("check", { project, pixels: false }),
        edit: await timed("edit", (run) => ({ project, ops: [{ op: "update_layer", layer: "layer 1", properties: { x: 300 + run + size } }] })),
      };
    }
  } finally { await server.stop(); }
  return results;
}

function exportScene4s() {
  const layers = Array.from({ length: 12 }, (_, index) => createLayer("rectangle", {
    id: `bar-${index}`, name: `Moving bar ${index + 1}`, x: 120 + index * 137, y: 310, width: 86, height: 420, radius: 22,
    fill: index % 2 ? "#3CC8B4" : "#FF6B4A",
    animations: [{ id: `move-${index}`, name: "move", kind: "custom", start: 0, duration: 4, easing: "smooth",
      from: { y: 310 }, to: { y: 150 + (index % 4) * 90 } }],
  }));
  layers.push(createLayer("text", { id: "title", name: "Title", text: "kino / render study", x: 120, y: 75, width: 1650, height: 120,
    fontFamily: "Inter", fontWeight: 600, fontSize: 86, fill: "#F0F0F0" }));
  return createScene({ id: "perf-export", name: "perf export", width: 1920, height: 1080, duration: 4, background: "#101114", layers });
}

async function measureExport() {
  const { exportScene } = await import("../backend/export.mjs");
  const { loadBundledFonts } = await import("../backend/fonts.mjs");
  const fonts = await loadBundledFonts();
  const scene = exportScene4s();
  const directory = await mkdtemp(path.join(tmpdir(), "kino-perf-"));
  try {
    const results = {};
    for (const [name, options] of [["draft", {}], ["final", { renderQuality: "final" }]]) {
      const started = performance.now();
      await exportScene(scene, { format: "mp4", fps: 30, width: 1920, ...options }, { fonts, outputPath: path.join(directory, `${name}.mp4`) });
      const elapsed = performance.now() - started;
      results[name] = { seconds: round(elapsed / 1000), framesPerSecond: round(120 * 1000 / elapsed) };
    }
    return results;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const report = {
  commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  recordedAt: new Date().toISOString(),
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, node: process.version },
  calls: has("--skip-calls") ? null : await measureCalls(),
  export: has("--skip-export") ? null : await measureExport(),
};
await mkdir(path.dirname(recordPath), { recursive: true });
await writeFile(recordPath, `${JSON.stringify(report, null, 2)}\n`);

const was = (value) => (value === undefined ? "" : ` (was ${value})`);
if (report.calls) {
  console.log("agent calls, median ms:");
  for (const size of SIZES) {
    const row = report.calls[size];
    console.log(`  ${String(size).padStart(2)} projects: ${Object.entries(row).map(([verb, ms]) => `${verb} ${ms}${was(baseline?.calls?.[size]?.[verb])}`).join(", ")}`);
  }
}
if (report.export) {
  console.log("4 s 1080p MP4 export:");
  for (const [name, row] of Object.entries(report.export))
    console.log(`  ${name}: ${row.seconds} s, ${row.framesPerSecond} frames a second${was(baseline?.export?.[name]?.framesPerSecond)}`);
}
console.log(`saved ${path.relative(root, recordPath)}`);
// The export's render pool keeps idle workers for a moment; the numbers are saved, so stop now.
process.exit(0);
