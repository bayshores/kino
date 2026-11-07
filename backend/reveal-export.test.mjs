import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createCatalogAnimation } from "../engine/presetCatalog.js";
import { createLayer, createScene } from "../engine/model.js";
import { renderSceneSvg } from "../engine/render.js";
import { exportScene } from "./export.mjs";
import { ffmpeg, near, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];

test("encoded GIF and MP4 preserve Mask, Wipe, Blink, Appear, and Blur & Slide frames", { skip: skipWithoutMediaTools }, async () => {
  const width = 400, height = 100, fps = 10;
  const layers = ["mask", "wipe", "blink", "appear", "blur-slide"].map((id, index) => {
    const base = createLayer("rectangle", { id, name: id, x: index * 80 + 15, y: 25,
      width: 50, height: 50, fill: "#304fa0", strokeWidth: 0 });
    const animation = createCatalogAnimation(`preset-${id}`, base, 0.13, {}, `effect-${id}`);
    Object.assign(animation, { duration: 0.8, easing: "linear" });
    return { ...base, animations: [animation] };
  });
  const scene = createScene({ id: "encoded-presets", width, height, duration: 1.5, background: "#ffffff", layers });
  const framesToCheck = [0, 2, 5, 9, 12];
  const reference = new Map();
  for (const frame of framesToCheck)
    reference.set(frame, await readImage(new Resvg(renderSceneSvg(scene, frame / fps)).render().asPng()));
  for (const [format, tolerance] of [["gif", 24], ["mp4", 30]]) {
    const encoded = await exportScene(scene, { format, fps, width, height });
    const decoded = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      // GIF may merge identical images into a longer frame; decode its timing at the export fps.
      "-vf", `fps=${fps}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: encoded.buffer });
    const frameBytes = width * height * 4;
    assert.equal(decoded.length / frameBytes, format === "gif" ? 16 : 15,
      `${format} retains its full frame count (animated images include the endpoint)`);
    for (const frame of framesToCheck) for (let column = 0; column < 5; column += 1) {
      for (const [dx, y] of [[25, 35], [40, 50], [55, 65]]) {
        const x = column * 80 + dx, offset = frame * frameBytes + (y * width + x) * 4;
        const actual = [...decoded.subarray(offset, offset + 4)];
        const expected = reference.get(frame).pixel(x, y);
        assert.ok(near(actual, expected, tolerance),
          `${format} ${layers[column].name} frame ${frame}: ${actual} versus ${expected}`);
      }
    }
  }
});

function operation(layer, presetId, parameters = {}) {
  const animation = createCatalogAnimation(presetId, layer, 0, { parameters }, "reveal-animation");
  animation.duration = 1;
  animation.easing = "linear";
  return animation;
}

function baseScene(layers) {
  return createScene({
    id: "reveal-export",
    width: 120,
    height: 100,
    duration: 1,
    background: "#ffffff",
    layers,
  });
}

async function comparePngWithSharedSvg(scene, time, points) {
  const editor = await readImage(new Resvg(renderSceneSvg(scene, time)).render().asPng());
  const exported = await readImage((await exportScene(scene, { format: "png", time })).buffer);
  for (const [x, y] of points) {
    assert.deepEqual(exported.pixel(x, y), editor.pixel(x, y), `PNG export matches SVG at ${time}s (${x},${y})`);
  }
  return exported;
}

test("hard Mask reveals media, its outside stroke, and group children through the shared SVG/PNG path", async () => {
  const imageBytes = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#ff0000"/></svg>').render().asPng();
  const imageBase = createLayer("image", {
    id: "photo", name: "Photo", x: 20, y: 20, width: 80, height: 60,
    src: `data:image/png;base64,${imageBytes.toString("base64")}`,
    radius: 10, stroke: "#0000ff", strokeWidth: 6, strokeAlign: "outside",
  });
  const image = createLayer("image", { ...imageBase, animations: [operation(imageBase, "mask-up")] });
  const groupBase = createLayer("group", {
    id: "group", name: "Group", x: 0, y: 0, width: 80, height: 60,
    clipContent: false,
  });
  const group = createLayer("group", { ...groupBase, animations: [operation(groupBase, "mask-up")] });
  const child = createLayer("rectangle", {
    id: "child", name: "Child", parentId: group.id, x: 0, y: 0, width: 80, height: 60, fill: "#ff0000",
  });
  const scene = baseScene([image, group, child]);

  const start = await comparePngWithSharedSvg(scene, 0, [[60, 70], [60, 29], [102, 50], [40, 10]]);
  assert.deepEqual(start.pixel(60, 70), WHITE, "a zero-progress Mask hides the media and children");
  assert.deepEqual(start.pixel(40, 10), WHITE, "a zero-progress Mask hides the group child");

  const middle = await comparePngWithSharedSvg(scene, 0.5, [[60, 70], [60, 29], [40, 10]]);
  assert.deepEqual(middle.pixel(60, 70), RED, "up reveals the bottom half first");
  assert.deepEqual(middle.pixel(60, 29), WHITE, "the upper half remains clipped");
  assert.deepEqual(middle.pixel(40, 10), WHITE, "the group reveal clips its children as one layer box");

  const end = await comparePngWithSharedSvg(scene, 1, [[60, 70], [60, 29], [102, 50], [40, 10]]);
  assert.deepEqual(end.pixel(60, 70), RED);
  assert.deepEqual(end.pixel(60, 29), RED);
  assert.deepEqual(end.pixel(102, 50), [0, 0, 255, 255], "the full endpoint does not crop the outside stroke");
  assert.deepEqual(end.pixel(40, 10), RED, "the full endpoint reveals the group child");
});

test("soft Wipe uses a dimension-relative luminance feather and keeps exact endpoint frames", async () => {
  const base = createLayer("rectangle", {
    id: "box", name: "Box", x: 20, y: 20, width: 80, height: 60, fill: "#ff0000", strokeWidth: 0,
  });
  const box = createLayer("rectangle", {
    ...base,
    animations: [operation(base, "wipe", { direction: "right", softness: 20 })],
  });
  const scene = baseScene([box]);

  const start = await comparePngWithSharedSvg(scene, 0, [[30, 40], [60, 40], [90, 40]]);
  assert.deepEqual(start.pixel(30, 40), WHITE);
  const middle = await comparePngWithSharedSvg(scene, 0.5, [[30, 40], [60, 40], [90, 40]]);
  assert.deepEqual(middle.pixel(30, 40), RED);
  const feather = middle.pixel(60, 40);
  assert.equal(feather[0], 255);
  assert.ok(feather[1] > 60 && feather[1] < 200, `feather alpha blends against the white background: ${feather}`);
  assert.deepEqual(middle.pixel(90, 40), WHITE);
  const end = await comparePngWithSharedSvg(scene, 1, [[30, 40], [90, 40]]);
  assert.deepEqual(end.pixel(90, 40), RED, "the full endpoint is not lost to gradient-mask bounds");
});

test("Lottie samples hard reveal masks in parent coordinates and warns when Wipe feathering is approximated", async () => {
  const base = createLayer("rectangle", {
    id: "box", name: "Box", x: 20, y: 20, width: 80, height: 60, fill: "#ff0000", strokeWidth: 0,
  });
  const hard = createLayer("rectangle", { ...base, animations: [operation(base, "mask-up")] });
  const hardExport = await exportScene(baseScene([hard]), { format: "lottie", fps: 10, width: 120, height: 100 });
  const hardAnimation = JSON.parse(hardExport.buffer.toString("utf8"));
  const wrapper = hardAnimation.layers.find((layer) => layer.nm === "Box reveal");
  assert.ok(wrapper?.hasMask, "the content composition has a native sampled mask");
  assert.equal(wrapper.masksProperties[0].mode, "a");
  const path = wrapper.masksProperties[0].pt;
  assert.equal(path.a, 1);
  assert.deepEqual(path.k[0].s[0].v[0], [20, 80], "the first up-reveal path is collapsed at the bottom edge");
  assert.deepEqual(path.k.at(-1).s[0].v, [[0, 0], [120, 0], [120, 100], [0, 100]], "the final frame clears the mask across the composition");
  assert.ok(!hardExport.warnings?.some((warning) => warning.code === "lottie-reveal-softness"));

  const soft = createLayer("rectangle", {
    ...base,
    animations: [operation(base, "wipe", { direction: "right", softness: 20 })],
  });
  const softExport = await exportScene(baseScene([soft]), { format: "lottie", fps: 10, width: 120, height: 100 });
  assert.ok(softExport.warnings?.some((warning) => warning.code === "lottie-reveal-softness"), "the Lottie export reports its hard-edge approximation");
  assert.ok(JSON.parse(softExport.buffer.toString("utf8")).layers.some((layer) => layer.hasMask), "Wipe timing remains represented by a native mask");
});

test("soft Wipe sweeps the full feather past the box without endpoint opacity pops", async () => {
  const base = createLayer("rectangle", { id: "box", x: 20, y: 20, width: 80, height: 60, fill: "#ff0000", strokeWidth: 0 });
  const probes = { right: [[20, 50], [99, 50]], left: [[99, 50], [20, 50]], down: [[60, 20], [60, 79]], up: [[60, 79], [60, 20]] };
  for (const [direction, [first, last]] of Object.entries(probes)) {
    const scene = baseScene([{ ...base, animations: [operation(base, "wipe", { direction, softness: 20 })] }]);
    const early = await comparePngWithSharedSvg(scene, 0.01, [first]);
    const late = await comparePngWithSharedSvg(scene, 0.99, [last]);
    assert.ok(early.pixel(...first)[1] > 235, `${direction} starts nearly transparent`);
    assert.ok(late.pixel(...last)[1] < 20, `${direction} reaches nearly opaque before the final frame`);
  }
});
