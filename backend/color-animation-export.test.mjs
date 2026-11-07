// A Color animation exports the same paints as the editor shows: every raster format draws the
// evaluated paint (engine/paintInterpolation.js) with the shared SVG renderer, and Lottie writes
// native gradients with one stop count (backend/lottie-paints.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { evaluateLayer } from "../engine/animation.js";
import { interpolatePaint, parseHexColor } from "../engine/paintInterpolation.js";
import { renderSceneSvg } from "../engine/render.js";
import { exportScene } from "./export.mjs";
import { ffmpeg, near, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const GREEN = "#00ff00";
const RED_TO_BLUE = { type: "linear", angle: 0, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] };
const THREE_STOP_RADIAL = { type: "radial", angle: 0, stops: [{ offset: 0, color: "#ffffff" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#000000" }] };

function colorAnimation(from, to) {
  return { id: "color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear", from: { fill: from }, to: { fill: to }, unit: "layer", stagger: 0, order: "forward" };
}

// A 40 × 20 box filling the scene, so pixel x is at gradient offset (x + 0.5) / 40.
function sceneWith(from, to, layer = {}) {
  const box = createLayer("rectangle", { id: "box", name: "Box", x: 0, y: 0, width: 40, height: 20, fill: from, animations: [colorAnimation(from, to)], ...layer });
  return createScene({ id: "color", name: "Color", width: 40, height: 20, duration: 1, background: "#000000", layers: [box] });
}

const rgba = (hex) => parseHexColor(hex).rgba;

function walk(value, matches, found = []) {
  if (Array.isArray(value)) value.forEach((item) => walk(item, matches, found));
  else if (value && typeof value === "object") {
    if (matches(value)) found.push(value);
    Object.values(value).forEach((child) => walk(child, matches, found));
  }
  return found;
}

test("PNG exports draw the evaluated paint pixel for pixel like the editor's renderer", async () => {
  const scene = sceneWith(GREEN, RED_TO_BLUE);
  for (const time of [0, 0.5, 1]) {
    const exported = await readImage((await exportScene(scene, { format: "png", time })).buffer);
    const editor = await readImage(new Resvg(renderSceneSvg(scene, time)).render().asPng());
    for (const x of [0, 10, 20, 39])
      assert.deepEqual(exported.pixel(x, 10), editor.pixel(x, 10), `pixel ${x} at ${time} s`);
  }
  const middle = await readImage((await exportScene(scene, { format: "png", time: 0.5 })).buffer);
  const mixed = interpolatePaint(GREEN, RED_TO_BLUE, 0.5);
  assert.deepEqual(mixed.stops.map((stop) => stop.color), ["#808000", "#008080"]);
  assert.ok(near(middle.pixel(0, 10), rgba("#808000")), "the left edge is From green mixed with red");
  assert.ok(near(middle.pixel(39, 10), rgba("#008080")), "the right edge is From green mixed with blue");
});

test("GIF and video frames draw the same mixed paint over time", { skip: skipWithoutMediaTools }, async () => {
  const scene = sceneWith(GREEN, RED_TO_BLUE);
  const frameBytes = 40 * 20 * 4;
  for (const [format, tolerance] of [["gif", 24], ["mp4", 40]]) {
    const result = await exportScene(scene, { format, fps: 4, width: 40, height: 20 });
    const frames = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: result.buffer });
    assert.ok(frames.length >= frameBytes * 3, `${format} has several frames`);
    const pixel = (frame, x) => [...frames.subarray(frame * frameBytes + (10 * 40 + x) * 4, frame * frameBytes + (10 * 40 + x) * 4 + 4)];
    // Frame 2 of a 4 fps export is 0.5 s.
    const middle = evaluateLayer(scene.layers[0], 0.5).fill.stops;
    assert.ok(near(pixel(2, 0), rgba(middle[0].color), tolerance), `${format} middle frame left ${pixel(2, 0)}`);
    assert.ok(near(pixel(2, 39), rgba(middle[1].color), tolerance), `${format} middle frame right ${pixel(2, 39)}`);
    assert.ok(near(pixel(0, 20), rgba(GREEN), tolerance), `${format} first frame is the solid From color ${pixel(0, 20)}`);
  }
});

test("Lottie exports a solid to gradient Color animation as one gradient with no warning", async () => {
  const result = await exportScene(sceneWith(GREEN, RED_TO_BLUE), { format: "lottie", fps: 4 });
  assert.equal(result.warnings, undefined);
  const data = JSON.parse(result.buffer.toString("utf8"));
  const gradients = walk(data, (item) => item.ty === "gf");
  assert.equal(gradients.length, 1);
  assert.equal(walk(data, (item) => item.ty === "fl" && item.nm === "Fill").length, 0, "no separate solid fill");
  const [gradient] = gradients;
  assert.equal(gradient.t, 1);
  assert.equal(gradient.g.p, 2);
  const values = gradient.g.k.k.map((keyframe) => keyframe.s);
  assert.equal(values.length, 5, "one keyframe per frame from 0 to 1 s");
  assert.deepEqual(values[0], [0, 0, 1, 0, 1, 0, 1, 0], "frame 0: both stops are the From green");
  assert.deepEqual(values[2], [0, 128 / 255, 128 / 255, 0, 1, 0, 128 / 255, 128 / 255], "frame 2 is the editor's mixed gradient");
  assert.deepEqual(values[4], [0, 1, 0, 0, 1, 0, 0, 1]);
});

test("Lottie gives linear to radial with different stop counts one stop count and two gradients that swap", async () => {
  const scene = sceneWith(RED_TO_BLUE, THREE_STOP_RADIAL);
  const data = JSON.parse((await exportScene(scene, { format: "lottie", fps: 4 })).buffer.toString("utf8"));
  const gradients = walk(data, (item) => item.ty === "gf");
  assert.deepEqual(gradients.map((item) => item.t), [1, 2], "a linear and a radial gradient fill");
  for (const gradient of gradients) {
    assert.equal(gradient.g.p, 3, "every frame has three stops");
    assert.ok(gradient.g.k.k.every((keyframe) => keyframe.s.length === 12), "three color stops, no alpha stops");
  }
  const [linear, radial] = gradients;
  // The editor switches type at eased progress 0.5, which is frame 2 (0.5 s) at 4 fps.
  assert.deepEqual(linear.o.k.map((keyframe) => keyframe.s[0]), [100, 100, 0, 0, 0]);
  assert.deepEqual(radial.o.k.map((keyframe) => keyframe.s[0]), [0, 0, 100, 100, 100]);
  for (const item of gradients) {
    const switchFrame = item.o.k.find((keyframe) => keyframe.t === 1);
    assert.equal(switchFrame.h, 1, "the gradients swap at once, with no cross-fade");
    assert.equal(item.g.k.k.find((keyframe) => keyframe.t === 1).h, 1);
  }
  const stopsAt = (gradient, frame) => {
    const value = gradient.g.k.k[frame].s;
    return [0, 1, 2].map((index) => [value[index * 4], ...value.slice(index * 4 + 1, index * 4 + 4).map((channel) => Math.round(channel * 255))]);
  };
  assert.deepEqual(stopsAt(linear, 0), [[0, 255, 0, 0], [0.5, 128, 0, 128], [1, 0, 0, 255]],
    "frame 0 is the From gradient with a stop added at 0.5 where it already is that color");
  const evaluated = evaluateLayer(scene.layers[0], 0.5).fill;
  assert.equal(evaluated.type, "radial");
  assert.deepEqual(stopsAt(radial, 2), evaluated.stops.map((stop) => [stop.offset, ...rgba(stop.color).slice(0, 3)]));
  assert.deepEqual(stopsAt(radial, 4), [[0, 255, 255, 255], [0.5, 0, 255, 0], [1, 0, 0, 0]]);
});

test("Lottie text and stroke paints also export solid to gradient Color animations", async () => {
  const text = createLayer("text", {
    id: "words", name: "Words", x: 0, y: 0, width: 40, height: 20, text: "Hi", fontSize: 12, fill: GREEN,
    animations: [colorAnimation(GREEN, RED_TO_BLUE)],
  });
  const textData = JSON.parse((await exportScene(createScene({ id: "t", name: "T", width: 40, height: 20, duration: 1, layers: [text] }), { format: "lottie", fps: 4 })).buffer.toString("utf8"));
  const glyphGradients = walk(textData, (item) => item.ty === "gf");
  assert.ok(glyphGradients.length >= 2, "each glyph gets the gradient");
  assert.ok(glyphGradients.every((item) => item.g.p === 2 && item.g.k.a === 1));

  const stroked = sceneWith(GREEN, GREEN, {
    strokeWidth: 2, stroke: GREEN,
    animations: [{ ...colorAnimation(GREEN, GREEN), from: { stroke: GREEN }, to: { stroke: RED_TO_BLUE } }],
  });
  const strokeData = JSON.parse((await exportScene(stroked, { format: "lottie", fps: 4 })).buffer.toString("utf8"));
  const strokes = walk(strokeData, (item) => item.ty === "gs");
  assert.equal(strokes.length, 1);
  assert.deepEqual(strokes[0].g.k.k[0].s, [0, 0, 1, 0, 1, 0, 1, 0]);
});

test("a disabled fill exports nothing in Lottie even while its Color animates", async () => {
  const data = JSON.parse((await exportScene(sceneWith(GREEN, RED_TO_BLUE, { fillEnabled: false }), { format: "lottie", fps: 4 })).buffer.toString("utf8"));
  assert.equal(walk(data, (item) => item.ty === "gf" || (item.ty === "fl" && item.nm === "Fill")).length, 0);
});

// Older versions accepted a Color animation on any layer. On a group or an image, which have no
// Fill, it draws nothing in the editor, so every export is the same as without it.
test("an older Color animation on a group or image exports exactly as the layer without it", async () => {
  const picture = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0f0"/></svg>').render().asPng();
  const layersFor = (animations) => [
    createLayer("group", { id: "folder", x: 0, y: 0, width: 40, height: 10, animations }),
    createLayer("rectangle", { id: "inside", parentId: "folder", x: 0, y: 0, width: 40, height: 10, fill: "#123456" }),
    createLayer("image", { id: "picture", x: 0, y: 10, width: 40, height: 10, src: `data:image/png;base64,${picture.toString("base64")}`, animations }),
  ];
  const sceneOf = (animations) => createScene({ id: "old", name: "Old", width: 40, height: 20, duration: 1, layers: layersFor(animations) });
  const older = sceneOf([colorAnimation("#ff0000", RED_TO_BLUE)]);
  const plain = sceneOf([]);
  for (const time of [0, 0.5, 1]) {
    const [withIt, without] = await Promise.all([older, plain].map((scene) => exportScene(scene, { format: "png", time })));
    assert.deepEqual(withIt.buffer, without.buffer, `PNG at ${time} s`);
  }
  const [lottieWith, lottieWithout] = await Promise.all([older, plain].map((scene) => exportScene(scene, { format: "lottie", fps: 4 })));
  assert.equal(lottieWith.buffer.toString("utf8"), lottieWithout.buffer.toString("utf8"));
  assert.equal(lottieWith.warnings, undefined);
});
