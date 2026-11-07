// A6: exact decoded-frame regression and 1080p throughput on a named, reproducible scene.
// Run before a renderer change with --record <json>, then with --baseline <json> --record <json>.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, arch, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { scenes } from "../tests/golden/scenes.mjs";
import { renderFrame, fonts } from "../tests/golden/render.mjs";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "../backend/export.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const recordPath = path.resolve(arg("--record") ?? path.join(root, ".local/a6-evidence/benchmark.json"));
const final = process.argv.includes("--final");
const count = Number(arg("--frames") ?? 60);
assert.ok(Number.isInteger(count) && count >= 10 && count <= 120);
const baseline = arg("--baseline") ? JSON.parse(await readFile(path.resolve(arg("--baseline")), "utf8")) : null;

export function benchmarkScene() {
  const layers = Array.from({ length: 12 }, (_, index) => createLayer("rectangle", {
    id: `bar-${index}`, name: `Moving bar ${index + 1}`, x: 120 + index * 137, y: 310,
    width: 86, height: 420, radius: 22, fill: index % 2 ? "#3CC8B4" : "#FF6B4A",
    animations: [{ id: `move-${index}`, name: "move", kind: "custom", start: 0, duration: 4,
      easing: "smooth", from: { y: 310 }, to: { y: 150 + (index % 4) * 90 } }],
  }));
  layers.push(createLayer("text", { id: "title", name: "Title", text: "kino / render study",
    x: 120, y: 75, width: 1650, height: 120, fontFamily: "Inter", fontWeight: 600, fontSize: 86, fill: "#F0F0F0" }));
  return createScene({ id: "a6-render-study", name: "A6 1080p render study", width: 1920, height: 1080,
    duration: 4, background: "#101114", layers });
}

const identities = [];
for (const fixture of scenes) for (const time of fixture.times) {
  const buffer = await renderFrame(fixture, time);
  const bitmap = await loadImage(buffer);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0);
  identities.push({ name: `${fixture.name}@${time}`, width: bitmap.width, height: bitmap.height,
    rgba: sha(context.getImageData(0, 0, bitmap.width, bitmap.height).data), png: sha(buffer) });
}
if (baseline) assert.deepEqual(identities, baseline.identities, "Every pre-change PNG and decoded RGBA hash must match");

const scene = benchmarkScene();
const quality = final ? { motionBlur: 0.5, dither: true } : {};
for (let index = 0; index < 2; index++) await exportScene(scene, { format: "png", time: index / 30, width: 1920, ...quality }, { fonts });
const latencies = [];
let next = 0;
let lastFrame;
const started = performance.now();
await Promise.all(Array.from({ length: 2 }, async () => {
  for (;;) {
    const index = next++;
    if (index >= count) return;
    const frameStart = performance.now();
    const result = await exportScene(scene, { format: "png", time: (index + 0.5) / 30, width: 1920, ...quality }, { fonts });
    latencies.push(performance.now() - frameStart);
    lastFrame = result.buffer;
  }
}));
const elapsed = performance.now() - started;
latencies.sort((a, b) => a - b);
const report = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  rendererSourceSha256: sha(await readFile(path.join(root, "backend/export.mjs"))),
  recordedAt: new Date().toISOString(), machine: { cpu: cpus()[0]?.model, cores: cpus().length,
    platform: platform(), arch: arch(), ramGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
  fixture: { name: scene.name, sceneSha256: sha(JSON.stringify(scene)), width: 1920, height: 1080,
    layers: scene.layers.length, frames: count, concurrency: 2, warmupFrames: 2, quality },
  timing: { elapsedMs: elapsed, msPerFrame: elapsed / count, fps: count * 1000 / elapsed,
    medianLatencyMs: latencies[Math.floor(latencies.length / 2)], p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] },
  identity: { compared: Boolean(baseline), frames: identities.length, exact: baseline ? true : null }, identities,
};
await mkdir(path.dirname(recordPath), { recursive: true });
await writeFile(recordPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(path.dirname(recordPath), final ? "benchmark-final.png" : "benchmark-standard.png"), lastFrame);
console.log(JSON.stringify({ ...report, identities: undefined }, null, 2));
if (process.argv.includes("--gate")) assert.ok(elapsed / count <= 50, `1080p throughput ${elapsed / count} ms/frame exceeds 50 ms`);
