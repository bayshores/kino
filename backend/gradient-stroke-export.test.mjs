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

function layer(id, values = {}) {
  return createLayer("rectangle", {
    id,
    name: id,
    fill: "#00000000",
    stroke: "none",
    strokeWidth: 0,
    ...values,
  });
}

function scene(layers, values = {}) {
  return createScene({
    id: values.id ?? "gradient-stroke-scene",
    name: values.name ?? "Gradient stroke export",
    width: values.width ?? 220,
    height: values.height ?? 100,
    duration: values.duration ?? 1,
    background: values.background ?? "transparent",
    layers,
  });
}

function assertAlpha(pixelValue, minimum, maximum, label) {
  assert.ok(pixelValue[3] >= minimum && pixelValue[3] <= maximum,
    `${label} preserves the gradient stop alpha (${pixelValue[3]})`);
}

test("PNG exports linear gradient strokes with per-stop alpha for all alignments and a width-based radial radius", async () => {
  const linearStroke = {
    type: "linear",
    angle: 0,
    stops: [
      { offset: 0, color: "#ff000080" },
      { offset: 1, color: "#0000ff40" },
    ],
  };
  const layers = [
    ["outside", 10, "outside"],
    ["center", 80, "center"],
    ["inside", 150, "inside"],
  ].map(([id, x, strokeAlign]) => layer(`${id}-linear`, {
    x, y: 10, width: 50, height: 30,
    stroke: linearStroke,
    strokeWidth: 8,
    strokeAlign,
  }));
  layers.push(layer("width-radius-radial", {
    x: 10, y: 55, width: 80, height: 30,
    stroke: {
      type: "radial",
      angle: 0,
      stops: [
        { offset: 0, color: "#ff0000" },
        { offset: 1, color: "#0000ff" },
      ],
    },
    strokeWidth: 2,
    strokeAlign: "center",
  }));

  const output = await exportScene(scene(layers), { format: "png", width: 220, height: 100 });
  assert.equal(output.mime, "image/png");
  const rgba = await decodePng(output.buffer);
  assert.equal(rgba.length, 220 * 100 * 4);

  for (const [id, x, y] of [["outside", 10, 8], ["center", 80, 9], ["inside", 150, 12]]) {
    const left = pixel(rgba, 220, x + 8, y);
    const middle = pixel(rgba, 220, x + 25, y);
    const right = pixel(rgba, 220, x + 42, y);
    assertAlpha(left, 90, 150, `${id} left edge`);
    assertAlpha(middle, 70, 130, `${id} middle`);
    assertAlpha(right, 45, 110, `${id} right edge`);
    assert.ok(left[0] > left[2] * 2, `${id} uses the red start stop (${left.join(",")})`);
    assert.ok(middle[0] > 35 && middle[2] > 35, `${id} interpolates between gradient stops (${middle.join(",")})`);
    assert.ok(right[2] > right[0] * 2, `${id} uses the blue end stop (${right.join(",")})`);
    assert.ok(left[3] > right[3] + 15, `${id} retains different alpha at each stop`);
  }

  const radialTop = pixel(rgba, 220, 50, 55);
  const radialSide = pixel(rgba, 220, 10, 70);
  assert.ok(radialTop[0] > radialTop[2] * 1.3,
    `the non-square radial stroke is still mid-gradient at the top edge, using radius width/2 (${radialTop.join(",")})`);
  assert.ok(radialSide[2] > radialSide[0] * 2,
    `the stroke reaches the blue endpoint one width-radius from center (${radialSide.join(",")})`);
});

test("MP4 export animates gradient stop colors, alpha, and stroke width in decoded frames", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "kino-gradient-stroke-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const outputPath = join(outputDirectory, "gradient-stroke.mp4");
  const fromStroke = {
    type: "linear",
    angle: 0,
    stops: [
      { offset: 0, color: "#ff000000" },
      { offset: 1, color: "#ff000000" },
    ],
  };
  const toStroke = {
    type: "linear",
    angle: 0,
    stops: [
      { offset: 0, color: "#0000ffbf" },
      { offset: 1, color: "#0000ffbf" },
    ],
  };
  const animated = layer("animated-gradient-stroke", {
    x: 20, y: 20, width: 24, height: 24,
    stroke: fromStroke,
    strokeWidth: 0,
    strokeAlign: "center",
    animations: [{
      id: "gradient-stroke-growth",
      name: "Gradient stroke growth",
      kind: "custom",
      start: 0,
      duration: 1,
      easing: "linear",
      from: { stroke: fromStroke, strokeWidth: 0 },
      to: { stroke: toStroke, strokeWidth: 8 },
      unit: "layer",
      stagger: 0,
      order: "forward",
    }],
  });
  const result = await exportScene(scene([animated], {
    id: "animated-gradient-stroke",
    width: 64,
    height: 64,
    duration: 1,
    background: "#ffffff",
  }), { format: "mp4", width: 64, height: 64, fps: 4, duration: 1 });
  await writeFile(outputPath, result.buffer);

  const metadata = JSON.parse((await run(ffprobe, [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration",
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

  const decoded = await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", outputPath,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ]);
  const frameSize = 64 * 64 * 4;
  assert.equal(decoded.length, frameSize * 4, "the encoded video decodes to four full-size frames");
  const firstFrame = decoded.subarray(0, frameSize);
  const middleFrame = decoded.subarray(frameSize * 2, frameSize * 3);
  const lastFrame = decoded.subarray(frameSize * 3, frameSize * 4);
  const first = pixel(firstFrame, 64, 20, 32);
  const middle = pixel(middleFrame, 64, 20, 32);
  const last = pixel(lastFrame, 64, 20, 32);
  assert.ok(first[0] > 235 && first[1] > 235 && first[2] > 235, "zero-width, transparent gradient stroke leaves the first frame white");
  assert.ok(middle[0] < 235 && middle[2] < 235 && Math.abs(middle[0] - middle[2]) < 35,
    `midpoint has a visible interpolated gradient color (${middle.join(",")})`);
  assert.ok(last[2] > last[0] + 35 && last[2] < 245,
    `later frame shows the more opaque blue endpoint (${last.join(",")})`);

  const expandedWidth = pixel(lastFrame, 64, 17, 32);
  const beforeExpansion = pixel(middleFrame, 64, 17, 32);
  assert.ok(beforeExpansion[0] > 235 && beforeExpansion[1] > 235, "the half-width stroke has not reached the outer sample");
  assert.ok(expandedWidth[2] > expandedWidth[0] + 25, "the later, wider stroke reaches the outer sample with the animated gradient");
});
