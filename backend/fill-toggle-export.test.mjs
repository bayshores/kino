// A layer whose Fill is turned off (fillEnabled: false) exports with no fill in every format,
// keeps its stroke, and keeps its paint for turning the fill back on (engine/paints.js).
import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { ffmpeg, near, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const RED = "#ff0000";
const GRADIENT = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff000080" }, { offset: 1, color: "#0000ff" }] };

function box(values = {}) {
  return createLayer("rectangle", {
    id: "box", name: "Box", x: 10, y: 10, width: 20, height: 20,
    fill: RED, stroke: "#0000ff", strokeWidth: 0, ...values,
  });
}

function scene(layers, background = "transparent") {
  return createScene({ id: "fill-toggle", name: "Fill toggle", width: 40, height: 40, duration: 1, background, layers });
}

// Every fill item (solid "fl" or gradient "gf") anywhere in a Lottie file, except the transparent
// boxes the exporter adds to reserve room and the track-matte layers (td: 1) whose white
// silhouette clips an aligned stroke to the shape.
function fillItems(value, found = []) {
  if (Array.isArray(value)) value.forEach((item) => fillItems(item, found));
  else if (value && typeof value === "object" && value.td !== 1) {
    if ((value.ty === "fl" || value.ty === "gf") && value.nm !== "Transparent bounds") found.push(value);
    Object.values(value).forEach((child) => fillItems(child, found));
  }
  return found;
}

function strokeItems(value, found = []) {
  if (Array.isArray(value)) value.forEach((item) => strokeItems(item, found));
  else if (value && typeof value === "object") {
    if (value.ty === "st" || value.ty === "gs") found.push(value);
    Object.values(value).forEach((child) => strokeItems(child, found));
  }
  return found;
}

const lottie = async (layers) =>
  JSON.parse((await exportScene(scene(layers), { format: "lottie", fps: 4, duration: 1 })).buffer.toString("utf8"));

test("a PNG export draws nothing for a layer whose fill is off, and the same fill once it is back on", async () => {
  const off = await readImage((await exportScene(scene([box({ fill: GRADIENT, fillEnabled: false })]), { format: "png", width: 40, height: 40 })).buffer);
  for (let y = 0; y < 40; y += 1)
    for (let x = 0; x < 40; x += 1)
      assert.equal(off.pixel(x, y)[3], 0, `pixel ${x},${y} stays transparent`);

  const stroked = await readImage((await exportScene(scene([box({ fillEnabled: false, strokeWidth: 4, strokeAlign: "inside" })]), { format: "png", width: 40, height: 40 })).buffer);
  assert.equal(stroked.pixel(20, 20)[3], 0, "the inside of the shape is empty");
  assert.ok(near(stroked.pixel(11, 20), [0, 0, 255, 255]), "the stroke is still drawn");

  const on = await readImage((await exportScene(scene([box({ fillEnabled: true })]), { format: "png", width: 40, height: 40 })).buffer);
  assert.ok(near(on.pixel(20, 20), [255, 0, 0, 255]), "turned back on, the kept color is drawn");
});

test("a GIF export draws nothing for a fill that is off, even while its color animates", { skip: skipWithoutMediaTools }, async () => {
  const animated = box({
    fillEnabled: false,
    animations: [{
      id: "recolor", name: "Recolor", kind: "custom", start: 0, duration: 1, easing: "linear",
      from: { fill: "#00ff00" }, to: { fill: RED }, unit: "layer", stagger: 0, order: "forward",
    }],
  });
  const result = await exportScene(scene([animated], "#ffffff"), { format: "gif", fps: 4, width: 40, height: 40 });
  const frames = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: result.buffer });
  const frameBytes = 40 * 40 * 4;
  assert.ok(frames.length >= frameBytes * 2, "the animation exports several frames");
  for (let offset = 0; offset + frameBytes <= frames.length; offset += frameBytes) {
    const center = offset + (20 * 40 + 20) * 4;
    assert.ok(near([...frames.subarray(center, center + 4)], [255, 255, 255, 255]), `frame ${offset / frameBytes} shows the white background`);
  }
});

test("a Lottie export writes no fill for shapes or text whose fill is off, and keeps their strokes", async () => {
  const shapes = await lottie([
    box({ id: "solid", fillEnabled: false }),
    box({ id: "gradient", fill: GRADIENT, fillEnabled: false, strokeWidth: 2 }),
    box({ id: "inside", fillEnabled: false, strokeWidth: 3, strokeAlign: "inside" }),
    createLayer("ellipse", { id: "ellipse", fillEnabled: false, width: 10, height: 10 }),
    createLayer("star", { id: "star", fillEnabled: false, width: 10, height: 10 }),
    createLayer("text", { id: "text", text: "Hi", fillEnabled: false, width: 40, height: 20, fontSize: 12 }),
  ]);
  assert.deepEqual(fillItems(shapes), [], "no fill item is exported");
  assert.equal(strokeItems(shapes).length, 2, "the gradient box and the inside-stroke box keep their strokes");

  const turnedOn = await lottie([
    box({ id: "solid" }),
    box({ id: "gradient", fill: GRADIENT }),
    createLayer("text", { id: "text", text: "Hi", width: 40, height: 20, fontSize: 12 }),
  ]);
  const fills = fillItems(turnedOn);
  assert.ok(fills.some((item) => item.ty === "fl"), "turned on, solid fills are exported");
  assert.ok(fills.some((item) => item.ty === "gf"), "turned on, the kept gradient is exported");
});
