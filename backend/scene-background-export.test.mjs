import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { mediaBackgroundLayer } from "../engine/sceneBackground.js";
import { duplicateSceneInDocument } from "../engine/sceneDuplication.js";
import { expandComponents } from "../engine/linkedComponents.js";
import { documentMediaIds } from "./media-use.mjs";
import { exportScene } from "./export.mjs";
import { near, readImage, readVideoFrames, skipWithoutMediaTools } from "./media.test.support.mjs";

const RED = "#ff0000";
const BLUE = "#0000ff";
const GRADIENT = {
  type: "linear",
  angle: 0,
  stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
};

function colorAnimation(from, to) {
  return {
    id: "background-color",
    name: "Color",
    kind: "custom",
    start: 0,
    duration: 1,
    easing: "linear",
    from: { fill: from },
    to: { fill: to },
    unit: "layer",
    stagger: 0,
    order: "forward",
  };
}

function walk(value, matches, found = []) {
  if (Array.isArray(value)) value.forEach((item) => walk(item, matches, found));
  else if (value && typeof value === "object") {
    if (matches(value)) found.push(value);
    Object.values(value).forEach((child) => walk(child, matches, found));
  }
  return found;
}

function scene(overrides = {}) {
  return createScene({
    id: "background-export",
    name: "Background export",
    width: 40,
    height: 20,
    duration: 1,
    background: "#ffffff",
    layers: [],
    ...overrides,
  });
}

test("PNG export paints a scene gradient across the full artboard", async () => {
  const image = await readImage((await exportScene(scene({ background: GRADIENT }), { format: "png" })).buffer);
  assert.ok(near(image.pixel(0, 10), [255, 0, 0, 255], 16), `left edge is red: ${image.pixel(0, 10)}`);
  assert.ok(near(image.pixel(39, 10), [0, 0, 255, 255], 16), `right edge is blue: ${image.pixel(39, 10)}`);
});

test("PNG export evaluates a scene background Color animation at the requested time", async () => {
  const value = scene({ background: RED, backgroundAnimations: [colorAnimation(RED, BLUE)] });
  const start = await readImage((await exportScene(value, { format: "png", time: 0 })).buffer);
  const end = await readImage((await exportScene(value, { format: "png", time: 1 })).buffer);
  assert.ok(near(start.pixel(20, 10), [255, 0, 0, 255]), `time 0 is red: ${start.pixel(20, 10)}`);
  assert.ok(near(end.pixel(20, 10), [0, 0, 255, 255]), `time 1 is blue: ${end.pixel(20, 10)}`);
});

test("component scene copies export a translucent background once, with independent Color animation IDs", async () => {
  for (const animated of [false, true]) {
    const source = scene({ id: "copy-source", isComponent: true, background: "#ff000080",
      backgroundAnimations: animated ? [colorAnimation("#ff000040", "#ff000080")] : [] });
    const result = duplicateSceneInDocument(createDocument({ scenes: [source] }), source.id);
    for (const time of [0, 0.5, 1]) {
      const original = await readImage((await exportScene(expandComponents(result.document, source.id), { format: "png", time })).buffer);
      const copy = await readImage((await exportScene(expandComponents(result.document, result.sceneId), { format: "png", time })).buffer);
      assert.deepEqual(copy.pixel(20, 10), original.pixel(20, 10), `same exported paint, animated=${animated}, time=${time}`);
    }
    const transparent = await readImage((await exportScene(expandComponents(result.document, result.sceneId), { format: "png", transparent: true, time: 0.5 })).buffer);
    assert.equal(transparent.pixel(20, 10)[3], 0, "transparent export has no linked source background left behind");
  }
});

test("a duplicated component has one Lottie background fill with the original alpha keyframes", async () => {
  const source = scene({ id: "lottie-copy-source", isComponent: true, background: "#ff000080",
    backgroundAnimations: [colorAnimation("#ff000040", "#ff000080")] });
  const result = duplicateSceneInDocument(createDocument({ scenes: [source] }), source.id);
  const expanded = expandComponents(result.document, result.sceneId);
  const data = JSON.parse((await exportScene(expanded, { format: "lottie", fps: 4 })).buffer.toString("utf8"));
  const fills = walk(data, (item) => item.ty === "fl");
  assert.equal(fills.length, 1, "the linked source adds no second fill");
  assert.equal(data.layers.at(-1).nm, "Background");
  assert.equal(fills[0].o.a, 1);
  assert.ok(Math.abs(fills[0].o.k[0].s[0] - 64 / 255 * 100) < 0.001);
  assert.ok(Math.abs(fills[0].o.k.at(-1).s[0] - 128 / 255 * 100) < 0.001);
  const transparent = JSON.parse((await exportScene(expanded, { format: "lottie", fps: 4, transparent: true })).buffer.toString("utf8"));
  assert.deepEqual(walk(transparent, (item) => item.ty === "fl"), []);
});

test("transparent PNG export removes background paint and its animation", async () => {
  const value = scene({ background: GRADIENT, backgroundAnimations: [colorAnimation(GRADIENT, BLUE)] });
  const image = await readImage((await exportScene(value, { format: "png", transparent: true, time: 0.5 })).buffer);
  assert.deepEqual(image.pixel(20, 10), [0, 0, 0, 0]);
});

test("transparent export keeps a persisted uploaded Background content layer and media tracking", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-background-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const picture = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000"/></svg>')
    .render().asPng();
  const mediaId = "00000000-0000-4000-8000-000000000001.png";
  await writeFile(join(directory, mediaId), picture);
  const target = scene({ background: BLUE });
  target.layers = [mediaBackgroundLayer(target, { type: "image", width: 4, height: 4, src: `/api/media/${mediaId}` })];
  const document = parseDocument(JSON.stringify(createDocument({ scenes: [target] })));
  assert.deepEqual([...documentMediaIds(document)], [mediaId]);
  assert.equal(document.scenes[0].layers[0].locked, true);
  const image = await readImage((await exportScene(document.scenes[0], {
    format: "png",
    transparent: true,
  }, { mediaRoot: directory })).buffer);
  assert.ok(near(image.pixel(20, 10), [255, 0, 0, 255]), `the media layer remains visible: ${image.pixel(20, 10)}`);
});

test("MP4 export draws the configured scene background", { skip: skipWithoutMediaTools }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-scene-background-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "background.mp4");
  await exportScene(scene({ background: "#285078" }), {
    profile: "mp4.alt",
    fps: 4,
    width: 40,
    height: 20,
  }, { outputPath });
  const frames = await readVideoFrames(outputPath, { width: 40, height: 20 });
  assert.ok(frames.length >= 1, "the MP4 contains a frame");
  assert.ok(near(frames[0].pixel(20, 10), [40, 80, 120, 255], 20), `frame shows the background: ${frames[0].pixel(20, 10)}`);
});

test("static solid Lottie background output retains the legacy serialized shape", async () => {
  const value = scene({ id: "background-snapshot", name: "Background", background: "#336699" });
  const result = await exportScene(value, { format: "lottie", fps: 4 });
  assert.equal(result.buffer.toString("utf8"), '{"v":"5.12.2","fr":4,"ip":0,"op":4,"w":40,"h":20,"nm":"Background","ddd":0,"assets":[],"layers":[{"ddd":0,"ind":1,"ty":4,"nm":"Background","sr":1,"ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":0,"k":[0,0,0]},"a":{"a":0,"k":[0,0,0]},"s":{"a":0,"k":[100,100,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"ty":"rc","d":1,"p":{"a":0,"k":[20,10]},"s":{"a":0,"k":[40,20]},"r":{"a":0,"k":0},"nm":"Background rectangle","hd":false},{"ty":"fl","c":{"a":0,"k":[0.2,0.4,0.6]},"o":{"a":0,"k":100},"r":1,"bm":0,"nm":"Background fill","hd":false},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100},"sk":{"a":0,"k":0},"sa":{"a":0,"k":0},"nm":"Transform"}],"nm":"Background","np":3,"cix":2,"bm":0,"ix":1,"mn":"ADBE Vector Group","hd":false}],"ip":0,"op":4,"st":0,"bm":0}],"markers":[]}');
});

test("Lottie background Color animations use fill keyframes on the bottom layer", async () => {
  const foreground = createLayer("rectangle", { id: "foreground", name: "Content", fill: "#00ff00" });
  const value = scene({
    background: RED,
    backgroundAnimations: [colorAnimation(RED, BLUE)],
    layers: [foreground],
  });
  const data = JSON.parse((await exportScene(value, { format: "lottie", fps: 4 })).buffer.toString("utf8"));
  assert.equal(data.layers.at(-1).nm, "Background", "the background is the bottom drawing layer");
  const backgroundFill = walk(data.layers.at(-1), (item) => item.ty === "fl" && item.nm === "Fill")[0];
  assert.ok(backgroundFill, "background is serialized through the normal shape fill path");
  assert.equal(backgroundFill.c.a, 1);
  assert.equal(backgroundFill.c.k.length, 5);
  assert.deepEqual(backgroundFill.c.k[0].s, [1, 0, 0]);
  assert.deepEqual(backgroundFill.c.k.at(-1).s, [0, 0, 1]);
});

test("Lottie exports a gradient background as a native bottom-layer gradient fill", async () => {
  const foreground = createLayer("rectangle", { id: "foreground", name: "Content", fill: "#00ff00" });
  const value = scene({ background: GRADIENT, layers: [foreground] });
  const data = JSON.parse((await exportScene(value, { format: "lottie", fps: 4 })).buffer.toString("utf8"));
  assert.equal(data.layers.at(-1).nm, "Background", "the background is the bottom drawing layer");
  const [gradient] = walk(data.layers.at(-1), (item) => item.ty === "gf");
  assert.ok(gradient, "gradient background uses a native Lottie gradient fill");
  assert.equal(gradient.t, 1, "the fill is linear");
  assert.equal(gradient.g.p, 2);
});

test("a disabled Lottie background adds no background layer", async () => {
  const value = scene({ background: "#ff0000", backgroundEnabled: false, layers: [] });
  const data = JSON.parse((await exportScene(value, { format: "lottie", fps: 4 })).buffer.toString("utf8"));
  assert.deepEqual(data.layers, []);
});
