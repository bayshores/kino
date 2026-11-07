import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportScene } from "./export.mjs";
import { presetAnimation } from "../engine/animation.js";

const layer = (id, type, values = {}) => ({
  id,
  name: id,
  type,
  parentId: null,
  x: 0,
  y: 0,
  width: 16,
  height: 12,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  fill: "#ff3355",
  stroke: "none",
  strokeWidth: 0,
  radius: 2,
  visible: true,
  locked: false,
  blur: 0,
  blendMode: "normal",
  isMask: false,
  shadow: null,
  text: "",
  fontFamily: "Inter",
  fontSize: 10,
  fontWeight: 400,
  lineHeight: 1.2,
  letterSpacing: 0,
  textAlign: "left",
  path: "",
  src: "",
  mediaStart: 0,
  mediaDuration: 0,
  volume: 1,
  animations: [],
  ...values,
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr || `${command} exited with ${code}`)),
    );
  });
}

async function probe(path) {
  const output = await run(process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_type,codec_name,width,height,nb_read_frames,avg_frame_rate",
    "-of",
    "json",
    path,
  ]);
  return JSON.parse(output);
}

function sampleScene() {
  const animated = layer("moving", "rectangle", {
    x: 2,
    y: 2,
    width: 14,
    height: 10,
    animations: [
      {
        id: "move",
        name: "Move",
        kind: "custom",
        start: 0,
        duration: 0.4,
        easing: "linear",
        from: { x: 2 },
        to: { x: 12 },
        unit: "layer",
        stagger: 0,
        order: "forward",
      },
    ],
  });
  const text = layer("caption", "text", {
    x: 1,
    y: 1,
    width: 100,
    height: 12,
    text: "kino",
    fontSize: 8,
    lineHeight: 1.2,
    fill: "#ffffff",
  });
  return {
    id: "scene",
    name: "Smoke",
    width: 32,
    height: 24,
    duration: 0.4,
    background: "#17202b",
    layers: [animated, text],
  };
}

test("PNG is rasterized at the requested aspect-preserving dimensions and Lottie contains playable layer data", async () => {
  const scene = sampleScene();
  const png = await exportScene(scene, {
    format: "png",
    width: 64,
    height: 48,
  });
  assert.equal(png.mime, "image/png");
  assert.equal(png.extension, "png");
  assert.deepEqual(
    [...png.buffer.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(png.buffer.readUInt32BE(16), 64);
  assert.equal(png.buffer.readUInt32BE(20), 48);

  const lottie = JSON.parse(
    (await exportScene(scene, { format: "lottie", fps: 5 })).buffer.toString(
      "utf8",
    ),
  );
  assert.equal(lottie.v, "5.12.2");
  assert.equal(lottie.w, scene.width);
  assert.equal(lottie.h, scene.height);
  assert.ok(lottie.layers.some((item) => item.ty === 4 && item.shapes?.length));
  const textLayer = lottie.layers.find((item) => item.nm === "caption 1");
  assert.equal(textLayer.ty, 4);
  assert.ok(textLayer.shapes.some((group) => group.it.some((item) => item.ty === "sh" && item.ks.k.v.length > 2)));
  assert.equal(lottie.layers.some((item) => item.ty === 5), false);
  assert.equal(Object.hasOwn(lottie, "chars"), false);
  assert.equal(Object.hasOwn(lottie, "fonts"), false);
  assert.ok(lottie.layers.some((item) => item.ty === 4 && item.ks.p.a === 1));
});

test("PNG sequence can retain real frames and keep the default ZIP result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-retained-sequence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = join(root, "frames");
  const unusedOutputPath = join(root, "must-not-be-created.zip");
  await mkdir(frames);
  const progress = [];
  const result = await exportScene(
    sampleScene(),
    { format: "png-sequence", duration: 1, fps: 5, width: 64, height: 48 },
    {
      sequenceDirectory: frames,
      outputPath: unusedOutputPath,
      onProgress(event) {
        if (event.stage !== "render") return;
        const currentFrame = join(
          frames,
          `frame-${String(event.completed - 1).padStart(6, "0")}.png`,
        );
        assert.equal(existsSync(currentFrame), true);
        const completedBytes = Array.from({ length: event.completed }, (_, index) =>
          statSync(join(frames, `frame-${String(index).padStart(6, "0")}.png`)).size,
        ).reduce((sum, size) => sum + size, 0);
        assert.equal(event.renderedBytes, completedBytes);
        progress.push(event);
      },
    },
  );

  assert.equal(result.sequence.directory, frames);
  assert.equal(result.sequence.frameCount, 5);
  assert.equal(result.size, progress.at(-1).renderedBytes);
  assert.equal(result.mime, "image/png");
  assert.equal(result.extension, "png");
  assert.equal("buffer" in result, false);
  assert.equal("path" in result, false);
  assert.equal(existsSync(unusedOutputPath), false);
  const decoded = (await probe(join(frames, "frame-000000.png"))).streams[0];
  assert.equal(decoded.codec_name, "png");
  assert.equal(Number(decoded.width), 64);
  assert.equal(Number(decoded.height), 48);
  assert.equal(progress.length, 5);
  assert.equal(progress.at(-1).completed, 5);

  const zipped = await exportScene(sampleScene(), {
    format: "png-sequence",
    duration: 0.4,
    fps: 5,
    width: 64,
    height: 48,
  });
  assert.equal(zipped.mime, "application/zip");
  assert.equal(zipped.extension, "zip");
  const zipPath = join(root, "default.zip");
  await writeFile(zipPath, zipped.buffer);
  assert.match(await run("unzip", ["-t", zipPath]), /No errors detected/);
  const names = await run("unzip", ["-Z1", zipPath]);
  assert.deepEqual(names.trim().split("\n"), [
    "frame-000000.png",
    "frame-000001.png",
  ]);
});

test("exports past ten minutes, and PNG sequence ZIPs past 65,535 frames, are refused before any frame is drawn", async () => {
  const drawn = [];
  const onProgress = (event) => { if (event.stage === "render") drawn.push(event); };
  await assert.rejects(
    exportScene(sampleScene(), { format: "mp4", duration: 600.5, fps: 30, width: 64, height: 48 }, { onProgress }),
    /Export duration must be greater than zero and at most 600 seconds/,
  );
  await assert.rejects(
    exportScene(sampleScene(), { format: "png-sequence", duration: 600, fps: 120, width: 64, height: 48 }, { onProgress }),
    /A PNG sequence ZIP holds at most 65535 frames; 600s at 120 fps is 72000\. Use at most 109 fps, a shorter scene, or a video format\./,
  );
  assert.deepEqual(drawn, []);
});

test("retained PNG sequence keeps completed frames on cancellation and validates destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kino-retained-sequence-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = join(root, "frames");
  const unusedOutputPath = join(root, "cancelled.zip");
  await mkdir(frames);
  const controller = new AbortController();
  await assert.rejects(
    exportScene(
      sampleScene(),
      { format: "png-sequence", duration: 1, fps: 5, width: 64, height: 48 },
      {
        sequenceDirectory: frames,
        outputPath: unusedOutputPath,
        signal: controller.signal,
        onProgress(event) {
          if (event.stage === "render" && event.completed === 1) {
            assert.equal(event.renderedBytes, statSync(join(frames, "frame-000000.png")).size);
            controller.abort();
          }
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(await readdir(frames), ["frame-000000.png"]);
  const decoded = (await probe(join(frames, "frame-000000.png"))).streams[0];
  assert.equal(decoded.codec_name, "png");
  assert.equal(existsSync(unusedOutputPath), false);

  const missingDirectory = join(root, "must-not-be-created");
  await assert.rejects(
    exportScene(sampleScene(), { format: "mp4" }, { sequenceDirectory: missingDirectory }),
    /only be used for PNG sequence/,
  );
  assert.equal(existsSync(missingDirectory), false);

  const occupiedDirectory = join(root, "occupied");
  await mkdir(occupiedDirectory);
  await writeFile(join(occupiedDirectory, "keep.txt"), "keep");
  await assert.rejects(
    exportScene(sampleScene(), { format: "png-sequence" }, { sequenceDirectory: occupiedDirectory }),
    /must be empty/,
  );
  assert.equal(existsSync(join(occupiedDirectory, "keep.txt")), true);
});

test("MP4, WebM, MOV, and GIF exports contain actual frames at the requested size", async (t) => {
  const scene = sampleScene();
  const temp = await mkdtemp(join(tmpdir(), "kino-export-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const format of ["mp4", "webm", "mov", "gif"]) {
    const result = await exportScene(scene, {
      format,
      fps: 5,
      width: 64,
      height: 48,
    });
    const path = join(temp, `scene.${format}`);
    await writeFile(path, result.buffer);
    const output = await probe(path);
    const stream = output.streams.find((item) => item.codec_type === "video");
    assert.ok(stream, `${format} has a video stream`);
    assert.equal(Number(stream.width), 64);
    assert.equal(Number(stream.height), 48);
    assert.equal(Number(stream.nb_read_frames), format === "gif" ? 3 : 2);
  }
});

test("normal text presets and animated blur produce real Lottie effects", async () => {
  const caption = layer("caption", "text", {text: "ABC", width: 60, fontSize: 16});
  caption.animations = [presetAnimation("fade-in", caption, 0)];
  const scene = {width: 80, height: 40, duration: 1, background: "transparent", layers: [caption]};
  const json = JSON.parse((await exportScene(scene, {format: "lottie", fps: 5})).buffer);
  const outlined = json.layers.find((item) => item.nm === "caption 1");
  assert.equal(outlined.ty, 4);
  assert.equal(outlined.ks.o.a, 1);
  assert.equal(outlined.ks.o.k[0].s[0], 0);
  assert.equal(outlined.ks.o.k.at(-1).s[0], 100);
  caption.animations[0].to.blur = 4;
  const blurred = JSON.parse((await exportScene(scene, {format: "lottie", fps: 5})).buffer);
  const effect = blurred.layers.find((item) => item.ef)?.ef.find((item) => item.ty === 29);
  assert.ok(effect, "The effect is retained in the actual exported JSON");
  assert.equal(effect.ef[0].v.a, 1);
  assert.equal(effect.ef[0].v.k[0].s[0], 0);
  assert.ok(Math.abs(effect.ef[0].v.k.at(-1).s[0] - 20 / 3) < 1e-9);
});

test("uploaded local video frames and their audio track are rendered and muxed", async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-media-test-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const source = join(mediaRoot, "sample.mp4");
  await run(process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x24:r=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "0.5",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    source,
  ]);
  const clip = layer("clip", "video", {
    src: "/api/media/sample.mp4",
    width: 32,
    height: 24,
    mediaDuration: 0.5,
    volume: 0.5,
  });
  const scene = {
    id: "video-scene",
    name: "Video",
    width: 32,
    height: 24,
    duration: 0.5,
    background: "#000000",
    layers: [clip],
  };
  const result = await exportScene(
    scene,
    { format: "mp4", fps: 4, width: 32, height: 24 },
    { mediaRoot },
  );
  const outputPath = join(mediaRoot, "export.mp4");
  await writeFile(outputPath, result.buffer);
  const streams = (await probe(outputPath)).streams;
  assert.ok(
    streams.some(
      (stream) =>
        stream.codec_type === "video" && Number(stream.nb_read_frames) >= 1,
    ),
  );
  assert.ok(streams.some((stream) => stream.codec_type === "audio"));
});
