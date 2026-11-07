import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLayer, createScene } from "../engine/model.js";
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

function pixel(frame, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...frame.subarray(offset, offset + 4)];
}

async function decodePng(buffer) {
  return run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], buffer);
}

function layer(type, id, values = {}) {
  return createLayer(type, {
    id,
    name: id,
    fill: "#ff0000",
    stroke: "none",
    strokeWidth: 0,
    ...values,
  });
}

function scene(layers, values = {}) {
  return createScene({
    id: values.id ?? "stroke-export-scene",
    name: values.name ?? "Stroke export",
    width: values.width ?? 120,
    height: values.height ?? 90,
    duration: values.duration ?? 1,
    background: values.background ?? "transparent",
    layers,
  });
}

function sampleLottiePath(shape, stepsPerCurve = 16) {
  const points = [];
  for (let index = 0; index < shape.v.length; index += 1) {
    const nextIndex = (index + 1) % shape.v.length;
    const start = shape.v[index];
    const control1 = [start[0] + shape.o[index][0], start[1] + shape.o[index][1]];
    const end = shape.v[nextIndex];
    const control2 = [end[0] + shape.i[nextIndex][0], end[1] + shape.i[nextIndex][1]];
    for (let step = 0; step < stepsPerCurve; step += 1) {
      const t = step / stepsPerCurve;
      const inverse = 1 - t;
      points.push([
        inverse ** 3 * start[0] + 3 * inverse ** 2 * t * control1[0] + 3 * inverse * t ** 2 * control2[0] + t ** 3 * end[0],
        inverse ** 3 * start[1] + 3 * inverse ** 2 * t * control1[1] + 3 * inverse * t ** 2 * control2[1] + t ** 3 * end[1],
      ]);
    }
  }
  return points;
}

function windingNumber(points, [x, y]) {
  let winding = 0;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const [currentX, currentY] = points[current];
    const [previousX, previousY] = points[previous];
    const side = (currentX - previousX) * (y - previousY) - (x - previousX) * (currentY - previousY);
    if (previousY <= y && currentY > y && side > 0) winding += 1;
    else if (previousY > y && currentY <= y && side < 0) winding -= 1;
  }
  return winding;
}

function pathArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea / 2;
}

function propertyAt(property, frameIndex) {
  if (property?.a === 0) return property.k;
  const frame = [...(property?.k ?? [])].reverse().find((candidate) => candidate.t <= frameIndex);
  assert.ok(frame, `native property has a keyframe at or before frame ${frameIndex}`);
  return frame.s ?? frame.e;
}

test("real PNG export places strokes inside, centered, and outside, keeps donut holes, and preserves path stroke width after nonuniform resize", async () => {
  const artboard = scene([
    layer("rectangle", "outside", {
      x: 4, y: 4, width: 20, height: 20,
      stroke: "#0000ff", strokeWidth: 4, strokeAlign: "outside",
    }),
    layer("rectangle", "center", {
      x: 38, y: 4, width: 20, height: 20,
      stroke: "#0000ff", strokeWidth: 4, strokeAlign: "center",
    }),
    layer("rectangle", "inside", {
      x: 72, y: 4, width: 20, height: 20,
      stroke: "#0000ff", strokeWidth: 4, strokeAlign: "inside",
    }),
    layer("ellipse", "translucent-donut", {
      x: 22, y: 36, width: 40, height: 40,
      donut: 0.5, fill: "#ff000080", stroke: "#0000ff80", strokeWidth: 4,
      strokeAlign: "outside",
    }),
    layer("path", "nonuniform-resize", {
      x: 72, y: 36, width: 40, height: 40,
      path: "M0 0 H20 V10 H0 Z", pathBounds: { width: 20, height: 10 },
      stroke: "#0000ff", strokeWidth: 4, strokeAlign: "center",
    }),
  ]);
  const result = await exportScene(artboard, { format: "png", width: 120, height: 90 });
  assert.equal(result.mime, "image/png");
  const rgba = await decodePng(result.buffer);
  assert.equal(rgba.length, 120 * 90 * 4);

  assert.deepEqual(pixel(rgba, 120, 2, 14), [0, 0, 255, 255], "outside alignment paints beyond the source rectangle");
  assert.deepEqual(pixel(rgba, 120, 6, 14), [255, 0, 0, 255], "outside alignment leaves the interior fill intact");
  assert.deepEqual(pixel(rgba, 120, 37, 14), [0, 0, 255, 255], "center alignment extends equally across the left edge");
  assert.deepEqual(pixel(rgba, 120, 35, 14), [0, 0, 0, 0], "center alignment does not extend more than half its width");
  assert.deepEqual(pixel(rgba, 120, 73, 14), [0, 0, 255, 255], "inside alignment paints the inward edge");
  assert.deepEqual(pixel(rgba, 120, 76, 14), [255, 0, 0, 255], "inside alignment leaves the rest of the source fill intact");
  assert.deepEqual(pixel(rgba, 120, 71, 14), [0, 0, 0, 0], "inside alignment leaves the exterior transparent");

  const transparentStroke = pixel(rgba, 120, 20, 56);
  assert.ok(transparentStroke[2] > 240 && transparentStroke[0] < 10, "a translucent outer donut stroke keeps its blue color");
  assert.ok(transparentStroke[3] >= 110 && transparentStroke[3] <= 145, `stroke alpha stays near 128 (${transparentStroke[3]})`);
  const donutHole = pixel(rgba, 120, 42, 56);
  assert.deepEqual(donutHole, [0, 0, 0, 0], "the ring's hole remains transparent beneath the outer stroke");
  const donutFill = pixel(rgba, 120, 27, 56);
  assert.ok(donutFill[0] > 240 && donutFill[2] < 10, "the ring keeps its independent red fill");
  assert.ok(donutFill[3] >= 110 && donutFill[3] <= 145, `fill alpha stays near 128 (${donutFill[3]})`);

  assert.deepEqual(pixel(rgba, 120, 92, 35), [0, 0, 255, 255], "nonuniformly resized path stroke reaches one pixel above its edge");
  assert.deepEqual(pixel(rgba, 120, 92, 33), [0, 0, 0, 0], "nonuniform path scaling does not stretch the stroke vertically");
  assert.deepEqual(pixel(rgba, 120, 71, 56), [0, 0, 255, 255], "nonuniformly resized path stroke reaches one pixel left of its edge");
  assert.deepEqual(pixel(rgba, 120, 69, 56), [0, 0, 0, 0], "nonuniform path scaling does not stretch the stroke horizontally");
});

test("real MP4 export interpolates stroke from zero through width and color changes", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "kino-stroke-export-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const outputPath = join(outputDirectory, "animated-stroke.mp4");
  const shape = layer("rectangle", "animated-stroke", {
    x: 20, y: 20, width: 24, height: 24,
    fill: "#ff0000", stroke: "#ff0000", strokeWidth: 0, strokeAlign: "outside",
    animations: [{
      id: "stroke-growth", name: "Stroke growth", kind: "custom", start: 0, duration: 1,
      easing: "linear", from: { stroke: "#ff0000", strokeWidth: 0 },
      to: { stroke: "#0000ff80", strokeWidth: 4 }, unit: "layer", stagger: 0, order: "forward",
    }],
  });
  const result = await exportScene(scene([shape], {
    id: "animated-stroke-export", width: 64, height: 64, duration: 1, background: "#ffffff",
  }), { format: "mp4", width: 64, height: 64, fps: 8, duration: 1 });
  await writeFile(outputPath, result.buffer);

  const metadata = JSON.parse((await run(ffprobe, [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,nb_read_frames,avg_frame_rate",
    "-of", "json", outputPath,
  ])).toString("utf8"));
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  assert.ok(video, "MP4 export contains a video stream");
  assert.equal(video.codec_name, "h264");
  assert.equal(Number(video.width), 64);
  assert.equal(Number(video.height), 64);
  assert.equal(Number(video.nb_read_frames), 8);
  assert.equal(video.avg_frame_rate, "8/1");

  const frames = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", outputPath,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  const frameSize = 64 * 64 * 4;
  assert.equal(frames.length, frameSize * 8, "the exported video decodes to eight real RGBA frames");
  const first = pixel(frames.subarray(0, frameSize), 64, 19, 32);
  const middle = pixel(frames.subarray(frameSize * 4, frameSize * 5), 64, 19, 32);
  const last = pixel(frames.subarray(frameSize * 7, frameSize * 8), 64, 19, 32);
  assert.ok(first[0] > 235 && first[1] > 235 && first[2] > 235, "zero stroke width leaves the exterior white at the first frame");
  assert.ok(middle[2] > 110 && middle[0] > 110 && middle[1] < 125, `halfway stroke has the interpolated purple color (${middle.join(",")})`);
  assert.ok(last[2] > last[0] + 55 && last[2] > 150, `later stroke has shifted toward its translucent blue endpoint (${last.join(",")})`);
});

test("native Lottie keeps original opposite-winding donut curves and animates a zero-to-positive stroke", async () => {
  const shape = layer("ellipse", "animated-donut-stroke", {
    x: 10, y: 10, width: 60, height: 60, donut: 0.5,
    stroke: "#3366ff", strokeWidth: 0, strokeAlign: "outside",
    animations: [{
      id: "donut-stroke-growth", name: "Donut stroke growth", kind: "custom", start: 0, duration: 1,
      easing: "linear", from: { stroke: "#3366ff", strokeWidth: 0 },
      to: { stroke: "#ff6633", strokeWidth: 4 }, unit: "layer", stagger: 0, order: "forward",
    }],
  });
  const result = await exportScene(scene([shape], {
    id: "native-animated-donut-stroke", width: 80, height: 80, duration: 1,
  }), { format: "lottie", fps: 4, duration: 1 });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const exported = animation.layers.find((item) => item.nm === "animated-donut-stroke" && item.ty === 0);
  assert.ok(exported, "aligned stroke uses a native vector precomposition wrapper");
  const asset = animation.assets.find((item) => item.id === exported.refId);
  assert.ok(asset, "the wrapper references its native paint and matte composition");
  const matteSource = asset.layers.find((item) => item.td === 1);
  const strokeTarget = asset.layers.find((item) => item.tt === 2);
  assert.ok(matteSource && strokeTarget, "outside stroke subtracts the original silhouette with a native matte pair");
  assert.equal(strokeTarget.tp, matteSource.ind, "the stroke target resolves its silhouette locally in the same composition");
  assert.equal(matteSource.ks.o.k, 100, "the original-curve matte source remains fully opaque");
  assert.equal(animation.layers.some((item) => item.ty === 2) || asset.layers.some((item) => item.ty === 2), false,
    "stroke and matte remain vector layers rather than an embedded image");

  const matteGroup = matteSource.shapes.find((item) => item.ty === "gr");
  const strokeGroup = strokeTarget.shapes.find((item) => item.ty === "gr" && item.it.some((child) => child.ty === "st"));
  assert.ok(matteGroup && strokeGroup, "both matte and stroke use editable native shape groups");
  const mattePaths = matteGroup.it.filter((item) => item.ty === "sh");
  const strokePaths = strokeGroup.it.filter((item) => item.ty === "sh");
  assert.equal(mattePaths.length, 2, "the source silhouette contains separate outer and inner donut contours");
  assert.equal(strokePaths.length, 2, "the animated stroke retains both original donut contour slots");
  assert.deepEqual(strokePaths.map((item) => item.ks.k), mattePaths.map((item) => item.ks.k),
    "zero stroke weight keeps the original annulus curves instead of replacing them with degenerate outlines");

  const contours = mattePaths.map((item) => sampleLottiePath(item.ks.k));
  const areas = contours.map(pathArea);
  assert.ok(areas[0] * areas[1] < 0, "outer and inner donut contours keep opposite winding directions");
  const fill = matteGroup.it.find((item) => item.ty === "fl");
  assert.equal(fill?.r, 1, "the original donut uses nonzero winding fill semantics");
  assert.equal(contours.reduce((sum, points) => sum + windingNumber(points, [30, 30]), 0), 0,
    "opposite contour windings cancel at the donut center and preserve its hole");
  assert.notEqual(contours.reduce((sum, points) => sum + windingNumber(points, [52, 30]), 0), 0,
    "the same original contours enclose material between the hole and the outside");

  const stroke = strokeGroup.it.find((item) => item.ty === "st");
  assert.ok(stroke?.w?.a === 1, "native stroke width animates rather than rebuilding path outlines");
  assert.equal(propertyAt(stroke.w, 0)[0], 0, "the first sampled frame has zero stroke width");
  assert.equal(propertyAt(stroke.w, 4)[0], 8, "the final width is twice the four-unit entered endpoint");
  assert.equal(propertyAt(stroke.o, 0)[0], 0, "zero width suppresses paint opacity in the first frame");
  assert.equal(propertyAt(stroke.o, 4)[0], 100, "stroke paint becomes visible at its positive-width endpoint");
  assert.ok(stroke.c.a === 1, "stroke color is a native animated property");
  const firstColorTarget = stroke.c.k[0].e;
  const finalColor = propertyAt(stroke.c, 4);
  assert.ok(firstColorTarget[2] > firstColorTarget[0] && finalColor[0] > firstColorTarget[2],
    "native stroke color transitions from blue toward orange while its weight grows");
});
