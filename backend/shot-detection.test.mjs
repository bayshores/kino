// Tests shot detection (shot-detection.mjs, plan fix 12): the flash, sliver and end rules; real
// FFmpeg runs on clips made here and on the Sintel test clip; the shots in the import answer and
// in `kino project import`; the refusal of an FFmpeg without scdet or signalstats; and shots found
// later for videos imported before kino found them on upload.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentClient, importedText } from "./agent/client.mjs";
import { probeMedia } from "./media-probe.mjs";
import { FLASH_FRAMES, MAX_VIDEO_SECONDS, MIN_SHOT_FRAMES, createShotFinder, cutsFromScores, findShots, shotFilters, shotsFromCuts, shotsLine } from "./shot-detection.mjs";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 4.4 s of the Sintel trailer, 384×216 (tests/fixtures/footage/SOURCES.md): cuts at frames 30 and 80.
const SINTEL = path.join(root, "tests/fixtures/footage/sintel-village-dragon.mp4");
// A real 1×1 PNG, for the upload that still works with an old FFmpeg.
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const CROP = ' · crop with look {mode:"source", layer}';
const CUTS_LINE = `shots: 3: 1) 0–1.5 s 2) 1.5–3.13 s 3) 3.13–4.63 s${CROP}`;

// Every temporary folder this file makes, removed at the end.
const folders = [];
async function tempFolder(prefix) {
  const folder = await mkdtemp(path.join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}
after(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))));

// 320×180 at 24 fps, 111 frames: testsrc2 1.5 s, color bars 0.75 s, white for 3 frames, the same
// bars 0.75 s, then a Mandelbrot zoom 1.5 s. Two hard cuts (1.5 s and 3.125 s) and a flash.
async function makeCutsClip(file) {
  const source = (name, seconds, options = "") => ["-f", "lavfi", "-t", String(seconds), "-i", `${name}=s=320x180:r=24${options}`];
  await run(ffmpeg, [
    "-hide_banner", "-v", "error", "-y",
    ...source("testsrc2", 1.5), ...source("smptebars", 0.75), ...source("color", 0.125, ":c=white"),
    ...source("smptebars", 0.75), ...source("mandelbrot", 1.5),
    "-filter_complex", "[0][1][2][3][4]concat=n=5:v=1:a=0,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", file,
  ]);
  return file;
}

// 3 s of the moving testsrc2 picture, white for frames 30–32.
async function makeFlashClip(file) {
  await run(ffmpeg, [
    "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=3",
    "-vf", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(n,30,32)',format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", file,
  ]);
  return file;
}

// The Sintel test clip with `filter` applied (FFmpeg drawbox and eq), saved as `name` in `folder`.
async function sintelWith(folder, name, filter) {
  const file = path.join(folder, name);
  await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", SINTEL, "-vf", `${filter},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", file]);
  return file;
}
// A drawbox that paints frames `from`–`to` white at `opacity`.
const white = (from, to, opacity = 1) => `drawbox=x=0:y=0:w=iw:h=ih:color=white@${opacity}:t=fill:enable='between(n,${from},${to})'`;

// Pieces of the Sintel test clip joined into `name`: [from, to) frame ranges, each with an
// optional filter after it.
async function sintelPieces(folder, name, pieces) {
  const file = path.join(folder, name);
  const chains = pieces.map(([from, to, filter], index) => `[0]trim=start_frame=${from}:end_frame=${to},setpts=PTS-STARTPTS${filter ? `,${filter}` : ""}[p${index}]`);
  const inputs = pieces.map((_, index) => `[p${index}]`).join("");
  await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", SINTEL, "-filter_complex", `${chains.join(";")};${inputs}concat=n=${pieces.length}:v=1:a=0,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", file]);
  return file;
}

// A stand-in FFmpeg that lists `filters` for -filters, says it is FFmpeg 4.2.7 and lists
// -fps_mode in its help when `fpsMode`; anything else fails. Its file is named ffmpeg, as kino's
// message names the command.
async function oldFfmpeg(filters, { fpsMode = true } = {}) {
  const folder = await tempFolder("kino-old-ffmpeg-");
  const file = path.join(folder, "ffmpeg");
  const list = filters.map((name) => ` ... ${name.padEnd(17)} V->V       A filter.`).join("\n");
  await writeFile(file, `#!/bin/sh
# Stand-in for an old FFmpeg in kino's shot tests.
case "$*" in
  *-filters*) cat <<'LIST'
Filters:
  T.. = Timeline support
${list}
LIST
  ;;
  *-version*) echo 'ffmpeg version 4.2.7-0ubuntu0.1 Copyright (c) 2000-2022 the FFmpeg developers' ;;
  *"-h long"*) echo '-vsync              set video sync method globally'${fpsMode ? `; echo '-fps_mode           set framerate mode for matching video streams'` : ""} ;;
  *) echo "stand-in ffmpeg does not run: $*" >&2; exit 1 ;;
esac
`);
  await chmod(file, 0o755);
  return file;
}

const oldMessage = (missing) => "kino needs FFmpeg 5.1 or newer, with the scdet and signalstats filters, to find the shots in a video and draw its frames, " +
  `and ffmpeg (4.2.7-0ubuntu0.1) has no ${missing}. Install a newer FFmpeg or set KINO_FFMPEG to one; nothing was imported.`;

// Runs `fn` with KINO_FFMPEG set to `command`, then puts the old value back.
async function withFfmpeg(command, fn) {
  const before = process.env.KINO_FFMPEG;
  process.env.KINO_FFMPEG = command;
  try { return await fn(); }
  finally {
    if (before === undefined) delete process.env.KINO_FFMPEG;
    else process.env.KINO_FFMPEG = before;
  }
}

describe("shotsFromCuts", () => {
  // A clip as runs of pictures, [["A", 36], ["W", 3], …]: frames with the same letter look alike
  // (they differ by 1 of 255), other frames differ by 100. A cut is where the letter changes.
  // W frames are white: they look like a flash (flashLike); other letters are pictures.
  function shotsOf(runs) {
    const pictures = runs.flatMap(([letter, count]) => Array(count).fill(letter));
    const cuts = pictures.flatMap((picture, frame) => (frame > 0 && picture !== pictures[frame - 1] ? [frame] : []));
    return shotsFromCuts(cuts, pictures.length, (first, second) => (pictures[first] === pictures[second] ? 1 : 100), { flashLike: (frame) => pictures[frame] === "W" });
  }

  test("two cuts and a flash between alike pictures make three shots and one flash", () => {
    assert.deepEqual(shotsOf([["A", 36], ["B", 18], ["W", 3], ["B", 18], ["C", 36]]), { starts: [0, 36, 75], flashes: 1 });
  });

  test(`a flash up to ${FLASH_FRAMES - 1} frames between alike pictures is one shot; ${FLASH_FRAMES} frames are a shot of their own`, () => {
    assert.deepEqual(shotsOf([["A", 30], ["W", FLASH_FRAMES - 1], ["A", 30]]), { starts: [0], flashes: 1 });
    assert.deepEqual(shotsOf([["A", 30], ["W", FLASH_FRAMES], ["A", 30]]), { starts: [0, 30, 30 + FLASH_FRAMES], flashes: 0 });
  });

  test("a flash at the start and at the end of the clip leaves one shot", () => {
    assert.deepEqual(shotsOf([["W", 3], ["A", 40], ["W", 3]]), { starts: [0], flashes: 0 });
  });

  test(`a 3-frame sliver joins the next shot (shots are at least ${MIN_SHOT_FRAMES} frames)`, () => {
    assert.deepEqual(shotsOf([["A", 30], ["X", 3], ["B", 30]]), { starts: [0, 30], flashes: 0 });
  });

  test("minShotFrames 2 keeps a reference edit's 2-frame shots, and onFlash hears each flash", () => {
    const pictures = [["A", 12], ["B", 2], ["C", 2], ["D", 2], ["W", 2], ["D", 10], ["E", 1], ["F", 12]];
    const frames = pictures.flatMap(([letter, count]) => Array(count).fill(letter));
    const cuts = frames.flatMap((picture, frame) => (frame > 0 && picture !== frames[frame - 1] ? [frame] : []));
    const mad = (first, second) => (frames[first] === frames[second] ? 1 : 100);
    const flashLike = (frame) => frames[frame] === "W";
    const heard = [];
    const short = shotsFromCuts(cuts, frames.length, mad, { flashLike, minShotFrames: 2, onFlash: (cut, back) => heard.push([cut, back]) });
    assert.deepEqual(short, { starts: [0, 12, 14, 16, 30], flashes: 1 }, "a 1-frame E runs on into F");
    assert.deepEqual(heard, [[18, 20]]);
    assert.deepEqual(shotsFromCuts(cuts, frames.length, mad, { flashLike }).starts, [0, 12, 30], "the default keeps shots of 6 frames or more");
  });

  test("a 14-frame real shot between two different shots stays", () => {
    assert.deepEqual(shotsOf([["A", 30], ["B", 14], ["C", 30]]), { starts: [0, 30, 44], flashes: 0 });
  });

  test(`a cutaway of ${MIN_SHOT_FRAMES} to ${FLASH_FRAMES - 1} frames between the same picture (A, B, A) is three shots; a shorter one is a flash`, () => {
    assert.deepEqual(shotsOf([["A", 30], ["B", 12], ["A", 30]]), { starts: [0, 30, 42], flashes: 0 });
    assert.deepEqual(shotsOf([["A", 30], ["B", MIN_SHOT_FRAMES], ["A", 30]]), { starts: [0, 30, 30 + MIN_SHOT_FRAMES], flashes: 0 });
    assert.deepEqual(shotsOf([["A", 30], ["B", MIN_SHOT_FRAMES - 1], ["A", 30]]), { starts: [0], flashes: 1 });
  });

  test("lengths are in the file's usual frames: a still held as 2 long frames is a shot", () => {
    // 36 frames, 2 frames held 24 usual frames each, then 36 frames: the cut at frame 38 is 48
    // usual frames (2 s at 24 fps) after the one at 36, not 2.
    const at = (frame) => (frame <= 36 ? frame : frame === 37 ? 60 : 84 + (frame - 38));
    const pictures = [...Array(36).fill(0), 100, 100, ...Array(36).fill(200)];
    const mad = (first, second) => Math.abs(pictures[first] - pictures[second]) + 1;
    assert.deepEqual(shotsFromCuts([36, 38], pictures.length, mad, { at }), { starts: [0, 36, 38], flashes: 0 });
    assert.deepEqual(shotsFromCuts([36, 38], pictures.length, mad), { starts: [0, 36], flashes: 0 }, "counted in frames, the still is a sliver");
  });

  test("no cuts is one shot", () => {
    assert.deepEqual(shotsOf([["A", 50]]), { starts: [0], flashes: 0 });
  });

  test("a flash that fades back has no cut back, and is still one shot", () => {
    // A 30, white 2 frames, a half-white frame (60 from A), then A again: scdet sees the cut in only.
    const pictures = [...Array(30).fill(0), 200, 200, 60, ...Array(30).fill(0)];
    const mad = (first, second) => Math.abs(pictures[first] - pictures[second]) + (pictures[first] === pictures[second] ? 1 : 0);
    assert.deepEqual(shotsFromCuts([30, 32], pictures.length, mad), { starts: [0], flashes: 1 });
  });

  test("a white flash over a cut between two different shots keeps the cut", () => {
    // A (0) for 28 frames, white (200) for 3, then B (40): B is far nearer A than white is, but
    // much further than A or B change by themselves (1 a frame).
    const pictures = [...Array(28).fill(0), 200, 200, 200, ...Array(30).fill(40)];
    const mad = (first, second) => Math.abs(pictures[first] - pictures[second]) + (pictures[first] === pictures[second] ? 1 : 0);
    assert.deepEqual(shotsFromCuts([28, 31], pictures.length, mad), { starts: [0, 28], flashes: 0 });
  });
});

describe("cutsFromScores", () => {
  // A clip from per-frame jumps: mad(i - 1, i) is jumps[i]; frames further apart add up.
  function cutsOf({ scores, jumps, brightness }) {
    const frames = jumps.length;
    const at = jumps.map((_, frame) => jumps.slice(1, frame + 1).reduce((total, jump) => total + jump, 0));
    return cutsFromScores(scores, frames, (first, second) => Math.abs(at[second] - at[first]), brightness ?? Array(frames).fill(100));
  }
  const flat = (length, value) => Array(length).fill(value);

  test("scdet's cuts at 10 or more; a low score counts only where the jump stands out", () => {
    // Frame 10 scores 12; frame 20 (dark to dark) 3.9 with a jump of 10.7 among 0.2s; frame 30 a
    // wing sweep, 3.5 with 38.7 between 27.5 and 29.1; frame 40 (a cut into fast action) 6.6 with
    // 36.8 after 15.9, before 9.7; frame 45 scores 2 with a big jump.
    const scores = flat(50, 0.1), jumps = flat(50, 0.2);
    Object.assign(scores, { 10: 12, 20: 3.9, 30: 3.5, 40: 6.6, 45: 2 });
    Object.assign(jumps, { 10: 60, 20: 10.7, 29: 27.5, 30: 38.7, 31: 29.1, 39: 15.9, 40: 36.8, 41: 9.7, 45: 40 });
    assert.deepEqual(cutsOf({ scores, jumps }), [10, 20, 40]);
  });

  test("the picture after two or more black frames starts a shot, unless the black opens the file", () => {
    const brightness = [...flat(5, 1), ...flat(20, 90), ...flat(6, 2), ...flat(20, 80), 3, ...flat(10, 70)];
    const length = brightness.length;
    // frame 51 is one black frame: not a dip.
    assert.deepEqual(cutsOf({ scores: flat(length, 0), jumps: flat(length, 1), brightness }), [31]);
  });

  test("one black frame between two different pictures ends a dip; between the same picture it does not", () => {
    // Pictures 1 (frames 0–19) and 2 (21–40) either side of black frame 20.
    const brightness = [...flat(20, 60), 1, ...flat(20, 60)];
    const length = brightness.length;
    const picture = (frame) => (frame < 20 ? 1 : frame > 20 ? 2 : 0);
    const cuts = (alike, at) => cutsFromScores(flat(length, 0), length, () => 1, brightness, { at, flat: (frame) => frame === 20, alike });
    assert.deepEqual(cuts((first, second) => picture(first) === picture(second)), [21]);
    assert.deepEqual(cuts(() => true), []);
    // One black frame shown as long as two (a variable-frame-rate file) is a dip whatever is around it.
    assert.deepEqual(cuts(() => true, (frame) => (frame <= 20 ? frame : frame + 1)), [21]);
  });
});

describe("shotsLine and the import answer", () => {
  const video = (fields) => ({ id: "a.mp4", src: "/api/media/a.mp4", name: "clip.mp4", mime: "video/mp4", width: 320, height: 180, duration: 4.625, ...fields });
  const cutsShots = [{ start: 0, end: 1.5 }, { start: 1.5, end: 3.125 }, { start: 3.125, end: 4.625 }];

  test("lists the shots in file seconds, at most 12 unless all", () => {
    assert.equal(shotsLine(video({ shots: cutsShots })), CUTS_LINE);
    assert.equal(shotsLine(video({ shots: [{ start: 0, end: 4.625 }] })), `shots: 1 (no cuts found)${CROP}`);
    const forty = Array.from({ length: 40 }, (_, index) => ({ start: index / 2, end: (index + 1) / 2 }));
    const twelve = forty.slice(0, 12).map((shot, index) => `${index + 1}) ${shot.start}–${shot.end} s`).join(" ");
    assert.equal(shotsLine(video({ shots: forty })),
      `shots: 40: ${twelve} … (40 in all; library {topic:"media", search:"a.mp4"} lists them)${CROP}`);
    const all = shotsLine(video({ shots: forty }), { all: true });
    assert.match(all, /^shots: 40: 1\) 0–0\.5 s .* 40\) 19\.5–20 s · crop with look \{mode:"source", layer\}$/);
  });

  test("says when the shots could not be found, or are not found yet; nothing for other media", () => {
    assert.equal(shotsLine(video({ shotsError: "Invalid data found when processing input" })), "shots: not found (Invalid data found when processing input)");
    assert.equal(shotsLine(video({})), "shots: not found yet (look sheet or library media finds them)");
    assert.equal(shotsLine({ mime: "audio/wav", shots: cutsShots }), "");
    assert.equal(shotsLine({ mime: "image/gif" }), "");
  });

  test("a video's import answer ends with its shots line; an image's has none", () => {
    const text = importedText(video({ shots: cutsShots }));
    assert.equal(text.split("\n").length, 2);
    assert.equal(text.split("\n")[1], CUTS_LINE);
    assert.equal(importedText({ id: "b.png", src: "/api/media/b.png", name: "b.png", mime: "image/png", width: 1, height: 1 }).includes("\n"), false);
  });
});

describe("findShots with FFmpeg", { skip: skipWithoutMediaTools }, () => {
  let folder;
  before(async () => { folder = await tempFolder("kino-shots-"); });

  test("two hard cuts and a 3-frame white flash between the same bars: three shots, one flash", async () => {
    const clip = await makeCutsClip(path.join(folder, "cuts.mp4"));
    const { shots, found: { ms, ...found }, flashes, fps } = await findShots(clip, { duration: (await probeMedia(clip)).duration });
    assert.deepEqual(shots, [{ start: 0, end: 1.5 }, { start: 1.5, end: 3.125 }, { start: 3.125, end: 4.625 }]);
    assert.deepEqual(found, { version: 1, frames: 111, cuts: 2, flashes: 1 });
    assert.deepEqual([flashes, fps], [[{ start: 2.25, end: 2.375 }], 24], "the flash's times and the frame rate, not saved with the record");
    assert.ok(Number.isInteger(ms) && ms >= 0);
  });

  test("a white flash over a moving picture does not split the shot", async () => {
    const clip = await makeFlashClip(path.join(folder, "flash.mp4"));
    const { shots, found } = await findShots(clip, { duration: 3 });
    assert.deepEqual(shots, [{ start: 0, end: 3 }]);
    assert.equal(found.flashes, 1);
    assert.equal(found.frames, 72);
  });

  test("the Sintel test clip has its two cuts", async (context) => {
    const { shots, found } = await findShots(SINTEL, { duration: (await probeMedia(SINTEL)).duration });
    assert.deepEqual(shots, [{ start: 0, end: 1.25 }, { start: 1.25, end: 3.333 }, { start: 3.333, end: 4.417 }]);
    assert.deepEqual([found.frames, found.cuts, found.flashes], [106, 2, 0]);
    context.diagnostic(`Sintel clip: ${found.ms} ms`);
  });

  test("a 3-frame flash that fades back, a lightning strike that fades, and a white flash over a cut", async () => {
    const fading = await sintelWith(folder, "fading.mp4", `${white(50, 51)},${white(52, 52, 0.5)}`);
    const shots = await findShots(fading, { duration: 4.417 });
    assert.deepEqual(shots.shots.map((shot) => shot.start), [0, 1.25, 3.333]);
    assert.equal(shots.found.flashes, 1);
    const lightning = path.join(folder, "lightning.mp4");
    const strike = [[30, 1], [31, 0.7], [32, 0.45], [33, 0.25], [34, 0.1]].map(([frame, opacity]) => white(frame, frame, opacity)).join(",");
    await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=3", "-vf", `${strike},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", lightning]);
    assert.deepEqual((await findShots(lightning, { duration: 3 })).shots, [{ start: 0, end: 3 }]);
    // White from frame 28 to the cut at 30: the cut is kept, at the start of the white.
    const covered = await findShots(await sintelWith(folder, "covered.mp4", white(28, 30)), { duration: 4.417 });
    assert.deepEqual(covered.shots.map((shot) => shot.start), [0, 1.167, 3.333]);
  });

  test("a 3-frame white flash anywhere in the bright, fast flying-dragon shot does not split it", async () => {
    for (const from of [90, 92]) {
      const { shots, found } = await findShots(await sintelWith(folder, `flash${from}.mp4`, white(from, from + 2)), { duration: 4.417 });
      assert.deepEqual(shots.map((shot) => shot.start), [0, 1.25, 3.333], `white on frames ${from}–${from + 2}`);
      assert.equal(found.flashes, 1);
    }
  });

  test("a cutaway (the city, 12 frames of the flying dragon, the city again) is three shots; 3 frames are a flash", async () => {
    const cutaway = await findShots(await sintelPieces(folder, "cutaway.mp4", [[30, 55], [80, 92], [55, 80]]), {});
    assert.deepEqual(cutaway.shots.map((shot) => shot.start), [0, 1.042, 1.542]);
    const flash = await findShots(await sintelPieces(folder, "insert.mp4", [[30, 55], [80, 83], [55, 80]]), {});
    assert.deepEqual([flash.shots.length, flash.found.flashes], [1, 1]);
  });

  test("a fade through one black frame into another shot is a cut", async () => {
    // The village fades to black on its last frame; the city fades in from its second.
    const dip = await sintelPieces(folder, "dip.mp4", [[0, 30, "fade=t=out:start_frame=20:nb_frames=9"], [30, 80, "fade=t=in:start_frame=0:nb_frames=10,trim=start_frame=1,setpts=PTS-STARTPTS"]]);
    assert.deepEqual((await findShots(dip, {})).shots.map((shot) => shot.start), [0, 1.25]);
  });

  test("a WebM whose picture size changes partway keeps its frames in order", async () => {
    const first = path.join(folder, "part1.webm"), second = path.join(folder, "part2.webm"), list = path.join(folder, "parts.txt");
    const vp9 = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "0", "-crf", "40"];
    await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", SINTEL, "-t", "2", ...vp9, first]);
    await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-ss", "2", "-i", SINTEL, "-vf", "scale=320:240", ...vp9, second]);
    await writeFile(list, `file '${first}'\nfile '${second}'\n`);
    const resized = path.join(folder, "resized.webm");
    await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", resized]);
    assert.deepEqual((await findShots(resized, {})).shots.map((shot) => shot.start), [0, 1.25, 3.333]);
  });

  test("a variable-frame-rate file keeps a still held as 2 frames for 2 s as a shot", async () => {
    const still = path.join(folder, "vfr.mp4");
    await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=1.5", "-f", "lavfi", "-i", "smptebars=s=320x180:r=1:d=2",
      "-f", "lavfi", "-t", "1.5", "-i", "mandelbrot=s=320x180:r=24", "-filter_complex", "[0]setpts=PTS-STARTPTS[a];[1]setpts=PTS-STARTPTS[b];[2]setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0,format=yuv420p",
      "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", still]);
    assert.deepEqual((await findShots(still, {})).shots.map((shot) => shot.start), [0, 1.5, 3.5]);
  });

  test("a video too long to look for shots in fails with a reason, before or during the FFmpeg run", async () => {
    await assert.rejects(findShots(SINTEL, { duration: MAX_VIDEO_SECONDS + 60 }), { code: "TOO_LONG", message: /^too long to look for shots in: it is 21 min; kino looks in videos up to 20 min and 72000 frames$/ });
    await assert.rejects(findShots(SINTEL, { duration: 4.417, maxFrames: 50 }), { code: "TOO_LONG", message: /^too long to look for shots in: it has more than 50 frames;/ });
  });

  test("a cut between two dark shots that scdet scores under 10 is found", async () => {
    const dark = await sintelWith(folder, "dark.mp4", "eq=brightness=-0.3:contrast=0.4");
    const { shots } = await findShots(dark, { duration: 4.417 });
    assert.deepEqual(shots.map((shot) => shot.start), [0, 1.25, 3.333]);
  });

  test("a file FFmpeg cannot read fails with FFmpeg's own last line, without the folder", async () => {
    const broken = path.join(folder, "broken.mp4");
    await writeFile(broken, "this is not a video");
    await assert.rejects(findShots(broken, { duration: 1 }), (error) => {
      assert.match(error.message, /Invalid data found when processing input/);
      assert.equal(error.message.includes(folder), false);
      return true;
    });
  });
});

describe("shotFilters", { skip: skipWithoutMediaTools }, () => {
  test("the FFmpeg kino uses has scdet and signalstats", async () => {
    const check = await shotFilters();
    assert.equal(check.ok, true);
    assert.match(check.version, /\d/);
  });

  test("an FFmpeg without scdet, signalstats, both or -fps_mode, or no FFmpeg at all, is not ok, with what is missing", async () => {
    // scdet_vulkan is not scdet.
    const noScdet = await oldFfmpeg(["scale", "scdet_vulkan", "signalstats"]);
    assert.deepEqual(await withFfmpeg(noScdet, () => shotFilters()),
      { ok: false, missing: ["scdet"], version: "4.2.7-0ubuntu0.1", message: oldMessage("scdet") });
    const noStats = await oldFfmpeg(["scale", "scdet"]);
    assert.equal((await withFfmpeg(noStats, () => shotFilters())).message, oldMessage("signalstats"));
    const neither = await oldFfmpeg(["scale"]);
    assert.equal((await withFfmpeg(neither, () => shotFilters())).message, oldMessage("scdet or signalstats"));
    // FFmpeg 4.4–5.0 have both filters but not -fps_mode, which every video frame kino draws needs.
    const noFpsMode = await oldFfmpeg(["scale", "scdet", "signalstats"], { fpsMode: false });
    assert.deepEqual(await withFfmpeg(noFpsMode, () => shotFilters()),
      { ok: false, missing: ["-fps_mode"], version: "4.2.7-0ubuntu0.1", message: oldMessage("-fps_mode") });
    const missing = await withFfmpeg(path.join(await tempFolder("kino-no-ffmpeg-"), "ffmpeg"), () => shotFilters());
    assert.equal(missing.ok, false);
    assert.match(missing.message, /^FFmpeg executable “ffmpeg” was not found\. Install FFmpeg/);
  });

  test("an FFmpeg upgraded in place is checked again: a refusal is not kept", async () => {
    const command = await oldFfmpeg(["scale"]);
    assert.equal((await withFfmpeg(command, () => shotFilters())).ok, false);
    await writeFile(command, `#!/bin/sh\nexec '${ffmpeg}' "$@"\n`);
    const upgraded = await withFfmpeg(command, () => shotFilters());
    assert.equal(upgraded.ok, true, upgraded.message);
  });
});

test("forSource {saved:true} answers saved shots and never runs FFmpeg for a video without them", async () => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "kino-shots-saved-"));
  try {
    const id = `${randomUUID()}.mp4`;
    const saves = [];
    const finder = createShotFinder({ mediaRoot, saveRecord: async (...args) => { saves.push(args); } });
    // No video file at all: a run would fail and save shotsError.
    await writeFile(path.join(mediaRoot, `${id}.json`), JSON.stringify({ id, mime: "video/mp4", duration: 2 }));
    assert.deepEqual(await finder.forSource(`/api/media/${id}`, { saved: true }), { shots: null, reason: "not found yet" });
    assert.deepEqual(saves, []);
    const shots = [{ start: 0, end: 2 }];
    await writeFile(path.join(mediaRoot, `${id}.json`), JSON.stringify({ id, mime: "video/mp4", duration: 2, shots }));
    assert.deepEqual(await finder.forSource(`/api/media/${id}`, { saved: true }), { shots });
  } finally { await rm(mediaRoot, { recursive: true, force: true }); }
});

describe("createShotFinder", { skip: skipWithoutMediaTools }, () => {
  let mediaRoot, saved, finder, clip;
  // Writes a media record as an upload before B3 did: measured, no shots.
  async function addRecord(file, fields) {
    const id = `${randomUUID()}.${path.extname(file).slice(1)}`;
    await copyFile(file, path.join(mediaRoot, id));
    const record = { id, src: `/api/media/${id}`, name: path.basename(file), measurementVersion: 1, measurementSucceeded: true, ...fields };
    await writeFile(path.join(mediaRoot, `${id}.json`), JSON.stringify(record));
    return record;
  }
  const readRecord = async (id) => JSON.parse(await readFile(path.join(mediaRoot, `${id}.json`), "utf8"));

  before(async () => {
    mediaRoot = await tempFolder("kino-shot-finder-");
    clip = await makeCutsClip(path.join(await tempFolder("kino-shot-clip-"), "cuts.mp4"));
    saved = [];
    finder = createShotFinder({
      mediaRoot,
      async saveRecord(id, fields) {
        saved.push({ id, fields });
        await writeFile(path.join(mediaRoot, `${id}.json`), JSON.stringify({ ...await readRecord(id), ...fields }));
      },
    });
  });

  test("a video imported without shots gets them once, saved; two calls at once share one FFmpeg run", async () => {
    // A stand-in that notes each run and then runs the real FFmpeg.
    const folder = await tempFolder("kino-counting-ffmpeg-");
    const log = path.join(folder, "runs.log");
    const counting = path.join(folder, "ffmpeg");
    await writeFile(counting, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${ffmpeg}' "$@"\n`);
    await chmod(counting, 0o755);
    const record = await addRecord(clip, { mime: "video/mp4", duration: 4.625, width: 320, height: 180 });
    const shots = [{ start: 0, end: 1.5 }, { start: 1.5, end: 3.125 }, { start: 3.125, end: 4.625 }];
    await withFfmpeg(counting, async () => {
      const [first, second] = await Promise.all([finder.forSource(record.src), finder.forSource(record.src)]);
      assert.deepEqual(first, { shots });
      assert.deepEqual(second, { shots });
      assert.deepEqual(await finder.forSource(record.src), { shots });
    });
    const runs = (await readFile(log, "utf8")).split("\n").filter((line) => line.includes("scdet="));
    assert.equal(runs.length, 1, "FFmpeg looked for shots once");
    assert.deepEqual(saved.map((save) => save.id), [record.id]);
    const updated = await readRecord(record.id);
    assert.deepEqual(updated.shots, shots);
    assert.deepEqual({ ...updated.shotsFound, ms: 0 }, { version: 1, frames: 111, cuts: 2, flashes: 1, ms: 0 });
    assert.equal(shotsLine(updated), CUTS_LINE);
  });

  test("a file not in the library, an audio file, an unreadable video and an old FFmpeg each say why", async () => {
    assert.deepEqual(await finder.forSource(`/api/media/${randomUUID()}.mp4`), { shots: null, reason: "not in kino's media library" });
    assert.deepEqual(await finder.forSource("https://example.com/clip.mp4"), { shots: null, reason: "not in kino's media library" });
    const tone = path.join(await tempFolder("kino-shot-tone-"), "tone.wav");
    await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", tone]);
    const audio = await addRecord(tone, { mime: "audio/wav", duration: 0.5 });
    assert.deepEqual(await finder.forSource(audio.src), { shots: null, reason: "not a video" });

    const brokenFile = path.join(await tempFolder("kino-shot-broken-"), "broken.mp4");
    await writeFile(brokenFile, "this is not a video");
    const broken = await addRecord(brokenFile, { mime: "video/mp4", duration: 0, measurementSucceeded: false });
    const answer = await finder.forSource(broken.src);
    assert.equal(answer.shots, null);
    assert.match(answer.reason, /^FFmpeg could not read its frames: .*Invalid data found when processing input$/);
    const savedError = (await readRecord(broken.id)).shotsError;
    assert.equal(`FFmpeg could not read its frames: ${savedError}`, answer.reason);
    assert.equal(shotsLine(await readRecord(broken.id)), `shots: not found (${savedError})`);

    const long = await addRecord(clip, { mime: "video/mp4", duration: MAX_VIDEO_SECONDS + 60 });
    const tooLong = await finder.forSource(long.src);
    assert.match(tooLong.reason, /^too long to look for shots in: it is 21 min;/);
    assert.equal((await finder.forSource(long.src)).reason, tooLong.reason, "the saved reason reads the same");
    assert.equal(shotsLine(await readRecord(long.id)), `shots: not found (${tooLong.reason})`);

    const waiting = await addRecord(clip, { mime: "video/mp4", duration: 4.625 });
    const old = await withFfmpeg(await oldFfmpeg(["scale"]), () => finder.forSource(waiting.src));
    assert.deepEqual(old, { shots: null, reason: oldMessage("scdet or signalstats").replace("; nothing was imported.", ".") });
    assert.equal("shots" in await readRecord(waiting.id), false, "nothing was saved with the old FFmpeg");
  });
});

// Runs `node bin/kino.mjs ...args` against a test server and collects what it prints.
function runKino(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "bin/kino.mjs"), ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function cliEnv(server, home) {
  const env = { ...process.env };
  for (const name of ["MOTION_API_URL", "KINO_OWNER_TOKEN", "KINO_SHARE_TOKEN", "KINO_RUNTIME_FILE", "KINO_METER_FILE", "KINO_SETUP_HOME"]) delete env[name];
  return { ...env, MOTION_API_URL: server.baseUrl, KINO_OWNER_TOKEN: server.ownerToken, KINO_RUNTIME_FILE: "/nonexistent", HOME: home };
}

describe("video import on a real server", { skip: skipWithoutMediaTools }, () => {
  test("an upload's record and answer list its shots, and kino project import prints them", async () => {
    const clip = await makeCutsClip(path.join(await tempFolder("kino-shot-upload-"), "cuts.mp4"));
    const server = await startTestServer();
    try {
      const response = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "cuts.mp4" }, body: await readFile(clip) });
      assert.equal(response.status, 201);
      const media = await response.json();
      const shots = [{ start: 0, end: 1.5 }, { start: 1.5, end: 3.125 }, { start: 3.125, end: 4.625 }];
      assert.deepEqual(media.shots, shots);
      assert.deepEqual({ ...media.shotsFound, ms: 0 }, { version: 1, frames: 111, cuts: 2, flashes: 1, ms: 0 });
      const record = JSON.parse(await readFile(path.join(server.dataDirectory, "media", `${media.id}.json`), "utf8"));
      assert.deepEqual(record.shots, shots);
      assert.deepEqual(record.shotsFound, media.shotsFound);
      assert.equal(importedText(media).split("\n")[1], CUTS_LINE);

      const printed = await runKino(["project", "import", clip], cliEnv(server, await tempFolder("kino-shot-home-")));
      assert.equal(printed.code, 0, printed.stderr);
      assert.match(printed.stdout, /^imported cuts\.mp4 \(320×180, duration 4\.625s\) as \/api\/media\/\S+\. Add it: edit .*\n(.*)\n$/);
      assert.equal(printed.stdout.split("\n")[1], CUTS_LINE);
    } finally {
      await server.stop();
    }
  });

  test("with an FFmpeg without scdet or signalstats a video is refused and nothing is saved; an image still imports", async () => {
    const clip = await makeCutsClip(path.join(await tempFolder("kino-shot-refused-"), "cuts.mp4"));
    const [noScdet, noStats] = await Promise.all([
      startTestServer({ env: { KINO_FFMPEG: await oldFfmpeg(["scale", "signalstats"]) } }),
      startTestServer({ env: { KINO_FFMPEG: await oldFfmpeg(["scale", "scdet"]) } }),
    ]);
    try {
      const refused = await noScdet.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "cuts.mp4" }, body: await readFile(clip) });
      assert.equal(refused.status, 422);
      assert.deepEqual(await refused.json(), { error: oldMessage("scdet") });
      assert.deepEqual(await readdir(path.join(noScdet.dataDirectory, "media")), [], "no file or record was left");

      // Through the client the MCP tool and the kino command share.
      const client = createAgentClient({ url: noStats.baseUrl, ownerToken: noStats.ownerToken }, { name: "cli" });
      await assert.rejects(client.importFile(clip), { message: `kino refused the file: ${oldMessage("signalstats")}` });
      assert.deepEqual(await readdir(path.join(noStats.dataDirectory, "media")), []);

      const image = await noScdet.api("/api/media", { method: "POST", headers: { "content-type": "image/png", "x-file-name": "pixel.png" }, body: TINY_PNG });
      assert.equal(image.status, 201);
      const media = await image.json();
      assert.equal(media.measurementSucceeded, true);
      assert.equal("shots" in media, false);
    } finally {
      await Promise.all([noScdet.stop(), noStats.stop()]);
    }
  });
});
