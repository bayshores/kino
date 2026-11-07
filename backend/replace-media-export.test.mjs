import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { exportScene } from "./export.mjs";
import { makeAnimatedGif, makeVideo, readImage, skipWithoutMediaTools } from "./media.test.support.mjs";

async function fixture(t) {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-replace-render-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const png = { id: "11111111-1111-4111-8111-111111111111.png", mime: "image/png", name: "green.png", duration: 0 };
  const gif = { id: "22222222-2222-4222-8222-222222222222.gif", mime: "image/gif", name: "colors.gif", duration: 0.3, animated: true, frameCount: 2 };
  const video = { id: "33333333-3333-4333-8333-333333333333.mp4", mime: "video/mp4", name: "clip.mp4", duration: 0.3, hasAudio: false };
  for (const item of [png, gif, video]) item.src = `/api/media/${item.id}`;
  const canvas = createCanvas(4, 8), context = canvas.getContext("2d");
  context.fillStyle = "#00ff00"; context.fillRect(0, 0, 4, 8);
  await writeFile(path.join(mediaRoot, png.id), await canvas.encode("png"));
  await writeFile(path.join(mediaRoot, gif.id), makeAnimatedGif({ width: 8, height: 4,
    frames: [{ delayCs: 10, color: [255, 0, 0] }, { delayCs: 20, color: [0, 255, 0] }] }));
  const document = createDocument({ scenes: [createScene({ id: "scene", duration: 0.3, width: 32, height: 24, background: "#112233", layers: [
    createLayer("image", { id: "layer", name: png.name, src: png.src, x: 4, y: 6, width: 16, height: 8,
      animations: [{ id: "fade", name: "Fade", kind: "custom", start: 0, duration: 0.2, easing: "linear", from: { opacity: 1 }, to: { opacity: 1 } }] }),
  ] })] });
  const mediaById = new Map([png, gif, video].map((item) => [item.id, item]));
  const replace = (source, media) => applyOperations(source, [{ type: "replace_media", sceneId: "scene", layerId: "layer", mediaId: media.id }], { mediaById });
  return { mediaRoot, png, gif, video, document, replace };
}

test("replaced GIFs render their new decoded frames in PNG and carry the existing Lottie first-frame warning", async (t) => {
  const { mediaRoot, gif, document, replace } = await fixture(t);
  const scene = replace(document, gif).scenes[0];
  const rendered = await readImage((await exportScene(scene, { format: "png", time: 0.15 }, { mediaRoot })).buffer);
  assert.deepEqual(rendered.pixel(10, 10), [0, 255, 0, 255]);
  assert.deepEqual(rendered.pixel(30, 22), [17, 34, 51, 255]);
  const lottie = await exportScene(scene, { format: "lottie", fps: 10 }, { mediaRoot });
  assert.ok(lottie.warnings.some((warning) => warning.code === "lottie-gif-first-frame"));
  const asset = JSON.parse(lottie.buffer).assets.find((item) => item.p?.startsWith("data:image/"));
  assert.ok(asset);
  const still = await readImage(Buffer.from(asset.p.split(",")[1], "base64"));
  const pixel = still.pixel(0, 0);
  assert.ok(pixel[0] > 250 && pixel[1] < 5 && pixel[2] < 5, "the embedded still is the new GIF's first frame");
});

test("video replacement and its later still replacement reach PNG, encoded video and Lottie using the kept box", { skip: skipWithoutMediaTools }, async (t) => {
  const { mediaRoot, png, video, document, replace } = await fixture(t);
  await makeVideo(path.join(mediaRoot, video.id), { width: 8, height: 4, fps: 10, frames: 3,
    frameColor: (index) => index ? [0, 255, 0] : [255, 0, 0] });
  const replaced = replace(document, video);
  const frame = await readImage((await exportScene(replaced.scenes[0], { format: "png", time: 0.15 }, { mediaRoot })).buffer);
  assert.ok(frame.pixel(10, 10)[1] > 250);
  const still = replace(replaced, png).scenes[0];
  assert.equal(still.layers[0].mediaDuration, 0);
  const rendered = await readImage((await exportScene(still, { format: "png", time: 0.15 }, { mediaRoot })).buffer);
  assert.deepEqual(rendered.pixel(4, 6), [0, 255, 0, 255], "new image covers the old box's corner");
  assert.deepEqual(rendered.pixel(19, 13), [0, 255, 0, 255]);
  assert.deepEqual(rendered.pixel(20, 14), [17, 34, 51, 255], "box did not resize");
  const mp4 = await exportScene(still, { format: "mp4", fps: 10, duration: 0.3 }, { mediaRoot });
  assert.ok(mp4.buffer.length > 100);
  const lottie = await exportScene(still, { format: "lottie", fps: 10 }, { mediaRoot });
  assert.ok(!lottie.warnings?.some((warning) => /video|gif/.test(warning.code)));
  const animation = JSON.parse(lottie.buffer);
  const asset = animation.assets.find((item) => item.p?.startsWith("data:image/png;base64,"));
  assert.ok(asset);
  // The asset is the still itself (its plain sRGB tag dropped, as for every render): same pixels.
  const [source, embedded] = await Promise.all([readImage(await readFile(path.join(mediaRoot, png.id))), readImage(Buffer.from(asset.p.split(",")[1], "base64"))]);
  assert.deepEqual([embedded.width, embedded.height, embedded.pixel(4, 6)], [source.width, source.height, source.pixel(4, 6)]);
});
