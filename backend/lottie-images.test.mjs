import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { inspectLottieImage, resizeLottieImage } from "./lottie-images.mjs";

const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

function available(command) {
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

const hasImageTools = available(ffmpeg) && available(ffprobe);

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`));
    });
    if (input) child.stdin.end(input);
  });
}

function patternedPng(width, height) {
  const rectangles = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let value = Math.imul(x + 17, 0x45d9f3b) ^ Math.imul(y + 31, 0x119de1f3);
      value ^= value >>> 16;
      const red = value & 0xff;
      const green = (value >>> 8) & 0xff;
      const blue = (value >>> 16) & 0xff;
      rectangles.push(`<rect x="${x}" y="${y}" width="2" height="2" fill="#${[red, green, blue].map((part) => part.toString(16).padStart(2, "0")).join("")}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rectangles.join("")}</svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}

function solidPng(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#3579bd"/></svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "kino-lottie-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function dataUrl(href) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/iu.exec(href);
  assert.ok(match, "resize output is a complete image data URL");
  return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], "base64") };
}

async function verifyDecodedImage(directory, href, width, height, label) {
  const { mime, buffer } = dataUrl(href);
  const extension = mime === "image/jpeg" ? ".jpg" : ".png";
  const path = join(directory, `${label}${extension}`);
  await writeFile(path, buffer);
  const metadata = JSON.parse((await run(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", path,
  ])).toString("utf8"));
  const stream = metadata.streams[0];
  assert.deepEqual([Number(stream.width), Number(stream.height)], [width, height], `${label} has actual encoded dimensions`);
  const rgba = await run(ffmpeg, [
    "-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  assert.equal(rgba.length, width * height * 4, `${label} decodes to real pixels at its declared dimensions`);
  assert.ok(rgba.some((value) => value !== 0), `${label} contains decoded pixel data`);
  return { mime, buffer, rgba };
}

test("inspects and genuinely resizes PNG assets at 1x, 2x, 3x, and Original", {
  skip: hasImageTools ? false : "FFmpeg and ffprobe are required for raster export tests",
}, async (t) => {
  const directory = await tempDirectory(t);
  const sourceBuffer = patternedPng(320, 160);
  const image = await inspectLottieImage({ buffer: sourceBuffer, mime: "image/png" }, { directory, index: 0 });
  assert.deepEqual([image.sourceWidth, image.sourceHeight], [320, 160]);
  assert.equal(image.mime, "image/png");
  assert.deepEqual(await readFile(image.path), sourceBuffer);
  assert.equal((await stat(image.path)).mode & 0o777, 0o600);
  const controller = new AbortController();
  const beforeCancellation = await readdir(directory);
  const resizing = resizeLottieImage(image, {
    maxWidth: 20,
    maxHeight: 10,
    imageDPIRatio: "1x",
    directory,
    index: 99,
    signal: controller.signal,
  });
  controller.abort(new Error("test cancellation"));
  await assert.rejects(resizing, { name: "AbortError" });
  assert.deepEqual(await readdir(directory), beforeCancellation, "cancelled resize removes its private partial output");

  const cases = [
    ["1x", 40, 20],
    ["2x", 80, 40],
    ["3x", 120, 60],
    ["original", 320, 160],
  ];
  for (const [ratio, width, height] of cases) {
    const resized = await resizeLottieImage(image, {
      maxWidth: 40,
      maxHeight: 20,
      imageDPIRatio: ratio,
      directory,
      index: cases.findIndex((entry) => entry[0] === ratio),
    });
    assert.deepEqual([resized.width, resized.height], [width, height], `${ratio} returns the requested resolution`);
    const decoded = await verifyDecodedImage(directory, resized.href, width, height, `ratio-${ratio}`);
    assert.equal(decoded.mime, "image/png");
    assert.equal(resized.clamped, false, `${ratio} is not reported as capped below its world size`);
  }
});

test("does not upscale small images and warns only when the 2048 cap reduces an oversized source below its world size", {
  skip: hasImageTools ? false : "FFmpeg and ffprobe are required for raster export tests",
}, async (t) => {
  const directory = await tempDirectory(t);
  const smallBuffer = patternedPng(64, 32);
  const small = await inspectLottieImage({ buffer: smallBuffer, mime: "image/png" }, { directory, index: 0 });
  const noUpscale = await resizeLottieImage(small, {
    maxWidth: 400,
    maxHeight: 200,
    imageDPIRatio: "3x",
    directory,
    index: 1,
  });
  assert.deepEqual([noUpscale.width, noUpscale.height], [64, 32]);
  assert.equal(noUpscale.href, small.href, "same-size PNG keeps the source bytes");
  assert.equal(noUpscale.clamped, false);

  const atLimit = await inspectLottieImage({ buffer: solidPng(2048, 32), mime: "image/png" }, { directory, index: 2 });
  const atLimitResult = await resizeLottieImage(atLimit, {
    maxWidth: 3000,
    maxHeight: 32,
    imageDPIRatio: "1x",
    directory,
    index: 3,
  });
  assert.deepEqual([atLimitResult.width, atLimitResult.height], [2048, 32]);
  assert.equal(atLimitResult.clamped, false, "an image exactly at 2048 pixels is not over the cap");

  const overLimit = await inspectLottieImage({ buffer: solidPng(2049, 32), mime: "image/png" }, { directory, index: 4 });
  const overLimitResult = await resizeLottieImage(overLimit, {
    maxWidth: 3000,
    maxHeight: 32,
    imageDPIRatio: "1x",
    directory,
    index: 5,
  });
  assert.deepEqual([overLimitResult.width, overLimitResult.height], [2048, 32]);
  assert.equal(overLimitResult.clamped, true, "the cap warning appears when it cuts below the world width");
  await verifyDecodedImage(directory, overLimitResult.href, 2048, 32, "over-limit");

  const original = await resizeLottieImage(overLimit, {
    maxWidth: 3000,
    maxHeight: 32,
    imageDPIRatio: "original",
    directory,
    index: 6,
  });
  assert.deepEqual([original.width, original.height], [2049, 32], "Original remains uncapped");
  assert.equal(original.clamped, false);
});

test("keeps JPEG output as JPEG and converts BMP input to a decoded PNG", {
  skip: hasImageTools ? false : "FFmpeg and ffprobe are required for raster export tests",
}, async (t) => {
  const directory = await tempDirectory(t);
  const png = patternedPng(160, 80);
  const jpeg = await run(ffmpeg, [
    "-v", "error", "-i", "pipe:0", "-frames:v", "1", "-q:v", "2", "-f", "image2", "pipe:1",
  ], png);
  const jpegImage = await inspectLottieImage({ buffer: jpeg, mime: "image/jpeg" }, { directory, index: 0 });
  const jpegResult = await resizeLottieImage(jpegImage, {
    maxWidth: 40,
    maxHeight: 20,
    imageDPIRatio: "1x",
    directory,
    index: 1,
  });
  const decodedJpeg = await verifyDecodedImage(directory, jpegResult.href, 40, 20, "jpeg-output");
  assert.equal(decodedJpeg.mime, "image/jpeg");
  assert.deepEqual([...decodedJpeg.buffer.subarray(0, 3)], [0xff, 0xd8, 0xff]);

  const bmp = await run(ffmpeg, [
    "-v", "error", "-i", "pipe:0", "-frames:v", "1", "-c:v", "bmp", "-f", "image2", "pipe:1",
  ], png);
  const bmpImage = await inspectLottieImage({ buffer: bmp, mime: "image/bmp" }, { directory, index: 2 });
  const pngResult = await resizeLottieImage(bmpImage, {
    maxWidth: 40,
    maxHeight: 20,
    imageDPIRatio: "1x",
    directory,
    index: 3,
  });
  const decodedPng = await verifyDecodedImage(directory, pngResult.href, 40, 20, "bmp-to-png");
  assert.equal(decodedPng.mime, "image/png");
  assert.deepEqual([...decodedPng.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("reports missing FFmpeg tools clearly and honors cancellation", async (t) => {
  const directory = await tempDirectory(t);
  const source = { buffer: solidPng(16, 8), mime: "image/png" };
  const missingTool = Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" });
  await assert.rejects(
    inspectLottieImage(source, {
      directory,
      index: 0,
      runProcess: async () => { throw missingTool; },
    }),
    /Install FFmpeg with ffprobe/,
  );
  assert.deepEqual(await readdir(directory), [], "failed inspection removes its private input");

  const duringProbe = new AbortController();
  await assert.rejects(
    inspectLottieImage(source, {
      directory,
      index: 2,
      signal: duringProbe.signal,
      runProcess: async (_command, _args, signal, cwd) => {
        assert.equal(signal, duringProbe.signal);
        assert.equal(cwd, directory);
        duringProbe.abort(new Error("cancel during probe"));
        throw new Error("stopped by cancellation");
      },
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(await readdir(directory), [], "cancelled inspection removes its private input");

  const controller = new AbortController();
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(
    inspectLottieImage(source, { directory, index: 1, signal: controller.signal }),
    { name: "AbortError" },
  );
});
