// Hide and Show operations export the same frames in every format: PNG stills and PNG sequences
// (which GIF and video encode), video, and Lottie, where the opacity switches with hold keyframes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { holdKeyframesAt, visibilitySwitchFrames } from "./lottie-visibility.mjs";
import { ffmpeg, ffprobe, readImage, readVideoFrames, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const SIZE = 32;
const hide = (start, id = `hide-${start}`) => ({ id, name: "Hide", kind: "hide", start });
const show = (start, id = `show-${start}`) => ({ id, name: "Show", kind: "show", start });
const fade = { id: "fade", name: "Fade", kind: "custom", start: 0, duration: 1, easing: "linear",
  from: { opacity: 0.5 }, to: { opacity: 1 } };

function box(animations, values = {}) {
  return createLayer("rectangle", { id: "box", name: "Box", x: 0, y: 0, width: SIZE, height: SIZE, fill: "#ff0000", animations, ...values });
}

function scene(layers, background = "transparent") {
  return createScene({ id: "visibility", name: "Visibility", width: SIZE, height: SIZE, duration: 1, background, layers });
}

async function lottie(document, fps) {
  return JSON.parse((await exportScene(document, { format: "lottie", fps })).buffer.toString("utf8"));
}

// Visible at time `time` for a layer hidden from 0.3 s and shown again at 0.7 s.
const expectedVisible = (frame, fps) => !(frame / fps >= 0.3 - 1e-9 && frame / fps < 0.7 - 1e-9);

test("visibility switch frames and hold keyframes", () => {
  const states = [{ visible: true }, { visible: false }, { visible: false }, {}, { visible: true }];
  assert.deepEqual([...visibilitySwitchFrames(states)], [0, 2]);
  const property = { a: 1, k: [
    { t: 0, s: [100], e: [0], i: { x: 1, y: 1 }, o: { x: 0, y: 0 } },
    { t: 1, s: [0], e: [0], i: { x: 1, y: 1 }, o: { x: 0, y: 0 } },
    { t: 2, s: [0], h: 1 },
  ] };
  holdKeyframesAt(property, new Set([0]));
  assert.deepEqual(property.k[0], { t: 0, s: [100], h: 1 });
  assert.equal(property.k[1].e[0], 0, "other keyframes stay linear");
  assert.deepEqual(holdKeyframesAt({ a: 0, k: 100 }, new Set([0])), { a: 0, k: 100 }, "a static value is unchanged");
});

test("Lottie switches opacity with hold keyframes at Hide and Show and keeps the opacity animation", async () => {
  // 30 fps: frame 9 is sampled at 0.2999997 s, frame 21 at 0.6999993 s (rounded export step).
  const fps = 30;
  const animation = await lottie(scene([box([fade, hide(0.3), show(0.7)])]), fps);
  const opacity = animation.layers.find((layer) => layer.nm === "Box").ks.o;
  assert.equal(opacity.a, 1);
  assert.equal(opacity.k.length, fps + 1);
  for (const keyframe of opacity.k) {
    const visible = expectedVisible(keyframe.t, fps);
    const value = visible ? (0.5 + 0.5 * (keyframe.t / fps)) * 100 : 0;
    assert.ok(Math.abs(keyframe.s[0] - value) < 1e-3, `frame ${keyframe.t}: opacity ${keyframe.s[0]}, expected ${value}`);
    const switches = expectedVisible(keyframe.t, fps) !== expectedVisible(keyframe.t + 1, fps);
    if (switches || keyframe.t === fps) {
      assert.equal(keyframe.h, 1, `frame ${keyframe.t} holds its value until the next frame`);
      assert.equal(keyframe.e, undefined);
    } else assert.equal(keyframe.h, undefined, `frame ${keyframe.t} stays linear, so the fade stays smooth`);
  }
  assert.deepEqual(opacity.k.filter((keyframe) => keyframe.h === 1).map((keyframe) => keyframe.t), [8, 20, 30]);
  assert.equal(animation.layers.find((layer) => layer.nm === "Box").ip, 0, "in and out points stay at the whole animation");
});

test("Lottie: a group's Hide hides its layers", async () => {
  const group = createLayer("group", { id: "group", name: "Group", width: SIZE, height: SIZE, animations: [hide(0.5)] });
  const child = createLayer("rectangle", { id: "child", name: "Child", parentId: "group", width: 10, height: 10 });
  const grouped = await lottie(scene([group, child]), 10);
  const precomp = grouped.layers.find((layer) => layer.nm === "Group");
  assert.equal(precomp.ty, 0, "the group is a precomposition");
  assert.deepEqual(precomp.ks.o.k.map((keyframe) => keyframe.s[0]), [100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0]);
  assert.equal(precomp.ks.o.k[4].h, 1, "the group switches off at once at 0.5 s");
  const inner = grouped.assets.find((asset) => asset.id === precomp.refId).layers.find((layer) => layer.nm === "Child");
  assert.deepEqual(inner.ks.o, { a: 0, k: 100 }, "the child keeps its own opacity; the group hides it");
});

// A white mask over the left half of a red box, hidden by a Hide at 0.5 s.
const halfMask = (animations) => createLayer("rectangle", { id: "mask", name: "Mask", isMask: true, x: 0, y: 0,
  width: SIZE / 2, height: SIZE, fill: "#ffffff", animations });

test("a mask that a Hide hides masks nothing in every export, like a mask hidden with the eye button", async () => {
  const document = scene([halfMask([hide(0.5)]), box([])]);
  const eyeHidden = scene([{ ...halfMask([]), visible: false }, box([])]);
  const pixel = async (document, time, x) => (await readImage((await exportScene(document, { format: "png", time })).buffer)).pixel(x, SIZE / 2);
  assert.deepEqual(await pixel(document, 0.3, 8), [255, 0, 0, 255], "inside the mask the box shows");
  assert.equal((await pixel(document, 0.3, 24))[3], 0, "outside the mask it is masked away");
  assert.deepEqual(await pixel(document, 0.5, 24), [255, 0, 0, 255], "after the Hide the whole box shows");
  assert.deepEqual(await pixel(document, 0.5, 24), await pixel(eyeHidden, 0.5, 24));

  // Lottie, front to back: the matte, the masked box, then a copy of the box without the matte
  // that shows only while the mask is off. All three switch at once at the same frame.
  const animation = await lottie(document, 10);
  assert.deepEqual(animation.layers.map((layer) => layer.nm), ["Mask", "Box", "Box (mask off)"]);
  const [matte, masked, unmasked] = animation.layers;
  assert.equal(matte.td, 1);
  assert.equal(masked.tt, 3);
  assert.equal(masked.tp, matte.ind);
  assert.equal(Object.hasOwn(unmasked, "tt") || Object.hasOwn(unmasked, "td"), false, "the copy is not masked");
  const opacity = (layer) => layer.ks.o.k.map((keyframe) => keyframe.s[0]);
  assert.deepEqual(opacity(matte), [100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(opacity(unmasked), [0, 0, 0, 0, 0, 100, 100, 100, 100, 100, 100]);
  assert.equal(matte.ks.o.k[4].h, 1);
  assert.equal(unmasked.ks.o.k[4].h, 1, "the copy appears at once, at the frame the matte goes");
  assert.equal(unmasked.ty, 0, "the copy is a precomposition, so its own opacity is left alone");
  const copy = animation.assets.find((asset) => asset.id === unmasked.refId).layers;
  assert.deepEqual(copy.map((layer) => layer.nm), ["Box"]);
  const indexes = [animation.layers, ...animation.assets.map((asset) => asset.layers)].flat().map((layer) => layer.ind);
  assert.equal(new Set(indexes).size, indexes.length, "every layer index is unique");

  // A mask that is off on every frame adds the box without a matte, as with the eye off.
  const off = await lottie(scene([halfMask([hide(0)]), box([])]), 10);
  assert.deepEqual(off.layers.map((layer) => layer.nm), ["Box"]);
  assert.equal(Object.hasOwn(off.layers[0], "tt"), false);
  assert.deepEqual(off.layers.map((layer) => layer.nm), (await lottie(eyeHidden, 10)).layers.map((layer) => layer.nm));
});

test("Lottie: in a mask group, a mask that a Hide hides shows the layers above it unmasked from then on", async () => {
  const group = createLayer("group", { id: "group", name: "Mask group", isMaskGroup: true, x: 0, y: 0, width: SIZE, height: SIZE });
  const mask = { ...halfMask([hide(0.5)]), parentId: "group" };
  const document = scene([group, mask, box([], { parentId: "group" }),
    createLayer("rectangle", { id: "dot", name: "Dot", parentId: "group", x: 20, y: 20, width: 4, height: 4, fill: "#0000ff" })]);
  const animation = await lottie(document, 10);
  const content = animation.assets.find((asset) => asset.id === animation.layers[0].refId).layers;
  assert.deepEqual(content.map((layer) => layer.nm), ["Mask", "Masked layers", "Masked layers (mask off)"]);
  const unmasked = content[2];
  assert.deepEqual(unmasked.ks.o.k.map((keyframe) => keyframe.s[0]), [0, 0, 0, 0, 0, 100, 100, 100, 100, 100, 100]);
  assert.deepEqual(animation.assets.find((asset) => asset.id === unmasked.refId).layers.map((layer) => layer.nm), ["Dot", "Box"]);
  const image = await readImage((await exportScene(document, { format: "png", time: 0.5 })).buffer);
  assert.deepEqual(image.pixel(24, 8), [255, 0, 0, 255], "the PNG shows the box outside the old mask too");
  assert.deepEqual(image.pixel(21, 21), [0, 0, 255, 255]);
});

test("PNG stills and PNG sequences show the layer exactly from Show and hide it exactly from Hide", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-visibility-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const document = scene([box([fade, hide(0.3), show(0.7)])]);
  const alphaAt = async (buffer) => (await readImage(buffer)).pixel(SIZE / 2, SIZE / 2)[3];
  const still = async (time) => alphaAt((await exportScene(document, { format: "png", time })).buffer);
  assert.ok((await still(0.29)) > 0, "visible just before the Hide");
  assert.equal(await still(0.3), 0, "hidden at the Hide's own time");
  assert.equal(await still(0.69), 0);
  assert.ok((await still(0.7)) > 0, "shown at the Show's own time");

  const fps = 30;
  const sequenceDirectory = join(directory, "sequence");
  await mkdir(sequenceDirectory);
  await exportScene(document, { format: "png-sequence", fps }, { sequenceDirectory });
  const names = (await readdir(sequenceDirectory)).sort();
  assert.equal(names.length, fps);
  const visible = [];
  for (const name of names) visible.push((await alphaAt(await readFile(join(sequenceDirectory, name)))) > 0);
  assert.deepEqual(visible, names.map((_, frame) => expectedVisible(frame, fps)), "the same frames Lottie shows");
});

test("a GIF hides and shows the layer on the expected frames", { skip: skipWithoutMediaTools }, async () => {
  const fps = 10;
  const result = await exportScene(scene([box([hide(0.3), show(0.7)])], "#000000"), { format: "gif", fps });
  // The GIF encoder may merge equal neighbouring frames into one longer frame, so read each
  // stored picture with its start time, and look up which picture is on screen at each frame time.
  const raw = await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-fps_mode", "passthrough",
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: result.buffer });
  const starts = String(await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
    "-of", "csv=p=0", "-i", "pipe:0"], { input: result.buffer })).trim().split("\n").map(Number);
  const frameBytes = SIZE * SIZE * 4;
  const center = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
  const pictures = [];
  for (let offset = 0; offset + frameBytes <= raw.length; offset += frameBytes) pictures.push(raw[offset + center] > 128);
  assert.equal(pictures.length, starts.length, "one decoded picture per stored GIF frame");
  const frames = Array.from({ length: fps }, (_, frame) => frame);
  const shown = frames.map((frame) => pictures[starts.findLastIndex((start) => start <= frame / fps + 1e-6)]);
  assert.deepEqual(shown, frames.map((frame) => expectedVisible(frame, fps)));
});

test("an MP4 hides and shows the layer on the same frames as Lottie", { skip: skipWithoutMediaTools }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-visibility-video-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fps = 30;
  const document = scene([box([hide(0.3), show(0.7)])], "#000000");
  const outputPath = join(directory, "visibility.mp4");
  await exportScene(document, { format: "mp4", fps }, { outputPath });
  const frames = await readVideoFrames(outputPath, { width: SIZE, height: SIZE });
  assert.equal(frames.length, fps);
  const mp4Visible = frames.map((frame) => frame.pixel(SIZE / 2, SIZE / 2)[0] > 128);
  const opacity = (await lottie(scene([box([hide(0.3), show(0.7)])]), fps)).layers.find((layer) => layer.nm === "Box").ks.o;
  const lottieVisible = opacity.k.slice(0, fps).map((keyframe) => keyframe.s[0] > 0);
  assert.deepEqual(mp4Visible, lottieVisible);
  assert.deepEqual(mp4Visible, frames.map((_, frame) => expectedVisible(frame, fps)));
});
