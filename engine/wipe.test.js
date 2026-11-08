// The general wipe: each shape at a few angles shows exactly the part of the box its field says,
// an edge band paints the layer in its color, and today's four straight wipes draw as before.
import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { renderSceneSvg } from "./render.js";
import { createLayer, createScene } from "./model.js";
import { normalizeReveal, interpolateReveal } from "./reveal.js";
import { wipeEdges, wipeField, wipeFieldAt } from "./wipe.js";
import { createCatalogAnimation, normalizePreset } from "./presetCatalog.js";

const W = 160, H = 100;
function draw(reveal, fill = "#FFFFFF") {
  const layer = createLayer("rectangle", { id: "r", x: 0, y: 0, width: W, height: H, fill, reveal });
  const svg = renderSceneSvg(createScene({ id: "s", width: W, height: H, background: "#000000", layers: [layer] }), 0);
  return { svg, pixels: new Resvg(svg).render().pixels };
}
const at = (pixels, x, y) => [...pixels.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];

// Every pixel center well inside or well outside the edge matches the field.
function assertShape(reveal) {
  const { pixels } = draw(reveal);
  const field = wipeField(W, H, reveal);
  const { feather, front, picture } = wipeEdges(field, reveal.progress, reveal.softness);
  let checked = 0;
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    const f = wipeFieldAt(field, x + 0.5, y + 0.5), margin = 0.04, [r] = at(pixels, x, y);
    // A clock's seam at f = 0 / 1 is its start line: skip the points next to it.
    if (field.shape === "clock" && (f < margin || f > 1 - margin)) continue;
    if (f < picture - (picture < front ? 0 : feather) - margin) { assert.ok(r > 240, `${JSON.stringify(reveal)} shows (${x},${y}) f=${f.toFixed(3)} r=${r}`); checked += 1; }
    if (f > front + margin) { assert.ok(r < 15, `${JSON.stringify(reveal)} hides (${x},${y}) f=${f.toFixed(3)} r=${r}`); checked += 1; }
  }
  assert.ok(checked > 300, `enough points checked (${checked})`);
}

test("linear at any angle, radial, iris and clock show what their field says", () => {
  for (const angle of [0, 30, 135, -60, 200]) {
    assertShape({ progress: 0.45, direction: "right", softness: 0, shape: "linear", angle });
    assertShape({ progress: 0.45, direction: "right", softness: 20, angle });
  }
  for (const [centerX, centerY] of [[0.5, 0.5], [0.2, 0.3], [1, 1]]) {
    assertShape({ progress: 0.5, direction: "up", softness: 0, shape: "iris", centerX, centerY });
    assertShape({ progress: 0.5, direction: "up", softness: 25, shape: "radial", centerX, centerY });
  }
  for (const angle of [-90, 0, 45]) {
    assertShape({ progress: 0.6, direction: "up", softness: 0, shape: "clock", angle });
    assertShape({ progress: 0.35, direction: "up", softness: 20, shape: "clock", angle, centerX: 0.3 });
  }
  // A clock from 12 o'clock at a quarter: the top-right quadrant only.
  const { pixels } = draw({ progress: 0.25, direction: "up", softness: 0, shape: "clock" });
  assert.ok(at(pixels, 120, 20)[0] > 240 && at(pixels, 40, 20)[0] < 15 && at(pixels, 120, 80)[0] < 15);
});

test("a soft clock fades evenly, with no dark seams between its steps", () => {
  const size = 300;
  const layer = createLayer("rectangle", { id: "r", x: 0, y: 0, width: size, height: size, fill: "#FFFFFF",
    reveal: { progress: 0.5, direction: "right", softness: 30, shape: "clock" } });
  const pixels = new Resvg(renderSceneSvg(createScene({ id: "s", width: size, height: size, background: "#000000", layers: [layer] }), 0)).render().pixels;
  // Clockwise from 12 o'clock on a 120 px circle the mask only darkens: a seam was a dip and rise.
  let last = 255;
  for (let deg = 90; deg <= 250; deg += 0.25) {
    const r = (deg - 90) * Math.PI / 180;
    const x = Math.round(150 + Math.cos(r) * 120), y = Math.round(150 + Math.sin(r) * 120);
    const value = pixels[(y * size + x) * 4];
    assert.ok(value <= last + 3, `${deg} deg: ${value} after ${last}`);
    last = Math.min(last, value);
  }
});

test("today's four directions draw as before, and the same wipe written as an angle matches them", () => {
  for (const [direction, angle] of [["right", 0], ["down", 90], ["left", 180], ["up", 270]]) {
    for (const softness of [0, 20]) {
      const old = draw({ progress: 0.4, direction, softness });
      assert.doesNotMatch(old.svg, /wipe-/, "an old reveal uses the old clip and gradient");
      assert.match(old.svg, softness ? /reveal-gradient/ : /reveal-clip/);
      const general = draw({ progress: 0.4, direction, softness, angle }).pixels;
      let worst = 0;
      for (let i = 0; i < general.length; i += 4) worst = Math.max(worst, Math.abs(general[i] - old.pixels[i]));
      assert.ok(worst <= 2, `${direction} softness ${softness}: largest difference ${worst}`);
    }
  }
});

test("an edge band rides ahead of the picture in its color, on the layer's own drawing", () => {
  const reveal = { progress: 0.5, direction: "right", softness: 0, edgeWidth: 20, edgeColor: "#FF0000" };
  const { svg, pixels } = draw(reveal);
  // Band 20 px of a 160 px travel: front at 0.5 × (1 + 0.125) = 0.5625 (x 90), picture at x 70.
  assert.deepEqual(at(pixels, 60, 50), [255, 255, 255]);
  assert.deepEqual(at(pixels, 80, 50), [255, 0, 0]);
  assert.deepEqual(at(pixels, 100, 50), [0, 0, 0]);
  // mask-type as an attribute: resvg reads a style one as luminance, so a dark layer's band went pale.
  assert.match(svg, /mask-type="alpha"><use href="#/);
  const dark = draw(reveal, "#203060").pixels;
  assert.deepEqual(at(dark, 80, 50), [255, 0, 0], "the band is solid on a dark layer");
  assert.deepEqual(at(dark, 60, 50), [32, 48, 96]);
  // Soft: the picture meets the band hard, the band stays solid, its front fades.
  const soft = draw({ ...reveal, softness: 10 }).pixels;
  // Front 0.5 × (1 + 0.1 + 0.125) = 0.6125 (x 98); band from x 66 to 82, fading to x 98.
  assert.deepEqual(at(soft, 60, 50), [255, 255, 255]);
  assert.deepEqual(at(soft, 74, 50), [255, 0, 0]);
  assert.ok(at(soft, 90, 50)[0] > 40 && at(soft, 90, 50)[0] < 215, "the front fades");
  // Done: no band left at the end.
  assert.doesNotMatch(draw({ ...reveal, progress: 1 }).svg, /wipe-/);
});

test("wipe settings: optional, checked, interpolated, and taken by the wipe and mask presets", () => {
  assert.deepEqual(Object.keys(normalizeReveal({ progress: 0, direction: "up", softness: 0 })), ["progress", "direction", "softness"]);
  assert.throws(() => normalizeReveal({ progress: 0, direction: "up", softness: 0, shape: "star" }), /shape must be/);
  assert.throws(() => normalizeReveal({ progress: 0, direction: "up", softness: 0, centerX: 3 }), /centerX/);
  assert.throws(() => normalizeReveal({ progress: 0, direction: "up", softness: 0, edgeColor: "red" }), /edgeColor/);
  const mid = interpolateReveal({ progress: 0, direction: "up", softness: 0, shape: "iris", centerX: 0 },
    { progress: 1, direction: "up", softness: 0, shape: "iris", centerX: 1 }, 0.25);
  assert.equal(mid.centerX, 0.25);
  assert.equal(mid.shape, "iris");
  const layer = createLayer("rectangle", { id: "r", width: 100, height: 100 });
  const wipe = createCatalogAnimation("preset-wipe", layer, 0, { parameters: { shape: "clock", angle: 0, edgeWidth: 12, edgeColor: "#00FF00" } }, "a");
  assert.deepEqual(wipe.from.reveal, { direction: "right", softness: 20, shape: "clock", angle: 0, edgeWidth: 12, edgeColor: "#00FF00", progress: 0 });
  const plain = createCatalogAnimation("preset-wipe", layer, 0, {}, "b");
  assert.deepEqual(plain.from.reveal, { direction: "right", softness: 20, progress: 0 }, "a wipe without settings is today's");
  assert.equal(createCatalogAnimation("preset-mask", layer, 0, { parameters: { shape: "iris" } }, "c").to.reveal.shape, "iris");
  assert.throws(() => normalizePreset({ id: "wipe", parameters: { shape: "star" } }), /shape must be/);
  assert.throws(() => normalizePreset({ id: "wipe", parameters: { angle: 5000 } }), /angle must be/);
  assert.throws(() => normalizePreset({ id: "slide", parameters: { shape: "iris" } }), /unknown field shape/);
});

test("shape-wipe's clock sweeps a frame of the color, then the next shot, around the point", async () => {
  const { MOVES } = await import("./blocks/moves/index.js");
  const { placeMove, readMoveInput, runMove } = await import("./blocks/move.js");
  const { styleFor } = await import("./blocks/looks.js");
  const { defaultFonts } = await import("./fonts.js");
  const scene = createScene({ id: "s", width: W, height: H, duration: 3, background: "#000000", layers: [
    createLayer("rectangle", { id: "shot-b", name: "shot-b", x: 0, y: 0, width: W, height: H, fill: "#0000FF" }),
    createLayer("rectangle", { id: "shot-a", name: "shot-a", x: 0, y: 0, width: W, height: H, fill: "#00FF00" }),
  ] });
  const input = readMoveInput(MOVES["shape-wipe"], { from: "shot-a", to: "shot-b", shape: "clock", color: "#FF0000" });
  const made = runMove(MOVES["shape-wipe"], { id: "w", input, scene, style: styleFor({ look: "crisp", frame: { width: W, height: H } }), fonts: defaultFonts, start: 1, dur: 1 });
  placeMove(scene, { id: "w", name: "shape-wipe", settings: input }, made);
  // 0.3 s in: the color has swept part way from 12 o'clock and the next shot not yet.
  const early = new Resvg(renderSceneSvg(scene, 1.3)).render().pixels;
  assert.deepEqual(at(early, 120, 10), [255, 0, 0], "color top right");
  assert.deepEqual(at(early, 40, 10), [0, 255, 0], "old shot top left");
  // Done: the next shot fills the frame.
  const done = new Resvg(renderSceneSvg(scene, 2)).render().pixels;
  assert.deepEqual(at(done, 40, 10), [0, 0, 255]);
  assert.deepEqual(at(done, 120, 90), [0, 0, 255]);
});

test("an inverted wipe at 1 - progress shows exactly what the plain wipe hides", () => {
  assert.throws(() => normalizeReveal({ progress: 0.5, direction: "up", softness: 0, invert: "yes" }), /invert must be true or false/);
  assert.equal(interpolateReveal({ progress: 1, direction: "up", softness: 0, shape: "iris", invert: true }, { progress: 0, direction: "up", softness: 0, shape: "iris", invert: true }, 0.5).invert, true);
  for (const shape of ["linear", "radial", "iris", "clock"]) for (const softness of [0, 10]) {
    const plain = draw({ progress: 0.4, direction: "right", softness, shape }).pixels;
    const inverted = draw({ progress: 0.6, direction: "right", softness, shape, invert: true, edgeWidth: 12 }).pixels;
    let worst = 0;
    for (let i = 0; i < W * H; i++) worst = Math.max(worst, Math.abs(plain[i * 4] + inverted[i * 4] - 255));
    assert.ok(worst <= 4, `${shape} softness ${softness}: the two cover the box once (worst ${worst})`);
  }
});
