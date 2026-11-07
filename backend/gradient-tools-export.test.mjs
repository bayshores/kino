import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";

const initial = { type: "linear", angle: 0, stops: [{ id: "dark", offset: 0, color: "#000000" }, { id: "light", offset: 1, color: "#ffffff" }] };
const vertical = { ...initial, angle: 90 };
// The same gradient with its stops reversed: light at 0, dark at 1.
const flipGradient = (paint) => ({ ...paint, stops: [...paint.stops].sort((a, b) => a.offset - b.offset).reverse().map((stop) => ({ ...stop, offset: 1 - stop.offset })) });
const scene = (fill, extra = {}) => createScene({ id: "gradient-tools", width: 64, height: 64, duration: 0.5,
  layers: [createLayer("rectangle", { id: "gradient-box", x: 0, y: 0, width: 64, height: 64, fill, ...extra })] });
const pixel = (data, x, y) => data[(y * 64 + x) * 4];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≈ ${expected}`);
function checkVertical(data, flipped = false) {
  const top = pixel(data, 32, 5), bottom = pixel(data, 32, 58);
  assert.ok(flipped ? top > 220 && bottom < 35 : top < 35 && bottom > 220, `top ${top}, bottom ${bottom}`);
}

test("PNG shows a 90 degree gradient as dark top/light bottom and reversed stops swap the pixels", async () => {
  for (const [fill, flipped] of [[vertical, false], [flipGradient(vertical), true]]) {
    const result = await exportScene(scene(fill), { format: "png", width: 64, height: 64 });
    const canvas = createCanvas(64, 64), context = canvas.getContext("2d");
    context.drawImage(await loadImage(result.buffer), 0, 0);
    checkVertical(context.getImageData(0, 0, 64, 64).data, flipped);
  }
});

test("MP4 decoded frames keep the rotated and flipped gradient direction", async () => {
  const result = await exportScene(scene(flipGradient(vertical)), { format: "mp4", width: 64, height: 64, fps: 4, duration: 0.5 });
  const decoded = await new Promise((resolve, reject) => {
    const child = spawn(process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [], errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(Buffer.concat(errors).toString())));
    child.stdin.end(result.buffer);
  });
  assert.equal(decoded.length, 64 * 64 * 4 * 2);
  checkVertical(decoded, true);
  checkVertical(decoded.subarray(64 * 64 * 4), true);
});

function items(value) {
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(items)];
}
test("native Lottie gradient fills, strokes and outlined text retain rotated geometry and full-range spaced stops", async () => {
  const spaced = { ...vertical, stops: [vertical.stops[0], { id: "middle", offset: 0.5, color: "#ff000080" }, vertical.stops[1]] };
  const document = scene(spaced, { stroke: flipGradient(spaced), strokeWidth: 2, strokeAlign: "center" });
  document.layers.push(createLayer("text", { id: "gradient-text", text: "A", x: 0, y: 0, width: 64, height: 64, textResize: "fixed", fill: spaced }));
  const result = await exportScene(document, { format: "lottie", width: 64, height: 64, fps: 4, duration: 0.5 });
  const paints = items(JSON.parse(result.buffer.toString())).filter((item) => ["gf", "gs"].includes(item.ty));
  assert.ok(paints.filter((item) => item.ty === "gf").length >= 2, "shape and text fills remain native gradients");
  assert.ok(paints.some((item) => item.ty === "gs"), "stroke remains a native gradient");
  for (const paint of paints) {
    assert.equal(paint.t, 1);
    assert.equal(paint.g.p, 3);
    assert.deepEqual([paint.g.k.k[0], paint.g.k.k[4], paint.g.k.k[8]], [0, 0.5, 1]);
    near(paint.s.k[0], 32); near(paint.s.k[1], 0);
    near(paint.e.k[0], 32); near(paint.e.k[1], 64);
  }
  const diagonal = await exportScene(scene({ ...initial, angle: 45 }), { format: "lottie", fps: 4, duration: 0.5 });
  const fill = items(JSON.parse(diagonal.buffer.toString())).find((item) => item.ty === "gf");
  fill.s.k.forEach((value) => near(value, 0));
  fill.e.k.forEach((value) => near(value, 64));
});
