// Media coverage through project manage, project import, edit and rendered look frames.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createAgentClient } from "./agent/client.mjs";
import {
  makeAnimatedGif,
  makeToneAfterSilence,
  makeVideo,
  near,
  readImage,
  skipWithoutMediaTools,
  startTestServer,
} from "./media.test.support.mjs";
// These tests are about reaching features; approvals (D3) are tested in dashboard tests and
// in agent-reach-workspace's approval test, so the person here allows them.
const REACH_ALLOW = ["delete-scene", "delete-project", "share-link", "final-render", "overwrite-export", "large-import"];

let server;
let client;
before(async () => {
  server = await startTestServer({ allow: REACH_ALLOW });
  client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "agent-reach-media-test" });
});
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers through the agent service`);
  return response.json();
}

async function manage(id, resource, action, fields = {}) {
  const reply = await agent("project", {
    action: "manage",
    ...(id ? { id } : {}),
    options: { resource, action, ...fields },
  });
  assert.equal(reply.isError, undefined, reply.text);
  return reply;
}

async function createProject(id, { name = id, width = 64, height = 32, duration = 1, background = "#000000" } = {}) {
  const reply = await agent("project", { action: "create", id, name, width, height, duration, background });
  assert.equal(reply.isError, undefined, reply.text);
  const saved = await readProject(id);
  return saved.document.scenes[0].id;
}

async function readProject(id) {
  const response = await server.api(`/api/projects/${id}`);
  assert.equal(response.status, 200, `project ${id} can be read`);
  return response.json();
}

async function edit(project, ops) {
  const reply = await agent("edit", { project, ops });
  assert.equal(reply.isError, undefined, reply.text);
  return reply;
}

async function look(project, scene, time = 0) {
  const record = await readProject(project);
  const target = record.document.scenes.find((item) => item.id === scene);
  assert.ok(target, `scene ${scene} exists in ${project}`);
  const reply = await agent("look", { project, mode: "frame", scene, t: time, width: target.width });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.images?.[0]?.mime, "image/png", "look returns real rendered pixels");
  return readImage(Buffer.from(reply.images[0].data, "base64"));
}

function solidPng(color) {
  const canvas = createCanvas(16, 16);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, 16, 16);
  return canvas.toBuffer("image/png");
}

async function importFile(name, bytes) {
  const directory = path.join(server.dataDirectory, "agent-imports");
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, name);
  await writeFile(filename, bytes);
  return client.importFile(filename);
}

async function original(media) {
  const reply = await manage(null, "media", "original", { id: media.id });
  assert.equal(reply.data.id, media.id);
  assert.ok(reply.data.path, "original bytes are copied to the agent's private output file");
  return readFile(reply.data.path);
}

function assertSamePixels(left, right, message) {
  assert.deepEqual([left.width, left.height], [right.width, right.height], `${message}: frame dimensions match`);
  for (let y = 0; y < left.height; y += 1) for (let x = 0; x < left.width; x += 1)
    assert.deepEqual(right.pixel(x, y), left.pixel(x, y), `${message}: pixel ${x},${y}`);
}

test("agent media import, list, original bytes and cached audio peaks use real uploaded files", { skip: skipWithoutMediaTools }, async () => {
  const stillBytes = solidPng("#ff0000");
  const tonePath = path.join(server.dataDirectory, "tone-source.wav");
  await makeToneAfterSilence(tonePath, { silence: 0.2, tone: 0.4 });
  const toneBytes = await readFile(tonePath);
  const still = await importFile("original-red.png", stillBytes);
  const audio = await importFile("original-tone.wav", toneBytes);

  const listing = await manage(null, "media", "list");
  const listed = new Map(listing.data.media.map((item) => [item.id, item]));
  assert.equal(listed.get(still.id).name, "original-red.png");
  assert.equal(listed.get(still.id).mime, "image/png");
  assert.equal(listed.get(audio.id).name, "original-tone.wav");
  assert.equal(listed.get(audio.id).mime, "audio/wav");
  assert.deepEqual(await original(still), stillBytes, "the agent can recover the uploaded PNG's original bytes");
  assert.deepEqual(await original(audio), toneBytes, "the agent can recover the uploaded WAV's original bytes");

  const first = await manage(null, "media", "peaks", { id: audio.id });
  const peaks = first.data;
  assert.equal(peaks.available, true);
  assert.ok(Math.abs(peaks.duration - 0.6) < 0.01, `peaks cover the source duration (${peaks.duration}s)`);
  assert.ok(peaks.peaks.length >= 50);
  const silentBins = peaks.peaks.slice(0, 15);
  const activeBins = peaks.peaks.slice(-20);
  assert.ok(silentBins.every((peak) => peak < 0.05), "initial silence remains near zero");
  assert.ok(activeBins.some((peak) => peak > 0.5), "the later tone has measured audio peaks");
  const cached = JSON.parse(await readFile(path.join(server.dataDirectory, "media", `${audio.id}.peaks`), "utf8"));
  assert.deepEqual(cached.data, peaks, "the waveform result is saved in its sidecar cache");
  assert.deepEqual((await manage(null, "media", "peaks", { id: audio.id })).data, peaks, "repeated requests reuse the same peak result");
});

test("image, GIF, video and audio sources can be edited, replaced, played and checked in rendered frames", { skip: skipWithoutMediaTools }, async () => {
  const project = "reach-media-render";
  const scene = await createProject(project, { width: 64, height: 32, duration: 1 });
  const redPng = solidPng("#ff0000");
  const bluePng = solidPng("#0000ff");
  const red = await importFile("red-still.png", redPng);
  const blue = await importFile("blue-still.png", bluePng);
  const gifBytes = makeAnimatedGif({ width: 16, height: 16, frames: [
    { color: [255, 0, 0], delayCs: 10 },
    { color: [0, 0, 255], delayCs: 10 },
  ] });
  const gif = await importFile("red-blue.gif", gifBytes);
  const videoPath = path.join(server.dataDirectory, "red-blue.mp4");
  await makeVideo(videoPath, {
    width: 16,
    height: 16,
    fps: 10,
    frames: 4,
    frameColor: (index) => index === 0 ? [255, 0, 0] : [0, 0, 255],
  });
  const video = await client.importFile(videoPath);
  const audioPath = path.join(server.dataDirectory, "play-tone.wav");
  await makeToneAfterSilence(audioPath, { silence: 0.1, tone: 0.4 });
  const audio = await client.importFile(audioPath);

  await edit(project, [
    { op: "add_layer", scene, layerType: "image", properties: {
      id: "still", name: "Still", src: red.src, x: 0, y: 0, width: 16, height: 16,
    } },
    { op: "add_layer", scene, layerType: "image", properties: {
      id: "gif", name: "GIF", src: gif.src, mediaSourceDuration: gif.duration,
      x: 16, y: 0, width: 16, height: 16, mediaStart: 0.1, mediaDuration: 0.3,
      mediaOffset: 0.05, mediaFreeze: "both",
    } },
    { op: "add_layer", scene, layerType: "video", properties: {
      id: "video", name: "Video", src: video.src, mediaSourceDuration: video.duration,
      x: 32, y: 0, width: 16, height: 16, mediaStart: 0.1, mediaDuration: 0.3,
      mediaOffset: 0.05, mediaFreeze: "both",
    } },
    { op: "add_layer", scene, layerType: "audio", properties: {
      id: "audio", name: "Audio", src: audio.src, mediaSourceDuration: audio.duration,
      mediaStart: 0.1, mediaDuration: 0.3, mediaOffset: 0, mediaFreeze: "both", volume: 1,
    } },
  ]);
  let saved = await readProject(project);
  const layers = saved.document.scenes.find((item) => item.id === scene).layers;
  assert.deepEqual(["gif", "video", "audio"].map((id) => layers.find((item) => item.id === id).mediaFreeze), ["both", "both", "both"]);
  assert.deepEqual(["gif", "video", "audio"].map((id) => layers.find((item) => item.id === id).mediaStart), [0.1, 0.1, 0.1]);

  const beforePlay = await look(project, scene, 0.05);
  assert.ok(near(beforePlay.pixel(8, 8), [255, 0, 0, 255], 12), "the still image is drawn before Play starts");
  assert.ok(near(beforePlay.pixel(24, 8), [255, 0, 0, 255], 12), "first-freeze shows the GIF's first frame before Play");
  assert.ok(near(beforePlay.pixel(40, 8), [255, 0, 0, 255], 24), `first-freeze shows the video's first frame before Play (${beforePlay.pixel(40, 8)})`);

  const duringPlay = await look(project, scene, 0.2);
  assert.ok(near(duringPlay.pixel(24, 8), [0, 0, 255, 255], 12), "the GIF advances to its blue frame during Play");
  assert.ok(near(duringPlay.pixel(40, 8), [0, 0, 255, 255], 24), "the video advances to its blue frame during Play");
  assert.deepEqual(layers.find((item) => item.id === "audio").src, audio.src, "the audio layer is linked to the imported source");

  const afterPlay = await look(project, scene, 0.5);
  assert.ok(near(afterPlay.pixel(24, 8), [0, 0, 255, 255], 12), "last-freeze holds the GIF's final frame after Play");
  assert.ok(near(afterPlay.pixel(40, 8), [0, 0, 255, 255], 24), "last-freeze holds the video's final frame after Play");

  await edit(project, [{ op: "replace_media", scene, layer: "still", mediaId: blue.id }]);
  saved = await readProject(project);
  const replaced = saved.document.scenes.find((item) => item.id === scene).layers.find((item) => item.id === "still");
  assert.equal(replaced.src, blue.src);
  assert.deepEqual([replaced.x, replaced.y, replaced.width, replaced.height], [0, 0, 16, 16], "replace_media keeps the source layer's box");
  const afterReplace = await look(project, scene, 0.05);
  assert.ok(near(afterReplace.pixel(8, 8), [0, 0, 255, 255], 12), "the new PNG source reaches the rendered frame");

  for (const media of [red, blue, gif, video, audio]) {
    const bytes = await original(media);
    assert.ok(bytes.length > 100, `${media.name} original bytes are available`);
  }
});

test("project manage projects list filters by search and folder, and paginates the actual project list", async () => {
  await createProject("reach-list-a", { name: "Reach List Alpha" });
  await createProject("reach-list-b", { name: "Reach List Beta" });
  await createProject("reach-list-c", { name: "Other List Gamma" });
  const folder = await manage(null, "folders", "create", { name: "Reach List Folder" });
  await manage("reach-list-b", "folders", "move", { folderId: folder.data.id });

  const first = await manage(null, "projects", "list", { search: "Reach List", offset: 0, limit: 1 });
  assert.equal(first.data.total, 2, "search narrows the authoritative list");
  assert.equal(first.data.projects.length, 1);
  assert.equal(first.data.next, 1, "the response gives the next offset");
  const second = await manage(null, "projects", "list", { search: "Reach List", offset: first.data.next, limit: 1 });
  assert.equal(second.data.total, 2);
  assert.equal(second.data.next, null, "the last page has no next offset");
  assert.deepEqual(new Set([first.data.projects[0].id, second.data.projects[0].id]), new Set(["reach-list-a", "reach-list-b"]));

  const inFolder = await manage(null, "projects", "list", { search: "Reach List", folderId: folder.data.id, offset: 0, limit: 10 });
  assert.deepEqual(inFolder.data.projects.map((item) => item.id), ["reach-list-b"]);
  const drafts = await manage(null, "projects", "list", { search: "Reach List", folderId: null, offset: 0, limit: 10 });
  assert.deepEqual(drafts.data.projects.map((item) => item.id), ["reach-list-a"]);
});

test("original media bytes remain available while their only project is in Trash", async () => {
  const project = "reach-media-trash";
  const scene = await createProject(project, { width: 16, height: 16, background: "#000000" });
  const bytes = solidPng("#00ff00");
  const image = await importFile("trash-retained.png", bytes);
  await edit(project, [{ op: "add_layer", scene, layerType: "image", properties: {
    id: "source", name: "Source", src: image.src, x: 0, y: 0, width: 16, height: 16,
  } }]);
  assert.ok(near((await look(project, scene)).pixel(8, 8), [0, 255, 0, 255], 12));

  const archived = await agent("project", { action: "archive", id: project });
  assert.equal(archived.isError, undefined, archived.text);
  const trash = await manage(null, "trash", "list");
  assert.ok(trash.data.projects.some((item) => item.id === project), "the project appears in Trash");
  assert.deepEqual(await original(image), bytes, "manage original still copies the upload while referenced from Trash");
  const direct = await server.api(image.src);
  assert.equal(direct.status, 200, "the original media route remains available in Trash");
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()), bytes);

  await manage(null, "trash", "restore", { id: project });
  assert.ok(near((await look(project, scene)).pixel(8, 8), [0, 255, 0, 255], 12), "restoring keeps the rendered source intact");
});

test("static SVG import adds an image layer that renders the sanitized vector", async () => {
  const project = "reach-static-svg";
  const scene = await createProject(project, { width: 16, height: 16, background: "#000000" });
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="#00ff00"/></svg>');
  const media = await importFile("static-green.svg", source);
  assert.equal(media.mime, "image/svg+xml");
  await edit(project, [{ op: "add_layer", scene, layerType: "image", properties: {
    id: "svg-image", name: "Static SVG image", src: media.src, x: 0, y: 0, width: 16, height: 16,
  } }]);

  const saved = await readProject(project);
  const layer = saved.document.scenes.find((item) => item.id === scene).layers[0];
  assert.equal(layer.type, "image", "the static asset remains an image layer, not editable path geometry");
  assert.equal(layer.src, media.src);
  assert.ok(near((await look(project, scene)).pixel(8, 8), [0, 255, 0, 255], 12), "the uploaded vector asset reaches the rendered frame");
});

test("a duplicate retains original and peak media through source deletion, then the final deletion removes both APIs", { skip: skipWithoutMediaTools }, async () => {
  const sourceProject = "reach-media-source";
  const scene = await createProject(sourceProject, { width: 16, height: 16, background: "#000000" });
  const imageBytes = solidPng("#0000ff");
  const image = await importFile("shared-blue.png", imageBytes);
  const tonePath = path.join(server.dataDirectory, "shared-tone.wav");
  await makeToneAfterSilence(tonePath, { silence: 0.1, tone: 0.3 });
  const toneBytes = await readFile(tonePath);
  const audio = await importFile("shared-tone.wav", toneBytes);
  await edit(sourceProject, [
    { op: "add_layer", scene, layerType: "image", properties: {
      id: "picture", name: "Picture", src: image.src, x: 0, y: 0, width: 16, height: 16,
    } },
    { op: "add_layer", scene, layerType: "audio", properties: {
      id: "sound", name: "Sound", src: audio.src, mediaSourceDuration: audio.duration, mediaDuration: audio.duration,
    } },
  ]);
  const peaks = await manage(null, "media", "peaks", { id: audio.id });
  assert.equal(peaks.data.available, true);
  const sourcePixels = await look(sourceProject, scene);

  const duplicated = await agent("project", { action: "duplicate", id: sourceProject });
  assert.equal(duplicated.isError, undefined, duplicated.text);
  const copyId = duplicated.data.project;
  const copy = await readProject(copyId);
  const copyScene = copy.document.scenes[0].id;
  const beforeSourceDelete = await look(copyId, copyScene);
  assertSamePixels(sourcePixels, beforeSourceDelete, "the copied project initially renders the same source image");

  const archived = await agent("project", { action: "archive", id: sourceProject });
  assert.equal(archived.isError, undefined, archived.text);
  const sourceDeletion = await manage(null, "trash", "delete", { id: sourceProject, confirm: true });
  assert.ok(!sourceDeletion.data.deletedMediaIds.includes(image.id), "the copied project retains its image source");
  assert.ok(!sourceDeletion.data.deletedMediaIds.includes(audio.id), "the copied project retains its audio source and cached peaks");
  assert.deepEqual(await original(image), imageBytes, "the image original remains accessible after deleting the source project");
  assert.deepEqual((await manage(null, "media", "peaks", { id: audio.id })).data, peaks.data, "the copied project's cached peaks remain accessible");
  const imageRoute = await server.api(image.src);
  assert.equal(imageRoute.status, 200);
  assert.deepEqual(Buffer.from(await imageRoute.arrayBuffer()), imageBytes);
  const retainedPeakRoute = await server.api(`/api/media/${audio.id}/peaks`);
  assert.equal(retainedPeakRoute.status, 200);
  assert.deepEqual((await retainedPeakRoute.json()).peaks, peaks.data.peaks);
  assertSamePixels(beforeSourceDelete, await look(copyId, copyScene), "source deletion leaves the duplicate's pixels unchanged");

  const copyArchived = await agent("project", { action: "archive", id: copyId });
  assert.equal(copyArchived.isError, undefined, copyArchived.text);
  const finalDeletion = await manage(null, "trash", "delete", { id: copyId, confirm: true });
  assert.ok(finalDeletion.data.deletedMediaIds.includes(image.id), "the final image reference releases its source");
  assert.ok(finalDeletion.data.deletedMediaIds.includes(audio.id), "the final audio reference releases its source");
  assert.equal((await server.api(image.src)).status, 404, "the original image route disappears");
  assert.equal((await server.api(`/api/media/${audio.id}/peaks`)).status, 404, "the waveform route disappears with its source");
  const missingOriginal = await agent("project", { action: "manage", options: { resource: "media", action: "original", id: image.id } });
  const missingPeaks = await agent("project", { action: "manage", options: { resource: "media", action: "peaks", id: audio.id } });
  assert.equal(missingOriginal.isError, true, "manage original no longer lists a deleted source");
  assert.equal(missingPeaks.isError, true, "manage peaks no longer lists a deleted source");
});

test("requesting peaks for an uploaded image reports no audio without changing its project", async () => {
  const project = "reach-image-peaks";
  const scene = await createProject(project, { width: 16, height: 16 });
  const image = await importFile("no-audio.png", solidPng("#ff0000"));
  await edit(project, [{ op: "add_layer", scene, layerType: "image", properties: {
    id: "picture", name: "Picture", src: image.src, x: 0, y: 0, width: 16, height: 16,
  } }]);
  const before = await readProject(project);

  const result = await manage(project, "media", "peaks", { id: image.id });
  assert.equal(result.data.available, false);
  assert.equal(result.data.reason, "no-audio");
  const after = await readProject(project);
  assert.equal(after.revision, before.revision, "peaks do not create a document revision");
  assert.deepEqual(after.document, before.document, "peaks leave the saved project unchanged");
});

test("CSV review resolves uploaded image filenames using the same metadata as bulk apply", async () => {
  const project = "reach-media-csv-review";
  const scene = await createProject(project, { width: 16, height: 16 });
  const media = await importFile("review-red.png", solidPng("#ff0000"));
  await edit(project, [{ op: "add_layer", scene, layerType: "image", properties: {
    id: "picture", name: "Picture", src: media.src, x: 0, y: 0, width: 16, height: 16,
  } }]);
  const csv = "id,Picture\nvariant,review-red.png\n";
  const reviewed = await manage(project, "csv", "review", { scene, csv });
  assert.equal(reviewed.data.plan.errors.length, 0, "the preview recognizes the uploaded original filename");
  assert.equal(reviewed.data.plan.creates.length, 1);
  const applied = await edit(project, [{ op: "bulk_create", scene, csv }]);
  assert.match(applied.data.summaries[0].csv, /variant,review-red.png,Created/);
  const record = await readProject(project);
  const variant = record.document.scenes.find((item) => item.bulkVariant?.key === "variant");
  assert.ok(near((await look(project, variant.id)).pixel(8, 8), [255, 0, 0, 255], 12));
});

// An upload holds the file lock only to write its record, so a slow one never holds up saves; and
// one unreadable record (cut short by a crash) leaves the rest of the library listed.
test("a stalled upload does not hold up a save, and an unreadable media record does not break the media list", async () => {
  const stalled = http.request(`${server.baseUrl}/api/media`, { method: "POST",
    headers: { "content-type": "image/png", "content-length": "100000", "x-kino-owner": server.ownerToken } });
  stalled.on("error", () => {});
  stalled.write(Buffer.alloc(10));
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const created = server.api("/api/projects", { method: "POST", body: {} }).then((response) => response.status);
    assert.equal(await Promise.race([created, new Promise((resolve) => setTimeout(() => resolve("waiting"), 2000))]), 201);
  } finally { stalled.destroy(); }
  await writeFile(path.join(server.dataDirectory, "media", "0000.png.json"), "");
  const listed = await server.api("/api/media");
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray((await listed.json()).media));
});
