import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponentInstance, expandComponents } from "../engine/linkedComponents.js";
import { createDocument, createLayer, createScene } from "../engine/model.js";
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

function shape(type, id, values = {}) {
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
    id: values.id ?? "shape-export-scene",
    name: values.name ?? "Shape export",
    width: values.width ?? 180,
    height: values.height ?? 120,
    duration: values.duration ?? 1,
    background: values.background ?? "#ffffff",
    layers,
  });
}

function allVectorLayers(animation) {
  const layers = [...animation.layers];
  for (const asset of animation.assets ?? []) layers.push(...(asset.layers ?? []));
  return layers;
}

test("PNG export preserves asymmetric corners, ring and sector fills, star tips, and empty geometry", async () => {
  const artboard = scene([
    shape("ellipse", "quarter-gradient-domain", {
      x: 10, y: 10, width: 100, height: 100,
      donut: 0, sweep: 0.25, startAngle: 0,
      fill: {
        type: "linear",
        angle: 0,
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "#0000ff" },
        ],
      },
    }),
    shape("rectangle", "asymmetric-corners", {
      x: 0, y: 0, width: 50, height: 50,
      cornerRadii: [20, 0, 0, 0], fill: "#ff0000",
    }),
    shape("ellipse", "annulus", {
      x: 60, y: 0, width: 50, height: 50,
      donut: 0.5, fill: "#00aa00",
    }),
    shape("ellipse", "sector", {
      x: 120, y: 0, width: 50, height: 50,
      sweep: 0.25, startAngle: 0, fill: "#0000ff",
    }),
    shape("star", "five-point-star", {
      x: 0, y: 60, width: 50, height: 50,
      spikes: 5, starThickness: 0.382, fill: "#00aa00",
    }),
    shape("ellipse", "empty-sector", {
      x: 120, y: 60, width: 50, height: 50,
      sweep: 0, fill: "#ff00ff",
    }),
  ]);
  const result = await exportScene(artboard, { format: "png", width: 180, height: 120 });
  assert.equal(result.mime, "image/png");
  const rgba = await decodePng(result.buffer);
  assert.equal(rgba.length, 180 * 120 * 4);

  assert.deepEqual(pixel(rgba, 180, 3, 3), [255, 255, 255, 255], "only the top-left corner is rounded");
  assert.deepEqual(pixel(rgba, 180, 47, 3), [255, 0, 0, 255], "the top-right corner remains square");
  assert.deepEqual(pixel(rgba, 180, 3, 47), [255, 0, 0, 255], "the bottom-left corner remains square");
  assert.deepEqual(pixel(rgba, 180, 85, 25), [255, 255, 255, 255], "a full donut keeps its center transparent to the background");
  assert.deepEqual(pixel(rgba, 180, 99, 25), [0, 170, 0, 255], "the full donut paints its ring");
  assert.deepEqual(pixel(rgba, 180, 156, 36), [0, 0, 255, 255], "the quarter sector paints inside its sweep");
  assert.deepEqual(pixel(rgba, 180, 134, 36), [255, 255, 255, 255], "the quarter sector leaves the unswept area empty");
  assert.deepEqual(pixel(rgba, 180, 25, 65), [0, 170, 0, 255], "the star reaches its top point");
  assert.deepEqual(pixel(rgba, 180, 38, 70), [255, 255, 255, 255], "the star's inward valley excludes the outer corner");
  assert.deepEqual(pixel(rgba, 180, 145, 85), [255, 255, 255, 255], "a zero-sweep ellipse emits no painted pixels");
  const gradientSample = pixel(rgba, 180, 70, 70);
  assert.ok(Math.abs(gradientSample[0] - 101) <= 12, `gradient stays mapped to the full 100px ellipse box (red ${gradientSample[0]})`);
  assert.ok(Math.abs(gradientSample[2] - 154) <= 12 && gradientSample[2] > gradientSample[0], `the quarter ellipse samples the expected blue side of the full-box gradient (blue ${gradientSample[2]})`);
});

test("native Lottie exports animated arc paths, independent corner paths, and component-contained star vectors", async () => {
  const source = createScene({
    id: "shape-component-source",
    name: "Wide shape component",
    width: 640,
    height: 360,
    duration: 1,
    isComponent: true,
    background: "#ffffff",
    layers: [shape("star", "component-star", {
      name: "Far star",
      x: 500, y: 250, width: 80, height: 80,
      spikes: 7, starThickness: 0.35, fill: "#ff8800",
    })],
  });
  const target = scene([
    shape("rectangle", "rounded-rectangle", {
      name: "Independent corners",
      x: 10, y: 10, width: 100, height: 70,
      cornerRadii: [24, 0, 12, 4], fill: "#223344",
    }),
    shape("ellipse", "animated-arc", {
      name: "Animated ring",
      x: 140, y: 10, width: 90, height: 90,
      donut: 0.5, sweep: 0, startAngle: 20,
      fill: {
        type: "linear",
        angle: 45,
        stops: [
          { offset: 0, color: "#ff0000" },
          { offset: 1, color: "#0000ff" },
        ],
      },
      stroke: "#00aa00",
      strokeWidth: 3,
      animations: [{
        id: "reveal-arc",
        name: "Reveal arc",
        kind: "custom",
        start: 0,
        duration: 1,
        easing: "linear",
        from: { sweep: 0 },
        to: { sweep: 1 },
        unit: "layer",
        stagger: 0,
        order: "forward",
      }],
    }),
    createComponentInstance(source, { id: "wide-instance", x: 280, y: 20 }),
  ], { id: "shape-lottie-target", width: 1000, height: 450, duration: 1 });
  const document = createDocument({ name: "Shape export", scenes: [source, target] });
  const expanded = expandComponents(document, target.id);
  const result = await exportScene(expanded, { format: "lottie", fps: 4, duration: 1 });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const exportedLayers = allVectorLayers(animation);

  const rectangle = exportedLayers.find((layer) => layer.nm === "Independent corners" && layer.ty === 4);
  assert.ok(rectangle, "rounded rectangle is a native vector layer");
  const cornerPath = rectangle.shapes.flatMap((item) => item.it ?? []).find((item) => item.ty === "sh");
  assert.ok(cornerPath, "independent corners become a vector path");
  assert.ok(cornerPath.ks.k.v.length >= 8, "the path retains separate cubic geometry at all four corners");

  const arc = exportedLayers.find((layer) => layer.nm === "Animated ring" && layer.ty === 4);
  assert.ok(arc, "the partial ellipse remains a native vector layer");
  const arcItems = arc.shapes.flatMap((item) => item.it ?? []);
  assert.ok(arcItems.some((item) => item.ty === "gf"), "the ring retains a real gradient fill");
  assert.ok(arcItems.some((item) => item.ty === "st"), "the ring retains a real stroke");
  const animatedPaths = arcItems.filter((item) => item.ty === "sh");
  assert.ok(animatedPaths.length >= 2, "the sweep-to-full-ring output carries outer and inner contours");
  assert.ok(animatedPaths.every((item) => item.ks.a === 1), "arc contours retain animated native shape properties");
  assert.equal(animation.fr, 4);
  assert.equal(animation.ip, 0);
  assert.equal(animation.op, 4);
  for (const path of animatedPaths) {
    const keyframes = path.ks.k;
    assert.ok(keyframes.length >= 2, "changing contours retain at least their endpoints");
    const times = keyframes.map((frame) => frame.t);
    assert.ok(times.every((time) => Number.isInteger(time) && time >= 0 && time <= 4), "retained keys stay on the original four-fps frame grid");
    assert.equal(times[0], 0, "animated geometry starts at the original first frame");
    assert.equal(times.at(-1), 4, "animated geometry reaches the sampled full-ring endpoint");
    for (const frame of keyframes) {
      const shapeValue = frame.s?.[0] ?? frame.e?.[0];
      assert.ok(shapeValue, "each retained key includes a native vector path");
      assert.ok(shapeValue.v.length >= 5, "empty and partial arcs keep the cubic vertex allocation required by the completed ring");
      assert.equal(shapeValue.v.length, keyframes[0].s?.[0]?.v.length ?? keyframes[0].e?.[0]?.v.length, "each contour slot keeps a stable vertex count");
    }
  }
  const lastContourShapes = animatedPaths.map((path) => path.ks.k.at(-1).s?.[0] ?? path.ks.k.at(-1).e?.[0]);
  const signedArea = (vertices) => vertices.reduce((sum, [x1, y1], index) => {
    const [x2, y2] = vertices[(index + 1) % vertices.length];
    return sum + x1 * y2 - x2 * y1;
  }, 0) / 2;
  assert.ok(signedArea(lastContourShapes[0].v) * signedArea(lastContourShapes[1].v) < 0, "the completed annulus uses opposite contour winding to preserve its hole");
  assert.equal(exportedLayers.some((layer) => layer.ty === 2), false, "shape export embeds no bitmap image layers");

  const instance = animation.layers.find((layer) => layer.nm === "Wide shape component" && layer.ty === 0);
  assert.ok(instance, "the linked source is an actual Lottie precomposition");
  const componentAsset = animation.assets.find((asset) => asset.id === instance.refId);
  assert.ok(componentAsset, "the linked component has vector asset data");
  assert.equal(componentAsset.w, 640);
  assert.equal(componentAsset.h, 360);
  const farStar = componentAsset.layers.find((layer) => layer.nm === "Far star" && layer.ty === 4);
  assert.ok(farStar, "the far star remains inside the component artboard precomposition");
  const starPath = farStar.shapes.flatMap((item) => item.it ?? []).find((item) => item.ty === "sh");
  assert.equal(starPath?.ks.k.v.length, 15, "seven-point star has a real closed vector outline");
});

test("MP4 export rasterizes a sweeping donut, preserves its hole, and reports the requested frames", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "kino-shape-export-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const outputPath = join(outputDirectory, "sweeping-donut.mp4");
  const layer = shape("ellipse", "sweeping-donut", {
    x: 4, y: 4, width: 56, height: 56,
    donut: 0.5, sweep: 0, startAngle: 0,
    fill: "#ff0000",
    animations: [{
      id: "sweep-animation",
      name: "Sweep",
      kind: "custom",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { sweep: 0 },
      to: { sweep: 1 },
      unit: "layer",
      stagger: 0,
      order: "forward",
    }],
  });
  const result = await exportScene(scene([layer], {
    id: "animated-donut-export",
    width: 64,
    height: 64,
    duration: 1,
  }), { format: "mp4", width: 64, height: 64, fps: 4, duration: 1 });
  await writeFile(outputPath, result.buffer);

  const metadata = JSON.parse((await run(ffprobe, [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,nb_read_frames,avg_frame_rate,duration:format=duration",
    "-of", "json", outputPath,
  ])).toString("utf8"));
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  assert.ok(video, "MP4 has a video stream");
  assert.equal(video.codec_name, "h264");
  assert.equal(Number(video.width), 64);
  assert.equal(Number(video.height), 64);
  assert.equal(Number(video.nb_read_frames), 4);
  assert.equal(video.avg_frame_rate, "4/1");
  assert.ok(Math.abs(Number(metadata.format.duration) - 1) < 0.03, "MP4 duration matches four frames at four fps");

  const frames = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", outputPath,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  const frameSize = 64 * 64 * 4;
  assert.equal(frames.length, frameSize * 4, "the encoded file decodes to four real RGBA frames");
  const firstFrame = frames.subarray(0, frameSize);
  const lastFrame = frames.subarray(frameSize * 3, frameSize * 4);
  const before = pixel(firstFrame, 64, 21, 51);
  const after = pixel(lastFrame, 64, 21, 51);
  assert.ok(before[0] > 220 && before[1] > 220, "the zero-sweep first frame is only the white background");
  assert.ok(after[0] > 150 && after[0] > after[1] * 2, "the animated sweep paints the expected ring point in the final encoded frame");
  const hole = pixel(lastFrame, 64, 32, 32);
  assert.ok(hole[0] > 220 && hole[1] > 220 && hole[2] > 220, "the animated donut keeps its center hole open");
  const outsideSweep = pixel(lastFrame, 64, 47, 17);
  assert.ok(outsideSweep[0] > 220 && outsideSweep[1] > 220, "the final partial sweep leaves the unswept region clear");
});
