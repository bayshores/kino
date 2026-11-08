// Log footage: the Apple Log curve, its Rec.709 conversion drawn on a video layer, and clips without log.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { Resvg } from "@resvg/resvg-js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createChromiumRasterizer } from "../backend/chromium-raster.mjs";
import { appleLogToLinear, appleLogToRec709, linearToAppleLog } from "./footageLog.js";
import { parseDocument, createDocument, createScene, createLayer } from "./model.js";
import { renderSceneSvg } from "./render.js";

let directory, chromium;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "kino-footage-log-"));
  chromium = await createChromiumRasterizer({ directory });
});
after(async () => {
  await chromium?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const within = (actual, expected, share, label) =>
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * share, `${label}: ${actual} vs ${expected}`);

test("the Apple Log curve maps known code values to scene light within 1%", () => {
  // Worked by hand from the white paper's formula: middle gray, the joint of the two pieces, the top.
  within(appleLogToLinear(0.4882725), 0.18, 0.01, "middle gray");
  within(appleLogToLinear(0.2085553), 0.01, 0.01, "joint");
  within(appleLogToLinear(1), 12.0004, 0.01, "top code value");
  assert.ok(Math.abs(appleLogToLinear(0.1504765)) < 1e-5, "black");
  for (const light of [0, 0.005, 0.01, 0.09, 0.18, 0.9, 4]) within(appleLogToLinear(linearToAppleLog(light)), light, 0.001, `round trip ${light}`);
  // Middle gray lands where Rec.709 puts it (0.409), and greys stay grey.
  const gray = appleLogToRec709(0.4882725, 0.4882725, 0.4882725);
  within(gray[0], 0.409, 0.01, "Rec.709 middle gray");
  assert.ok(Math.abs(gray[0] - gray[1]) < 1e-3 && Math.abs(gray[0] - gray[2]) < 1e-3);
});

// A 256 px gray ramp as a PNG data URL, drawn as a video layer's frame.
function rampFrame() {
  const canvas = createCanvas(256, 2);
  const context = canvas.getContext("2d");
  for (let x = 0; x < 256; x += 1) { context.fillStyle = `rgb(${x},${x},${x})`; context.fillRect(x, 0, 1, 2); }
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}
function rampScene(log) {
  return parseDocument(createDocument({ id: "log", scenes: [createScene({ id: "s", width: 256, height: 2, duration: 1, background: "#000000",
    layers: [createLayer("video", { id: "clip", src: "/api/media/clip.mp4", x: 0, y: 0, width: 256, height: 2, mediaSourceDuration: 1, ...(log === undefined ? {} : { log }) })] })] })).scenes[0];
}
// resvg (exports of scenes without effects); a log scene is drawn by Chromium (raster-policy.mjs).
function drawRamp(log) {
  const svg = renderSceneSvg(rampScene(log), 0, { raster: true, videoFrames: { clip: rampFrame() } });
  const pixels = new Resvg(svg).render().pixels;
  return { svg, row: Array.from({ length: 256 }, (_, x) => pixels[x * 4]) };
}

test("a gray ramp converts monotonically and close to the curve", async () => {
  // The conversion itself rises at every step of a fine ramp past black.
  let last = -1;
  for (let step = 0; step <= 1024; step += 1) {
    const [r, g, b] = appleLogToRec709(step / 1024, step / 1024, step / 1024);
    assert.ok(Math.abs(r - g) < 1e-3 && Math.abs(r - b) < 1e-3, "grays stay gray");
    assert.ok(step / 1024 <= linearToAppleLog(0) ? r === 0 : r > last, `step ${step}`);
    last = r;
  }
  // Drawn (Chromium, as exports draw it): close to the curve; the LUT drawing's 8-bit steps may
  // wobble by 1/255 but never fall further.
  const svg = renderSceneSvg(rampScene("apple-log"), 0, { videoFrames: { clip: rampFrame() } });
  const image = await loadImage((await chromium.render(svg, 256, 2)).buffer);
  const canvas = createCanvas(256, 2);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const pixels = canvas.getContext("2d").getImageData(0, 0, 256, 1).data;
  const row = Array.from({ length: 256 }, (_, x) => pixels[x * 4]);
  let largest = 0;
  for (let x = 0; x < 256; x += 1) {
    largest = Math.max(largest, Math.abs(row[x] - Math.round(appleLogToRec709(x / 255, x / 255, x / 255)[0] * 255)));
    if (x) assert.ok(row[x] >= row[x - 1] - 1, `step ${x}: ${row[x - 1]} -> ${row[x]}`);
    if (x >= 8) assert.ok(row[x] > row[x - 8] || row[x] >= 245 || row[x] === 0, `rising by ${x}: ${row[x - 8]} -> ${row[x]}`);
  }
  assert.ok(largest <= 6, `largest error ${largest}/255`);
  assert.ok(Math.abs(row[125] - 104) <= 3, `log middle gray ${row[125]} near Rec.709's 104`);
});

test("a clip without log draws exactly as before", () => {
  const plain = drawRamp(undefined);
  assert.deepEqual(drawRamp(null), plain, "log null is no log");
  assert.doesNotMatch(plain.svg, /feComponentTransfer|feColorMatrix/);
  assert.deepEqual(plain.row, Array.from({ length: 256 }, (_, x) => x));
  const layer = (type, extra) => createLayer(type, { id: "l", ...extra });
  const parse = (item) => parseDocument(createDocument({ id: "d", scenes: [createScene({ id: "s", layers: [item] })] }));
  assert.equal(Object.hasOwn(parse(layer("video", { src: "/api/media/a.mp4" })).scenes[0].layers[0], "log"), false);
  assert.throws(() => parse(layer("image", { src: "/api/media/a.png", log: "apple-log" })), /log/);
  assert.throws(() => parse(layer("video", { src: "/api/media/a.mp4", log: "s-log3" })), /apple-log/);
});
