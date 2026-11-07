import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDocument, createScene, createLayer, parseDocument } from "../engine/model.js";
import { createComponentFromLayers } from "../engine/createComponent.js";
import { expandComponents, createComponentInstance } from "../engine/linkedComponents.js";
import { presetAnimation } from "../engine/animation.js";
import { loadBundledFonts } from "./fonts.mjs";
import { exportScene } from "./export.mjs";
import { makeAnimatedGif, makeVideo, skipWithoutMediaTools } from "./media.test.support.mjs";

const fonts = await loadBundledFonts();

function fixture() {
  const badge = createScene({ id: "badge", isComponent: true, width: 60, height: 30, background: "#00000000", layers: [
    createLayer("ellipse", { id: "badge-shape", x: 0, y: 0, width: 60, height: 30, fill: "#5784ff" }),
  ] });
  const rectangle = createLayer("rectangle", { id: "turned", name: "Turned", x: 65, y: 60, width: 45, height: 32, rotation: 31, fill: "#e95370", shadow: { color: "#00000088", x: -24, y: -18, blur: 8 }, stroke: "#453273", strokeWidth: 3, strokeAlign: "outside" });
  rectangle.animations = [{ ...presetAnimation("slide-right", rectangle, 0.25), id: "slide-in", duration: 1, easing: "linear" }];
  const main = createScene({ id: "main", width: 360, height: 240, duration: 3, background: "#faf5ed", layers: [
    rectangle,
    createLayer("text", { id: "title", name: "Centred text", x: 125, y: 118, width: 12, height: 10, text: "Component", textAlign: "center", textResize: "width-height", fontFamily: "Inter", fontSize: 23, fill: "#203852" }),
    createLayer("ellipse", { id: "mask", name: "Mask", x: 180, y: 42, width: 74, height: 55, isMask: true, fill: "#ffffff" }),
    createLayer("rectangle", { id: "masked", name: "Masked", x: 165, y: 33, width: 100, height: 78, fill: "#ffc857" }),
    createComponentInstance(badge, { id: "nested", name: "Nested badge", x: 130, y: 90, rotation: -12, componentOverrides: { "badge-shape": { fill: "#31b6a5" } } }),
    createLayer("rectangle", { id: "blend", name: "Blended", x: 90, y: 75, width: 110, height: 48, fill: "#69b4d488", blendMode: "multiply" }),
  ] });
  return parseDocument(createDocument({ scenes: [main, badge] }));
}

async function frame(document, time, sceneId = "main", mediaRoot) {
  const scene = expandComponents(document, sceneId, { fonts });
  const png = await exportScene(scene, { format: "png", time }, { fonts, mediaRoot });
  assert.equal(png.mime, "image/png");
  const image = await loadImage(png.buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height).data;
}

test("Create component preserves PNG RGBA through motion, text, outside shadows, masks, nesting and blending", async () => {
  const before = fixture();
  const after = createComponentFromLayers(before, "main", before.scenes[0].layers.map((layer) => layer.id), { componentSceneId: "created", instanceId: "instance", fonts }).document;
  for (const time of [0, 0.75, 1.25, 3]) {
    const original = await frame(before, time);
    const converted = await frame(after, time);
    assert.equal(converted.length, original.length);
    let maximum = 0;
    for (let index = 0; index < original.length; index += 1) maximum = Math.max(maximum, Math.abs(original[index] - converted[index]));
    assert.ok(maximum <= 1, `RGBA changed by ${maximum} at ${time}s (allowed: 1 per channel)`);
  }
});

test("a created component exports its live nested content and masks through the Lottie path", async () => {
  const before = fixture();
  const next = createComponentFromLayers(before, "main", before.scenes[0].layers.map((layer) => layer.id), { name: "Card component", fonts }).document;
  const original = await exportScene(expandComponents(next, "main", { fonts }), { format: "lottie", fps: 4 }, { fonts });
  next.scenes[1].layers.find((layer) => layer.id === "title").text = "Live source edit";
  const result = await exportScene(expandComponents(next, "main", { fonts }), { format: "lottie", fps: 4 }, { fonts });
  assert.notDeepEqual(result.buffer, original.buffer, "a source edit changes the exported glyph outlines");
  const data = JSON.parse(result.buffer.toString());
  const layers = [...data.layers, ...data.assets.flatMap((asset) => asset.layers ?? [])];
  assert.ok(layers.some((layer) => layer.nm === "Card component"));
  assert.ok(layers.some((layer) => layer.nm?.startsWith("Centred text ")));
  assert.ok(layers.some((layer) => layer.nm === "Nested badge"));
  assert.ok(layers.some((layer) => layer.tt === 3), "the mask keeps its luminance matte");
  assert.ok(result.warnings?.some((warning) => warning.code === "lottie-blend-mode-normalized"), "the existing Lottie blend-mode limitation stays explicit");
});

test("existing instances retain overridden pixels when a selection becomes another component inside their main", async () => {
  const before = fixture();
  before.scenes[0].isComponent = true;
  before.scenes.push(createScene({ id: "output", width: 450, height: 300, duration: 3, layers: [
    createComponentInstance(before.scenes[0], { id: "existing", x: 20, y: 20, componentOverrides: {
      title: { text: "Overridden", x: 120, y: 142, fontSize: 27 },
      turned: { fill: "#3947c8", x: 40, rotation: 45 },
      "nested/badge-shape": { fill: "#dc7233" },
    } }),
  ] }));
  const validated = parseDocument(before);
  const after = createComponentFromLayers(validated, "main", before.scenes[0].layers.map((layer) => layer.id), { fonts }).document;
  for (const time of [0, 0.75, 1.25, 3]) {
    const original = await frame(validated, time, "output");
    const converted = await frame(after, time, "output");
    let maximum = 0;
    for (let index = 0; index < original.length; index += 1) maximum = Math.max(maximum, Math.abs(original[index] - converted[index]));
    assert.ok(maximum <= 1, `overridden RGBA changed by ${maximum} at ${time}s`);
  }
});

test("finite video and GIF selections preserve PNG frames before, at and after their Play end", { skip: skipWithoutMediaTools }, async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-component-create-media-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  await writeFile(join(mediaRoot, "colors.gif"), makeAnimatedGif({
    width: 8, height: 8, frames: colors.map((color) => ({ color, delayCs: 25 })),
  }));
  await makeVideo(join(mediaRoot, "colors.mp4"), {
    width: 32, height: 24, fps: 4, frames: 12, frameColor: (index) => colors[index % colors.length],
  });
  for (const type of ["video", "image"]) {
    for (const mediaFreeze of ["none", "first"]) {
      await t.test(`${type}/${mediaFreeze}`, async () => {
        const layer = createLayer(type, {
          id: "finite-media", x: 12, y: 10, width: 32, height: 24,
          src: `/api/media/colors.${type === "video" ? "mp4" : "gif"}`,
          mediaStart: 0.5, mediaDuration: 2, mediaOffset: 0.25, mediaFreeze,
        });
        const before = parseDocument(createDocument({ scenes: [createScene({
          id: "main", width: 64, height: 48, duration: 5, background: "#ffffff", layers: [layer],
        })] }));
        const after = createComponentFromLayers(before, "main", [layer.id], {
          componentSceneId: "created", instanceId: "instance", fonts,
        }).document;
        for (const time of [0, 0.5, 1.25, 2.5, 2.5 + 1 / 60, 4, 5]) {
          const original = await frame(before, time, "main", mediaRoot);
          const converted = await frame(after, time, "main", mediaRoot);
          assert.equal(converted.length, original.length);
          let maximum = 0;
          for (let index = 0; index < original.length; index += 1) maximum = Math.max(maximum, Math.abs(original[index] - converted[index]));
          assert.ok(maximum <= 1, `${type}/${mediaFreeze} RGBA changed by ${maximum} at ${time}s (allowed: 1 per channel)`);
        }
        const opacity = async (document) => {
          const result = await exportScene(expandComponents(document, "main", { fonts }), { format: "lottie", fps: 4 }, { fonts, mediaRoot });
          const data = JSON.parse(result.buffer.toString());
          const layers = [...data.layers, ...data.assets.flatMap((asset) => asset.layers ?? [])];
          const media = layers.find((item) => item.nm === layer.name && item.ks?.o?.a === 1);
          assert.ok(media, "Lottie includes the timed media's opacity keyframes");
          return media.ks.o;
        };
        const originalOpacity = await opacity(before);
        assert.deepEqual(await opacity(after), originalOpacity, "Lottie retains the media visibility keyframes after extraction");
        assert.ok(originalOpacity.k.some((keyframe) => keyframe.t / 4 > 2.5 && keyframe.s[0] === 0), "Lottie hides frames after Play");
      });
    }
  }
});
