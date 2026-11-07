// Test footage for the subject cut-out (backend/cutout), made in code so the tests know exactly
// where the subject is in every frame.
//
// The subject is a lit, textured ball (a striped sphere with soft light from the upper left, a
// highlight and a contact shadow on the floor) on a studio background: "plain" (a grey sweep) or
// "pattern" (a busy wallpaper of dots and stripes). For `still` seconds it rests; then it rolls
// to the right along a low arc. truthAt(frame) gives the ball's outline for that frame: {cx, cy, r}.
// The shadow is not part of the subject.
//
// look "red" draws a plain red disc on a navy background instead, for the stand-in helper
// (cutout.test.stand-in.mjs), which keys red; the real helper (Apple Vision) gets the ball.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Why the Apple Vision tests cannot run here (a string for test's skip option), or false.
 * The subject engine needs macOS 14 (Darwin 23); the helper is built with the Swift compiler.
 */
export const skipWithoutVision = skipWithoutMediaTools
  || (process.platform !== "darwin" && "Apple Vision cut-out test skipped: it needs macOS")
  || (Number(release().split(".")[0]) < 23 && "Apple Vision cut-out test skipped: the subject engine needs macOS 14 or later")
  || (spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status !== 0
    && "Apple Vision cut-out test skipped: the Swift compiler (Xcode command line tools) is not installed");

/** Builds kino-cutout from backend/cutout/kino-cutout.swift once per source version; returns its path. */
export async function visionHelper() {
  const source = join(ROOT, "backend", "cutout", "kino-cutout.swift");
  const hash = createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 16);
  const folder = join(tmpdir(), `kino-cutout-helper-${hash}`);
  const binary = join(folder, "kino-cutout");
  if (existsSync(binary)) return binary;
  await mkdir(folder, { recursive: true });
  const partial = `${binary}.${process.pid}`;
  const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`;
  await run("xcrun", ["swiftc", "-O", "-target", target, source, "-o", partial]);
  await chmod(partial, 0o755);
  await rename(partial, binary);
  return binary;
}

/**
 * A small program that runs the stand-in helper with this Node, for KINO_CUTOUT_HELPER. `env` sets
 * the stand-in's KINO_STAND_IN_* settings; each set of settings is its own program, because kino
 * asks a helper what it can do once per path. The program is kept in the temporary folder, named
 * by everything it holds: this Node, the settings, and the stand-in's path and contents. The path
 * matters: two checkouts with the same stand-in (a worktree and the main one) would otherwise
 * share one program that runs the first checkout's file, and fail once that checkout is deleted.
 */
export async function standInHelper(env = {}) {
  const script = join(ROOT, "backend", "cutout.test.stand-in.mjs");
  const settings = Object.entries(env).map(([name, value]) => `${name}=${JSON.stringify(String(value))} `).join("");
  const hash = createHash("sha256").update(process.execPath).update("\0").update(settings).update("\0").update(script).update("\0").update(await readFile(script)).digest("hex").slice(0, 16);
  const program = join(tmpdir(), `kino-cutout-stand-in-${hash}`);
  if (!existsSync(program)) {
    const partial = `${program}.${process.pid}`;
    await writeFile(partial, `#!/bin/sh\n${settings}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    await chmod(partial, 0o755);
    await rename(partial, program);
  }
  return program;
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function backgroundColor(kind, x, y, width, height) {
  const v = y / height;
  if (kind === "plain") {
    // A studio sweep: light grey at the top to a darker grey floor, with a soft vignette.
    const dx = (x / width - 0.5) * 1.4, dy = v - 0.45;
    const vignette = 1 - 0.18 * (dx * dx + dy * dy);
    const base = (0.78 - 0.22 * v) * vignette;
    return [base * 0.96, base * 0.98, base * 1.02];
  }
  // A wallpaper: teal and sand stripes with dots, and a floor of darker boards below 70%.
  if (v > 0.7) {
    const board = Math.floor((x + 0.5 * (y - height * 0.7)) / 48) % 2 === 0 ? 0.36 : 0.30;
    const grain = 0.03 * Math.sin(x * 0.21 + Math.sin(y * 0.05) * 4);
    return [board + grain + 0.06, board + grain + 0.02, board + grain - 0.04];
  }
  const stripe = Math.floor(x / 36) % 2 === 0;
  const cell = 28, px = (x % cell) - cell / 2, py = (y % cell) - cell / 2;
  const dot = px * px + py * py < 36;
  const base = stripe ? [0.33, 0.55, 0.56] : [0.80, 0.72, 0.55];
  return dot ? base.map((c) => c * 0.7) : base;
}

/**
 * Where the ball is in frame `index`: {cx, cy, r} in pixels. It rests for `still` seconds, then
 * rolls right across 60% of the width with a small hop.
 */
export function ballPath({ width, height, fps, still = 1, seconds = 3 }) {
  const r = Math.round(height * 0.2);
  const startX = width * 0.22, endX = width * 0.78;
  const floorY = height * 0.72;
  return (index) => {
    const t = index / fps;
    const moving = Math.max(0, Math.min(1, (t - still) / Math.max(0.001, seconds - still)));
    const eased = moving * moving * (3 - 2 * moving);
    return { cx: startX + (endX - startX) * eased, cy: floorY - r - Math.sin(Math.PI * moving) * height * 0.08, r,
      spin: eased * (endX - startX) / r };
  };
}

/** One frame of look "red" as RGB bytes: a red disc with an anti-aliased edge on navy. */
function redFrame({ width, height, where }) {
  const { cx, cy, r } = where;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const coverage = clamp01(r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      const back = [0.10, 0.15 + 0.1 * (y / height), 0.35];
      const disc = [0.9, 0.1, 0.1];
      const offset = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) pixels[offset + c] = Math.round(255 * (back[c] * (1 - coverage) + disc[c] * coverage));
    }
  return pixels;
}

/** One frame as RGB bytes, and the ball's outline. */
export function ballFrame({ width, height, background = "plain", where, look = "ball" }) {
  if (look === "red") return redFrame({ width, height, where });
  const { cx, cy, r, spin } = where;
  const pixels = Buffer.alloc(width * height * 3);
  const floorY = cy + r;
  // Light from the upper left, towards the viewer.
  const light = [-0.5, -0.6, 0.62];
  const norm = Math.hypot(...light);
  const L = light.map((c) => c / norm);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let [red, green, blue] = backgroundColor(background, x, y, width, height);
      // Contact shadow: a soft ellipse on the floor under the ball.
      const sx = (x - cx) / (r * 1.1), sy = (y - floorY) / (r * 0.22);
      const shadow = 0.55 * Math.exp(-(sx * sx + sy * sy) * 1.6);
      red *= 1 - shadow; green *= 1 - shadow; blue *= 1 - shadow;
      // The ball, with an anti-aliased edge (coverage from the distance to its outline).
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const distance = Math.hypot(dx, dy);
      const coverage = clamp01(r + 0.5 - distance);
      if (coverage > 0) {
        const nx = dx / r, ny = dy / r, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const diffuse = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
        // Reflection of the light for a highlight.
        const dot = nx * L[0] + ny * L[1] + nz * L[2];
        const rz = 2 * dot * nz - L[2];
        const specular = Math.pow(Math.max(0, rz), 24) * 0.6;
        // Stripes that turn as the ball rolls, and a fine speckle so it has texture.
        const angle = Math.atan2(ny, nx * Math.cos(spin) + nz * Math.sin(spin));
        const stripe = Math.sin(angle * 4 + spin) > 0;
        const speckle = 0.06 * Math.sin(x * 1.7 + y * 2.3) * Math.sin(x * 0.9 - y * 1.3);
        const albedo = stripe ? [0.92, 0.42, 0.12] : [0.96, 0.86, 0.62];
        const shade = 0.18 + 0.82 * diffuse;
        const ball = albedo.map((c) => clamp01(c * shade + specular + speckle));
        red = red * (1 - coverage) + ball[0] * coverage;
        green = green * (1 - coverage) + ball[1] * coverage;
        blue = blue * (1 - coverage) + ball[2] * coverage;
      }
      const offset = (y * width + x) * 3;
      pixels[offset] = Math.round(clamp01(red) * 255);
      pixels[offset + 1] = Math.round(clamp01(green) * 255);
      pixels[offset + 2] = Math.round(clamp01(blue) * 255);
    }
  }
  return pixels;
}

/**
 * Adds camera-like grain to RGB bytes: each pixel gets its own random brightness change (sd
 * `amount` levels out of 255), new in every frame, from a seeded generator so a clip is always the
 * same. Grain is what makes a matte found frame by frame flicker on real footage.
 */
export function addNoise(pixels, amount, seed) {
  let state = (seed * 2654435761) >>> 0 || 1;
  const random = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  for (let i = 0; i < pixels.length; i += 3) {
    // Sum of three uniforms: close enough to a bell curve, sd 1 after scaling.
    const grain = (random() + random() + random() - 1.5) * 2 * amount;
    for (let c = 0; c < 3; c += 1) pixels[i + c] = Math.max(0, Math.min(255, Math.round(pixels[i + c] + grain)));
  }
}

/** The ball's outline as a matte: 1 inside, 0 outside (pixel centres). */
export function ballTruth({ width, height, where }) {
  const truth = new Uint8Array(width * height);
  const { cx, cy, r } = where;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      truth[y * width + x] = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r ? 1 : 0;
  return truth;
}

/**
 * Writes the ball clip as an H.264 MP4 (or a still when `seconds` is 0: PNG, or JPEG when the path
 * ends in .jpg) and returns {path, width, height, fps, frames, truthAt(index)}. look "red" draws the
 * stand-in helper's red disc.
 */
export async function makeBallClip(path, { width = 640, height = 360, fps = 30, seconds = 3, still = 1, background = "plain", noise = 0, look = "ball" } = {}) {
  const frames = Math.max(1, Math.round(seconds * fps));
  const at = ballPath({ width, height, fps, still, seconds: seconds || 3 });
  const image = seconds === 0;
  const args = ["-hide_banner", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`,
    "-r", String(fps), "-i", "pipe:0",
    ...(image ? ["-frames:v", "1", ...(path.endsWith(".jpg") ? ["-q:v", "2"] : []), path]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path])];
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr}`))));
  });
  for (let index = 0; index < frames; index += 1) {
    const chunk = ballFrame({ width, height, background, where: at(index), look });
    if (noise > 0) addNoise(chunk, noise, index + 1);
    if (!child.stdin.write(chunk)) await new Promise((resolve) => child.stdin.once("drain", resolve));
  }
  child.stdin.end();
  await closed;
  return { path, width, height, fps, frames, truthAt: (index) => ballTruth({ width, height, where: at(index) }), where: at };
}

/**
 * A JPEG's bytes with an EXIF orientation tag added (6: the picture is shown turned a quarter
 * clockwise, as a phone held upright writes it).
 */
export function withOrientation(jpeg, orientation) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  // TIFF header (little-endian), one IFD entry: tag 0x0112, type SHORT, count 1, the value.
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, body, jpeg.subarray(2)]);
}
