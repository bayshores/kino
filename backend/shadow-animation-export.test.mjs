// A Shadow animation exports the same shadow as the editor shows: PNG, GIF and video frames draw
// the evaluated shadow (engine/shadowInterpolation.js) with the shared SVG renderer. Lottie is
// tested in lottie-shadow.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { evaluateLayer } from "../engine/animation.js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";
import { exportScene } from "./export.mjs";
import { ffmpeg, near, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

// A white 20 × 20 box at (10, 10) on white whose red shadow, with no blur, fades in 20 px down
// and to the right: pixel (40, 40) is inside the shadow and outside the box.
function sceneWithShadow() {
  const box = createLayer("rectangle", {
    id: "box", name: "Box", x: 10, y: 10, width: 20, height: 20, fill: "#ffffff", strokeWidth: 0,
    animations: [{
      id: "shadow", name: "Shadow", kind: "custom", start: 0, duration: 1, easing: "linear",
      from: { shadow: null }, to: { shadow: { color: "#ff0000", x: 20, y: 20, blur: 0 } },
      unit: "layer", stagger: 0, order: "forward",
    }],
  });
  return createScene({ id: "shadow", name: "Shadow", width: 60, height: 60, duration: 1, background: "#ffffff", layers: [box] });
}

const WHITE = [255, 255, 255, 255];
const HALF_RED = [255, 127, 127, 255];
const RED = [255, 0, 0, 255];

test("colored translucent shadows retain sRGB values in raster exports", async () => {
  const scene = createScene({ id: "color-space", width: 80, height: 50, background: "#ffffff", layers: [
    createLayer("rectangle", { id: "box", x: 10, y: 10, width: 20, height: 20, fill: "#ffffff",
      shadow: { color: "#4000bfaa", x: 25, y: 0, blur: 0 } }),
  ] });
  const png = await readImage((await exportScene(scene, { format: "png", time: 0 })).buffer);
  // RGB(64,0,191) at alpha 170/255 over white, outside the source box.
  assert.ok(near(png.pixel(43, 20), [128, 85, 212, 255], 1), `straight sRGB compositing: ${png.pixel(43, 20)}`);
});

test("PNG shadow offsets follow rotations, mirrors, skew and parent transforms", async () => {
  const poses = [
    { name: "rotation", properties: { rotation: 90 }, shadow: { x: 30, y: 0 }, pixel: [50, 80] },
    { name: "mirror", properties: { scaleX: -1 }, shadow: { x: 30, y: 0 }, pixel: [20, 50] },
    { name: "skew", properties: { skewX: 45 }, shadow: { x: 0, y: 30 }, pixel: [80, 80] },
    { name: "parent", properties: { parentId: "group" }, shadow: { x: 30, y: 0 }, pixel: [70, 80],
      parent: createLayer("group", { id: "group", width: 120, height: 120, x: 0, y: 0, rotation: 90 }) },
  ];
  for (const pose of poses) {
    const box = createLayer("rectangle", { id: "box", x: 40, y: 40, width: 20, height: 20, fill: "#ffffff",
      shadow: { color: "#ff0000", blur: 0, ...pose.shadow }, ...pose.properties });
    const scene = createScene({ id: pose.name, width: 120, height: 120, background: "#ffffff",
      layers: pose.parent ? [pose.parent, box] : [box] });
    for (const scale of [1, 2]) {
      const png = await readImage((await exportScene(scene, { format: "png", time: 0,
        width: 120 * scale, height: 120 * scale })).buffer);
      const [x, y] = pose.pixel.map((value) => value * scale);
      assert.ok(near(png.pixel(x, y), RED, 1), `${pose.name} at ${scale}x follows the transformed offset: ${png.pixel(x, y)}`);
    }
  }
});

test("a narrow text glyph keeps its shadow beyond the old percentage filter region", async () => {
  for (const unit of ["layer", "letters"]) {
    const shadow = { color: "#ff0000", x: 30, y: 0, blur: 0 };
    const text = createLayer("text", { id: "text", text: "I", fontSize: 40, x: 20, y: 20,
      width: 50, height: 60, fill: "#000000", shadow,
      animations: [{ id: "shadow", name: "Shadow", kind: "custom", start: 0, duration: 1,
        easing: "linear", from: { shadow }, to: { shadow }, unit, stagger: 0 }] });
    const scene = createScene({ id: `narrow-${unit}`, width: 100, height: 100, background: "#ffffff", layers: [text] });
    const png = await readImage((await exportScene(scene, { format: "png", time: 0.5 })).buffer);
    assert.ok(near(png.pixel(55, 50), RED, 1), `${unit} shadow is visible outside the narrow glyph's old bounds: ${png.pixel(55, 50)}`);
  }
});

test("a group shadow includes children beyond its design box", async () => {
  const scene = createScene({ id: "outside-child", width: 220, height: 100, background: "#ffffff", layers: [
    createLayer("group", { id: "group", x: 20, y: 20, width: 10, height: 10,
      shadow: { color: "#ff0000", x: 30, y: 0, blur: 0 } }),
    createLayer("rectangle", { id: "child", parentId: "group", x: 100, y: 0, width: 20, height: 20, fill: "#ffffff" }),
  ] });
  const png = await readImage((await exportScene(scene, { format: "png", time: 0 })).buffer);
  assert.ok(near(png.pixel(160, 30), RED, 1), `the outside child casts an unclipped group shadow: ${png.pixel(160, 30)}`);
});

function channelTrack(id, start, duration, from, to, shadowChannels) {
  return {
    id,
    name: id,
    kind: "in",
    start,
    duration,
    easing: "linear",
    from: { shadow: from },
    to: { shadow: to },
    shadowChannels,
  };
}

function sceneWithIndependentShadowChannels() {
  const base = { color: "#ff000080", x: 4, y: 0, blur: 2 };
  const box = createLayer("rectangle", {
    id: "box",
    name: "Box",
    x: 25,
    y: 30,
    width: 20,
    height: 20,
    fill: "#ffffff",
    strokeWidth: 0,
    shadow: base,
    animations: [
      channelTrack("rgb", 0, 1, base, { ...base, color: "#0000ff80" }, ["color"]),
      channelTrack("opacity", 0.25, 0.75,
        { ...base, color: "#ff000000" }, { ...base, color: "#ff0000ff" }, ["opacity"]),
      channelTrack("xy", 0.25, 1,
        base, { ...base, x: 16, y: 8 }, ["x", "y"]),
      channelTrack("blur", 0.5, 0.5,
        base, { ...base, blur: 10 }, ["blur"]),
    ],
  });
  return parseDocument(createDocument({
    scenes: [createScene({ id: "channels", width: 100, height: 100, duration: 1, background: "#ffffff", layers: [box] })],
  })).scenes[0];
}

const COMPOSED_SHADOWS = [
  [0.5, { color: "#80008055", x: 7, y: 2, blur: 2 }, [213, 170, 213, 255]],
  [0.75, { color: "#4000bfaa", x: 10, y: 4, blur: 6 }, [128, 85, 212, 255]],
  [1, { color: "#0000ff", x: 13, y: 6, blur: 10 }, null],
];

test("PNG exports draw the animated shadow like the editor's renderer at every time", async () => {
  const scene = sceneWithShadow();
  for (const [time, expected] of [[0, WHITE], [0.5, HALF_RED], [1, RED]]) {
    const exported = await readImage((await exportScene(scene, { format: "png", time })).buffer);
    const editor = await readImage(new Resvg(renderSceneSvg(scene, time)).render().asPng());
    assert.deepEqual(exported.pixel(40, 40), editor.pixel(40, 40), `the export matches the editor at ${time} s`);
    assert.ok(near(exported.pixel(40, 40), expected), `shadow pixel at ${time} s is ${exported.pixel(40, 40)}`);
    assert.ok(near(exported.pixel(20, 20), WHITE), "the box itself stays white");
  }
});

test("GIF and video frames draw the shadow fading in over time", { skip: skipWithoutMediaTools }, async () => {
  const scene = sceneWithShadow();
  const frameBytes = 60 * 60 * 4;
  for (const [format, tolerance] of [["gif", 24], ["mp4", 40]]) {
    const result = await exportScene(scene, { format, fps: 4, width: 60, height: 60 });
    const frames = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: result.buffer });
    assert.ok(frames.length >= frameBytes * 4, `${format} has every frame`);
    const pixel = (frame) => [...frames.subarray(frame * frameBytes + (40 * 60 + 40) * 4, frame * frameBytes + (40 * 60 + 40) * 4 + 4)];
    // Frames 0, 2 and 3 of a 4 fps export are 0, 0.5 and 0.75 s.
    assert.ok(near(pixel(0), WHITE, tolerance), `${format} first frame has no shadow ${pixel(0)}`);
    assert.ok(near(pixel(2), HALF_RED, tolerance), `${format} middle frame is half faded ${pixel(2)}`);
    assert.ok(near(pixel(3), [255, 64, 64, 255], tolerance), `${format} frame 3 is three quarters faded ${pixel(3)}`);
  }
});

test("PNG renders overlapping shadow channels at their independent timings", async () => {
  const scene = sceneWithIndependentShadowChannels();
  const box = scene.layers[0];
  for (const [time, shadow, expectedPixel] of COMPOSED_SHADOWS) {
    assert.deepEqual(evaluateLayer(box, time).shadow, shadow, `the channel composition at ${time} s`);
    const exported = await readImage((await exportScene(scene, { format: "png", time })).buffer);
    const editor = await readImage(new Resvg(renderSceneSvg(scene, time)).render().asPng());
    assert.deepEqual(exported.pixel(47, 42), editor.pixel(47, 42), `PNG and editor match at ${time} s`);
    const sample = exported.pixel(47, 42);
    if (expectedPixel) assert.ok(near(sample, expectedPixel, 20), `PNG samples the composed shadow at ${time} s: ${sample}`);
    else assert.ok(Math.abs(sample[0] - sample[1]) <= 2 && sample[0] > 0 && sample[0] < 90 && sample[2] >= 253,
      `the final blue shadow softens at its edge while keeping its hue: ${sample}`);
    assert.ok(near(exported.pixel(35, 35), WHITE, 2), "the separate box area remains white");
  }
});

test("GIF and MP4 render overlapping shadow channels at their independent timings", { skip: skipWithoutMediaTools }, async () => {
  const scene = sceneWithIndependentShadowChannels();
  const frameBytes = 100 * 100 * 4;
  for (const [format, tolerance] of [["gif", 28], ["mp4", 42]]) {
    const result = await exportScene(scene, { format, fps: 4, width: 100, height: 100 });
    const frames = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "fps=4", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: result.buffer });
    assert.ok(frames.length >= frameBytes * 4, `${format} has all four frames`);
    const pixel = (frame) => [...frames.subarray(frame * frameBytes + (42 * 100 + 47) * 4, frame * frameBytes + (42 * 100 + 47) * 4 + 4)];
    assert.ok(near(pixel(2), COMPOSED_SHADOWS[0][2], tolerance), `${format} frame at 0.5 s has the overlapped RGB and opacity: ${pixel(2)}`);
    assert.ok(near(pixel(3), COMPOSED_SHADOWS[1][2], tolerance), `${format} frame at 0.75 s includes its XY and blur tracks: ${pixel(3)}`);
  }
});
