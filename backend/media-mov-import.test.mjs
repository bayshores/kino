// Importing a QuickTime .mov (what iPhones record) or an .m4v: kino keeps it as an MP4 with the
// same picture, copied without encoding it again, and refuses a picture it cannot play.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { probeCodecs } from "./media-remux.mjs";
import { ffmpeg, ffprobe, near, readImage, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

let server;
let client;
let folder;
before(async () => {
  if (skipWithoutMediaTools) return;
  server = await startTestServer({ allow: ["large-import"] });
  client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "media-mov-import-test" });
  folder = await mkdtemp(path.join(tmpdir(), "kino-mov-import-"));
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

// A one-second 64x48 test picture (or `picture`, an FFmpeg lavfi source) with a tone, written
// with `video` as the picture codec into `name`. The timecode track is what an iPhone or camera
// .mov carries besides picture and sound.
async function makeClip(name, video, { audio = ["-c:a", "aac"], picture = "testsrc2=size=64x48:rate=30:duration=1" } = {}) {
  const file = path.join(folder, name);
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", picture,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    ...video, ...audio, "-timecode", "01:00:00:00", "-shortest", file,
  ]);
  return file;
}

async function savedFile(media) {
  return path.join(server.dataDirectory, "media", media.id);
}

test("an H.264 .mov imports as an MP4 with the same picture, its sound and its own name", { skip: skipWithoutMediaTools }, async () => {
  const mov = await makeClip("IMG_0001.mov", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const media = await client.importFile(mov);
  assert.match(media.id, /\.mp4$/);
  assert.equal(media.mime, "video/mp4");
  assert.equal(media.name, "IMG_0001.mov");
  assert.equal(media.measurementSucceeded, true);
  assert.equal(media.width, 64);
  assert.equal(media.height, 48);
  assert.equal(media.hasAudio, true);
  assert.ok(Math.abs(media.duration - 1) < 0.1, `about one second long, got ${media.duration}`);
  const stored = await savedFile(media);
  const bytes = await readFile(stored);
  assert.equal(bytes.subarray(4, 8).toString("ascii"), "ftyp", "stored as an MP4 file");
  assert.equal(media.size, bytes.length);
  assert.deepEqual(await probeCodecs(stored), { video: "h264", audio: "aac" });
  // The library lists it like any other video.
  const listed = await (await server.api("/api/media")).json();
  assert.ok((listed.media ?? listed).some((item) => item.id === media.id));
});

async function agent(verb, body) {
  const reply = await (await server.api(`/api/agent/${verb}`, { method: "POST", body })).json();
  assert.notEqual(reply.isError, true, reply.text);
  return reply;
}

test("an HEVC .mov (iPhone default) is copied into an MP4 tagged hvc1, PCM sound becomes AAC, and its picture renders", { skip: skipWithoutMediaTools }, async () => {
  const mov = await makeClip("IMG_0002.mov", ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error"],
    { audio: ["-c:a", "pcm_s16le"], picture: "color=c=0x2060e0:size=64x48:rate=30:duration=1" });
  const media = await client.importFile(mov);
  assert.equal(media.mime, "video/mp4");
  assert.equal(media.measurementSucceeded, true);
  const stored = await savedFile(media);
  assert.deepEqual(await probeCodecs(stored), { video: "hevc", audio: "aac" });
  const tag = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_tag_string", "-of", "json", stored]);
  assert.equal(JSON.parse(tag.toString("utf8")).streams[0].codec_tag_string, "hvc1");
  // Through the agent path: a video layer of it, and a rendered frame shows its blue.
  await agent("project", { action: "create", id: "hevc", name: "HEVC", width: 64, height: 48, duration: 1, background: "#000000" });
  await agent("edit", { project: "hevc", ops: [{ op: "add_layer", layerType: "video", name: "clip", properties: {
    src: media.src, mediaSourceDuration: media.duration, x: 0, y: 0, width: 64, height: 48 } }] });
  const frame = await agent("look", { project: "hevc", mode: "frame", t: 0.5, width: 64 });
  const image = await readImage(Buffer.from(frame.images[0].data, "base64"));
  assert.ok(near(image.pixel(32, 24), [0x20, 0x60, 0xe0, 255], 16), `the clip's blue is drawn, got ${image.pixel(32, 24)}`);
});

test("a portrait .mov (an iPhone held upright) keeps its rotation, so it measures taller than wide", { skip: skipWithoutMediaTools }, async () => {
  const landscape = await makeClip("upright-source.mov", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const upright = path.join(folder, "IMG_0003.mov");
  // iPhones store the picture sideways with a display rotation, as this copy does.
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", landscape, "-c", "copy", upright]);
  const media = await client.importFile(upright);
  assert.equal(media.measurementSucceeded, true);
  assert.deepEqual([media.width, media.height], [48, 64]);
});

test("an .m4v imports as an MP4 too", { skip: skipWithoutMediaTools }, async () => {
  const m4v = await makeClip("clip.m4v", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "ipod"]);
  const media = await client.importFile(m4v);
  assert.equal(media.mime, "video/mp4");
  assert.equal(media.measurementSucceeded, true);
});

test("a ProRes .mov is refused with what to do, and nothing is saved", { skip: skipWithoutMediaTools }, async () => {
  const mov = await makeClip("camera.mov", ["-c:v", "prores_ks", "-profile:v", "0"], { audio: ["-c:a", "pcm_s16le"] });
  const before = (await (await server.api("/api/media")).json());
  await assert.rejects(client.importFile(mov), (error) => {
    assert.match(error.message, /prores/);
    assert.match(error.message, /H\.264 and HEVC/);
    assert.match(error.message, /ffmpeg -i in\.mov/);
    return true;
  });
  const afterList = (await (await server.api("/api/media")).json());
  assert.equal((afterList.media ?? afterList).length, (before.media ?? before).length);
});
