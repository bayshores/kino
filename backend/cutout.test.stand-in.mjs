// A stand-in for the kino-cutout helper, for tests only. It speaks the helper's protocol
// (backend/cutout/kino-cutout.swift: --engines, --version, BGRA pictures in, one-byte mattes out)
// but finds "the subject" with a colour key instead of Apple Vision: the subject is whatever is
// red. Tests set KINO_CUTOUT_HELPER to it so the whole cut_out path (decoding, steadying, outputs,
// the media library, the agent op and the render) runs on Linux CI, where Vision does not exist.
// It never ships: the Mac app bundles kino-cutout, and without KINO_CUTOUT_HELPER on Linux kino
// refuses with the reason.
//
// Matte = how much redder a pixel is than its green and blue, so an anti-aliased edge gives an
// in-between value like a real matte does. Environment for tests:
//   KINO_STAND_IN_MACOS    the version --engines reports (default "15.0"); below 14 the subject
//                          engine is reported missing, as on a real Mac
//   KINO_STAND_IN_FAIL     exit with this message after the first picture
//   KINO_STAND_IN_FAIL_AFTER  ...or after this many pictures (a --track run: the backward pass is the long one)
//   KINO_STAND_IN_DELAY_MS wait this long before each matte (to test waiting and cancelling)
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args[0] === "--version") {
  console.log("kino-cutout stand-in 1");
  process.exit(0);
}
if (args[0] === "--engines") {
  const macOS = process.env.KINO_STAND_IN_MACOS ?? "15.0";
  const major = Number(macOS.split(".")[0]);
  console.log(JSON.stringify({ version: "stand-in 1", macOS, subject: major >= 14, person: major >= 12 }));
  process.exit(0);
}

// --stabilize: motion says the camera panned 2 px a frame with a 3 px shake every other frame (a 6 px jerk);
// render copies the file (FFmpeg) so the op, the library and the receipt can be tested off macOS.
if (args[0] === "--stabilize") {
  const { execFileSync } = await import("node:child_process");
  const { ffmpegCommand, ffprobeCommand } = await import("./media-probe.mjs");
  const input = option("--input");
  if (args[1] === "motion") {
    const frames = Number(execFileSync(ffprobeCommand(), ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", input], { encoding: "utf8" }).trim());
    const steady = input.includes("stabilized");
    for (let i = 0; i < frames; i += 1) console.log(i === 0 ? "m 0 0 0 1" : `m ${2 + (steady ? 0 : i % 2 ? 3 : -3)} 0 0 1`);
  } else {
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-i", input, "-c", "copy", option("--output")]);
    console.log('{"frames":0}');
  }
  process.exit(0);
}

const width = Number(option("--width")), height = Number(option("--height"));
// --track: the box around what is red in each picture, at confidence 1 (0 when nothing is red).
const tracking = args.includes("--track");
let lastBox = (option("--box") ?? "0,0,1,1").split(",").map(Number);
function trackLine(bgra) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0, p = 0; y < height; y += 1) for (let x = 0; x < width; x += 1, p += 4)
    if (bgra[p + 2] - Math.max(bgra[p], bgra[p + 1]) > 80) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  if (right < 0) return `${JSON.stringify({ x: lastBox[0], y: lastBox[1], w: lastBox[2], h: lastBox[3], c: 0 })}\n`;
  lastBox = [left / width, top / height, (right + 1 - left) / width, (bottom + 1 - top) / height];
  return `${JSON.stringify({ x: lastBox[0], y: lastBox[1], w: lastBox[2], h: lastBox[3], c: 1 })}\n`;
}
if (!(width > 0 && height > 0)) {
  process.stderr.write("kino-cutout: usage: kino-cutout --width <w> --height <h> --engine subject|person\n");
  process.exit(2);
}
const size = width * height * 4;
const delay = Number(process.env.KINO_STAND_IN_DELAY_MS) || 0;
let pending = Buffer.alloc(0);
let pictures = 0;
let queue = Promise.resolve();

function matteOf(bgra) {
  const matte = Buffer.alloc(width * height);
  for (let i = 0, p = 0; i < matte.length; i += 1, p += 4) {
    const blue = bgra[p], green = bgra[p + 1], red = bgra[p + 2];
    matte[i] = Math.max(0, Math.min(255, Math.round(((red - Math.max(green, blue)) * 255) / 160)));
  }
  return matte;
}

process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= size) {
    const picture = pending.subarray(0, size);
    pending = pending.subarray(size);
    queue = queue.then(async () => {
      if (delay) await sleep(delay);
      if (process.env.KINO_STAND_IN_FAIL && pictures >= (Number(process.env.KINO_STAND_IN_FAIL_AFTER) || 1)) {
        process.stderr.write(`kino-cutout: ${process.env.KINO_STAND_IN_FAIL}\n`);
        process.exit(3);
      }
      pictures += 1;
      if (!process.stdout.write(tracking ? trackLine(picture) : matteOf(picture))) await new Promise((resolve) => process.stdout.once("drain", resolve));
    });
  }
});
process.stdin.on("end", () => {
  queue.then(() => {
    if (pending.length) {
      process.stderr.write(`kino-cutout: the last picture was ${pending.length} bytes, not ${size}\n`);
      process.exit(4);
    }
  });
});
