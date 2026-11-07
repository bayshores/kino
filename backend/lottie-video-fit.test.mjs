import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";

const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

function available(command) {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0;
}

const hasMediaTools = available(ffmpeg) && available(ffprobe);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

function contrastingAspectPng() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#ed3018"/><rect x="0" y="0" width="40" height="160" fill="#1746e8"/></svg>';
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}

async function makeContrastingMedia(mediaRoot) {
  const frame = join(mediaRoot, "wide-frame.png");
  const still = join(mediaRoot, "wide-still.png");
  const png = contrastingAspectPng();
  await writeFile(frame, png, { mode: 0o600 });
  await writeFile(still, png, { mode: 0o600 });
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1", "-framerate", "2", "-i", frame,
    "-frames:v", "2", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p",
    join(mediaRoot, "wide-video.mp4"),
  ]);
  return join(mediaRoot, "wide-video.mp4");
}

function imageLayer(animation, name) {
  const root = animation.layers.find((layer) => layer.nm === name);
  assert.ok(root, `Lottie contains ${name}`);
  const composition = animation.assets.find((asset) => asset.id === root.refId);
  assert.ok(composition, `${name} has a composition`);
  const image = composition.layers.find((layer) => layer.ty === 2);
  assert.ok(image, `${name} composition contains a raster layer`);
  return { image, asset: animation.assets.find((asset) => asset.id === image.refId) };
}

test("Lottie preserves contain fit for video posters while still images cover their boxes", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for Lottie video fit tests",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-lottie-video-fit-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = await makeContrastingMedia(mediaRoot);
  const stillLayer = createLayer("image", {
    id: "wide-still", name: "Still image", x: 10, y: 10, width: 90, height: 130,
    src: "/api/media/wide-still.png",
  });
  const videoLayer = createLayer("video", {
    id: "wide-video", name: "Video", x: 120, y: 10, width: 90, height: 130,
    src: "/api/media/wide-video.mp4",
  });
  const document = createScene({
    id: "video-fit-scene", name: "Video fit", width: 240, height: 160, duration: 1,
    background: "transparent", layers: [stillLayer, videoLayer],
  });
  const before = structuredClone(document);
  const result = await exportScene(document, {
    format: "lottie", fps: 2, imageDPIRatio: "original",
  }, { mediaRoot });
  const animation = JSON.parse(result.buffer.toString("utf8"));
  const stillResult = imageLayer(animation, "Still image");
  const videoResult = imageLayer(animation, "Video");

  assert.deepEqual([stillResult.asset.w, stillResult.asset.h], [240, 160]);
  assert.deepEqual([videoResult.asset.w, videoResult.asset.h], [240, 160]);
  assert.deepEqual(stillResult.image.ks.s.k, [81.25, 81.25, 100], "ordinary image uses cover scaling");
  assert.deepEqual(stillResult.image.ks.p.k, [-52.5, 0, 0], "ordinary image centers its cover crop");
  assert.deepEqual(videoResult.image.ks.s.k, [37.5, 37.5, 100], "video poster uses contain scaling");
  assert.deepEqual(videoResult.image.ks.p.k, [0, 35, 0], "video poster is centered without cropping");
  assert.deepEqual(result.warnings.map(({ code }) => code), ["lottie-video-first-frame"]);
  assert.deepEqual(document, before, "export does not write its transient fit marker to the source document");
  assert.equal(document.layers[1].type, "video");
  assert.equal("lottieFitMode" in document.layers[1], false);
  assert.equal(JSON.stringify(animation).includes("lottieFitMode"), false, "fit marker is not serialized into Lottie output");
});
