import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene, createDocument, parseDocument } from "../engine/model.js";
import { canConvertToShape, convertLayerToShape } from "../engine/shapeConversion.js";
import { exportScene } from "./export.mjs";

const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(errorText || `${command} exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

async function decodePng(buffer) {
  return run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], buffer);
}

function pixel(frame, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...frame.subarray(offset, offset + 4)];
}

function layer(type, id, values = {}) {
  return createLayer(type, {
    id,
    name: id,
    stroke: "#000000",
    strokeWidth: 0,
    strokeAlign: "center",
    ...values,
  });
}

function scene(layers, values = {}) {
  return createScene({
    id: values.id ?? "shape-conversion-artboard",
    name: values.name ?? "Shape conversion",
    width: values.width ?? 260,
    height: values.height ?? 130,
    duration: values.duration ?? 1,
    background: values.background ?? "#ffffff",
    layers,
  });
}

function animation(id, name, from, to) {
  return {
    id,
    name,
    kind: "custom",
    start: 0,
    duration: 1,
    easing: "linear",
    from,
    to,
    unit: "layer",
    stagger: 0,
    order: "forward",
  };
}

function documentWith(artboard) {
  return parseDocument(createDocument({ name: "Shape conversion export", scenes: [artboard] }));
}

function convertedDocument(document) {
  const converted = structuredClone(document);
  converted.scenes = converted.scenes.map((artboard) => ({
    ...artboard,
    layers: artboard.layers.map((item) => canConvertToShape(item) ? convertLayerToShape(item) : item),
  }));
  return parseDocument(converted);
}

function sceneFrom(document) {
  return document.scenes[0];
}

function compareRgba(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} uses the same decoded image dimensions`);
  let maxChannelDelta = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < actual.length; offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(actual[offset + channel] - expected[offset + channel]);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      pixelChanged ||= delta > 0;
    }
    if (pixelChanged) changedPixels += 1;
  }
  assert.ok(maxChannelDelta <= 1,
    `${label} differs by at most one channel level (max ${maxChannelDelta}; ${changedPixels} pixels changed)`);
  return { maxChannelDelta, changedPixels };
}

function reportDifference(t, label, difference) {
  t.diagnostic(`${label}: max channel delta ${difference.maxChannelDelta}; ${difference.changedPixels} pixels changed`);
}

function layersIn(animation) {
  return [
    ...animation.layers,
    ...(animation.assets ?? []).flatMap((asset) => asset.layers ?? []),
  ];
}

function nestedItems(items) {
  return items.flatMap((item) => item.ty === "gr" ? nestedItems(item.it ?? []) : [item]);
}

function pathsIn(layerValue) {
  return nestedItems(layerValue.shapes ?? []).filter((item) => item.ty === "sh");
}

function compositionFor(animation, layerValue) {
  if (layerValue.ty !== 0) return [layerValue];
  const asset = animation.assets.find((item) => item.id === layerValue.refId);
  assert.ok(asset, `${layerValue.nm} references its matte composition`);
  return asset.layers ?? [];
}

function conversionFixture() {
  const rectangleStroke = {
    type: "linear", angle: 25,
    stops: [
      { offset: 0, color: "#0080ffb0" },
      { offset: 1, color: "#ff400060" },
    ],
  };
  const starStroke = {
    type: "radial", angle: 0,
    stops: [
      { offset: 0, color: "#00aa80c0" },
      { offset: 1, color: "#8800ffaa" },
    ],
  };
  const ellipseStroke = {
    type: "linear", angle: 90,
    stops: [
      { offset: 0, color: "#ff8800a0" },
      { offset: 1, color: "#0044ff70" },
    ],
  };
  const rectangle = layer("rectangle", "mixed-corner-rectangle", {
    name: "Mixed corners",
    x: 10, y: 12, width: 64, height: 44,
    cornerRadii: [14, 5, 9, 0],
    fill: {
      type: "linear", angle: 30,
      stops: [
        { offset: 0, color: "#ffcc0080" },
        { offset: 1, color: "#0088ff60" },
      ],
    },
    stroke: rectangleStroke,
    strokeWidth: 3,
    strokeAlign: "outside",
    animations: [
      animation("rectangle-move", "Move", { x: 10 }, { x: 18 }),
      animation("rectangle-stroke", "Stroke", { stroke: rectangleStroke, strokeWidth: 2 }, { stroke: { ...rectangleStroke, stops: [
        { offset: 0, color: "#ff0000c0" },
        { offset: 1, color: "#0000ff80" },
      ] }, strokeWidth: 4 }),
    ],
  });
  const star = layer("star", "editable-star", {
    name: "Gradient star",
    x: 88, y: 15, width: 58, height: 54,
    spikes: 6, starThickness: 0.41,
    fill: {
      type: "radial", angle: 0,
      stops: [
        { offset: 0, color: "#ffcc00c0" },
        { offset: 1, color: "#ff006080" },
      ],
    },
    stroke: starStroke,
    strokeWidth: 3,
    strokeAlign: "inside",
    animations: [
      animation("star-move", "Move", { x: 88 }, { x: 96 }),
      animation("star-stroke", "Stroke", { stroke: starStroke, strokeWidth: 2 }, { stroke: { ...starStroke, stops: [
        { offset: 0, color: "#00ff00e0" },
        { offset: 1, color: "#ff00ff90" },
      ] }, strokeWidth: 4 }),
    ],
  });
  const partialEllipse = layer("ellipse", "partial-ellipse", {
    name: "Partial ellipse",
    x: 164, y: 16, width: 60, height: 50,
    donut: 0.22, sweep: 0.72, startAngle: 23,
    fill: {
      type: "linear", angle: 0,
      stops: [
        { offset: 0, color: "#ff008080" },
        { offset: 1, color: "#00aaff90" },
      ],
    },
    stroke: ellipseStroke,
    strokeWidth: 2,
    strokeAlign: "center",
    animations: [
      animation("ellipse-move", "Move", { x: 164 }, { x: 172 }),
      animation("ellipse-stroke", "Stroke", { stroke: ellipseStroke, strokeWidth: 1 }, { stroke: { ...ellipseStroke, stops: [
        { offset: 0, color: "#00ffffd0" },
        { offset: 1, color: "#ff00ff80" },
      ] }, strokeWidth: 3 }),
    ],
  });
  const emptyEllipse = layer("ellipse", "empty-arc", {
    name: "Empty arc",
    x: 230, y: 92, width: 20, height: 20,
    donut: 0.3, sweep: 0, startAngle: 18,
    fill: "#ff00ff",
  });
  return scene([rectangle, star, partialEllipse, emptyEllipse]);
}

test("converting rounded rectangles, stars, and partial ellipses preserves PNG and MP4 frames", async (t) => {
  const primitiveDocument = documentWith(conversionFixture());
  const pathDocument = convertedDocument(primitiveDocument);
  const primitiveScene = sceneFrom(primitiveDocument);
  const pathScene = sceneFrom(pathDocument);

  assert.deepEqual(
    pathScene.layers.map((item) => item.type),
    ["path", "path", "path", "path"],
    "conversion persists each primitive as an editable path layer",
  );
  assert.deepEqual(
    pathScene.layers.map((item) => item.convertedFrom),
    ["rectangle", "star", "ellipse", "ellipse"],
  );

  const primitivePng = await exportScene(primitiveScene, { format: "png", width: 260, height: 130, time: 0.5 });
  const pathPng = await exportScene(pathScene, { format: "png", width: 260, height: 130, time: 0.5 });
  reportDifference(t, "converted and primitive PNG output", compareRgba(
    await decodePng(pathPng.buffer), await decodePng(primitivePng.buffer), "converted and primitive PNG output",
  ));

  const directory = await mkdtemp(join(tmpdir(), "kino-shape-conversion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const primitivePath = join(directory, "primitive.mp4");
  const convertedPath = join(directory, "converted.mp4");
  const [primitiveVideo, convertedVideo] = await Promise.all([
    exportScene(primitiveScene, { format: "mp4", width: 260, height: 130, fps: 4, duration: 1 }),
    exportScene(pathScene, { format: "mp4", width: 260, height: 130, fps: 4, duration: 1 }),
  ]);
  await Promise.all([
    writeFile(primitivePath, primitiveVideo.buffer),
    writeFile(convertedPath, convertedVideo.buffer),
  ]);
  const probe = (file) => run(ffprobe, [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration",
    "-of", "json", file,
  ]).then((result) => JSON.parse(result.toString("utf8")));
  const [primitiveMeta, convertedMeta] = await Promise.all([probe(primitivePath), probe(convertedPath)]);
  for (const metadata of [primitiveMeta, convertedMeta]) {
    const video = metadata.streams.find((item) => item.codec_type === "video");
    assert.ok(video, "exported video has an actual video stream");
    assert.equal(video.codec_name, "h264");
    assert.equal(Number(video.width), 260);
    assert.equal(Number(video.height), 130);
    assert.equal(Number(video.nb_read_frames), 4);
    assert.equal(video.avg_frame_rate, "4/1");
    assert.ok(Math.abs(Number(metadata.format.duration) - 1) < 0.03);
  }
  const decodeVideo = (file) => run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", file,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  const [primitiveFrames, pathFrames] = await Promise.all([decodeVideo(primitivePath), decodeVideo(convertedPath)]);
  assert.equal(primitiveFrames.length, 260 * 130 * 4 * 4);
  assert.equal(pathFrames.length, primitiveFrames.length);
  reportDifference(t, "all four decoded MP4 frames after conversion", compareRgba(
    pathFrames, primitiveFrames, "all four decoded MP4 frames after conversion",
  ));
});

test("converted Lottie contains editable paths with the original partial-ellipse gradient domain", async () => {
  const document = convertedDocument(documentWith(conversionFixture()));
  const output = await exportScene(sceneFrom(document), { format: "lottie", fps: 4, duration: 1 });
  const animationData = JSON.parse(output.buffer.toString("utf8"));
  const exportedLayers = layersIn(animationData);

  for (const name of ["Mixed corners", "Gradient star", "Partial ellipse"]) {
    const rootLayer = animationData.layers.find((item) => item.nm === name);
    assert.ok(rootLayer, `${name} exports in the root composition`);
    const compositionLayers = compositionFor(animationData, rootLayer);
    const vectorLayers = compositionLayers.filter((item) => item.ty === 4);
    assert.ok(vectorLayers.some((item) => pathsIn(item).length > 0), `${name} contains editable native path geometry`);

    if (rootLayer.ty === 0) {
      const matte = compositionLayers.find((item) => item.td === 1);
      const stroke = compositionLayers.find((item) => item.tt === 1 || item.tt === 2);
      assert.ok(matte && stroke, `${name} retains its aligned-stroke silhouette and matte target`);
      assert.equal(stroke.tp, matte.ind, `${name} resolves the matte locally in its native composition`);
      const sourcePaths = pathsIn(matte);
      const strokePaths = pathsIn(stroke);
      assert.ok(sourcePaths.length > 0 && strokePaths.length > 0, `${name} keeps editable silhouette and stroke curves`);
      assert.deepEqual(strokePaths.map((item) => item.ks.k), sourcePaths.map((item) => item.ks.k),
        `${name} stroke and matte use the original converted curves`);
      const strokePaint = nestedItems(stroke.shapes ?? []).find((item) => item.ty === "gs" || item.ty === "st");
      assert.ok(strokePaint, `${name} keeps its stroke as native vector paint`);
    } else {
      assert.equal(rootLayer.ty, 4, `${name} uses a direct native shape layer when no aligned-stroke matte is needed`);
    }
  }
  assert.equal(exportedLayers.some((item) => item.ty === 2) ||
    (animationData.assets ?? []).some((asset) => asset.layers?.some((item) => item.ty === 2)), false,
  "converted primitives are not flattened into image layers");

  const ellipse = animationData.layers.find((item) => item.nm === "Partial ellipse" && item.ty === 4);
  const fillGroup = ellipse.shapes.find((item) => item.ty === "gr" && item.nm === "Partial ellipse Fill");
  const gradient = fillGroup?.it.find((item) => item.ty === "gf");
  assert.ok(gradient, "the converted partial ellipse keeps its native fill gradient");
  assert.deepEqual(gradient.s.k, [0, 25], "gradient start remains on the nominal 60×50 layer box");
  assert.deepEqual(gradient.e.k, [60, 25], "gradient end remains on the nominal 60×50 layer box");
  assert.ok(nestedItems(ellipse.shapes).some((item) => item.ty === "gs"), "the converted partial ellipse keeps its native gradient stroke");

  const emptyArc = animationData.layers.find((item) => item.nm === "Empty arc" && item.ty === 4);
  assert.ok(emptyArc, "an all-empty converted zero-sweep ellipse still exports as a layer");
  assert.equal(pathsIn(emptyArc).length, 0, "the empty arc contains no fabricated path geometry");
});

test("native export skips a retained converted corner operation even when its endpoints include blur", async (t) => {
  const rectangle = layer("rectangle", "corners-with-blur", {
    name: "Converted corners with blur",
    x: 20, y: 14, width: 70, height: 50,
    cornerRadii: [16, 4, 9, 0],
    fill: "#ffcc00",
    blur: 0,
    animations: [animation(
      "incompatible-corners-and-blur",
      "Corners with blur",
      { cornerRadii: [16, 4, 9, 0], blur: 0.5 },
      { cornerRadii: [0, 0, 0, 0], blur: 5 },
    )],
  });
  const primitiveDocument = documentWith(scene([rectangle], {
    id: "converted-corners-blur-document",
    width: 120,
    height: 80,
  }));
  const pathDocument = convertedDocument(primitiveDocument);
  const converted = sceneFrom(pathDocument);
  const retained = converted.layers[0].animations[0];
  assert.equal(converted.layers[0].convertedFrom, "rectangle");
  assert.deepEqual(retained.from, { cornerRadii: [16, 4, 9, 0], blur: 0.5 });
  assert.deepEqual(retained.to, { cornerRadii: [0, 0, 0, 0], blur: 5 });

  const atStart = await exportScene(converted, { format: "png", width: 120, height: 80, time: 0 });
  const afterIncompatibleOperation = await exportScene(converted, { format: "png", width: 120, height: 80, time: 0.75 });
  reportDifference(t, "converted corner-plus-blur operation across PNG times", compareRgba(
    await decodePng(afterIncompatibleOperation.buffer), await decodePng(atStart.buffer),
    "the incompatible combined operation leaves the baked path pixels static",
  ));

  const native = await exportScene(converted, { format: "lottie", fps: 4, duration: 1 });
  const animationData = JSON.parse(native.buffer.toString("utf8"));
  const exported = layersIn(animationData).find((item) => item.nm === "Converted corners with blur" && item.ty === 4);
  assert.ok(exported, "native export accepts the retained incompatible operation");
  const path = nestedItems(exported.shapes).find((item) => item.ty === "sh");
  assert.ok(path?.ks?.k?.v?.length >= 8, "native JSON contains the static baked rounded-rectangle path");
  assert.equal(layersIn(animationData).some((item) => item.ty === 2), false, "the static converted path remains vector geometry");
});

test("converted corner animations are skipped while separate Move and Stroke operations render", async (t) => {
  const rectangle = layer("rectangle", "animated-conversion", {
    name: "Animated conversion",
    x: 30, y: 40, width: 60, height: 40,
    cornerRadii: [12, 0, 12, 0],
    fill: "#ffff00",
    stroke: "#ff000000",
    strokeWidth: 0,
    strokeAlign: "outside",
    animations: [
      animation("animate-corners", "Corners", { cornerRadii: [12, 0, 12, 0] }, { cornerRadii: [0, 0, 0, 0] }),
      animation("move-converted", "Move", { x: 30 }, { x: 90 }),
      animation("stroke-converted", "Stroke", { stroke: "#ff000000", strokeWidth: 0 }, { stroke: "#0000ffff", strokeWidth: 8 }),
    ],
  });
  const primitiveDocument = documentWith(scene([rectangle], {
    id: "animated-conversion-document",
    width: 150,
    height: 110,
  }));
  const pathDocument = convertedDocument(primitiveDocument);
  const noCorners = structuredClone(pathDocument);
  noCorners.scenes[0].layers[0].animations = noCorners.scenes[0].layers[0].animations.filter((item) => item.id !== "animate-corners");
  const compatibleOnlyDocument = parseDocument(noCorners);
  const noStroke = structuredClone(pathDocument);
  noStroke.scenes[0].layers[0].animations = noStroke.scenes[0].layers[0].animations.filter((item) => item.id !== "stroke-converted");
  const noStrokeDocument = parseDocument(noStroke);
  const pathScene = sceneFrom(pathDocument);

  assert.ok(pathScene.layers[0].animations.some((item) => item.id === "animate-corners"), "the incompatible corner operation remains saved on the converted path");
  const convertedAtHalf = await exportScene(pathScene, { format: "png", width: 150, height: 110, time: 0.5 });
  const compatibleOnlyAtHalf = await exportScene(sceneFrom(compatibleOnlyDocument), { format: "png", width: 150, height: 110, time: 0.5 });
  reportDifference(t, "converted output and explicit compatible-operation baseline", compareRgba(
    await decodePng(convertedAtHalf.buffer), await decodePng(compatibleOnlyAtHalf.buffer),
    "converted output ignores only the retained corner operation",
  ));

  const primitiveAtHalf = await exportScene(sceneFrom(primitiveDocument), { format: "png", width: 150, height: 110, time: 0.5 });
  assert.notDeepEqual(convertedAtHalf.buffer, primitiveAtHalf.buffer, "the original rectangle still evaluates its corner animation");
  const convertedAtStart = await exportScene(pathScene, { format: "png", width: 150, height: 110, time: 0 });
  const startPixels = await decodePng(convertedAtStart.buffer);
  const middlePixels = await decodePng(convertedAtHalf.buffer);
  assert.deepEqual(pixel(startPixels, 150, 110, 60), [255, 255, 255, 255], "the initial path has not moved into the final region");
  assert.deepEqual(pixel(middlePixels, 150, 110, 60), [255, 255, 0, 255], "the compatible Move operation relocates the converted path");
  const strokeProbe = pixel(middlePixels, 150, 122, 60);
  assert.ok(strokeProbe[0] < 235 && strokeProbe[2] < 235 && strokeProbe[1] < 200,
    `the separate Stroke operation paints the moved path boundary (${strokeProbe.join(",")})`);

  const noStrokeAtHalf = await exportScene(sceneFrom(noStrokeDocument), { format: "png", width: 150, height: 110, time: 0.5 });
  const withoutStrokePixels = await decodePng(noStrokeAtHalf.buffer);
  assert.deepEqual(pixel(withoutStrokePixels, 150, 122, 60), [255, 255, 255, 255], "without the compatible Stroke operation the same outer pixel stays clear");
});
