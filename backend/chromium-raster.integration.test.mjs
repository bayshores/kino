import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createChromiumRasterizer, rasterWorkerStarts } from "./chromium-raster.mjs";

const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="16" viewBox="0 0 20 16" preserveAspectRatio="none">${content}</svg>`;
const solid = svg('<rect width="20" height="16" fill="#c83278"/>');

async function pixels(buffer) {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

test("the desktop ES module entry starts an isolated export worker before app readiness", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kino-desktop-worker-"));
  let renderer;
  t.after(async () => { await renderer?.close(); await rm(directory, { recursive: true, force: true }); });
  renderer = await createChromiumRasterizer({ directory, dependencies: {
    workerEntry: fileURLToPath(new URL("../desktop/main.mjs", import.meta.url)),
    startupTimeoutMs: 10000,
  } });
  const frame = await pixels((await renderer.render(solid, 20, 16)).buffer);
  assert.deepEqual([frame.width, frame.height], [20, 16]);
  assert.deepEqual([...frame.data.slice(0, 4)], [200, 50, 120, 255]);
});

test("the isolated Chromium worker paints alpha, embedded images, deterministic frames and large export sizes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kino-chromium-test-"));
  let renderer;
  t.after(async () => { await renderer?.close(); await rm(directory, { recursive: true, force: true }); });
  renderer = await createChromiumRasterizer({ directory });
  const first = await renderer.render(solid, 20, 16);
  const repeat = await renderer.render(solid, 20, 16);
  assert.deepEqual(first.buffer, repeat.buffer);
  const frame = await pixels(first.buffer);
  assert.deepEqual([frame.width, frame.height], [20, 16]);
  assert.deepEqual([...frame.data.slice(0, 4)], [200, 50, 120, 255]);
  const alpha = await pixels((await renderer.render(svg('<rect x="2" y="2" width="8" height="8" fill="#ff0000" opacity=".5"/>'), 20, 16)).buffer);
  assert.equal(alpha.data[3], 0);
  assert.ok(Math.abs(alpha.data[(4 * 20 + 4) * 4 + 3] - 128) <= 1);

  const embedded = createCanvas(1, 1);
  embedded.getContext("2d").fillStyle = "#00aa55";
  embedded.getContext("2d").fillRect(0, 0, 1, 1);
  const withImage = svg(`<image width="20" height="16" preserveAspectRatio="none" href="${embedded.toDataURL("image/png")}"/>`);
  const image = await pixels((await renderer.render(withImage, 20, 16)).buffer);
  assert.deepEqual([...image.data.slice(0, 4)], [0, 170, 85, 255]);

  // Mac export dimensions may exceed the visible display. Check both the PNG
  // header and far corner so a clamped or padded window cannot pass this check.
  const large = await pixels((await renderer.render(solid, 2400, 2400)).buffer);
  assert.deepEqual([large.width, large.height], [2400, 2400]);
  assert.deepEqual([...large.data.slice(-4)], [200, 50, 120, 255]);
  const nativeWidth = await pixels((await renderer.render(solid, 16384, 2)).buffer);
  assert.deepEqual([nativeWidth.width, nativeWidth.height], [16384, 2]);
  assert.deepEqual([...nativeWidth.data.slice(-4)], [200, 50, 120, 255]);
});

// The worker's Electron app (found by its folder) and the page renderers it started, however deep.
function pageRenderers(directory) {
  const processes = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  const app = processes.find(entry => entry.command.includes(`--kino-raster-directory=${directory}`) && !entry.command.includes("--type="));
  assert.ok(app, "the worker's app is running");
  const family = new Set([app.pid]);
  for (let added = true; added;) {
    added = false;
    for (const entry of processes) if (family.has(entry.ppid) && !family.has(entry.pid)) { family.add(entry.pid); added = true; }
  }
  return processes.filter(entry => family.has(entry.pid) && entry.command.includes("--type=renderer")).map(entry => entry.pid);
}

test("a worker whose page renderer is gone is replaced, and the reason it stopped says why", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "kino-chromium-gone-"));
  let renderer;
  t.after(async () => { await renderer?.close(); await rm(directory, { recursive: true, force: true }); });
  const stops = [];
  renderer = await createChromiumRasterizer({ directory, onWorkerStopped: stop => stops.push(stop) });
  await renderer.render(solid, 20, 16);
  const renderers = pageRenderers(directory);
  assert.ok(renderers.length >= 1, "the page has a renderer");
  const startsBefore = rasterWorkerStarts.count;
  for (const pid of renderers) process.kill(pid, "SIGKILL");
  // The worker exits. Whether it was drawing the next frame then or not, a new worker draws it,
  // and the frames after it, and the export is told why the first one stopped. Before, the export
  // ended with that reason. (Before that, the reason said only "exited with code 1".)
  for (const started = Date.now(); !stops.length && Date.now() - started < 10000;) {
    const frame = await pixels((await renderer.render(solid, 20, 16, { label: "frame 2" })).buffer);
    assert.deepEqual([...frame.data.slice(0, 4)], [200, 50, 120, 255]);
  }
  const after = await pixels((await renderer.render(solid, 20, 16)).buffer);
  assert.deepEqual([...after.data.slice(0, 4)], [200, 50, 120, 255]);
  t.diagnostic(stops.map(stop => `${stop.label}: ${stop.reason.message}`).join("; ") || "no stop");
  assert.equal(stops.length, 1);
  assert.match(stops[0].reason.message, /exited with code 1\. page renderer gone: [a-z-]+ \(exit code -?\d+\)/);
  assert.equal(rasterWorkerStarts.count - startsBefore, 1, "one new worker started");
  assert.equal(renderer.workers, 1);
});

test("the isolated Chromium worker sends raw RGBA pixels with premultiplied alpha at any size", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kino-chromium-pixels-test-"));
  let renderer;
  t.after(async () => { await renderer?.close(); await rm(directory, { recursive: true, force: true }); });
  renderer = await createChromiumRasterizer({ directory });
  // Red, green, blue and alpha in that order, whatever order Chromium keeps them in.
  const frame = await renderer.renderPixels(solid, 20, 16);
  assert.deepEqual([frame.width, frame.height, frame.pixels.length], [20, 16, 20 * 16 * 4]);
  assert.deepEqual([...frame.pixels.subarray(0, 4)], [200, 50, 120, 255]);
  assert.deepEqual([...frame.pixels.subarray(-4)], [200, 50, 120, 255]);
  // Half-transparent red is about 128 red at alpha 128 (premultiplied); outside it is all zero.
  const alpha = (await renderer.renderPixels(svg('<rect x="2" y="2" width="8" height="8" fill="#ff0000" opacity=".5"/>'), 20, 16)).pixels;
  assert.deepEqual([...alpha.subarray(0, 4)], [0, 0, 0, 0]);
  const inside = [...alpha.subarray((4 * 20 + 4) * 4, (4 * 20 + 4) * 4 + 4)];
  assert.ok(Math.abs(inside[0] - 128) <= 1 && inside[1] === 0 && inside[2] === 0 && Math.abs(inside[3] - 128) <= 1, `half red pixel ${inside}`);
  // A PNG request between pixel requests still answers a PNG file.
  assert.deepEqual([...(await pixels((await renderer.render(solid, 20, 16)).buffer)).data.slice(0, 4)], [200, 50, 120, 255]);
  // Big frames arrive whole, with no padding at the end of a row.
  for (const [width, height] of [[1920, 1080], [2400, 2400], [16384, 2]]) {
    const large = await renderer.renderPixels(solid, width, height);
    assert.equal(large.pixels.length, width * height * 4);
    assert.deepEqual([...large.pixels.subarray(-4)], [200, 50, 120, 255], `${width}×${height}`);
  }
});

// Chromium's GPU process says what it draws with a while after the start (3 to 5 s on WSLg), and
// its status says "disabled_software" until then; the worker says it once that report has come,
// in its ready line or the first frame's answer (desktop/raster-worker.cjs drawingRenderer). Under
// Xvfb, as on CI, the frames are drawn on the processor; on WSLg's own display (no xvfb-run) on
// the graphics card.
test("a worker says what draws its frames: the card or the processor, as Chromium's GPU process reported", async t => {
  const directories = [];
  const renderers = [];
  t.after(async () => {
    for (const renderer of renderers) await renderer.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });
  const start = async graphics => {
    const directory = await mkdtemp(join(tmpdir(), "kino-chromium-drawing-"));
    directories.push(directory);
    const renderer = await createChromiumRasterizer({ directory, graphics });
    renderers.push(renderer);
    await renderer.render(solid, 20, 16);
    return renderer.renderers();
  };
  assert.deepEqual(await start("processor"), [{ renderer: "processor (software)", card: false }]);
  const [auto, ...others] = await start("auto");
  assert.equal(others.length, 0);
  assert.equal(typeof auto.renderer, "string", "Chromium said what it draws with");
  assert.equal(auto.card, !auto.renderer.startsWith("processor"), auto.renderer);
  const wslgDisplay = existsSync("/dev/dxg") && existsSync("/tmp/.X11-unix/X0") && [undefined, ":0"].includes(process.env.DISPLAY);
  if (wslgDisplay && process.env.KINO_RASTER_GPU !== "off") assert.equal(auto.card, true, `WSLg draws on the card: ${auto.renderer}`);
  t.diagnostic(`auto draws with ${auto.renderer}`);
});

test("export SVG refuses scripts, event handlers, external images and external styles", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kino-chromium-boundary-"));
  let renderer;
  t.after(async () => { await renderer?.close(); await rm(directory, { recursive: true, force: true }); });
  renderer = await createChromiumRasterizer({ directory });
  for (const content of [
    '<script>throw new Error("must never execute")</script>',
    '<rect width="10" height="10" onload="document.body.remove()"/>',
    '<image width="10" height="10" href="file:///etc/hosts"/>',
    '<image width="10" height="10" href="http://127.0.0.1:9/private.png"/>',
    '<rect width="10" height="10" style="fill:url(https://example.com/paint.svg#color)"/>',
    '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">unavailable</div></foreignObject>',
  ]) await assert.rejects(renderer.render(svg(content), 20, 16), /unavailable|embedded raster/i);
  // Local references, including quoted references, remain usable after refusal.
  const local = svg('<defs><linearGradient id="paint"><stop stop-color="#c83278"/></linearGradient></defs><rect width="20" height="16" style="fill:url(\'#paint\')"/>');
  const localFrame = await renderer.render(local, 20, 16);
  const frame = await pixels(localFrame.buffer);
  assert.deepEqual([...frame.data.slice(0, 4)], [200, 50, 120, 255]);
  assert.deepEqual(localFrame.buffer, (await renderer.render(solid, 20, 16)).buffer,
    "different SVG markup with the same pixels has canonical PNG bytes for Lottie deduplication");
});
