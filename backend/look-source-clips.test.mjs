// look {mode:"source"} with no layer shows every clip and picture of the project on one sheet;
// times:[…] draws exact file seconds; a video over the upload limit imports as kino's own copy.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { loadImage } from "@napi-rs/canvas";
import { createAgentClient } from "./agent/client.mjs";
import { clipTile, clipTimes, layoutClips, planClips } from "./agent/clips-sheet.mjs";
import { makeWorkingCopy } from "./media-working-copy.mjs";
import { ffmpeg, ffprobe, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { TRANSCRIPT_VERSION } from "./speech/transcribe.mjs";
import { writeFakeWhisper } from "../tests/fake-whisper-cli.mjs";

let server, client, folder;
before(async () => {
  if (skipWithoutMediaTools) return;
  folder = await mkdtemp(path.join(tmpdir(), "kino-source-clips-"));
  // A stand-in whisper: saved transcripts are read (look source's heard lines), none is made.
  server = await startTestServer({ env: await writeFakeWhisper(folder, []) });
  client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "look-source-clips-test" });
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function call(verb, input) {
  const reply = await client.call(verb, input);
  assert.equal(reply.isError, undefined, reply.text);
  return reply;
}
// A test picture clip: `size` WxH, `seconds` long, no sound. lossless:true makes a big file.
async function clip(name, size, seconds, { lossless = false } = {}) {
  const file = path.join(folder, name);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${seconds}`,
    "-c:v", "libx264", ...(lossless ? ["-preset", "ultrafast", "-qp", "0"] : ["-pix_fmt", "yuv420p"]), file]);
  return file;
}

test("clip times and layout: 3 to 6 frames by length, one picture frame, rows in one page", () => {
  assert.deepEqual(clipTimes(2), [0.3, 1, 1.7]);
  assert.equal(clipTimes(6).length, 4);
  assert.equal(clipTimes(60).length, 6);
  assert.deepEqual(clipTimes(0), [0]);
  const wide = { tile: clipTile(1920, 1080), times: clipTimes(30) };
  assert.deepEqual(wide.tile, { width: 200, height: 113 });
  const pages = layoutClips(Array.from({ length: 16 }, () => wide));
  assert.equal(pages.length, 2, "16 wide clips of 6 frames: 2 pages");
  assert.ok(pages.every((page) => page.height <= 1400 && page.places.every((place) => place.x + place.width <= 1280)));
  // planClips gives each fewer frames so all 16 share one page; 4 such clips keep 6 frames.
  const sixteen = planClips(Array.from({ length: 16 }, () => ({ width: 1920, height: 1080, duration: 30 })));
  assert.equal(sixteen.pages.length, 1);
  assert.ok(sixteen.blocks.every((block) => block.times.length === 3));
  assert.ok(planClips(Array.from({ length: 4 }, () => ({ width: 1920, height: 1080, duration: 30 }))).blocks.every((block) => block.times.length === 6));
});

test("look source with no layer: one sheet names every clip and picture of the project, not another project's", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  await call("project", { action: "create", id: "other", name: "Other", width: 320, height: 180, duration: 2 });
  await client.importFile(await clip("99-elsewhere.mp4", "160x90", 1));
  await call("project", { action: "create", id: "clips", name: "Clips", width: 320, height: 180, duration: 4 });
  for (const [name, size, seconds] of [["01-wide.mp4", "160x90", 2], ["02-tall.mp4", "90x160", 6], ["03-square.mp4", "120x120", 3]])
    await client.importFile(await clip(name, size, seconds));
  const still = path.join(folder, "04-logo.png");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1", still]);
  await client.importFile(still);

  const reply = await call("look", { project: "clips", mode: "source" });
  for (const name of ["01-wide.mp4", "02-tall.mp4", "03-square.mp4", "04-logo.png"]) assert.match(reply.text, new RegExp(name.replace(".", "\\.")));
  assert.doesNotMatch(reply.text, /99-elsewhere/, "a clip imported for another project is left out");
  assert.match(reply.text, /^source: 4 files\. /);
  assert.equal(reply.images.length, 1, "one sheet");
  const sheet = await loadImage(Buffer.from(reply.images[0].data, "base64"));
  assert.equal(sheet.width, 1280);
  assert.ok(sheet.height < 500, `all four fit one short sheet (${sheet.height} px)`);
  if (process.env.KINO_SHEET_OUT) await writeFile(process.env.KINO_SHEET_OUT, Buffer.from(reply.images[0].data, "base64"));
});

test("look source times: those file seconds of a clip, by file name or video layer", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  const byName = await call("look", { project: "clips", mode: "source", layer: "02-tall.mp4", times: [0.5, 5.2, 9] });
  assert.match(byName.text, /file 0\.5, 5\.2, 5\.9\d* s\./, byName.text);
  const media = (await call("library", { topic: "media", search: "01-wide" })).data.media[0];
  await call("edit", { project: "clips", ops: [{ op: "add_layer", layerType: "video", name: "wide", properties: { src: media.src, x: 0, y: 0, width: 320, height: 180, mediaSourceDuration: 2 } }] });
  const byLayer = await call("look", { project: "clips", mode: "source", layer: "wide", times: [1] });
  assert.match(byLayer.text, /^source 01-wide\.mp4 \(160×90, 2 s\): file 1 s\./);
  // A line in the clip's saved transcript: the overview and the layer's own view say it, in file seconds.
  const file = path.join(server.dataDirectory, "media", media.src.split("/").pop());
  const words = [{ text: "Hello", start: 0.2, end: 0.5, p: 0.9 }, { text: "there.", start: 0.6, end: 1.1, p: 0.9 }];
  await writeFile(`${file}.words-small.en`, JSON.stringify({ version: TRANSCRIPT_VERSION, words }));
  const all = await call("look", { project: "clips", mode: "source" });
  assert.match(all.text, /^1 01-wide\.mp4 160×90 2 s · wide$/m, "the overview names the layer that shows a clip");
  assert.match(all.text, /^heard \(shortest first\): \S+ "Hello there\." 0\.2-1\.1 s$/m);
  assert.match((await call("look", { project: "clips", mode: "source", layer: "wide", t: 1 })).text, /^sound: (?:-?\d+\.\d LUFS · )?heard "Hello there\." 0\.2-1\.1 s \(file s\)$/m);
});

test("a video over the upload limit imports as kino's own copy with a note; one under it has none", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  const limit = 200_000;
  const small = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "look-source-clips-test", maxUploadBytes: limit });
  const big = await clip("05-big.mp4", "320x180", 1, { lossless: true });
  assert.ok((await stat(big)).size > limit, "the test clip is over the lowered limit");
  const media = await small.importFile(big);
  assert.equal(media.name, "05-big.mp4");
  assert.ok(media.size <= limit, `the copy is ${media.size} bytes`);
  assert.equal(media.width, 320);
  assert.match(media.note, /^05-big\.mp4 is [\d.]+ MB, over kino's 0\.2 MB upload limit, so kino imported its own working copy \(H\.264, [\d.]+ MB\); the original is unchanged\./);
  const plain = await small.importFile(await clip("06-small.mp4", "64x48", 1));
  assert.equal(plain.note, undefined);
  // A picture over the limit is still refused, with the limit.
  const picture = path.join(folder, "07-huge.png");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=size=640x640,geq=random(1)*255:128:128", "-frames:v", "1", picture]);
  await assert.rejects(createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { maxUploadBytes: 1000 }).importFile(picture), /Media files must be at most 1000 bytes/);
});

test("a clip too long for a usable copy under the limit is refused with what to do", { skip: skipWithoutMediaTools, timeout: 60_000 }, async () => {
  const file = await clip("08-long.mp4", "64x48", 2);
  await assert.rejects(makeWorkingCopy({ actualPath: file, mime: "video/mp4", size: 999_999, name: "08-long.mp4" }, { maxBytes: 100_000 }),
    /08-long\.mp4 is 1 MB, over kino's 0\.1 MB upload limit, and at 2 s it is too long for a usable copy under it\. Import a shorter part of it\./);
});

test("a working copy of a picture bigger than 1080p is scaled to its long edge, either way up; one at the cap is not", { skip: skipWithoutMediaTools, timeout: 60_000 }, async () => {
  // A small cap (160 px) stands in for 1920, so no 4K is decoded.
  const size = async (file) => String(await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file])).trim();
  const copy = async (name, frame) => {
    const made = await makeWorkingCopy({ actualPath: await clip(name, frame, 1), mime: "video/mp4", size: 999_999, name }, { maxBytes: 10 * 1024 * 1024, longEdge: 160 });
    try { return { size: await size(made.path), note: made.note }; } finally { await made.cleanup(); }
  };
  const wide = await copy("09-wide.mp4", "320x180");
  assert.equal(wide.size, "160x90");
  assert.match(wide.note, /working copy \(H\.264, long edge 160 px, /);
  assert.equal((await copy("10-tall.mp4", "180x320")).size, "90x160");
  const same = await copy("11-at-cap.mp4", "160x90");
  assert.equal(same.size, "160x90");
  assert.match(same.note, /working copy \(H\.264, [\d.]+ MB\)/);
});
