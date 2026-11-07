import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Resvg } from "@resvg/resvg-js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { applyOperations } from "../engine/operations.js";
import { renderSceneSvg } from "../engine/render.js";
import { exportScene } from "./export.mjs";

const initial = {
  type: "linear", angle: 0,
  stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }],
};
const cases = [
  {
    name: "horizontal", width: 100, height: 20, path: "M0 10L100 10",
    sceneWidth: 120, sceneHeight: 80, samples: [[20, 20], [60, 20], [100, 20]],
    start: [40, 0], end: [60, 20],
  },
  {
    name: "vertical", width: 20, height: 100, path: "M10 0L10 100",
    sceneWidth: 80, sceneHeight: 120, samples: [[20, 20], [20, 60], [20, 100]],
    start: [0, 40], end: [20, 60],
  },
];

function rotatedPathScene(fixture) {
  const document = parseDocument(createDocument({ scenes: [createScene({
    id: "path-scene", width: fixture.sceneWidth, height: fixture.sceneHeight, duration: 0.5,
    layers: [createLayer("path", {
      id: "line", x: 10, y: 10, width: fixture.width, height: fixture.height,
      path: fixture.path, pathBounds: { width: fixture.width, height: fixture.height },
      fillEnabled: false, strokeWidth: 8, stroke: initial,
    })],
  })] }));
  return parseDocument(applyOperations(document, [{
    type: "update_layer", sceneId: "path-scene", layerId: "line",
    properties: { stroke: { ...initial, angle: 45 } },
  }])).scenes[0];
}

function checkPixels(data, fixture, tolerance = 2) {
  const reds = fixture.samples.map(([x, y]) => data[(y * fixture.sceneWidth + x) * 4]);
  assert.ok(reds[0] < 10 && Math.abs(reds[1] - 134) <= tolerance && reds[2] > 245,
    `${fixture.name} stroke must retain dark, middle and light pixels; got ${JSON.stringify(reds)}`);
}

function checkEndpoints(start, end, fixture) {
  for (const [actual, expected] of [[start, fixture.start], [end, fixture.end]]) {
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-7,
      `${fixture.name}: ${JSON.stringify(actual)} should be ${JSON.stringify(expected)}`));
  }
}

function gradientStrokes(value) {
  if (!value || typeof value !== "object") return [];
  return [value.ty === "gs" ? value : null, ...Object.values(value).flatMap(gradientStrokes)].filter(Boolean);
}

for (const fixture of cases) {
  test(`rotated ${fixture.name} path stroke uses a positive local gradient box in canvas SVG`, () => {
    const svg = renderSceneSvg(rotatedPathScene(fixture), 0, { canvas: true });
    checkPixels(new Resvg(svg).render().pixels, fixture);
    const gradient = /<linearGradient[^>]*x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/.exec(svg);
    assert.ok(gradient);
    checkEndpoints(gradient.slice(1, 3).map(Number), gradient.slice(3, 5).map(Number), fixture);
  });

  test(`rotated ${fixture.name} path stroke retains its gradient in exported PNG pixels`, async () => {
    const result = await exportScene(rotatedPathScene(fixture), { format: "png" });
    const canvas = createCanvas(fixture.sceneWidth, fixture.sceneHeight);
    const context = canvas.getContext("2d");
    context.drawImage(await loadImage(result.buffer), 0, 0);
    checkPixels(context.getImageData(0, 0, fixture.sceneWidth, fixture.sceneHeight).data, fixture);
  });

  test(`rotated ${fixture.name} path stroke retains distinct native Lottie endpoints`, async () => {
    const result = await exportScene(rotatedPathScene(fixture), { format: "lottie", fps: 4, duration: 0.5 });
    const strokes = gradientStrokes(JSON.parse(result.buffer.toString()));
    assert.equal(strokes.length, 1);
    assert.equal(strokes[0].s.a, 0);
    assert.equal(strokes[0].e.a, 0);
    checkEndpoints(strokes[0].s.k, strokes[0].e.k, fixture);
  });
}

test("decoded MP4 frames retain rotated gradients on horizontal and vertical path strokes", async () => {
  for (const fixture of cases) {
    const result = await exportScene(rotatedPathScene(fixture), { format: "mp4", fps: 4, duration: 0.5 });
    const decoded = await new Promise((resolve, reject) => {
      const child = spawn(process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      const frames = [], errors = [];
      child.stdout.on("data", (chunk) => frames.push(chunk));
      child.stderr.on("data", (chunk) => errors.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(Buffer.concat(frames)) : reject(new Error(Buffer.concat(errors).toString())));
      child.stdin.end(result.buffer);
    });
    const frameSize = fixture.sceneWidth * fixture.sceneHeight * 4;
    assert.equal(decoded.length, frameSize * 2);
    checkPixels(decoded.subarray(0, frameSize), fixture, 10);
    checkPixels(decoded.subarray(frameSize), fixture, 10);
  }
});

test("native Lottie path gradient fallback follows animated local resizing", async () => {
  for (const fixture of cases) {
    const scene = rotatedPathScene(fixture);
    scene.layers[0].animations = [{
      id: "resize", name: "Resize", kind: "custom", start: 0, duration: 0.25, easing: "linear",
      from: { width: fixture.width, height: fixture.height },
      to: { width: fixture.width * 2, height: fixture.height * 2 },
    }];
    const result = await exportScene(scene, { format: "lottie", fps: 4, duration: 0.5 });
    const [stroke] = gradientStrokes(JSON.parse(result.buffer.toString()));
    assert.equal(stroke.s.a, 1);
    assert.equal(stroke.e.a, 1);
    checkEndpoints(stroke.s.k[0].s, stroke.e.k[0].s, fixture);
    checkEndpoints(stroke.s.k.at(-1).s, stroke.e.k.at(-1).s, {
      ...fixture, start: fixture.start.map((value) => value * 2), end: fixture.end.map((value) => value * 2),
    });
  }
});
