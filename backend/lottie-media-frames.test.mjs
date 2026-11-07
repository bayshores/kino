import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";
import { createDecodeSlots, gifDecodeSlots } from "./gif-decode-slots.mjs";
import { decodeLottieMediaFrame } from "./lottie-media-frames.mjs";
import { makeAnimatedGif, near } from "./media.test.support.mjs";

const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

function available(command) {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0;
}

const hasMediaTools = available(ffmpeg) && available(ffprobe);
const hasVpxEncoders = hasMediaTools && /libvpx(?:-vp9)?/u.test(
  spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "",
);

function run(command, args, { input, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stderr = "";
    let killTimer;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, terminatingSignal) => {
      cleanup();
      if (signal?.aborted) {
        const error = new Error("cancelled test subprocess");
        error.name = "AbortError";
        reject(error);
      } else if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited with ${code ?? terminatingSignal}: ${stderr.trim()}`));
    });
    if (input) child.stdin.end(input);
  });
}

function colorPng(width, height, fill, clearRight = false) {
  const paintedWidth = clearRight ? width / 2 : width;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${paintedWidth}" height="100%" fill="${fill}"/></svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "kino-lottie-media-frames-"));
  const fixtures = join(root, "fixtures");
  const privateDirectory = join(root, "private");
  await mkdir(fixtures);
  await mkdir(privateDirectory, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, fixtures, privateDirectory };
}

async function writeFrame(path, buffer) {
  await writeFile(path, buffer, { mode: 0o600 });
}

async function makeGif(directory, name, frameCount, { transparent = false, inputName = name } = {}) {
  const pattern = join(directory, `${inputName}-%d.png`);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "2",
    "-i", pattern,
    "-frames:v", String(frameCount),
  ];
  if (transparent) {
    args.push(
      "-filter_complex",
      "split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse=alpha_threshold=128",
    );
  }
  args.push("-loop", "0", "-f", "gif", join(directory, `${name}.gif`));
  await run(ffmpeg, args);
  return readFile(join(directory, `${name}.gif`));
}

async function makeMp4(directory) {
  const output = join(directory, "two-color.mp4");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "2", "-i", join(directory, "opaque-%d.png"),
    "-frames:v", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    output,
  ]);
  return readFile(output);
}

async function makeTransparentWebm(directory, codec) {
  const output = join(directory, `${codec}.webm`);
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", "2", "-i", join(directory, "alpha-%d.png"),
    "-frames:v", "2", "-c:v", codec, "-pix_fmt", "yuva420p",
    "-auto-alt-ref", "0", output,
  ]);
  return readFile(output);
}

async function decodedPixels(frame) {
  const bitmap = await loadImage(frame.buffer);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  return {
    width: bitmap.width,
    height: bitmap.height,
    rgba: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
  };
}

function pixel(pixels, x, y) {
  const offset = (y * pixels.width + x) * 4;
  return [...pixels.rgba.subarray(offset, offset + 4)];
}

async function assertNoPrivateFiles(directory) {
  assert.deepEqual(await readdir(directory), [], "decoder removes its generated input and frame files");
}

// GIFs are decoded by engine/gifDecode.js; FFmpeg is only for videos.
const noProcesses = async (command) => assert.fail(`a GIF frame needs no ${command} process`);

test("GIF decoding distinguishes still, animated, and transparent first frames", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for Lottie media frame tests",
}, async (t) => {
  const { fixtures, privateDirectory } = await setup(t);
  const first = colorPng(32, 24, "#ed3018");
  const second = colorPng(32, 24, "#1746e8");
  await writeFrame(join(fixtures, "opaque-0.png"), first);
  await writeFrame(join(fixtures, "opaque-1.png"), second);
  await writeFrame(join(fixtures, "still-0.png"), first);
  await writeFrame(join(fixtures, "alpha-0.png"), colorPng(32, 24, "#ed3018", true));
  await writeFrame(join(fixtures, "alpha-1.png"), colorPng(32, 24, "#1746e8", true));

  const staticGif = await makeGif(fixtures, "still", 1, { inputName: "opaque" });
  const still = await decodeLottieMediaFrame({ buffer: staticGif, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses });
  assert.equal(still.animated, false);
  assert.equal(still.mime, "image/jpeg", "an opaque GIF first frame is encoded as JPEG");
  const stillPixels = await decodedPixels(still);
  assert.deepEqual([stillPixels.width, stillPixels.height], [32, 24]);
  const stillRed = pixel(stillPixels, 2, 2);
  assert.ok(stillRed[0] > 170 && stillRed[1] < 90 && stillRed[2] < 90, `still GIF first pixel remains red: ${stillRed}`);
  const poster = await decodeLottieMediaFrame({ buffer: staticGif, mime: "image/gif" },
    { directory: privateDirectory, runProcess: noProcesses, requirePng: true });
  assert.equal(poster.mime, "image/png", "viewer posters avoid an intermediate lossy JPEG encode");
  assert.deepEqual([...poster.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await assertNoPrivateFiles(privateDirectory);

  const animatedGif = await makeGif(fixtures, "opaque", 2);
  const animated = await decodeLottieMediaFrame({ buffer: animatedGif, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses });
  assert.equal(animated.animated, true, "reading the first two frames detects the second GIF frame");
  assert.equal(animated.mime, "image/jpeg");
  const animatedPixels = await decodedPixels(animated);
  assert.deepEqual([animatedPixels.width, animatedPixels.height], [32, 24]);
  const animatedRed = pixel(animatedPixels, 2, 2);
  assert.ok(animatedRed[0] > 170 && animatedRed[1] < 90 && animatedRed[2] < 90, `animated GIF embeds its actual first frame: ${animatedRed}`);
  await assertNoPrivateFiles(privateDirectory);

  const alphaGif = await makeGif(fixtures, "alpha", 2, { transparent: true });
  const transparent = await decodeLottieMediaFrame({ buffer: alphaGif, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses });
  assert.equal(transparent.animated, true);
  assert.equal(transparent.mime, "image/png", "any transparent GIF pixel keeps an alpha-capable output");
  const transparentPixels = await decodedPixels(transparent);
  assert.deepEqual([transparentPixels.width, transparentPixels.height], [32, 24]);
  const red = pixel(transparentPixels, 2, 2);
  const clear = pixel(transparentPixels, 28, 2);
  assert.ok(red[0] > 170 && red[1] < 90 && red[2] < 90, `transparent GIF first frame contains its opaque red region: ${red}`);
  assert.equal(clear[3], 0, `transparent GIF first frame keeps transparent pixels: ${clear}`);
  await assertNoPrivateFiles(privateDirectory);
});

test("video decoding keeps native frame size and exports the actual first frame as PNG", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for Lottie media frame tests",
}, async (t) => {
  const { fixtures, privateDirectory } = await setup(t);
  await writeFrame(join(fixtures, "opaque-0.png"), colorPng(32, 24, "#ed3018"));
  await writeFrame(join(fixtures, "opaque-1.png"), colorPng(32, 24, "#1746e8"));
  const video = await makeMp4(fixtures);
  for (const mime of ["video/mp4", "video/quicktime", "video/x-m4v"]) {
    const frame = await decodeLottieMediaFrame({ buffer: video, mime }, {
      directory: privateDirectory,
      runProcess: async (command, args, signal, cwd) => {
        const output = await run(command, args, { signal, cwd });
        if (command === ffmpeg) {
          assert.equal((await stat(args.at(-1))).mode & 0o777, 0o600, "FFmpeg writes the generated PNG to a private mode-0600 path");
        }
        return output;
      },
    });
    assert.equal(frame.animated, true);
    assert.equal(frame.mime, "image/png", `${mime} first frames always use PNG`);
    const pixels = await decodedPixels(frame);
    assert.deepEqual([pixels.width, pixels.height], [32, 24]);
    const firstPixel = pixel(pixels, 2, 2);
    assert.ok(firstPixel[0] > 150 && firstPixel[1] < 100 && firstPixel[2] < 100, `${mime} export uses its actual red first frame: ${firstPixel}`);
    await assertNoPrivateFiles(privateDirectory);
  }
});

test("transparent VP8 and VP9 WebM use FFmpeg's alpha-capable decoders", {
  skip: !hasVpxEncoders ? "FFmpeg libvpx encoders are required for transparent WebM tests" : false,
}, async (t) => {
  const { fixtures, privateDirectory } = await setup(t);
  await writeFrame(join(fixtures, "alpha-0.png"), colorPng(32, 24, "#ed3018", true));
  await writeFrame(join(fixtures, "alpha-1.png"), colorPng(32, 24, "#1746e8", true));
  for (const [codec, codecName] of [["libvpx", "vp8"], ["libvpx-vp9", "vp9"]]) {
    const webm = await makeTransparentWebm(fixtures, codec);
    const metadata = JSON.parse((await run(ffprobe, [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name:stream_tags=alpha_mode", "-of", "json", join(fixtures, `${codec}.webm`),
    ])).toString("utf8"));
    assert.equal(metadata.streams?.[0]?.codec_name, codecName);
    const tags = metadata.streams?.[0]?.tags ?? {};
    const alphaMode = Object.entries(tags).find(([name]) => name.toLowerCase() === "alpha_mode")?.[1];
    assert.equal(String(alphaMode), "1", `test ${codecName.toUpperCase()} clip is tagged as alpha WebM`);

    const frame = await decodeLottieMediaFrame({ buffer: webm, mime: "video/webm" }, { directory: privateDirectory });
    assert.equal(frame.animated, true);
    assert.equal(frame.mime, "image/png");
    const pixels = await decodedPixels(frame);
    assert.deepEqual([pixels.width, pixels.height], [32, 24]);
    const red = pixel(pixels, 2, 2);
    const clear = pixel(pixels, 28, 2);
    assert.ok(red[0] > 140 && red[1] < 110 && red[2] < 110, `transparent WebM keeps the real first-frame red region: ${red}`);
    assert.equal(clear[3], 0, `${codecName.toUpperCase()} alpha survives first-frame extraction: ${clear}`);
    await assertNoPrivateFiles(privateDirectory);
  }
});

test("uses private files, reports invalid media, and cleans up on cancellation", {
  skip: hasMediaTools ? false : "FFmpeg and ffprobe are required for Lottie media frame tests",
}, async (t) => {
  const { fixtures, privateDirectory } = await setup(t);
  await writeFrame(join(fixtures, "opaque-0.png"), colorPng(32, 24, "#ed3018"));
  await writeFrame(join(fixtures, "opaque-1.png"), colorPng(32, 24, "#1746e8"));
  const video = await makeMp4(fixtures);
  const controller = new AbortController();
  let inputPath;
  await assert.rejects(decodeLottieMediaFrame(
    { buffer: video, mime: "video/mp4" },
    {
      directory: privateDirectory,
      signal: controller.signal,
      time: 0.5,
      runProcess: async (command, args, signal, cwd) => {
        if (command === ffprobe) {
          inputPath = args.at(-1);
          assert.equal(cwd, privateDirectory);
          assert.equal((await stat(inputPath)).mode & 0o777, 0o600, "decoder input file is private");
          return run(command, args, { signal, cwd });
        }
        assert.equal(command, ffmpeg);
        controller.abort(new Error("test cancellation"));
        throw new Error("decoder stopped by cancellation");
      },
    },
  ), { name: "AbortError" });
  assert.ok(inputPath, "the real ffprobe process inspected the generated video");
  await assertNoPrivateFiles(privateDirectory);

  await assert.rejects(
    decodeLottieMediaFrame({ buffer: Buffer.from("not a real GIF"), mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses }),
    { code: "GIF_UNREADABLE", message: "This file is not a GIF." },
  );
  await assertNoPrivateFiles(privateDirectory);
  await assert.rejects(
    decodeLottieMediaFrame({ buffer: video, mime: "video/x-unsupported" }, { directory: privateDirectory }),
    /Unsupported Lottie media MIME/u,
  );
});

test("a GIF over the decoding limits is refused from its header, with its code, and nothing is decoded", async (t) => {
  const { privateDirectory } = await setup(t);
  // 16000 x 16000 pixels would need 1 GB of memory per frame, though the file is a few bytes.
  const u16 = (value) => [value & 0xff, value >> 8];
  const onePixelFrame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
  const bomb = Buffer.from([
    ..."GIF89a".split("").map((char) => char.charCodeAt(0)), ...u16(16000), ...u16(16000), 0x80, 0, 0,
    255, 0, 0, 0, 0, 255,
    ...onePixelFrame, ...onePixelFrame, ...onePixelFrame,
    0x3b,
  ]);
  // Time 0 needs only the first frame, which has the larger still-picture limit.
  for (const [time, limit] of [[0, "33,554,432"], [0.25, "16,777,216"]]) {
    const started = Date.now();
    await assert.rejects(decodeLottieMediaFrame({ buffer: bomb, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses, time }), {
      code: "GIF_TOO_LARGE",
      message: `This GIF's picture (16000 x 16000) is larger than ${limit} pixels.`,
    });
    assert.ok(Date.now() - started < 1000, "refused at once");
  }
  await assertNoPrivateFiles(privateDirectory);

  // A frame that browsers cannot decode (LZW minimum code size 12) is an error too.
  const badCodeSize = Buffer.from(bomb);
  badCodeSize.writeUInt16LE(4, 6);
  badCodeSize.writeUInt16LE(4, 8);
  badCodeSize[13 + 6 + 10] = 12;
  await assert.rejects(decodeLottieMediaFrame({ buffer: badCodeSize, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses }), {
    code: "GIF_UNREADABLE",
  });
});

test("a Play offset embeds the GIF frame shown at that time, composed with browser rules", async (t) => {
  const { privateDirectory } = await setup(t);
  const RED = [255, 0, 0];
  const BLUE = [0, 0, 255];
  // A 16 x 8 canvas. Frame 0 paints the left half red (kept: disposal 1); frame 1 paints the right half
  // blue and is cleared by disposal 2; frame 2 paints a 4 x 4 blue square in the bottom right corner.
  // Delays: 0.1 s, 0.2 s, 0.3 s, so the GIF loops every 0.6 s.
  const gif = makeAnimatedGif({
    width: 16,
    height: 8,
    frames: [
      { delayCs: 10, color: RED, rect: { left: 0, top: 0, width: 8, height: 8 }, disposal: 1 },
      { delayCs: 20, color: BLUE, rect: { left: 8, top: 0, width: 8, height: 8 }, disposal: 2, transparent: false },
      { delayCs: 30, color: BLUE, rect: { left: 12, top: 4, width: 4, height: 4 }, disposal: 1 },
    ],
  });
  const at = async (time) => {
    const frame = await decodeLottieMediaFrame({ buffer: gif, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses, time });
    assert.equal(frame.animated, true);
    return { mime: frame.mime, ...(await decodedPixels(frame)) };
  };
  const first = await at(0);
  assert.equal(first.mime, "image/png", "the first frame has transparent pixels");
  assert.deepEqual(pixel(first, 2, 2), [...RED, 255]);
  assert.equal(pixel(first, 13, 2)[3], 0, "the canvas starts transparent, not the background color");

  // A frame without transparent pixels is embedded as JPEG, so its colors are compared with a tolerance.
  const second = await at(0.15);
  assert.equal(second.mime, "image/jpeg");
  assert.ok(near(pixel(second, 2, 4), [...RED, 255]), `frame 0 stays under frame 1: ${pixel(second, 2, 4)}`);
  assert.ok(near(pixel(second, 13, 2), [...BLUE, 255]), `frame 1 is drawn: ${pixel(second, 13, 2)}`);

  const third = await at(0.35);
  assert.deepEqual(pixel(third, 2, 4), [...RED, 255]);
  assert.equal(pixel(third, 10, 1)[3], 0, "disposal 2 cleared frame 1, although it has no transparent color");
  assert.deepEqual(pixel(third, 14, 6), [...BLUE, 255]);

  const looped = await at(0.6 + 0.15);
  assert.ok(near(pixel(looped, 13, 2), [...BLUE, 255]), "the GIF loops: 0.75 s shows frame 1 again");
});

test("GIF frames wait for the shared GIF decode slots, and cancelling while waiting decodes nothing", async (t) => {
  const { privateDirectory } = await setup(t);
  const gif = makeAnimatedGif({ width: 2, height: 2, frames: [{ delayCs: 10, color: [255, 0, 0] }] });

  // Two raster exports or frame-cache decodes holding both process-wide slots make the Lottie frame wait.
  let releaseOthers;
  const othersFinish = new Promise((resolve) => { releaseOthers = resolve; });
  const others = [1, 2].map(() => gifDecodeSlots.run(() => othersFinish));
  let decoded = false;
  const waiting = decodeLottieMediaFrame({ buffer: gif, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses })
    .then((frame) => { decoded = true; return frame; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(decoded, false, "no GIF decode starts while every slot is in use");
  releaseOthers();
  await Promise.all(others);
  assert.equal((await waiting).mime, "image/jpeg");

  const slots = createDecodeSlots(1);
  let releaseSlot;
  const busy = slots.run(() => new Promise((resolve) => { releaseSlot = resolve; }));
  const controller = new AbortController();
  const cancelled = decodeLottieMediaFrame({ buffer: gif, mime: "image/gif" }, {
    directory: privateDirectory, runProcess: noProcesses, signal: controller.signal, slots,
  });
  controller.abort(new Error("export cancelled"));
  await assert.rejects(cancelled, { name: "AbortError", message: "Lottie media frame decoding was cancelled" });
  releaseSlot();
  await busy;
});

test("the first frame uses the still-picture limit at any time it is shown, and pictures too wide for JPEG stay PNG", async (t) => {
  const { privateDirectory } = await setup(t);
  // A 6000 x 4000 GIF is over the 16,777,216-pixel limit for playing, but within the still limit.
  const big = (frames) => makeAnimatedGif({ width: 6000, height: 4000, frames });
  const still = big([{ color: [255, 0, 0], delayCs: 100 }]);
  const twoFrames = big([{ color: [255, 0, 0], delayCs: 100 }, { color: [0, 0, 255], delayCs: 100 }]);
  for (const [bytes, time] of [[still, 5], [twoFrames, 0.5]]) {
    const frame = await decodeLottieMediaFrame({ buffer: bytes, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses, time });
    assert.equal(frame.mime, "image/jpeg", `the first frame at ${time} s`);
  }
  await assert.rejects(
    decodeLottieMediaFrame({ buffer: twoFrames, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses, time: 1.5 }),
    { code: "GIF_TOO_LARGE", message: "This GIF's picture (6000 x 4000) is larger than 16,777,216 pixels." },
    "a later frame needs the whole GIF, with the limits for playing it",
  );

  for (const [width, mime] of [[65_500, "image/jpeg"], [65_501, "image/png"]]) {
    const wide = makeAnimatedGif({ width, height: 1, frames: [{ color: [255, 0, 0], delayCs: 10 }] });
    const frame = await decodeLottieMediaFrame({ buffer: wide, mime: "image/gif" }, { directory: privateDirectory, runProcess: noProcesses });
    assert.equal(frame.mime, mime, `an opaque ${width} x 1 GIF`);
  }
});
