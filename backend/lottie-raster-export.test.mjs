import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { EFFECTS, effectDefaults } from "../engine/effects/catalog.js";
import { captureLayerSvg } from "../engine/render.js";
import { exportScene } from "./export.mjs";
import { startTestServer } from "./media.test.support.mjs";

const outputOptions = { format: "lottie", fps: 2, duration: 1 };

// Color Grade's defaults are the identity, so these captures use a visible 1.5 contrast.
const VISIBLE = { "color-grade": { contrast: 1.5 } };
function effectOperation(key, { id = `effect-${key}`, parameters = { ...effectDefaults(key), ...VISIBLE[key] } } = {}) {
  const definition = EFFECTS.find((effect) => effect.key === key);
  return {
    id, name: definition.label, kind: "effect", effect: key,
    start: 0, duration: 1, easing: "linear", to: parameters,
    ...(definition.kind === "ranged" ? { keepStill: "both" } : {}),
  };
}

function colorGradeLayer({ id = "static-grade", name = "Color Grade", ...overrides } = {}) {
  return createLayer("rectangle", {
    id, name, x: 12, y: 8, width: 20, height: 16, fill: "#E63946",
    ...overrides,
    animations: [effectOperation("color-grade")],
  });
}

function sceneWith(layers, { id = "raster-scene", width = 48, height = 36, ...overrides } = {}) {
  return createScene({ id, name: "Raster export", width, height, duration: 1, background: "#FFFFFF", layers, ...overrides });
}

function animationFrom(result) {
  return JSON.parse(result.buffer.toString("utf8"));
}

function allLottieLayers(animation) {
  const assets = new Map(animation.assets.map((asset) => [asset.id, asset]));
  const seen = new Set();
  const layers = [];
  const visit = (items) => {
    for (const layer of items ?? []) {
      layers.push(layer);
      const asset = layer.ty === 0 ? assets.get(layer.refId) : null;
      if (asset?.layers && !seen.has(asset.id)) {
        seen.add(asset.id);
        visit(asset.layers);
      }
    }
  };
  visit(animation.layers);
  return layers;
}

function sequenceFor(animation, name) {
  const assets = new Map(animation.assets.map((asset) => [asset.id, asset]));
  const root = allLottieLayers(animation).find((layer) => layer.nm === name && layer.ty === 0 &&
    assets.get(layer.refId)?.id.startsWith("effect_sequence_"));
  assert.ok(root, `expected embedded raster sequence for ${name}`);
  return { root, asset: assets.get(root.refId), assets };
}

const imageFrames = (sequence) => sequence.asset.layers.filter((layer) => layer.ty === 2).sort((a, b) => a.ip - b.ip);

function assertContinuous(frames, expectedEnd = 2) {
  assert.ok(frames.length > 0);
  let cursor = 0;
  for (const frame of frames) {
    assert.equal(frame.ip, cursor);
    assert.ok(frame.op > frame.ip);
    cursor = frame.op;
  }
  assert.equal(cursor, expectedEnd);
}

async function readEmbeddedPng(sequence, frame) {
  const asset = sequence.assets.get(frame.refId);
  assert.ok(asset, "Lottie frame points to an embedded asset");
  assert.equal(asset.e, 1);
  assert.match(asset.p, /^data:image\/png;base64,/u);
  const bitmap = await loadImage(Buffer.from(asset.p.slice(asset.p.indexOf(",") + 1), "base64"));
  assert.equal(bitmap.width, asset.w);
  assert.equal(bitmap.height, asset.h);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const pixels = Uint8ClampedArray.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
  return { asset, bitmap, pixels };
}

function rasterWarning(result, layerId, name, effects = [name]) {
  const warning = result.warnings?.find((item) => item.code === "lottie-effect-rasterized" && item.layerId === layerId);
  assert.ok(warning, `export warning names ${name}`);
  assert.equal(warning.layerName, name);
  assert.deepEqual(warning.effects, effects);
  assert.match(warning.message, /embedded raster image sequence/u);
  return warning;
}

function constant(track) {
  assert.equal(track?.a, 0, "expected a native constant property track");
  return track.k;
}

test("static effects dedupe held frames and honor every documented local image resolution", async () => {
  const layer = colorGradeLayer();
  const scene = sceneWith([layer]);
  const before = structuredClone(scene);
  const choices = [[undefined, 3], ["1x", 1], ["2x", 2], ["3x", 3], ["original", 1]];
  for (const [imageDPIRatio, density] of choices) {
    const result = await exportScene(scene, { ...outputOptions, ...(imageDPIRatio ? { imageDPIRatio } : {}) });
    assert.deepEqual(scene, before, "all resolution choices leave the source scene unchanged");
    rasterWarning(result, layer.id, layer.name);
    const sequence = sequenceFor(animationFrom(result), layer.name);
    const frames = imageFrames(sequence);
    assert.equal(frames.length, 1, "a static effect becomes one image held across the timeline");
    assertContinuous(frames);
    assert.equal(frames[0].ip, 0);
    assert.equal(frames[0].op, 2);
    const { asset, pixels } = await readEmbeddedPng(sequence, frames[0]);
    assert.ok(asset.w > 0 && asset.h > 0);
    assert.equal(pixels.length, asset.w * asset.h * 4);
    const scale = frames[0].ks.s.k;
    assert.ok(Math.abs(100 / scale[0] - density) < 0.02, `${imageDPIRatio ?? "default 3x"} X density`);
    assert.ok(Math.abs(100 / scale[1] - density) < 0.02, `${imageDPIRatio ?? "default 3x"} Y density`);
  }
});

test("Color Grade capture preserves its expected colored pixel", () => {
  const layer = colorGradeLayer();
  const capture = captureLayerSvg(sceneWith([layer]), layer.id, 0, { rasterScale: { x: 3, y: 3 } });
  const image = new Resvg(capture.svg, { font: { loadSystemFonts: false } }).render();
  const x = Math.round((10 - capture.bounds.x) * 3);
  const y = Math.round((8 - capture.bounds.y) * 3);
  const pixel = [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
  assert.deepEqual(pixel, [255, 21, 41, 255], "1.5 contrast maps the red source to a saturated red pixel");
});

test("time-varying Noise Warp embeds distinct actual pixels at the sampled frames", async () => {
  const layer = createLayer("rectangle", {
    id: "moving-noise", name: "Moving Noise", x: 10, y: 8, width: 24, height: 18,
    fill: "#E63946", animations: [effectOperation("noise-warp")],
  });
  const scene = sceneWith([layer]);
  const result = await exportScene(scene, outputOptions);
  rasterWarning(result, layer.id, layer.name, ["Noise Warp"]);
  const sequence = sequenceFor(animationFrom(result), layer.name);
  const frames = imageFrames(sequence);
  assert.equal(frames.length, 2, "the two changing samples use separate intervals");
  assertContinuous(frames);
  const first = await readEmbeddedPng(sequence, frames[0]);
  const second = await readEmbeddedPng(sequence, frames[1]);
  assert.notEqual(frames[0].refId, frames[1].refId);
  assert.notDeepEqual(first.pixels, second.pixels, "the embedded frame pixels reflect animated noise time");
});

test("outermost effected group is one raster subtree while ancestor transforms stay native", async () => {
  const group = createLayer("group", {
    id: "outer-group", name: "Outer group", x: 4, y: 3, width: 36, height: 27,
    rotation: 17, opacity: 0.55, animations: [effectOperation("color-grade", { id: "group-grade" })],
  });
  const child = createLayer("rectangle", {
    id: "inner-effect", name: "Inner effect", parentId: group.id,
    x: 4, y: 4, width: 18, height: 13, fill: "#2D76BD",
    animations: [effectOperation("ripple", { id: "inner-ripple" })],
  });
  const unaffected = createLayer("ellipse", {
    id: "plain-child", name: "Plain child", parentId: group.id,
    x: 22, y: 9, width: 9, height: 9, fill: "#F2BD43",
  });
  const scene = sceneWith([group, child, unaffected], { id: "group-raster" });
  const before = structuredClone(scene);
  const result = await exportScene(scene, outputOptions);
  assert.deepEqual(scene, before);
  rasterWarning(result, group.id, group.name, ["Color Grade"]);
  rasterWarning(result, child.id, child.name, ["Ripple"]);

  const animation = animationFrom(result);
  const rasterCompositions = animation.assets.filter((asset) => asset.id.startsWith("effect_sequence_"));
  assert.equal(rasterCompositions.length, 1, "nested effect targets collapse into one outer raster sequence");
  const sequence = sequenceFor(animation, group.name);
  assert.ok(sequence.root.ks.r, "the group keeps its native rotation track");
  assert.equal(constant(sequence.root.ks.o), 100, "the effected group's own opacity is already baked into its pixels");
  assert.equal(sequence.asset.layers.some((layer) => layer.ty !== 2), false, "the sequence contains only embedded raster frames");
  assert.equal(allLottieLayers(animation).some((layer) => [child.name, unaffected.name].includes(layer.nm)), false,
    "rasterized descendants are not emitted a second time as vector layers");
});

test("child raster keeps ancestor opacity native and bakes own opacity, reveal, shadow, and blur", async () => {
  const parent = createLayer("group", {
    id: "native-parent", name: "Native parent", x: 4, y: 3, width: 36, height: 27,
    rotation: 19, opacity: 0.5,
  });
  const target = createLayer("rectangle", {
    id: "raster-child", name: "Raster child", parentId: parent.id,
    x: 3, y: 4, width: 21, height: 15, fill: "#E5483D", opacity: 0.6, blur: 2,
    shadow: { color: "#00000080", x: 2, y: 2, blur: 4 },
    animations: [effectOperation("color-grade"), {
      id: "child-reveal", name: "Reveal", kind: "custom", start: 0, duration: 1, easing: "linear",
      from: { reveal: { direction: "right", progress: 0, softness: 0 } },
      to: { reveal: { direction: "right", progress: 1, softness: 0 } },
    }],
  });
  const scene = sceneWith([parent, target], { id: "parent-native-child-raster" });
  const result = await exportScene(scene, outputOptions);
  rasterWarning(result, target.id, target.name, ["Color Grade"]);
  const animation = animationFrom(result);
  const parentLayer = allLottieLayers(animation).find((layer) => layer.nm === parent.name && layer.ty === 0);
  assert.ok(parentLayer);
  assert.equal(constant(parentLayer.ks.o), 50, "ancestor opacity remains a Lottie property");
  assert.ok(parentLayer.ks.r, "ancestor rotation remains a Lottie transform");

  const sequence = sequenceFor(animation, target.name);
  assert.equal(constant(sequence.root.ks.o), 100, "the child's opacity is not applied twice");
  assert.equal(sequence.root.hasMask, undefined, "the reveal is baked into the raster frames");
  assert.equal(sequence.root.ef, undefined, "the child's blur and shadow are baked into the raster frames");
  assert.ok(sequence.asset.w > target.width && sequence.asset.h > target.height, "shadow and blur overflow survives in local bounds");
  const frames = imageFrames(sequence);
  assertContinuous(frames);
  const shown = await readEmbeddedPng(sequence, frames.at(-1));
  let maximumAlpha = 0;
  for (let index = 3; index < shown.pixels.length; index += 4) maximumAlpha = Math.max(maximumAlpha, shown.pixels[index]);
  assert.ok(maximumAlpha >= 140 && maximumAlpha <= 160, `own opacity is baked into pixels (max alpha ${maximumAlpha})`);
});

test("a mask and its rasterized target keep the native Lottie track-matte pair", async () => {
  const mask = createLayer("ellipse", {
    id: "matte-source", name: "Matte source", x: 8, y: 5, width: 30, height: 26, fill: "#FFFFFF", isMask: true,
  });
  const target = createLayer("rectangle", {
    id: "matte-target", name: "Matte target", x: 9, y: 7, width: 28, height: 22,
    fill: "#CE542C", animations: [effectOperation("color-grade")],
  });
  const scene = sceneWith([mask, target], { id: "matte-raster" });
  const result = await exportScene(scene, outputOptions);
  rasterWarning(result, target.id, target.name, ["Color Grade"]);
  const animation = animationFrom(result);
  const layers = allLottieLayers(animation);
  const matte = layers.find((layer) => layer.td === 1);
  assert.ok(matte, "mask remains a native Lottie track matte");
  const graphic = layers.find((layer) => layer.tt === 3 && layer.tp === matte.ind);
  assert.ok(graphic, "the raster sequence stays attached to its matte composition");
  assert.ok(sequenceFor(animation, target.name).asset.layers.every((layer) => layer.ty === 2));
});

test("Backdrop Blur samples the animated lower sibling into both local raster frames", async () => {
  const lower = createLayer("rectangle", {
    id: "animated-backdrop", name: "Animated backdrop", x: 2, y: 2, width: 44, height: 32,
    fill: "#FF0000", animations: [{
      id: "backdrop-color", name: "Color", kind: "custom", start: 0, duration: 1, easing: "linear",
      from: { fill: "#FF0000" }, to: { fill: "#0000FF" },
    }],
  });
  const blur = createLayer("rectangle", {
    id: "backdrop-blur", name: "Backdrop Blur", x: 8, y: 6, width: 32, height: 24,
    fill: "#FFFFFF00", backgroundBlur: { enabled: true, radius: 8, blend: 100 },
  });
  const scene = sceneWith([lower, blur], { id: "animated-lower-backdrop" });
  const result = await exportScene(scene, outputOptions);
  rasterWarning(result, blur.id, blur.name, ["Background Blur"]);
  const sequence = sequenceFor(animationFrom(result), blur.name);
  const frames = imageFrames(sequence);
  assert.equal(frames.length, 2);
  assertContinuous(frames);
  const first = await readEmbeddedPng(sequence, frames[0]);
  const second = await readEmbeddedPng(sequence, frames[1]);
  assert.notDeepEqual(first.pixels, second.pixels, "backdrop color changes affect the captured glass/blur pixels");
});

test("default sample, pixel, and side caps name the affected effect before native raster allocation", async () => {
  const many = Array.from({ length: 501 }, (_, index) => createLayer("rectangle", {
    id: `sample-cap-${index}`, name: `Sample ${index}`, x: 1, y: 1, width: 8, height: 8,
    animations: [effectOperation("color-grade", { id: `grade-${index}` })],
  }));
  await assert.rejects(exportScene(sceneWith(many, { id: "sample-limit" }), outputOptions),
    /Color Grade on layer “Sample 500” exceeds the maxSamples limit \(1000\)/u);

  const pixelLayer = createLayer("rectangle", {
    id: "pixel-cap", name: "Pixel cap", x: 0, y: 0, width: 8000, height: 8000,
    animations: [effectOperation("color-grade")],
  });
  await assert.rejects(exportScene(sceneWith([pixelLayer], { id: "pixel-limit", width: 8000, height: 8000 }),
    { ...outputOptions, imageDPIRatio: "1x" }),
  /Color Grade on layer “Pixel cap” exceeds the maxPixels limit \(64000000\)/u);

  const sideLayer = createLayer("rectangle", {
    id: "side-cap", name: "Side cap", x: 0, y: 0, width: 9000, height: 10,
    animations: [effectOperation("color-grade")],
  });
  await assert.rejects(exportScene(sceneWith([sideLayer], { id: "side-limit", width: 9000, height: 36 }),
    { ...outputOptions, imageDPIRatio: "1x" }),
  /Color Grade on layer “Side cap” exceeds the maxSide limit \(8192\)/u);
});

test("asynchronous cancellation writes no output and removes the temporary Lottie job", async () => {
  const controller = new AbortController();
  const layer = createLayer("rectangle", {
    id: "cancel-raster", name: "Cancel raster", x: 8, y: 6, width: 30, height: 22,
    fill: "#E63946", animations: [effectOperation("noise-warp")],
  });
  const scene = sceneWith([layer], { id: "cancel-raster-scene" });
  const directory = await mkdtemp(path.join(tmpdir(), "kino-lottie-cancel-test-"));
  const outputPath = path.join(directory, "result.json");
  // The export makes its temporary folder in a private TMPDIR, so other test runs on this computer cannot add to it.
  const privateTemp = path.join(directory, "tmp");
  await mkdir(privateTemp);
  const savedTemp = process.env.TMPDIR;
  process.env.TMPDIR = privateTemp;
  try {
    await assert.rejects(exportScene(scene, outputOptions, {
      signal: controller.signal,
      outputPath,
      onProgress(event) {
        if (event.stage === "render" && event.completed === 1) {
          setImmediate(() => controller.abort(Object.assign(new Error("test cancellation"), { name: "AbortError" })));
        }
      },
    }), { name: "AbortError", message: "test cancellation" });
    await assert.rejects(access(outputPath), { code: "ENOENT" });
    assert.deepEqual((await readdir(privateTemp)).filter((name) => name.startsWith("kino-export-")), [],
      "the aborted export's private temporary directory is removed");
  } finally {
    if (savedTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTemp;
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP header, batch snapshot, and agent render results carry raster warning details", async (t) => {
  const service = await startTestServer({ ownerToken: `raster-warning-owner-${randomUUID()}` });
  t.after(() => service.stop());
  const layer = colorGradeLayer({ id: "warning-layer", name: "Warning Layer \u2014 Ω" });
  const scene = sceneWith([layer], { id: "warning-scene" });
  const document = createDocument({ id: "raster-warning-project", name: "Raster warning", scenes: [scene] });
  const projectResponse = await service.api("/api/projects", { method: "POST", body: { document } });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json();

  const direct = await service.api("/api/export", {
    method: "POST", body: { document: project.document, sceneId: scene.id, options: outputOptions },
  });
  assert.equal(direct.status, 200);
  const directWarnings = JSON.parse(direct.headers.get("x-kino-export-warnings") || "[]");
  rasterWarning({ warnings: directWarnings }, layer.id, layer.name, ["Color Grade"]);
  const directAnimation = JSON.parse(Buffer.from(await direct.arrayBuffer()).toString("utf8"));
  sequenceFor(directAnimation, layer.name);

  const created = await service.api("/api/export-batches", {
    method: "POST", body: { document: project.document, sceneIds: [scene.id], options: outputOptions },
  });
  assert.equal(created.status, 202);
  const batchId = (await created.json()).batch.id;
  let batch;
  const deadline = Date.now() + 15_000;
  do {
    const response = await service.api(`/api/export-batches/${batchId}`);
    assert.equal(response.status, 200);
    batch = (await response.json()).batch;
    if (batch.status === "complete" || batch.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(batch.status, "complete", JSON.stringify(batch.jobs));
  rasterWarning({ warnings: batch.jobs[0].warnings }, layer.id, layer.name, ["Color Grade"]);

  // The agent's render answer carries the same warning for its saved file.
  const render = async (body) => {
    const reply = await (await service.api("/api/agent/render", { method: "POST", body })).json();
    assert.equal(Boolean(reply.isError), false, reply.text);
    return reply;
  };
  const started = await render({ project: document.id, scene: scene.id, action: "start", format: "lottie", options: { fps: 2, duration: 1 } });
  const done = await render({ project: document.id, action: "wait", job: started.data.job, timeout_s: 30 });
  assert.equal(done.data.status, "done", done.text);
  rasterWarning(done.data.files[0], layer.id, layer.name, ["Color Grade"]);
});
