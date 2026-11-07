import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
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

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-lottie-media-export-"));
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, mediaRoot };
}

function framePng(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="${color}"/></svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}

async function writeFrame(directory, name, color) {
  await writeFile(join(directory, name), framePng(color), { mode: 0o600 });
}

async function makeGif(directory, name, colors) {
  const prefix = `${name}-frame`;
  for (const [index, color] of colors.entries()) {
    await writeFrame(directory, `${prefix}-${index}.png`, color);
  }
  const output = join(directory, `${name}.gif`);
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "2", "-start_number", "0", "-i", join(directory, `${prefix}-%d.png`),
    "-frames:v", String(colors.length), "-loop", "0", "-f", "gif", output,
  ]);
  return output;
}

async function makeMp4(directory, name = "two-color") {
  await writeFrame(directory, "video-frame-0.png", "#ed3018");
  await writeFrame(directory, "video-frame-1.png", "#1746e8");
  const output = join(directory, `${name}.mp4`);
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "2", "-start_number", "0", "-i", join(directory, "video-frame-%d.png"),
    "-frames:v", "2", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", output,
  ]);
  return output;
}

function createTestScene(layers, overrides = {}) {
  return createScene({
    id: "lottie-media-export-scene",
    name: "Lottie media export",
    width: 80,
    height: 60,
    duration: 1,
    background: "transparent",
    layers,
    ...overrides,
  });
}

async function exportLottie(document, options = {}, exportOptions = {}) {
  const before = structuredClone(document);
  const result = await exportScene(document, {
    format: "lottie",
    fps: 4,
    imageDPIRatio: "1x",
    ...options,
  }, exportOptions);
  assert.deepEqual(document, before, "Lottie export leaves the source document unchanged");
  return {
    animation: JSON.parse(result.buffer.toString("utf8")),
    warnings: result.warnings ?? [],
  };
}

function bitmapForLayer(animation, name) {
  const rootLayer = animation.layers.find((layer) => layer.nm === name);
  assert.ok(rootLayer, `exported Lottie contains ${name}`);
  const composition = animation.assets.find((asset) => asset.id === rootLayer.refId);
  assert.ok(composition, `${name} has a composition layer`);
  const imageLayer = composition.layers.find((layer) => layer.ty === 2);
  assert.ok(imageLayer, `${name} composition contains its decoded image`);
  const bitmap = animation.assets.find((asset) => asset.id === imageLayer.refId);
  assert.ok(bitmap?.p, `${name} embeds its bitmap as a data URI`);
  return bitmap;
}

async function centerPixel(asset) {
  const match = /^data:image\/[^;]+;base64,([a-z0-9+/=]+)$/iu.exec(asset.p);
  assert.ok(match, "embedded media has a base64 image data URI");
  const bitmap = await loadImage(Buffer.from(match[1], "base64"));
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const x = Math.floor(bitmap.width / 2), y = Math.floor(bitmap.height / 2);
  const offset = (y * bitmap.width + x) * 4;
  return [...context.getImageData(0, 0, bitmap.width, bitmap.height).data.subarray(offset, offset + 4)];
}

function localMedia(name) {
  return `/api/media/${name}`;
}

async function waitForFile(path) {
  const started = Date.now();
  while (Date.now() - started < 3_000) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for subprocess start marker ${path}`);
}

test("real GIF and MP4 exports embed their first frames at requested Lottie image densities", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for Lottie media export tests",
}, async (t) => {
  const { mediaRoot } = await setup(t);
  await makeGif(mediaRoot, "animated", ["#ed3018", "#1746e8"]);
  await makeMp4(mediaRoot);
  const gif = createLayer("image", {
    id: "animated-gif",
    name: "Animated GIF",
    x: 4,
    y: 4,
    width: 8,
    height: 6,
    src: localMedia("animated.gif"),
  });
  const video = createLayer("video", {
    id: "video-layer",
    name: "Video",
    x: 24,
    y: 4,
    width: 8,
    height: 6,
    src: localMedia("two-color.mp4"),
  });
  const document = createTestScene([gif, video]);

  for (const [ratio, dimensions] of [["1x", [8, 6]], ["2x", [16, 12]]]) {
    const { animation, warnings } = await exportLottie(document, { imageDPIRatio: ratio }, { mediaRoot });
    assert.deepEqual(warnings.map(({ code }) => code), ["lottie-media-first-frame"], "animated GIF and video share one first-frame warning");
    for (const name of [gif.name, video.name]) {
      const bitmap = bitmapForLayer(animation, name);
      assert.deepEqual([bitmap.w, bitmap.h], dimensions, `${name} bitmap follows ${ratio} image resolution`);
      const [red, green, blue, alpha] = await centerPixel(bitmap);
      assert.ok(red > 150 && red > green * 1.6 && red > blue * 1.6 && alpha > 240, `${name} embeds the red first frame rather than the later blue frame: ${[red, green, blue, alpha]}`);
    }
  }
});

test("a real single-frame GIF is embedded without an animated-media warning", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for Lottie media export tests",
}, async (t) => {
  const { mediaRoot } = await setup(t);
  await makeGif(mediaRoot, "still", ["#ed3018"]);
  const image = createLayer("image", {
    id: "still-gif",
    name: "Still GIF",
    width: 16,
    height: 12,
    src: localMedia("still.gif"),
  });
  const { animation, warnings } = await exportLottie(createTestScene([image]), {}, { mediaRoot });
  assert.deepEqual(warnings, []);
  const bitmap = bitmapForLayer(animation, image.name);
  assert.deepEqual([bitmap.w, bitmap.h], [16, 12]);
});

test("missing local video is transparent with a warning, while corrupt video remains fatal", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required to classify corrupt Lottie video",
}, async (t) => {
  const { mediaRoot } = await setup(t);
  await writeFile(join(mediaRoot, "broken.mp4"), Buffer.from("not an MP4 stream"), { mode: 0o600 });
  const broken = createLayer("video", { id: "broken-video", name: "Broken Video", src: localMedia("broken.mp4") });
  const missing = createLayer("video", { id: "missing-video", name: "Missing Video", src: localMedia("missing.mp4") });
  const artwork = createLayer("rectangle", { id: "surviving-artwork", name: "Surviving Artwork", x: 8, y: 9, width: 22, height: 18, fill: "#22aa66", stroke: "none" });
  const { animation, warnings } = await exportLottie(createTestScene([missing, artwork]), {}, { mediaRoot });
  assert.deepEqual(warnings.map(({ code }) => code), ["missing-media"]);
  assert.equal(warnings[0].layerId, missing.id);
  assert.equal(warnings[0].source, "missing.mp4");
  assert.ok(animation.layers.some((layer) => layer.nm === artwork.name && layer.ty === 4), "the real vector layer still exports");
  assert.ok(animation.layers.some((layer) => layer.nm === missing.name), "the missing video's layer stays in the Lottie topology");
  assert.equal((await centerPixel(bitmapForLayer(animation, missing.name)))[3], 0, "the missing video becomes a transparent still");
  await assert.rejects(
    exportLottie(createTestScene([broken, artwork]), {}, { mediaRoot }),
    "corrupt video data remains a fatal Lottie export error",
  );
});

test("media under a hidden parent is neither loaded nor reported and visible artwork remains", async () => {
  const hiddenParent = createLayer("group", { id: "hidden-media-parent", name: "Hidden Media", visible: false });
  const hiddenGif = createLayer("image", { id: "hidden-gif", name: "Hidden GIF", parentId: hiddenParent.id, src: localMedia("does-not-exist.gif") });
  const hiddenVideo = createLayer("video", { id: "hidden-video", name: "Hidden Video", parentId: hiddenParent.id, src: localMedia("does-not-exist.mp4") });
  const visible = createLayer("rectangle", { id: "visible-artwork", name: "Visible Artwork", width: 20, height: 15, fill: "#11aa55", stroke: "none" });
  const { animation, warnings } = await exportLottie(createTestScene([hiddenParent, hiddenGif, hiddenVideo, visible]));
  assert.deepEqual(warnings, []);
  assert.deepEqual(animation.layers.map((layer) => layer.nm), [visible.name]);
});

test("missing FFmpeg fails the real Lottie video export instead of omitting media as success", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required to create the source MP4",
}, async (t) => {
  const { mediaRoot } = await setup(t);
  await makeMp4(mediaRoot);
  const video = createLayer("video", { id: "video-without-tool", name: "Video Without Tool", src: localMedia("two-color.mp4") });
  const document = createTestScene([video]);
  const before = structuredClone(document);
  const previousFfmpeg = process.env.KINO_FFMPEG;
  process.env.KINO_FFMPEG = join(mediaRoot, "missing-ffmpeg-executable");
  try {
    await assert.rejects(exportLottie(document, {}, { mediaRoot }), /executable .* was not found/u);
    assert.deepEqual(document, before, "a failed media export leaves the source document unchanged");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.KINO_FFMPEG;
    else process.env.KINO_FFMPEG = previousFfmpeg;
  }
});

test("cancelling while the real media export subprocess is active rejects without a success result", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required to create the source MP4",
}, async (t) => {
  const { mediaRoot } = await setup(t);
  await makeMp4(mediaRoot);
  const marker = join(mediaRoot, "decoder-started");
  const slowExecutable = join(mediaRoot, "wait-for-cancellation.sh");
  await writeFile(slowExecutable, '#!/bin/sh\n: > "$KINO_TEST_MARKER"\nexec /bin/sleep 15\n', { mode: 0o700 });
  await chmod(slowExecutable, 0o700);
  const video = createLayer("video", { id: "cancelled-video", name: "Cancelled Video", src: localMedia("two-color.mp4") });
  const document = createTestScene([video]);
  const before = structuredClone(document);
  const controller = new AbortController();
  const previousFfmpeg = process.env.KINO_FFMPEG;
  const previousMarker = process.env.KINO_TEST_MARKER;
  process.env.KINO_FFMPEG = slowExecutable;
  process.env.KINO_TEST_MARKER = marker;
  const pending = exportLottie(document, {}, { mediaRoot, signal: controller.signal });
  try {
    await waitForFile(marker);
    controller.abort(new Error("cancel media export test"));
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(document, before, "cancelling a media export leaves the source document unchanged");
  } finally {
    if (!controller.signal.aborted) controller.abort(new Error("cancel media export test cleanup"));
    await pending.catch(() => {});
    if (previousFfmpeg === undefined) delete process.env.KINO_FFMPEG;
    else process.env.KINO_FFMPEG = previousFfmpeg;
    if (previousMarker === undefined) delete process.env.KINO_TEST_MARKER;
    else process.env.KINO_TEST_MARKER = previousMarker;
  }
});
