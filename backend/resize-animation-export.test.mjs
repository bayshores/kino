// A Resize animation with an anchor point (engine/resizeAnchor.js) exports the same box as the
// editor shows. PNG, GIF and video frames use the editor's SVG renderer; Lottie writes the
// evaluated size and position on every frame, so the anchor stays on the same spot there too.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { layerMatrix, point } from "../engine/geometry.js";
import { renderSceneSvg } from "../engine/render.js";
import { evaluateLayer } from "../engine/animation.js";
import { resizeTextLayer } from "../engine/textLayout.js";
import { exportScene } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { ffmpeg, near, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

function resize(anchor, from, to, extra = {}) {
  return {
    id: "resize", name: "Resize", kind: "custom", start: 0, duration: 1, easing: "linear", from, to,
    unit: "layer", stagger: 0, order: "forward", ...(anchor ? { anchor } : {}), ...extra,
  };
}

// A red 40 × 40 box whose bottom-right corner is at (90, 90) on a white 100 × 100 canvas grows to
// 80 × 80 around that corner: at 1 s it covers (10, 10) to (90, 90).
function growingBox(anchor = "bottom-right") {
  const box = createLayer("rectangle", {
    id: "box", name: "Box", x: 50, y: 50, width: 40, height: 40, fill: "#ff0000", strokeWidth: 0,
    animations: [resize(anchor, { width: 40, height: 40 }, { width: 80, height: 80 })],
  });
  return createScene({ id: "resize", name: "Resize", width: 100, height: 100, duration: 1, background: "#ffffff", layers: [box] });
}

const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];

test("PNG exports grow the box around its anchor like the editor's renderer", async () => {
  const scene = growingBox();
  // [time, a pixel that must be red, a pixel that must be white]
  for (const [time, red, white] of [[0, [85, 85], [45, 45]], [0.5, [35, 35], [25, 25]], [1, [15, 15], [5, 5]]]) {
    const exported = await readImage((await exportScene(scene, { format: "png", time })).buffer);
    const editor = await readImage(new Resvg(renderSceneSvg(scene, time)).render().asPng());
    for (const [x, y] of [red, white, [88, 88]])
      assert.deepEqual(exported.pixel(x, y), editor.pixel(x, y), `the export matches the editor at (${x}, ${y}), ${time} s`);
    assert.ok(near(exported.pixel(...red), RED), `(${red}) is inside the box at ${time} s`);
    assert.ok(near(exported.pixel(...white), WHITE), `(${white}) is outside the box at ${time} s`);
    assert.ok(near(exported.pixel(88, 88), RED), `the anchored corner stays covered at ${time} s`);
  }
  // Without an anchor the box keeps x and y and grows to the right and down instead.
  const legacy = await readImage((await exportScene(growingBox(null), { format: "png", time: 1 })).buffer);
  assert.ok(near(legacy.pixel(15, 15), WHITE) && near(legacy.pixel(95, 95), RED));
});

test("PNG exports keep a turned box's anchor in place", async () => {
  const scene = growingBox("top-left");
  scene.layers[0].rotation = 45;
  scene.layers[0].x = 30;
  scene.layers[0].y = 20;
  for (const time of [0, 0.5, 1]) {
    const exported = await readImage((await exportScene(scene, { format: "png", time })).buffer);
    const editor = await readImage(new Resvg(renderSceneSvg(scene, time)).render().asPng());
    for (const [x, y] of [[50, 30], [50, 60], [30, 70], [70, 50], [55, 85]])
      assert.deepEqual(exported.pixel(x, y), editor.pixel(x, y), `(${x}, ${y}) at ${time} s`);
  }
});

test("PNG sequence frames grow the box around its anchor", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-resize-sequence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sequenceDirectory = join(directory, "sequence");
  await mkdir(sequenceDirectory);
  await exportScene(growingBox(), { format: "png-sequence", fps: 4 }, { sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, 4, "0, 0.25, 0.5 and 0.75 s");
  const frames = await Promise.all(names.map(async (name) => readImage(await readFile(join(sequenceDirectory, name)))));
  // 40, 50, 60 and 70 px wide, always ending at (90, 90).
  assert.deepEqual(frames.map((frame) => near(frame.pixel(37, 37), RED)), [false, false, true, true]);
  assert.deepEqual(frames.map((frame) => near(frame.pixel(45, 45), RED)), [false, true, true, true]);
  assert.ok(frames.every((frame) => near(frame.pixel(88, 88), RED)), "the anchored corner stays covered");
});

test("GIF and video frames grow the box around its anchor over time", { skip: skipWithoutMediaTools }, async () => {
  const scene = growingBox();
  const frameBytes = 100 * 100 * 4;
  for (const [format, tolerance] of [["gif", 24], ["mp4", 48]]) {
    const result = await exportScene(scene, { format, fps: 4, width: 100, height: 100 });
    const frames = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: result.buffer });
    assert.ok(frames.length >= frameBytes * 4, `${format} has every frame`);
    const pixel = (frame, x, y) => [...frames.subarray(frame * frameBytes + (y * 100 + x) * 4, frame * frameBytes + (y * 100 + x) * 4 + 4)];
    // Frames 0, 2 and 3 of a 4 fps export are 0, 0.5 and 0.75 s: 40, 60 and 70 px wide.
    assert.ok(near(pixel(0, 35, 35), WHITE, tolerance), `${format} frame 0 is small ${pixel(0, 35, 35)}`);
    assert.ok(near(pixel(2, 35, 35), RED, tolerance), `${format} frame 2 reaches (35, 35) ${pixel(2, 35, 35)}`);
    assert.ok(near(pixel(2, 25, 25), WHITE, tolerance), `${format} frame 2 does not reach (25, 25) ${pixel(2, 25, 25)}`);
    assert.ok(near(pixel(3, 25, 25), RED, tolerance), `${format} frame 3 reaches (25, 25) ${pixel(3, 25, 25)}`);
    for (const frame of [0, 2, 3]) assert.ok(near(pixel(frame, 87, 87), RED, tolerance), `${format} frame ${frame} keeps the corner`);
  }
});

// The value of a Lottie property at `frame`: a still value, or the keyframes read the way a Lottie
// player does for these linear keys (between two keys it moves in a straight line from s to e).
function lottieValue(property, frame) {
  if (property.a !== 1) return property.k;
  const keys = property.k;
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    if (frame < key.t) continue;
    if (key.h === 1 || !key.e || index === keys.length - 1) return key.s;
    const amount = (frame - key.t) / (keys[index + 1].t - key.t);
    return key.s.map((value, axis) => value + (key.e[axis] - value) * amount);
  }
  return keys[0].s;
}

// Where the point at fraction (u, v) of an exported rectangle is drawn on the canvas at `frame`:
// the rectangle's own position and size, then the layer's anchor, scale, rotation and position
// (Lottie applies them in that order; these test layers have no skew and no parent).
function lottieRectanglePoint(layer, frame, u, v) {
  const rect = layer.shapes[0].it.find((item) => item.ty === "rc");
  const [cx, cy] = lottieValue(rect.p, frame);
  const [width, height] = lottieValue(rect.s, frame);
  const [ax, ay] = lottieValue(layer.ks.a, frame);
  const [px, py] = lottieValue(layer.ks.p, frame);
  const [sx, sy] = lottieValue(layer.ks.s, frame).map((percent) => percent / 100);
  const angle = (lottieValue(layer.ks.r, frame) * Math.PI) / 180;
  assert.ok(Math.abs(lottieValue(layer.ks.sk, frame)) < 1e-9, "no skew (a rounding-sized value is fine)");
  assert.equal(layer.parent, undefined);
  const qx = (cx + (u - 0.5) * width - ax) * sx;
  const qy = (cy + (v - 0.5) * height - ay) * sy;
  return { x: px + Math.cos(angle) * qx - Math.sin(angle) * qy, y: py + Math.sin(angle) * qx + Math.cos(angle) * qy, width, height };
}

function close(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: expected ${expected}, received ${actual}`);
}

test("Lottie keeps the anchor of a turned, scaled box in place on every frame and between frames", async () => {
  const card = createLayer("rectangle", {
    id: "card", name: "Card", x: 60, y: 50, width: 100, height: 60, rotation: 30, scaleX: 1.5, scaleY: 0.8, fill: "#3366ff", strokeWidth: 0,
    animations: [resize("bottom-right", { width: 100, height: 60 }, { width: 160, height: 30 }, { easing: "smooth" })],
  });
  // A second box that grows from its left edge while a Move carries it 100 px to the right.
  const slider = createLayer("rectangle", {
    id: "slider", name: "Slider", x: 20, y: 150, width: 40, height: 20, fill: "#00aa00", strokeWidth: 0,
    animations: [
      resize("left", { width: 40, height: 20 }, { width: 80, height: 40 }),
      { id: "move", name: "Move", kind: "custom", start: 0, duration: 1, easing: "linear", from: { x: 20 }, to: { x: 120 } },
    ],
  });
  const scene = createScene({ id: "lottie", name: "Lottie", width: 300, height: 200, duration: 1, layers: [card, slider] });
  const result = await exportScene(scene, { format: "lottie", fps: 4, imageDPIRatio: "original" });
  assert.deepEqual(result.warnings ?? [], [], "the anchor needs no warning");
  const animation = JSON.parse(result.buffer.toString("utf8"));
  assert.equal(animation.op, 4, "frames 0 to 4 are 0 s to 1 s");

  const exported = animation.layers.find((layer) => layer.nm === "Card");
  const resting = point(layerMatrix(card), card.width, card.height); // the editor's bottom-right corner
  const start = lottieRectanglePoint(exported, 0, 1, 1);
  const end = lottieRectanglePoint(exported, 4, 1, 1);
  assert.deepEqual([start.width, start.height, end.width, end.height], [100, 60, 160, 30], "the size changes between the two times");
  for (const frame of [0, 1, 1.5, 2, 3, 4]) {
    const corner = lottieRectanglePoint(exported, frame, 1, 1);
    close(corner.x, resting.x, `corner x at frame ${frame}`);
    close(corner.y, resting.y, `corner y at frame ${frame}`);
  }
  const opposite = [lottieRectanglePoint(exported, 0, 0, 0), lottieRectanglePoint(exported, 4, 0, 0)];
  assert.ok(Math.hypot(opposite[1].x - opposite[0].x, opposite[1].y - opposite[0].y) > 20, "the opposite corner moves");

  const moving = animation.layers.find((layer) => layer.nm === "Slider");
  for (const frame of [0, 2, 4]) {
    const leftMiddle = lottieRectanglePoint(moving, frame, 0, 0.5);
    close(leftMiddle.x, 20 + 25 * frame, `the left edge follows the Move at frame ${frame}`);
    close(leftMiddle.y, 160, `the left edge's middle stays at y 160 at frame ${frame}`);
  }
  assert.deepEqual([lottieRectanglePoint(moving, 4, 0, 0).width, lottieRectanglePoint(moving, 4, 0, 0).height], [80, 40]);
});

test("Lottie keeps the anchor of Auto height text that wraps onto more lines as it narrows", async () => {
  // A font only this export's registry has, as an imported font is on the server: the export
  // must measure the text with its own fonts.
  const fonts = await loadBundledFonts();
  fonts.register(await readFile(new URL("../assets/fonts/Inter-700.ttf", import.meta.url)), {
    id: "brand-bold", family: "Brand Bold", src: "/api/media/brand-bold.ttf",
  });
  const words = resizeTextLayer(createLayer("text", {
    id: "words", name: "Words", x: 100, y: 100, width: 400, fontSize: 32, rotation: 30, fill: "#000000",
    fontFamily: "Brand Bold", fontSource: "/api/media/brand-bold.ttf", fontWeight: 700,
    text: "The quick brown fox jumps over the lazy dog again and again", textResize: "height",
  }), fonts);
  words.animations = [resize("bottom", { width: 400 }, { width: 120 })];
  const scene = createScene({ id: "text", name: "Text", width: 800, height: 800, duration: 1, layers: [words] });
  const result = await exportScene(scene, { format: "lottie", fps: 4 }, { fonts });
  assert.deepEqual(result.warnings ?? [], [], "the anchor needs no warning");
  const exported = JSON.parse(result.buffer.toString("utf8")).layers.find((layer) => layer.nm.startsWith("Words"));
  const resting = point(layerMatrix(words), words.width / 2, words.height); // the bottom middle
  const heights = [];
  for (const frame of [0, 1, 2, 3, 4]) {
    // The box as the editor draws it at this frame (its height comes from its lines).
    const drawn = resizeTextLayer({ ...words, ...evaluateLayer(words, frame / 4, { fonts }) }, fonts);
    heights.push(drawn.height);
    // The exported text layer is the box: its anchor and position are its top-left corner, and
    // it is turned and scaled like the box. Its bottom middle stays where it started.
    const [ax, ay] = lottieValue(exported.ks.a, frame);
    const [px, py] = lottieValue(exported.ks.p, frame);
    const [sx, sy] = lottieValue(exported.ks.s, frame).map((percent) => percent / 100);
    const angle = (lottieValue(exported.ks.r, frame) * Math.PI) / 180;
    const qx = (drawn.width / 2 - ax) * sx;
    const qy = (drawn.height - ay) * sy;
    close(px + Math.cos(angle) * qx - Math.sin(angle) * qy, resting.x, `bottom middle x at frame ${frame}`);
    close(py + Math.sin(angle) * qx + Math.cos(angle) * qy, resting.y, `bottom middle y at frame ${frame}`);
  }
  assert.ok(heights[4] > heights[0] * 2, `the narrower text wraps onto more lines (${heights})`);
});
