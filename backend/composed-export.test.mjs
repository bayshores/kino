import test from "node:test";
import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { flattenAnimations } from "../engine/animationTree.js";
import { exportScene } from "./export.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { readImage } from "./media.test.support.mjs";

const fonts = await loadBundledFonts();
const testImage = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#1684ff"/></svg>').render().asPng();

function custom(id, start, duration, from, to, extra = {}) {
  return {
    id, name: id, kind: "custom", start, duration, easing: "linear", from, to,
    unit: "layer", stagger: 0, order: "forward", ...extra,
  };
}

function composed(id, start, animations, enabled = true) {
  return { id, name: id, kind: "composed", start, ...(enabled ? {} : { enabled: false }), animations };
}

function composedScene() {
  const reveal = { direction: "right", softness: 0 };
  const rectangle = createLayer("rectangle", {
    id: "box", name: "Box", x: 10, y: 10, width: 40, height: 30, fill: "#ed3429", strokeWidth: 0,
    animations: [composed("box-group", 0.1, [composed("box-nested", 0.1, [
      custom("resize-and-reveal", 0.1, 0.6,
        { width: 40, reveal: { ...reveal, progress: 0 } },
        { width: 60, reveal: { ...reveal, progress: 1 } }),
    ])])],
  });
  const text = createLayer("text", {
    id: "copy", name: "Copy", x: 5, y: 53, width: 70, height: 28, text: "AB", fontSize: 20,
    fontFamily: "Inter", textResize: "width-height", fill: "#111111",
    animations: [composed("copy-group", 0.1, [composed("copy-nested", 0.2, [
      custom("clipped-text-move", 0.1, 0.8, { x: 5, opacity: 0 }, { x: 16, opacity: 100 }, {
        textAnchor: "layer", textClip: true,
      }),
      { id: "change-copy", name: "Change text", kind: "change-text", start: 0.45, text: "CD", overlap: true,
        out: null, in: { preset: "fade-in", duration: 0.2, easing: "linear", unit: "layer", stagger: 0, order: "forward" } },
    ])])],
  });
  const bitmap = createLayer("image", {
    id: "bitmap", name: "Bitmap", x: 108, y: 12, width: 16, height: 16,
    src: `data:image/png;base64,${testImage.toString("base64")}`,
    animations: [
      composed("bitmap-group", 0.1, [composed("bitmap-nested", 0.1, [
        custom("bitmap-scale", 0.1, 0.6, { scaleX: 1, scaleY: 1 }, { scaleX: 3, scaleY: 3 }),
      ])]),
      composed("disabled-bitmap-group", 0, [
        custom("disabled-bitmap-scale", 0, 0.8, { scaleX: 1, scaleY: 1 }, { scaleX: 10, scaleY: 10 }),
      ], false),
    ],
  });
  return createScene({
    id: "composed-export", name: "Composed export", width: 160, height: 100, duration: 1.2,
    background: "#ffffff", layers: [rectangle, text, bitmap],
  });
}

function flattenedScene(scene) {
  return {
    ...scene,
    layers: scene.layers.map((layer) => ({
      ...layer,
      animations: flattenAnimations(layer.animations, { enabledOnly: true }),
    })),
  };
}

async function assertPngsMatch(grouped, flattened, time) {
  const options = { format: "png", time, width: 160, height: 100 };
  const [actual, expected] = await Promise.all([
    exportScene(grouped, options, { fonts }), exportScene(flattened, options, { fonts }),
  ]);
  const [left, right] = await Promise.all([readImage(actual.buffer), readImage(expected.buffer)]);
  assert.deepEqual([left.width, left.height], [right.width, right.height]);
  for (let y = 0; y < left.height; y += 1) for (let x = 0; x < left.width; x += 1)
    assert.deepEqual(left.pixel(x, y), right.pixel(x, y), `PNG pixel (${x},${y}) at ${time}s`);
}

test("PNG and Lottie preserve nested Composed reveal, resize, text clip, Change text, and bitmap scale", async () => {
  const grouped = composedScene();
  const flattened = flattenedScene(grouped);
  for (const time of [0.35, 0.6, 0.95]) await assertPngsMatch(grouped, flattened, time);

  const options = { format: "lottie", fps: 8, duration: 1.2, width: 160, height: 100, imageDPIRatio: "1x" };
  const [actual, expected] = await Promise.all([
    exportScene(grouped, options, { fonts }), exportScene(flattened, options, { fonts }),
  ]);
  assert.deepEqual(actual.warnings, expected.warnings);
  assert.deepEqual(JSON.parse(actual.buffer.toString("utf8")), JSON.parse(expected.buffer.toString("utf8")),
    "the nested export matches the same operations with absolute member starts");

  const animation = JSON.parse(actual.buffer.toString("utf8"));
  assert.ok(animation.layers.some((layer) => layer.nm === "Box reveal" && layer.hasMask),
    "the nested reveal receives its sampled Lottie mask");
  const bitmapAsset = animation.assets.find((asset) => asset.p);
  assert.ok(bitmapAsset, "the bitmap is embedded");
  assert.deepEqual([bitmapAsset.w, bitmapAsset.h], [48, 48],
    "bitmap density includes the enabled nested scale and excludes a disabled Composed ancestor");
});
