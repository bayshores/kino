// Test helpers that build small, exactly known media files in temporary folders,
// so media tests never depend on committed binary fixtures, and that run the real
// server against a temporary data folder.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";
export const ffprobe = process.env.KINO_FFPROBE ?? process.env.OPEN_MOTION_FFPROBE ?? "ffprobe";

function available(command) {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0;
}

export const hasMediaTools = available(ffmpeg) && available(ffprobe);
export const skipWithoutMediaTools = hasMediaTools ? false : "FFmpeg and ffprobe are required for media tests";

/**
 * An agent answer's text without its last line, the next call (`next: look {...}`), for tests
 * of what comes before it. backend/agent-next-call.test.mjs tests the next calls themselves.
 */
export const withoutNext = (text) => String(text ?? "").replace(/\nnext: [^\n]*$/, "");
/** The next call an answer ends with, as {tool, input}, or null. */
export function nextCallOf(reply) {
  const text = String(reply?.text ?? "");
  let line = null;
  if (/^\s*\{/.test(text)) { try { line = JSON.parse(text).next ?? null; } catch { line = null; } }
  else line = /\nnext: ([^\n]*)$/.exec(text)?.[1] ?? null;
  if (!line) return null;
  const space = line.indexOf(" ");
  return { tool: line.slice(0, space), input: JSON.parse(line.slice(space + 1)) };
}

/** Runs a command; resolves with stdout as a Buffer and rejects with stderr on failure. */
export function run(command, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], shell: false });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`));
    });
    if (input) child.stdin.end(input);
  });
}

const TRANSPARENT = 255;

/**
 * Builds an animated GIF89a file byte by byte.
 * frames: [{ delayCs, color: [r, g, b] | null }] where null is a fully transparent frame,
 *   or [{ delayCs, pixels: [[r, g, b] | null, ...] }] with one entry per pixel, row by row.
 * By default every frame covers the whole canvas, uses disposal 2 (clear to transparent before the
 * next one), and treats null pixels as transparent. A frame may instead set
 *   rect: { left, top, width, height }  to cover only part of the canvas (pixels then fill that rectangle),
 *   disposal: 0-3                       to choose how it is removed before the next frame,
 *   transparent: false                  to turn off its transparent color (null pixels then show palette color 255, black).
 */
export function makeAnimatedGif({ width, height, frames, loop = 0 }) {
  const palette = Buffer.alloc(256 * 3);
  const colorIndex = new Map();
  const indexFor = (color) => {
    if (!color) return TRANSPARENT;
    const key = color.join(",");
    if (!colorIndex.has(key)) {
      if (colorIndex.size >= TRANSPARENT) throw new Error("A test GIF can use at most 255 colors.");
      palette.set(color, colorIndex.size * 3);
      colorIndex.set(key, colorIndex.size);
    }
    return colorIndex.get(key);
  };
  const rectOf = (frame) => frame.rect ?? { left: 0, top: 0, width, height };
  const frameIndices = frames.map((frame) => frame.pixels
    ? frame.pixels.map(indexFor)
    : new Array(rectOf(frame).width * rectOf(frame).height).fill(indexFor(frame.color)));
  const u16 = (value) => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16LE(value);
    return bytes;
  };
  const parts = [Buffer.from("GIF89a"), u16(width), u16(height), Buffer.from([0xf7, TRANSPARENT, 0]), palette];
  if (loop !== null) parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0"), Buffer.from([3, 1]), u16(loop), Buffer.from([0]));
  for (const [index, frame] of frames.entries()) {
    // Graphic control extension: disposal, transparency flag, delay in hundredths of a second.
    const flags = ((frame.disposal ?? 2) << 2) | (frame.transparent === false ? 0 : 1);
    parts.push(Buffer.from([0x21, 0xf9, 4, flags]), u16(frame.delayCs), Buffer.from([TRANSPARENT, 0]));
    const rect = rectOf(frame);
    parts.push(Buffer.from([0x2c]), u16(rect.left), u16(rect.top), u16(rect.width), u16(rect.height), Buffer.from([0]));
    parts.push(Buffer.from([8]), subBlocks(uncompressedLzw(frameIndices[index])), Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// LZW data without compression: a clear code every 254 pixels keeps every code 9 bits wide.
function uncompressedLzw(indices) {
  const CLEAR = 256;
  const END = 257;
  const bytes = [];
  let bits = 0;
  let count = 0;
  const write = (code) => {
    bits |= code << count;
    count += 9;
    while (count >= 8) {
      bytes.push(bits & 0xff);
      bits >>>= 8;
      count -= 8;
    }
  };
  for (let index = 0; index < indices.length; index += 1) {
    if (index % 254 === 0) write(CLEAR);
    write(indices[index]);
  }
  write(END);
  if (count > 0) bytes.push(bits & 0xff);
  return Buffer.from(bytes);
}

function subBlocks(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.subarray(offset, offset + 255);
    blocks.push(Buffer.from([chunk.length]), chunk);
  }
  return Buffer.concat(blocks);
}

/**
 * Writes a video whose frame N is filled with frameColor(N) ([r, g, b]), or is the picture
 * framePixels(N) (RGB bytes, row by row). Frames are encoded nearly losslessly so colors survive
 * within a few levels.
 */
// `bt709` tags the file BT.709, as phone and camera footage is.
export async function makeVideo(path, { width = 32, height = 24, fps, frames, frameColor, framePixels, format = "mp4", bt709 = false }) {
  const raw = Buffer.alloc(width * height * 3 * frames);
  for (let frame = 0; frame < frames; frame += 1) {
    // framePixels(frame) gives a whole picture (RGB, row by row); frameColor(frame) one colour.
    if (framePixels) {
      raw.set(framePixels(frame), frame * width * height * 3);
      continue;
    }
    const color = frameColor(frame);
    for (let pixel = 0; pixel < width * height; pixel += 1) raw.set(color, (frame * width * height + pixel) * 3);
  }
  const codec = format === "webm"
    ? ["-c:v", "libvpx-vp9", "-lossless", "1", "-pix_fmt", "yuv444p"]
    : ["-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", "-bf", "2", "-g", "300"];
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
    ...(bt709 ? ["-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"] : []), ...codec, path,
  ], { input: raw });
  return path;
}

/** Writes a mono WAV file: silence for `silence` seconds, then a 440 Hz tone for `tone` seconds. */
export async function makeToneAfterSilence(path, { silence, tone, rate = 48000 }) {
  const samples = Math.round((silence + tone) * rate);
  const data = Buffer.alloc(samples * 2);
  for (let index = Math.round(silence * rate); index < samples; index += 1)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 16000), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
  return path;
}

/** Decodes a PNG (or any image @napi-rs/canvas reads) and returns a pixel reader. */
export async function readImage(buffer) {
  const bitmap = await loadImage(buffer);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return {
    width: bitmap.width,
    height: bitmap.height,
    pixel(x, y) {
      const offset = (y * bitmap.width + x) * 4;
      return [...data.subarray(offset, offset + 4)];
    },
  };
}

/** Decodes every frame of a video into RGBA and returns one pixel reader per frame. */
export async function readVideoFrames(path, { width, height }) {
  const raw = await run(ffmpeg, ["-v", "error", "-i", path, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  const size = width * height * 4;
  const frames = [];
  for (let offset = 0; offset + size <= raw.length; offset += size) {
    const frame = raw.subarray(offset, offset + size);
    frames.push({ pixel: (x, y) => [...frame.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] });
  }
  return frames;
}

/** True when two RGBA colors differ by at most `tolerance` in every channel. */
export function near(actual, expected, tolerance = 8) {
  return expected.every((value, index) => Math.abs(actual[index] - value) <= tolerance);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/**
 * Starts backend/index.mjs on a free port with a new temporary data folder (never the user's data).
 * Requests made with api() send the owner key unless { owner: false } is passed.
 * Call stop() when done; it stops the server and deletes the data folder.
 */
// `allow` lists approval kinds (plan D3, such as "delete-scene") the person allows without
// asking, for tests about something else.
export async function startTestServer({ ownerToken = "kino-test-owner", allow = [], env: extraEnv = {} } = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-test-server-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.KINO_PUBLIC_URL;
  delete env.KINO_SHARE_TOKEN;
  Object.assign(env, {
    MOTION_DATA_DIR: dataDirectory,
    MOTION_HOST: "127.0.0.1",
    MOTION_API_PORT: String(port),
    KINO_OWNER_TOKEN: ownerToken,
    // A test never starts the real claude or codex (AGENTS.md): kino's crew looks for them here,
    // where nothing is, unless a test passes its own stub programs.
    KINO_CLAUDE: path.join(dataDirectory, "no-claude"),
    KINO_CODEX: path.join(dataDirectory, "no-codex"),
    // Nor the real whisper model (check's speech_cut transcribes heard sound): a test that needs
    // transcripts passes tests/fake-whisper-cli.mjs.
    KINO_WHISPER_MODEL: path.join(dataDirectory, "no-whisper-model.bin"),
    // Nor the 600 MB CLAP song model (backend/music-embed.mjs): songs rank by the old features.
    KINO_MUSIC_DOWNLOAD: "0",
    // No yt-dlp here: the sound stop does not push a YouTube song search.
    KINO_SONG_SEARCH: "0",
    // Nor the origin search of a brief's about line: it would reach YouTube from a test.
    KINO_YTDLP: path.join(dataDirectory, "no-yt-dlp"),
    KINO_LOOK_DOWNLOAD: "0",
    // It stops when this test process dies (backend/index.mjs), even one killed mid-run.
    KINO_EXIT_WITH_PARENT: "1",
  }, extraEnv);
  let output = "";
  const child = spawn(process.execPath, ["backend/index.mjs"], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      // unref: a pending timer keeps the test process alive, so without it every file waited
      // the whole 4 s after its server had already stopped.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000).unref())]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(dataDirectory, { recursive: true, force: true });
  }
  // Generous, because a full parallel test run can keep the machine busy for a while.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`The server exited during startup. ${output}`);
    }
    if (await fetch(`${baseUrl}/api/health`).then((response) => response.ok, () => false)) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The server did not start. ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  function api(endpoint, { owner = true, share, headers: extra, body, ...options } = {}) {
    const headers = new Headers(extra);
    if (owner) headers.set("X-Kino-Owner", ownerToken);
    if (share) headers.set("X-Kino-Share", share);
    let requestBody = body;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }
    return fetch(`${baseUrl}${endpoint}`, { ...options, headers, body: requestBody });
  }
  if (allow.length) {
    // The dashboard page's review key changes settings (dashboard-routes.mjs).
    const keyed = await api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: baseUrl } });
    const { key } = await keyed.json();
    const saved = await api("/api/dashboard/settings", { method: "PUT", headers: { "x-kino-review": key },
      body: { approvals: Object.fromEntries(allow.map((kind) => [kind, "allow"])) } });
    if (!saved.ok) { await stop(); throw new Error(`Approval settings were refused: ${await saved.text()}`); }
  }
  return { baseUrl, dataDirectory, ownerToken, api, stop, output: () => output };
}
