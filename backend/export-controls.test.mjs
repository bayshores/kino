import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportScene } from "./export.mjs";

const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

function layer(id, values = {}) {
  return {
    id,
    name: id,
    type: "rectangle",
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
    radius: 0,
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
  };
}

function scene({ width = 32, height = 24, duration = 1, background = "transparent", layers = [] } = {}) {
  return { id: "export-controls", name: "Export controls", width, height, duration, background, layers };
}

function movingScene() {
  return scene({
    duration: 0.4,
    background: "#17202b",
    layers: [layer("moving", {
      x: 2,
      y: 6,
      width: 6,
      height: 8,
      fill: "#ff0000",
      animations: [{
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
      }],
    })],
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} failed (${code ?? signal}): ${stderr.trim()}`));
    });
  });
}

async function probe(path) {
  const result = await run(ffprobe, [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,nb_read_frames,avg_frame_rate:stream_tags=alpha_mode",
    "-of", "json", path,
  ]);
  return JSON.parse(result.toString("utf8")).streams[0];
}

async function decodeRgba(path, { codec, frames, passthrough = true } = {}) {
  const args = ["-v", "error"];
  if (codec) args.push("-c:v", codec);
  args.push("-i", path);
  if (passthrough) args.push("-fps_mode", "passthrough");
  if (frames != null) args.push("-frames:v", String(frames));
  args.push("-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1");
  return run(ffmpeg, args);
}

function leftmostRedPerFrame(rgba, width, height) {
  const frameBytes = width * height * 4;
  assert.equal(rgba.length % frameBytes, 0, "decoded output contains complete frames");
  const result = [];
  for (let offset = 0; offset < rgba.length; offset += frameBytes) {
    let left = width;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = offset + (y * width + x) * 4;
        if (rgba[pixel] > 220 && rgba[pixel + 1] < 35 && rgba[pixel + 2] < 35) left = Math.min(left, x);
      }
    }
    assert.ok(left < width, "each decoded frame contains the moving red rectangle");
    result.push(left);
  }
  return result;
}

function pngChunks(buffer) {
  const chunks = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) break;
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset = end;
  }
  return chunks;
}

function gifLogicalSize(buffer) {
  assert.match(buffer.toString("ascii", 0, 6), /^GIF8[79]a$/);
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

async function writeResult(directory, name, result) {
  const path = join(directory, name);
  await writeFile(path, result.buffer);
  return path;
}

test("GIF samples include the animation endpoint and boomerang playback reverses real decoded frames", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-export-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const normal = await exportScene(movingScene(), { format: "gif", fps: 5, width: 32, height: 24 });
  const normalPath = await writeResult(directory, "normal.gif", normal);
  const normalFrames = leftmostRedPerFrame(await decodeRgba(normalPath), 32, 24);
  assert.equal(normalFrames.length, 3, "0, 0.2, and the inclusive 0.4-second endpoint are encoded");
  assert.ok(normalFrames[0] < normalFrames[1] && normalFrames[1] < normalFrames[2]);

  const boomerang = await exportScene(movingScene(), {
    format: "gif", fps: 5, width: 32, height: 24, playbackDirection: "boomerang",
  });
  const boomerangPath = await writeResult(directory, "boomerang.gif", boomerang);
  const boomerangFrames = leftmostRedPerFrame(await decodeRgba(boomerangPath), 32, 24);
  assert.equal(boomerangFrames.length, 5);
  assert.ok(boomerangFrames[0] < boomerangFrames[1] && boomerangFrames[1] < boomerangFrames[2]);
  assert.ok(boomerangFrames[2] > boomerangFrames[3] && boomerangFrames[3] > boomerangFrames[4]);
  assert.equal(boomerangFrames[0], boomerangFrames[4], "the return reaches the starting frame");
});

test("GIF loop settings encode or omit the Netscape loop extension", async (t) => {
  const value = scene({ duration: 0.2, layers: [layer("still", { x: 2, y: 2, width: 12, height: 8 })] });
  const looping = await exportScene(value, { format: "gif", fps: 5, width: 32, height: 24, loop: true });
  const once = await exportScene(value, { format: "gif", fps: 5, width: 32, height: 24, loop: false });
  assert.equal(looping.buffer.includes(Buffer.from("NETSCAPE2.0")), true);
  assert.equal(once.buffer.includes(Buffer.from("NETSCAPE2.0")), false);
});

test("GIF quality changes a procedural gradient-and-noise render, and output dimensions follow presets", async (t) => {
  const width = 64;
  const height = 48;
  const gradient = layer("gradient", {
    width,
    height,
    fill: {
      type: "linear",
      angle: 0,
      stops: [
        { offset: 0, color: "#130c80" },
        { offset: 0.25, color: "#00c5d4" },
        { offset: 0.5, color: "#e2ed32" },
        { offset: 0.75, color: "#fb4f36" },
        { offset: 1, color: "#511364" },
      ],
    },
  });
  let seed = 0x5a17;
  const noise = [];
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const color = `#${(seed & 0xffffff).toString(16).padStart(6, "0")}`;
      noise.push(layer(`grain-${x}-${y}`, { x, y, width: 4, height: 4, fill: color, opacity: 0.42 }));
    }
  }
  const richScene = scene({ width, height, duration: 0.2, background: "#202020", layers: [gradient, ...noise] });
  const low = await exportScene(richScene, { format: "gif", fps: 5, width, height, quality: 10 });
  const high = await exportScene(richScene, { format: "gif", fps: 5, width, height, quality: 95 });
  assert.notDeepEqual(low.buffer, high.buffer, "the selected Gifski quality affects encoded output");

  const odd = await exportScene(scene({ width: 31, height: 21, duration: 0.2, layers: [layer("pixel", { width: 31, height: 21 })] }), {
    format: "gif", profile: "gif", size: "1x", fps: 5,
  });
  assert.deepEqual(gifLogicalSize(odd.buffer), { width: 31, height: 21 });
});

test("APNG stores real endpoint frames and the selected playback count", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-export-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [loop, plays] of [[true, 0], [false, 1]]) {
    const result = await exportScene(movingScene(), { format: "apng", fps: 5, width: 32, height: 24, loop });
    const chunks = pngChunks(result.buffer);
    const animation = chunks.find(({ type }) => type === "acTL");
    assert.ok(animation, "the APNG animation control chunk is present");
    assert.equal(animation.data.readUInt32BE(0), 3);
    assert.equal(animation.data.readUInt32BE(4), plays);
    assert.equal(chunks.filter(({ type }) => type === "fcTL").length, 3);
    const path = await writeResult(directory, `loop-${loop}.apng`, result);
    const decoded = await decodeRgba(path);
    assert.equal(decoded.length, 3 * 32 * 24 * 4, "FFmpeg decodes all three rendered frames");
  }
});

test("MP4 exports real 120 fps frames and the 480p preset dimensions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-export-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await exportScene(scene({ duration: 0.1, background: "#315577", layers: [layer("detail")] }), {
    format: "mp4", profile: "mp4", fps: 120, width: 32, height: 24,
  });
  const path = await writeResult(directory, "120fps.mp4", result);
  const video = await probe(path);
  assert.equal(video.codec_name, "h264");
  assert.equal(Number(video.nb_read_frames), 12);
  assert.equal(video.avg_frame_rate, "120/1");

  const preset = await exportScene(scene({ width: 640, height: 360, duration: 1 / 15 }), {
    format: "mp4", profile: "mp4", size: "480p", fps: 15,
  });
  const presetPath = await writeResult(directory, "480p.mp4", preset);
  const dimensions = await probe(presetPath);
  assert.deepEqual([Number(dimensions.width), Number(dimensions.height)], [852, 480]);
});

test("transparent WebM and ProRes outputs preserve alpha in decoded pixels", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kino-export-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = scene({
    duration: 0.5,
    layers: [layer("opaque-shape", { x: 8, y: 6, width: 16, height: 12, fill: "#ff0000" })],
  });
  for (const [profile, extension, decoder] of [
    ["webm-transparent", "webm", "libvpx-vp9"],
    ["mov-transparent", "mov", undefined],
  ]) {
    const result = await exportScene(value, { profile, fps: 2, width: 32, height: 24 });
    const path = await writeResult(directory, `alpha.${extension}`, result);
    if (profile === "webm-transparent") assert.equal((await probe(path)).tags?.alpha_mode, "1");
    const rgba = await decodeRgba(path, { codec: decoder, frames: 1, passthrough: false });
    assert.deepEqual([...rgba.subarray((1 * 32 + 1) * 4 + 3, (1 * 32 + 1) * 4 + 4)], [0], `${profile} leaves the background transparent`);
    assert.equal(rgba[(10 * 32 + 12) * 4 + 3], 255, `${profile} keeps the shape opaque`);
  }
});

test("a transparent WebM can be imported and rasterized with its alpha intact", async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-webm-roundtrip-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const source = await exportScene(scene({
    duration: 1,
    layers: [layer("source-shape", { x: 8, y: 6, width: 16, height: 12, fill: "#ff0000" })],
  }), { profile: "webm-transparent", fps: 2, width: 32, height: 24 });
  await writeFile(join(mediaRoot, "source.webm"), source.buffer);
  // Some muxers write the tag as ALPHA_MODE: the same file with the tag renamed.
  await run(ffmpeg, ["-v", "error", "-i", join(mediaRoot, "source.webm"), "-c", "copy",
    "-metadata:s:v:0", "alpha_mode=", "-metadata:s:v:0", "ALPHA_MODE=1", join(mediaRoot, "upper.webm")]);
  for (const file of ["source.webm", "upper.webm"]) {
    const video = layer("webm-layer", {
      type: "video",
      x: 0,
      y: 0,
      width: 32,
      height: 24,
      src: `/api/media/${file}`,
      mediaDuration: 1,
    });
    const raster = await exportScene(scene({ width: 32, height: 24, duration: 1, layers: [video] }), {
      format: "png", width: 32, height: 24, time: 0,
    }, { mediaRoot });
    const png = raster.buffer;
    const directory = await mkdtemp(join(tmpdir(), "kino-webm-roundtrip-output-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = await writeResult(directory, `${file}.png`, raster);
    const rgba = await run(ffmpeg, ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    assert.equal(rgba[(1 * 32 + 1) * 4 + 3], 0, `${file}: transparent pixels survive demux, decode, and rasterization`);
    assert.equal(rgba[(10 * 32 + 12) * 4 + 3], 255, `${file}: opaque pixels survive the same round trip`);
    assert.equal(png.readUInt32BE(16), 32);
  }
});

test("a video whose address carries a share code exports from the same uploaded file", async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "kino-shared-video-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const source = await exportScene(scene({
    duration: 1,
    layers: [layer("source-shape", { x: 0, y: 0, width: 32, height: 24, fill: "#00ff00" })],
  }), { format: "mp4", fps: 2, width: 32, height: 24 });
  const fileName = "11111111-1111-4111-8111-111111111111.mp4";
  await writeFile(join(mediaRoot, fileName), source.buffer);
  const video = layer("shared-video", {
    type: "video", x: 0, y: 0, width: 32, height: 24,
    src: `/api/media/${fileName}?share=file-capability`, mediaDuration: 1,
  });
  const raster = await exportScene(scene({ width: 32, height: 24, duration: 1, layers: [video] }), {
    format: "png", width: 32, height: 24, time: 0,
  }, { mediaRoot });
  const directory = await mkdtemp(join(tmpdir(), "kino-shared-video-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = await writeResult(directory, "shared.png", raster);
  const rgba = await run(ffmpeg, ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  const center = (12 * 32 + 16) * 4;
  assert.ok(rgba[center + 1] > 200 && rgba[center] < 60, "the video's green frame is drawn");
  const frame = layer("frame-as-video", {
    type: "video", width: 32, height: 24, src: "/api/media/11111111-1111-4111-8111-111111111111.gif/frames/0.png",
  });
  await assert.rejects(exportScene(scene({ width: 32, height: 24, duration: 1, layers: [frame] }), {
    format: "png", width: 32, height: 24, time: 0,
  }, { mediaRoot }), /GIF frame instead of a video/);
});

test("cancelling during rendering rejects and removes the private export work directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kino-cancel-parent-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  const controller = new AbortController();
  try {
    await assert.rejects(exportScene(movingScene(), { format: "mp4", fps: 5, width: 32, height: 24 }, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.stage === "render" && progress.completed === 1) controller.abort();
      },
    }), (error) => error.name === "AbortError");
    assert.deepEqual(await readdir(parent), [], "the per-export temporary directory is removed on cancellation");
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(parent, { recursive: true, force: true });
  }
});
