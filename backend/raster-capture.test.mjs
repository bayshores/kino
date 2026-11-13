import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { capturePage, captureFrame, drawingRenderer, exitOnUncaught, exitWithParent, frameMarker, rgbaPixels } = require("../desktop/raster-worker.cjs");

// A stand-in for Electron's webContents whose first `failures` captures reject with `message`.
function contentsThatFail(failures, message = "UnknownVizError") {
  return {
    captures: 0,
    invalidations: 0,
    async capturePage() {
      this.captures += 1;
      if (this.captures <= failures) throw new Error(message);
      return "frame";
    },
    invalidate() { this.invalidations += 1; },
  };
}
const noWait = async () => {};

test("a capture with no frame ready is retried after asking Chromium for a new frame", async () => {
  const contents = contentsThatFail(2);
  assert.equal(await capturePage(contents, noWait), "frame");
  assert.equal(contents.captures, 3);
  assert.equal(contents.invalidations, 2);
});

test("a capture gives up after five attempts and never retries other errors", async () => {
  const stuck = contentsThatFail(Infinity);
  await assert.rejects(capturePage(stuck, noWait), /^Error: UnknownVizError$/);
  assert.equal(stuck.captures, 5);

  const gone = contentsThatFail(1, "Frame Gone");
  await assert.rejects(capturePage(gone, noWait), /Frame Gone/);
  assert.equal(gone.captures, 1);
  assert.equal(gone.invalidations, 0);
});

// A stand-in for a captured image: two rows under a width x height picture, an empty one that the
// picture may leak into (`leaked`) and the marker row, `grey`.
function capturedImage(width, height, grey, leaked = 0) {
  return {
    getSize: () => ({ width, height: height + 2 }),
    crop(area) {
      if (area.y === height + 1) return { toBitmap: () => Buffer.from([grey, grey, grey, 255]) };
      if (area.y === height) return { toBitmap: () => Buffer.from([leaked, leaked, leaked, 255]) };
      return { picture: area };
    },
  };
}

test("the grey row is read under an empty row, which a picture past the bottom edge may leak into", async () => {
  // Measured on a 1920x1080 frame with a zoomed video past the bottom: the row right under the
  // picture read 201 for the grey 208, so frames with that grey ran out of time.
  const marker = frameMarker(11);
  const contents = { captures: 0, async capturePage() { this.captures += 1; return capturedImage(4, 3, marker, 201); }, invalidate() {} };
  const image = await captureFrame(contents, { width: 4, height: 3, marker, wait: noWait });
  assert.deepEqual(image.picture, { x: 0, y: 0, width: 4, height: 3 });
  assert.equal(contents.captures, 1);
});

test("an export frame is captured only once the page shows this request's grey row", async () => {
  const marker = frameMarker(7);
  const shown = [frameMarker(6), frameMarker(6), marker];
  const contents = { captures: 0, async capturePage() { return capturedImage(4, 3, shown[this.captures++]); }, invalidate() {} };
  const image = await captureFrame(contents, { width: 4, height: 3, marker, wait: noWait });
  assert.deepEqual(image.picture, { x: 0, y: 0, width: 4, height: 3 });
  assert.equal(contents.captures, 3);
  // Requests that follow one another use greys far enough apart to tell them apart.
  for (let id = 1; id < 40; id += 1) assert.ok(Math.abs(frameMarker(id) - frameMarker(id + 1)) >= 16);
});

test("a frame that never shows its grey, or a wrong size, fails instead of returning another picture", async () => {
  let clock = 0;
  const stale = { async capturePage() { clock += 1_000; return capturedImage(4, 3, frameMarker(1)); }, invalidate() {} };
  await assert.rejects(captureFrame(stale, { width: 4, height: 3, marker: frameMarker(2), wait: noWait, timeout: 10_000, now: () => clock }),
    /did not draw the export frame in time/);
  const wrong = { async capturePage() { return capturedImage(5, 3, frameMarker(2)); }, invalidate() {} };
  await assert.rejects(captureFrame(wrong, { width: 4, height: 3, marker: frameMarker(2), wait: noWait }), /unexpected export size/);
});

test("a slow frame with no picture ready yet is waited for, within the time limit", async () => {
  let clock = 0;
  const marker = frameMarker(3);
  const slow = { captures: 0, async capturePage() {
    this.captures += 1; clock += 100;
    if (this.captures <= 12) throw new Error("UnknownVizError");
    return capturedImage(4, 3, marker);
  }, invalidate() {} };
  const image = await captureFrame(slow, { width: 4, height: 3, marker, wait: noWait, now: () => clock });
  assert.deepEqual(image.picture, { x: 0, y: 0, width: 4, height: 3 });
  assert.equal(slow.captures, 13);

  clock = 0;
  const never = { async capturePage() { clock += 1_000; throw new Error("UnknownVizError"); }, invalidate() {} };
  await assert.rejects(captureFrame(never, { width: 4, height: 3, marker, wait: noWait, timeout: 10_000, now: () => clock }), /UnknownVizError/);
});

test("raw export pixels are RGBA whichever byte order Chromium keeps them in", () => {
  // Two pixels: opaque orange, and blue at half alpha (premultiplied, as Chromium keeps it).
  const bgra = () => ({ toBitmap: () => Buffer.from([0, 128, 255, 255, 128, 0, 0, 128]) });
  assert.deepEqual([...rgbaPixels(bgra(), true)], [255, 128, 0, 255, 0, 0, 128, 128]);
  const rgba = () => ({ toBitmap: () => Buffer.from([255, 128, 0, 255, 0, 0, 128, 128]) });
  assert.deepEqual([...rgbaPixels(rgba(), false)], [255, 128, 0, 255, 0, 0, 128, 128]);
});

// A stand-in for Electron's app whose feature status is `before` until the GPU process reports
// (report()), then `after`, as Chromium's is: "disabled_software" until its GPU process reports.
function gpuThatReports({ before, after = before, info = async () => ({}) }) {
  let reported = false, report;
  const gpu = {
    infoAsked: 0,
    getGPUFeatureStatus: () => reported ? after : before,
    getGPUInfo() { gpu.infoAsked += 1; return info(); },
  };
  const arrived = new Promise(resolve => { report = () => { reported = true; resolve(); }; });
  return { gpu, arrived, report };
}
const SOFTWARE = { gpu_compositing: "disabled_software", rasterization: "disabled_software" };
const HARDWARE = { gpu_compositing: "enabled", rasterization: "enabled" };
// A wait that never ends, and the time limits it was asked for.
function waitsForever() {
  const asked = [];
  return { asked, wait: milliseconds => { asked.push(milliseconds); return new Promise(() => {}); } };
}

test("a GPU report that comes late is waited for, and the page's WebGL names the card when getGPUInfo does not", async () => {
  // WSLg with Mesa's d3d12 driver: the report came 3 to 5 s after the start, and getGPUInfo had no GL renderer.
  const { gpu, arrived, report } = gpuThatReports({ before: SOFTWARE, after: HARDWARE,
    info: async () => ({ auxAttributes: { glImplementationParts: "(gl=none,angle=none)" }, gpuDevice: [{ active: false }] }) });
  const { asked, wait } = waitsForever();
  let pageAsked = 0;
  const answer = drawingRenderer(false, { gpu, reported: arrived, wait,
    askPage: async () => { pageAsked += 1; return "ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4090), OpenGL 4.6)"; } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(gpu.infoAsked, 0, "nothing is read before the report");
  report();
  assert.deepEqual(await answer, { renderer: "D3D12 (NVIDIA GeForce RTX 4090)", card: true });
  assert.equal(pageAsked, 1);
  assert.equal(asked[0], 60_000, "the report is waited for no longer than a minute");
});

test("a status still on the processor after the GPU report is the processor, and the page is not asked", async () => {
  // Xvfb, as on CI: the report came 0.1 s after the start, and getGPUInfo rejects.
  const { gpu, arrived, report } = gpuThatReports({ before: SOFTWARE, info: async () => { throw new Error("GPU access not allowed."); } });
  report();
  const answer = await drawingRenderer(false, { gpu, reported: arrived, wait: waitsForever().wait, askPage: () => assert.fail("no card to name") });
  assert.deepEqual(answer, { renderer: "processor (software)", card: false });
});

test("a status that names the card at once is not waited for, and no report in time claims nothing", async () => {
  const metal = { auxAttributes: { glRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)" } };
  const atOnce = gpuThatReports({ before: HARDWARE, info: async () => metal });
  const { asked, wait } = waitsForever();
  assert.deepEqual(await drawingRenderer(false, { gpu: atOnce.gpu, reported: atOnce.arrived, wait, askPage: () => assert.fail("getGPUInfo named it") }),
    { renderer: "Apple M3 Pro (Metal)", card: true });
  assert.ok(!asked.includes(60_000), "no wait for a report");
  // A GPU process that has not reported within the time limit: the early status is not an answer.
  const silent = gpuThatReports({ before: SOFTWARE });
  assert.deepEqual(await drawingRenderer(false, { gpu: silent.gpu, reported: silent.arrived, wait: async () => {} }), { renderer: null, card: null });
  assert.equal(silent.gpu.infoAsked, 0);
  // Hardware acceleration off: the processor, without asking Chromium.
  assert.deepEqual(await drawingRenderer(true, { gpu: { getGPUFeatureStatus: () => assert.fail("not asked") } }), { renderer: "processor (software)", card: false });
});

test("an export worker exits once its parent is gone (it becomes process 1's child)", { skip: process.platform === "win32" }, async () => {
  let parent = 4242, exits = 0;
  const timer = exitWithParent(4242, { every: 10, current: () => parent, exit: () => { exits += 1; } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(exits, 0, "the parent is still there");
  parent = 1;
  await new Promise((resolve) => setTimeout(resolve, 40));
  clearInterval(timer);
  assert.ok(exits >= 1, "the orphaned worker exits");
  // An uncaught error (EPIPE once the parent is gone) exits too, instead of Electron's error dialog.
  let quits = 0;
  const quit = exitOnUncaught({ exit: () => { quits += 1; }, write: () => { throw new Error("EPIPE"); } });
  quit(new Error("write EPIPE"));
  process.off("uncaughtException", quit);
  process.off("unhandledRejection", quit);
  assert.equal(quits, 1, "an uncaught error exits even when the parent's pipe is gone");
});
