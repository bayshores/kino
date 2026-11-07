// Media files for the golden-frame fixtures that play footage (clip speed, reverse). They are
// made fresh on every run, exactly the same each time, in a temporary folder that is removed
// when the process ends, so no video is committed and nothing depends on the machine's files.
//
// golden.mp4: 320 × 90, 30 frames a second, 2 s. Frame N has its own background colour and a
// white bar whose left edge is at x = 10 + 5N, so a frame shows which file frame was drawn.
// golden.gif: 320 × 90, 10 frames of 0.1 s. Frame N is one colour with a black bar at x = 8 + 30N.
// golden-subject.webm: golden.mp4 with only its white bar opaque, for the cut-out fixture.
// The video is lossless (H.264 at qp 0, 4:4:4), and both are drawn at their own size, so a
// golden frame only changes when a different file frame is chosen.
// GOLDEN_LUT: a 9-point 3D .cube for the colour grading fixture. It makes shadows teal and
// highlights warm and mixes the channels, so the lut effect takes its 3D path. Its name is a
// hex ID because the lut effect accepts only the src of an imported file (/api/media/<id>.cube).
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpeg, makeAnimatedGif, makeVideo, run } from "../../backend/media.test.support.mjs";
import { cubeText } from "../../engine/effects/colorMath.js";

export { hasMediaTools } from "../../backend/media.test.support.mjs";

export const GOLDEN_MEDIA = Object.freeze({ width: 320, height: 90, fps: 30, frames: 60, gifFrames: 10 });

/** The src the colour grading fixture's lut effect names; the file is made in goldenMediaRoot. */
export const GOLDEN_LUT = "/api/media/00000000-0000-4000-8000-00000000c0be.cube";
const GOLDEN_LUT_FILE = GOLDEN_LUT.slice("/api/media/".length);
function goldenLutText() {
  return cubeText({ size: 9, title: "Golden teal and orange", color: (r, g, b) => {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return [r * 0.8 + 0.2 * y, g * 0.9 + 0.04 * (1 - y), b * 0.75 + 0.12 * (1 - y)].map((value) => Math.min(1, Math.max(0, value)));
  } });
}

/** The left edge of the white bar in video frame `frame`. */
export const videoBarAt = (frame) => 10 + 5 * frame;
/** The left edge of the black bar in GIF frame `frame`. */
export const gifBarAt = (frame) => 8 + 30 * frame;

function videoFrame(frame) {
  const { width, height } = GOLDEN_MEDIA;
  const pixels = Buffer.alloc(width * height * 3);
  const background = [30 + 3 * frame, 60, 200 - 2 * frame];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const bar = x >= videoBarAt(frame) && x < videoBarAt(frame) + 6;
      pixels.set(bar ? [255, 255, 255] : background, (y * width + x) * 3);
    }
  return pixels;
}

function gifFrame(frame) {
  const { width, height } = GOLDEN_MEDIA;
  const background = [240 - 20 * frame, 120 + 10 * frame, 40 + 15 * frame];
  const pixels = [];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) pixels.push(x >= gifBarAt(frame) && x < gifBarAt(frame) + 10 ? [0, 0, 0] : background);
  return { pixels, delayCs: 10, transparent: false };
}

// golden-subject.webm: golden.mp4 as cut_out's output "subject" would be if the white bar were
// the subject: the same pictures, transparent except the bar (VP9 with alpha, lossless).
async function makeSubjectVideo(file) {
  const { width, height, fps, frames } = GOLDEN_MEDIA;
  const raw = Buffer.alloc(width * height * 4 * frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const rgb = videoFrame(frame);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const x = pixel % width, at = (frame * width * height + pixel) * 4;
      raw.set(rgb.subarray(pixel * 3, pixel * 3 + 3), at);
      raw[at + 3] = x >= videoBarAt(frame) && x < videoBarAt(frame) + 6 ? 255 : 0;
    }
  }
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps),
    "-i", "pipe:0", "-c:v", "libvpx-vp9", "-lossless", "1", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", file], { input: raw });
}

let made = null;
/** The folder holding golden.mp4, golden.gif, golden-subject.webm and the GOLDEN_LUT .cube (made once per process); its path is the export's mediaRoot. */
export function goldenMediaRoot() {
  made ??= (async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "kino-golden-media-"));
    process.once("exit", () => rmSync(folder, { recursive: true, force: true }));
    await writeFile(path.join(folder, GOLDEN_LUT_FILE), goldenLutText());
    const { width, height, fps, frames, gifFrames } = GOLDEN_MEDIA;
    await makeVideo(path.join(folder, "golden.mp4"), { width, height, fps, frames, framePixels: videoFrame });
    await writeFile(path.join(folder, "golden.gif"), makeAnimatedGif({ width, height, frames: Array.from({ length: gifFrames }, (_, frame) => gifFrame(frame)) }));
    await makeSubjectVideo(path.join(folder, "golden-subject.webm"));
    return folder;
  })();
  return made;
}
