// Runs the real server in a temporary data folder and checks uploaded-media measurements
// and the decoded GIF frame routes, including share-link access.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GIF_DECODER_VERSION, parseGif } from "../engine/gifDecode.js";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { writeGifFrames } from "./media-probe.mjs";
import { makeAnimatedGif, readImage, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];

async function expectStatus(response, status, reason) {
  if (response.status !== status) assert.equal(response.status, status, `${reason}: ${await response.text()}`);
}

/** A GIF whose header is fine but whose frames add up to more pixels than the decoder allows. */
function makeOverBudgetGif() {
  const u16 = (value) => [value & 0xff, value >> 8];
  // 4000 x 4000 is under the per-picture limit, but 63 such frames exceed 1,000,000,000 pixels.
  // Each frame only stores one pixel, so the file itself is tiny.
  const onePixelFrame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0];
  return Buffer.from([
    ..."GIF89a".split("").map((char) => char.charCodeAt(0)), ...u16(4000), ...u16(4000), 0x80, 0, 0,
    255, 0, 0, 0, 0, 255,
    ...Array.from({ length: 63 }, () => onePixelFrame).flat(),
    0x3b,
  ]);
}

function makeDocument(id) {
  return createDocument({
    id,
    name: id,
    scenes: [createScene({
      id: `scene-${id}`,
      width: 32,
      height: 18,
      duration: 1,
      layers: [createLayer("rectangle", { id: `layer-${id}`, width: 10, height: 10, fill: "#633ae9" })],
    })],
  });
}

test("uploads are measured, and GIF frames are decoded once and served only to links that may read them", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const { api, dataDirectory } = server;
  async function upload(projectId, bytes, mime, name) {
    const response = await api(`/api/media?project=${projectId}`, {
      method: "POST",
      body: bytes,
      headers: { "Content-Type": mime, "X-File-Name": name },
    });
    await expectStatus(response, 201, `upload ${name}`);
    return response.json();
  }

  for (const id of ["gif-project", "other-project"]) {
    await expectStatus(await api("/api/projects", { method: "POST", body: { document: makeDocument(id) } }), 201, `create ${id}`);
  }

  // Red, green, blue, yellow; the second delay is 1/100 s, which plays as 1/10 s like in browsers.
  const colors = [RED, GREEN, BLUE, YELLOW];
  const gifBytes = makeAnimatedGif({
    width: 12,
    height: 8,
    frames: colors.map((color, index) => ({ color, delayCs: [10, 1, 20, 5][index] })),
  });
  const gif = await upload("gif-project", gifBytes, "image/gif", "colors.gif");
  assert.deepEqual(
    { duration: gif.duration, width: gif.width, height: gif.height, frameCount: gif.frameCount, animated: gif.animated },
    { duration: 0.45, width: 12, height: 8, frameCount: 4, animated: true },
    "the upload response includes the measured GIF timeline",
  );
  const otherGif = await upload("other-project", makeAnimatedGif({
    width: 4, height: 4, frames: [{ color: RED, delayCs: 10 }, { color: BLUE, delayCs: 10 }],
  }), "image/gif", "other.gif");
  const brokenGif = await upload("gif-project", Buffer.from("not a GIF at all"), "image/gif", "broken.gif");
  assert.equal(brokenGif.duration, 0, "a GIF that cannot be read still uploads, with duration 0");
  assert.equal(brokenGif.frameCount, undefined);

  // Frame timeline.
  const timelineResponse = await api(`/api/media/${gif.id}/frames`);
  await expectStatus(timelineResponse, 200, "the owner reads the frame timeline");
  assert.deepEqual(await timelineResponse.json(), { count: 4, durations: [0.1, 0.1, 0.2, 0.05], width: 12, height: 8, decoder: GIF_DECODER_VERSION });

  // Each frame is a complete PNG with the expected color.
  for (const [index, color] of colors.entries()) {
    const response = await api(`/api/media/${gif.id}/frames/${index}.png`);
    await expectStatus(response, 200, `frame ${index}`);
    assert.equal(response.headers.get("content-type"), "image/png");
    const picture = await readImage(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual([picture.width, picture.height], [12, 8]);
    assert.deepEqual(picture.pixel(6, 4), [...color, 255], `frame ${index} is ${color}`);
  }
  const head = await api(`/api/media/${gif.id}/frames/2.png`, { method: "HEAD" });
  await expectStatus(head, 200, "HEAD works for a frame");

  // Frame numbers are validated.
  for (const frame of ["4.png", "99.png", "01.png", "-1.png", "1.gif", "1.png.json", "abc.png"]) {
    await expectStatus(await api(`/api/media/${gif.id}/frames/${frame}`), 404, `frame ${frame} does not exist`);
  }
  // Only GIFs have frames; unknown files and malformed names do not reach the media folder.
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=", "base64");
  const png = await upload("gif-project", pngBytes, "image/png", "still.png");
  assert.equal(png.duration, 0, "a still image has no length");
  const notGif = await api(`/api/media/${png.id}/frames`);
  await expectStatus(notGif, 400, "a PNG has no decoded frames");
  assert.match((await notGif.json()).error, /Only GIF images have decoded frames/);
  await expectStatus(await api("/api/media/00000000-0000-4000-8000-000000000000.gif/frames"), 404, "a missing GIF");
  await expectStatus(await api("/api/media/..%2Fprojects.gif/frames"), 404, "a path outside the media folder is not a media name");
  const broken = await api(`/api/media/${brokenGif.id}/frames`);
  await expectStatus(broken, 422, "an undecodable GIF is refused");
  assert.deepEqual(await broken.json(), { error: "This GIF's frames could not be decoded." },
    "the client gets a fixed message, never decoder output or server file paths");
  // A GIF with a valid header whose first frame stops halfway through its descriptor.
  const cutGif = await upload("gif-project", Buffer.from([...gifBytes.subarray(0, 13 + 3 * 256), 0x2c, 0, 0]), "image/gif", "cut.gif");
  const cut = await api(`/api/media/${cutGif.id}/frames/0.png`);
  await expectStatus(cut, 422, "a GIF cut off before its first frame is refused");
  const cutBody = await cut.text();
  assert.equal(cutBody, JSON.stringify({ error: "This GIF's frames could not be decoded." }));
  assert.ok(!cutBody.includes(dataDirectory) && !cutBody.includes("/"), "no path reaches the client");
  // A GIF over the decode budget is refused before any frame is decoded.
  const hugeGif = await upload("gif-project", makeOverBudgetGif(), "image/gif", "huge.gif");
  const huge = await api(`/api/media/${hugeGif.id}/frames`);
  await expectStatus(huge, 413, "a GIF over the decode budget is refused");
  assert.deepEqual(await huge.json(), { error: "This GIF is too large to decode frame by frame." });

  // Share links read frames of their own file's media only.
  const shareResponse = await api("/api/projects/gif-project/shares", { method: "POST", body: { role: "view", label: "Frames" } });
  await expectStatus(shareResponse, 201, "create a view link");
  const { token } = await shareResponse.json();
  const shared = await api(`/api/media/${gif.id}/frames/3.png`, { owner: false, share: token });
  await expectStatus(shared, 200, "a view link reads frames of its file's GIF");
  assert.equal(shared.headers.get("cache-control"), "no-cache", "share-link frames are revalidated, so a revoked link stops working");
  assert.match((await api(`/api/media/${gif.id}/frames/0.png`)).headers.get("cache-control"), /immutable/, "owner frames are cached");
  const foreign = await api(`/api/media/${otherGif.id}/frames`, { owner: false, share: token });
  await expectStatus(foreign, 403, "a view link cannot read another file's GIF frames");
  await expectStatus(await api(`/api/media/${otherGif.id}/frames/0.png`, { owner: false, share: token }), 403, "or its frame pictures");
  await expectStatus(await api(`/api/media/${gif.id}/frames`, { owner: false }), 403, "no key and no link");

  // Simultaneous first requests share one decode and all get the same answer.
  const burst = await Promise.all(Array.from({ length: 6 }, (_, index) => api(`/api/media/${otherGif.id}/frames${index % 2 ? "/1.png" : ""}`)));
  for (const response of burst) await expectStatus(response, 200, "a concurrent first request");
  const jsonBodies = await Promise.all(burst.filter((_, index) => index % 2 === 0).map((response) => response.json()));
  for (const body of jsonBodies) assert.deepEqual(body, { count: 2, durations: [0.1, 0.1], width: 4, height: 4, decoder: GIF_DECODER_VERSION });
  for (const response of burst.filter((_, index) => index % 2)) {
    assert.deepEqual((await readImage(Buffer.from(await response.arrayBuffer()))).pixel(1, 1), [...BLUE, 255]);
  }

  // A record saved before uploads were measured is measured the first time media is listed.
  const legacyId = "11111111-2222-4333-8444-555555555555.gif";
  await writeFile(path.join(dataDirectory, "media", legacyId), gifBytes);
  await writeFile(path.join(dataDirectory, "media", `${legacyId}.json`), JSON.stringify({
    id: legacyId, src: `/api/media/${legacyId}`, name: "legacy.gif", mime: "image/gif", size: gifBytes.length, projectId: "gif-project",
  }));
  const listResponse = await api("/api/media");
  await expectStatus(listResponse, 200, "list media");
  const legacy = (await listResponse.json()).media.find((entry) => entry.id === legacyId);
  assert.deepEqual([legacy.duration, legacy.frameCount, legacy.animated, legacy.name], [0.45, 4, true, "legacy.gif"]);
  const savedLegacy = JSON.parse(await readFile(path.join(dataDirectory, "media", `${legacyId}.json`), "utf8"));
  assert.equal(savedLegacy.duration, 0.45, "the measurement is saved, so it happens once");
  const sharedList = await api("/api/media", { owner: false, share: token }).then((response) => response.json());
  assert.ok(sharedList.media.every((entry) => entry.projectId === "gif-project"), "a link lists only its file's media");

  // Decoded frames live outside the media folder, which keeps only uploads and their records.
  const mediaFiles = await readdir(path.join(dataDirectory, "media"));
  const uploads = [gif, otherGif, brokenGif, cutGif, hugeGif, png].map((entry) => entry.id).concat(legacyId);
  assert.deepEqual(mediaFiles.sort(), uploads.flatMap((id) => [id, `${id}.json`]).sort(), "no extra files in the media folder");
  const frameFolders = await readdir(path.join(dataDirectory, "media-frames"));
  assert.deepEqual(frameFolders.filter((name) => name !== ".partial").sort(), [gif.id, otherGif.id].sort());
  assert.deepEqual(await readdir(path.join(dataDirectory, "media-frames", ".partial")), [], "no temporary decode folders remain");
  assert.deepEqual((await readdir(path.join(dataDirectory, "media-frames", gif.id))).sort(),
    ["000000.png", "000001.png", "000002.png", "000003.png", "timeline.json"]);
});

/** Bytes of PNG files the frame cache writes for `gifBytes`, measured with the same encoder. */
async function decodedBytes(gifBytes) {
  const folder = await mkdtemp(path.join(tmpdir(), "kino-gif-bytes-"));
  try {
    return await writeGifFrames(parseGif(gifBytes), folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("frames are decoded again after their folder disappears, the cache keeps to its disk budget, and file errors hide paths", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const firstBytes = makeAnimatedGif({ width: 12, height: 8, frames: [RED, GREEN, BLUE, YELLOW].map((color) => ({ color, delayCs: 10 })) });
  const secondBytes = makeAnimatedGif({ width: 12, height: 8, frames: [YELLOW, BLUE, GREEN, RED].map((color) => ({ color, delayCs: 10 })) });
  const firstDecodedBytes = await decodedBytes(firstBytes);
  // The budget holds either GIF's frames, but not both.
  const budget = firstDecodedBytes + (await decodedBytes(secondBytes)) - 1;
  // Noisy frames: their PNG files are far larger than the budget.
  let seed = 7;
  const noise = () => Array.from({ length: 40 * 40 }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return [RED, GREEN, BLUE][seed % 3];
  });
  const largeBytes = makeAnimatedGif({ width: 40, height: 40, frames: Array.from({ length: 4 }, () => ({ delayCs: 10, pixels: noise() })) });
  assert.ok((await decodedBytes(largeBytes)) > budget);

  const previousBudget = process.env.KINO_GIF_FRAME_CACHE_BYTES;
  process.env.KINO_GIF_FRAME_CACHE_BYTES = String(budget);
  let server;
  try {
    server = await startTestServer();
  } finally {
    if (previousBudget === undefined) delete process.env.KINO_GIF_FRAME_CACHE_BYTES;
    else process.env.KINO_GIF_FRAME_CACHE_BYTES = previousBudget;
  }
  t.after(server.stop);
  const { api, dataDirectory } = server;
  const framesRoot = path.join(dataDirectory, "media-frames");
  const cachedFolders = async () => (await readdir(framesRoot)).filter((name) => name !== ".partial").sort();
  await expectStatus(await api("/api/projects", { method: "POST", body: { document: makeDocument("budget-project") } }), 201, "create the project");
  async function upload(bytes, name) {
    const response = await api("/api/media?project=budget-project", {
      method: "POST", body: bytes, headers: { "Content-Type": "image/gif", "X-File-Name": name },
    });
    await expectStatus(response, 201, `upload ${name}`);
    return response.json();
  }
  async function frameColor(id, index) {
    const response = await api(`/api/media/${id}/frames/${index}.png`);
    await expectStatus(response, 200, `frame ${index} of ${id}`);
    return (await readImage(Buffer.from(await response.arrayBuffer()))).pixel(6, 4);
  }
  const first = await upload(firstBytes, "first.gif");
  const second = await upload(secondBytes, "second.gif");

  assert.deepEqual(await frameColor(first.id, 2), [...BLUE, 255]);
  // A disk cleanup removes the folder while the server still remembers the timeline.
  await rm(path.join(framesRoot, first.id), { recursive: true });
  assert.deepEqual(await frameColor(first.id, 3), [...YELLOW, 255], "the GIF is decoded again instead of failing");
  const saved = JSON.parse(await readFile(path.join(framesRoot, first.id, "timeline.json"), "utf8"));
  assert.equal(saved.bytes, firstDecodedBytes, "timeline.json records the folder's bytes");

  // Both GIFs were requested within the last minute, so the second does not push out the first
  // even though together they are over the budget (gif-frame-cache.test.mjs covers eviction itself).
  assert.deepEqual(await frameColor(second.id, 0), [...YELLOW, 255]);
  const both = [first.id, second.id].sort();
  assert.deepEqual(await cachedFolders(), both);

  // One GIF whose frames alone need more than the budget is stopped while decoding.
  const large = await upload(largeBytes, "large.gif");
  const tooLarge = await api(`/api/media/${large.id}/frames`);
  await expectStatus(tooLarge, 413, "a GIF bigger than the whole cache is refused");
  assert.deepEqual(await tooLarge.json(), { error: "This GIF is too large to decode frame by frame." });
  assert.deepEqual(await cachedFolders(), both);
  assert.deepEqual(await readdir(path.join(framesRoot, ".partial")), [], "its partial folder was removed");

  // A frame with an LZW minimum code size of 12 cannot be decoded by browsers, so it is refused.
  const badCodeSize = Buffer.from(firstBytes);
  badCodeSize[parseGif(firstBytes).frames[0].dataStart - 1] = 12;
  const bad = await upload(badCodeSize, "bad-code-size.gif");
  for (const suffix of ["", "/0.png"]) {
    const response = await api(`/api/media/${bad.id}/frames${suffix}`);
    await expectStatus(response, 422, `a GIF with LZW code size 12${suffix}`);
    assert.deepEqual(await response.json(), { error: "This GIF's frames could not be decoded." });
  }

  // A file the server cannot read gives a fixed answer; the path stays in the server log.
  if (process.getuid?.() !== 0) {
    const mediaFile = path.join(dataDirectory, "media", first.id);
    await chmod(mediaFile, 0o000);
    try {
      const unreadable = await api(`/api/media/${first.id}`);
      await expectStatus(unreadable, 500, "an unreadable media file");
      const text = await unreadable.text();
      assert.equal(text, JSON.stringify({ error: "The server could not read a file it needed." }));
      assert.ok(!text.includes(dataDirectory) && !text.includes("EACCES"), "no path or system error reaches the client");
      assert.match(server.output(), /EACCES/, "the real error is in the server log");
    } finally {
      await chmod(mediaFile, 0o600);
    }

    // A GIF the server cannot read right now is a temporary failure (500), not an undecodable GIF
    // (422), so the editor asks again; once the file is readable its frames are decoded.
    const later = await upload(secondBytes, "later.gif");
    const laterFile = path.join(dataDirectory, "media", later.id);
    await chmod(laterFile, 0o000);
    try {
      const failed = await api(`/api/media/${later.id}/frames`);
      await expectStatus(failed, 500, "frames of an unreadable GIF");
      assert.deepEqual(await failed.json(), { error: "The server could not prepare this GIF's frames. Try again later." });
    } finally {
      await chmod(laterFile, 0o600);
    }
    await expectStatus(await api(`/api/media/${later.id}/frames`), 200, "the same GIF after the file is readable again");
  }
});
