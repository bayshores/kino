import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { startTestServer, makeAnimatedGif, makeToneAfterSilence, makeVideo, run, ffmpeg, skipWithoutMediaTools } from "./media.test.support.mjs";

const gifBytes = makeAnimatedGif({ width: 8, height: 4, frames: [{ delayCs: 10, color: [255, 0, 0] }, { delayCs: 20, color: [0, 255, 0] }] });

async function jsonResponse(response, status = 200) {
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

test("Replace Media API, original downloads, share permissions and retained sources work end to end", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  const base = createDocument({ id: "replace-media", name: "Replacement", scenes: [createScene({ id: "scene", duration: 3, layers: [] })] });
  let record = await jsonResponse(await api("/api/projects", { method: "POST", body: { document: base } }), 201);
  async function upload(name, project = base.id) {
    return jsonResponse(await api(`/api/media?project=${project}`, { method: "POST", headers: { "Content-Type": "image/gif", "X-File-Name": encodeURIComponent(name) }, body: gifBytes }), 201);
  }
  const original = await upload("été 🌊 original.gif");
  const replacement = await upload("replacement.gif");
  assert.equal(original.measurementSucceeded, true);
  assert.equal(replacement.measurementSucceeded, true);
  const layer = createLayer("image", { id: "photo", name: original.name, src: original.src, x: 2, y: 3, width: 20, height: 10, mediaDuration: 0.3, mediaSourceDuration: 0.3 });
  base.scenes[0].layers.push(layer);
  record = await jsonResponse(await api(`/api/projects/${base.id}`, { method: "PUT", body: { document: base, revision: record.revision } }));
  const link = await jsonResponse(await api(`/api/projects/${base.id}/shares`, { method: "POST", body: { role: "view" } }), 201);
  const shared = { owner: false, share: link.token };
  const info = await jsonResponse(await api(`${original.src}/metadata`, shared));
  assert.equal(info.size, gifBytes.length);
  assert.equal(info.name, original.name);
  assert.equal(info.width, 8);
  assert.equal(info.height, 4);
  assert.equal(info.frameCount, 2);
  assert.equal(info.animated, true);
  assert.equal(info.hasAudio, false);
  const downloaded = await api(`${original.src}/download`, shared);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get("content-disposition"), /attachment; filename=/);
  assert.ok(downloaded.headers.get("content-disposition").includes(`filename*=UTF-8''${encodeURIComponent(original.name)}`));
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), gifBytes);

  const op = { type: "replace_media", sceneId: "scene", layerId: "photo", mediaId: replacement.id };
  assert.equal((await api(`/api/projects/${base.id}/operations`, { ...shared, method: "POST", body: { operations: [op], revision: record.revision } })).status, 403);
  assert.equal((await api(`/api/media?project=${base.id}`, { ...shared, method: "POST", headers: { "Content-Type": "image/gif" }, body: gifBytes })).status, 403);
  assert.equal((await api(`/api/projects/${base.id}`, shared).then((r) => r.json())).revision, record.revision);

  const missing = await api(`/api/projects/${base.id}/operations`, { method: "POST", body: { operations: [{ ...op, mediaId: "55555555-5555-4555-8555-555555555555.png" }], revision: record.revision } });
  assert.equal(missing.status, 400);
  assert.equal((await api(`/api/projects/${base.id}`).then((r) => r.json())).revision, record.revision, "refusal creates no server revision");
  record = await jsonResponse(await api(`/api/projects/${base.id}/operations`, { method: "POST", body: { operations: [op], revision: record.revision } }));
  const changed = record.document.scenes[0].layers[0];
  assert.equal(changed.id, layer.id);
  assert.equal(changed.src, replacement.src);
  assert.equal(changed.name, replacement.name);
  assert.equal(changed.width, 20);
  assert.deepEqual(Buffer.from(await (await api(`${original.src}/download`, shared)).arrayBuffer()), gifBytes, "old source still downloads after replacement");
  record = await jsonResponse(await api(`/api/projects/${base.id}`, { method: "PUT", body: { document: base, revision: record.revision } }));
  assert.equal(record.document.scenes[0].layers[0].src, original.src, "undo snapshot can be saved");
  assert.equal((await api(`${replacement.src}/download`, shared)).status, 200, "redo source remains available");

  const other = createDocument({ id: "private-file", name: "Private" });
  await jsonResponse(await api("/api/projects", { method: "POST", body: { document: other } }), 201);
  const privateMedia = await upload("private.gif", other.id);
  assert.equal((await api(`${privateMedia.src}/metadata`, shared)).status, 403);
  assert.equal((await api(`${privateMedia.src}/download`, shared)).status, 403);
});

test("legacy media size and source facts are measured once and saved without discarding retention", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const media = await jsonResponse(await service.api("/api/media", { method: "POST", headers: { "Content-Type": "image/gif", "X-File-Name": "legacy.gif" }, body: gifBytes }), 201);
  const filename = path.join(service.dataDirectory, "media", `${media.id}.json`);
  const legacy = { ...media, usedInProjects: ["retained-project"] };
  delete legacy.size;
  delete legacy.measurementSucceeded;
  delete legacy.hasAudio;
  await writeFile(filename, JSON.stringify(legacy));
  const measured = await jsonResponse(await service.api(`${media.src}/metadata`));
  assert.equal(measured.size, gifBytes.length);
  assert.equal(measured.hasAudio, false);
  assert.equal(measured.measurementSucceeded, true, "a version-1 legacy record without an outcome is re-probed");
  assert.deepEqual(measured.usedInProjects, legacy.usedInProjects);
  const saved = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(saved.size, gifBytes.length);
  assert.equal(saved.measurementSucceeded, true);
  const firstStat = await stat(filename);
  await jsonResponse(await service.api(`${media.src}/metadata`));
  const secondStat = await stat(filename);
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, "the second read does not rewrite or remeasure");
});

test("replace_media refuses a zero-byte upload without changing the project", async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  const document = createDocument({ id: "replace-corrupt-media", name: "Corrupt replacement", scenes: [createScene({
    id: "scene",
    duration: 2,
    layers: [],
  })] });
  let record = await jsonResponse(await api("/api/projects", { method: "POST", body: { document } }), 201);
  const original = await jsonResponse(await api(`/api/media?project=${document.id}`, {
    method: "POST",
    headers: { "Content-Type": "image/gif", "X-File-Name": "working.gif" },
    body: gifBytes,
  }), 201);
  const layer = createLayer("image", { id: "photo", name: original.name, src: original.src, width: 20, height: 10 });
  document.scenes[0].layers.push(layer);
  record = await jsonResponse(await api(`/api/projects/${document.id}`, {
    method: "PUT",
    body: { document, revision: record.revision },
  }));
  const corrupt = await jsonResponse(await api(`/api/media?project=${document.id}`, {
    method: "POST",
    headers: { "Content-Type": "image/png", "X-File-Name": "empty.png" },
    body: Buffer.alloc(0),
  }), 201);
  assert.equal(corrupt.measurementSucceeded, false, "failed probes are stored separately from a zero duration");
  const corruptRecordPath = path.join(service.dataDirectory, "media", `${corrupt.id}.json`);
  const oldFailure = { ...corrupt, duration: 0, measurementVersion: 1 };
  delete oldFailure.measurementSucceeded;
  await writeFile(corruptRecordPath, JSON.stringify(oldFailure));
  const backfilled = await jsonResponse(await api(`${corrupt.src}/metadata`));
  assert.equal(backfilled.measurementSucceeded, false, "a version-1 legacy failure is re-probed and saved once");

  const response = await api(`/api/projects/${document.id}/operations`, {
    method: "POST",
    body: {
      revision: record.revision,
      operations: [{ type: "replace_media", sceneId: "scene", layerId: "photo", mediaId: corrupt.id }],
    },
  });
  const after = await jsonResponse(await api(`/api/projects/${document.id}`));
  assert.equal(response.status, 400, "the operation rejects an unreadable upload");
  assert.equal(after.revision, record.revision, "refusal does not create a revision");
  assert.equal(after.document.scenes[0].layers[0].src, original.src, "refusal preserves the original source");
});

test("replace_media accepts readable image, GIF, video and audio, and rejects corrupt or mismatched streams", {
  skip: skipWithoutMediaTools,
}, async (t) => {
  const service = await startTestServer();
  t.after(service.stop);
  const { api } = service;
  const document = createDocument({ id: "replace-media-kinds", name: "Media kinds", scenes: [createScene({
    id: "scene",
    duration: 3,
    layers: [],
  })] });
  let record = await jsonResponse(await api("/api/projects", { method: "POST", body: { document } }), 201);
  const canvas = createCanvas(20, 12);
  canvas.getContext("2d").fillRect(0, 0, 20, 12);
  const pngBytes = canvas.toBuffer("image/png");
  const videoPath = await makeVideo(path.join(service.dataDirectory, "clip.mp4"), {
    width: 20, height: 12, fps: 12, frames: 12, frameColor: (frame) => [frame * 10, 0, 255 - frame * 10],
  });
  const audioPath = await makeToneAfterSilence(path.join(service.dataDirectory, "tone.wav"), { silence: 0.05, tone: 0.25 });
  const videoBytes = await readFile(videoPath);
  const audioBytes = await readFile(audioPath);
  const videoAudioPath = path.join(service.dataDirectory, "audio-only.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-i", audioPath, "-vn", "-c:a", "aac", videoAudioPath]);
  const audioOnlyMp4 = await readFile(videoAudioPath);
  async function upload(name, mime, bytes) {
    return jsonResponse(await api(`/api/media?project=${document.id}`, {
      method: "POST",
      headers: { "Content-Type": mime, "X-File-Name": name },
      body: bytes,
    }), 201);
  }
  const originalImage = await upload("original.png", "image/png", pngBytes);
  const originalVideo = await upload("original.mp4", "video/mp4", videoBytes);
  const originalAudio = await upload("original.wav", "audio/wav", audioBytes);
  const gifReplacement = await upload("replacement.gif", "image/gif", gifBytes);
  const videoReplacement = await upload("replacement.mp4", "video/mp4", videoBytes);
  const audioReplacement = await upload("replacement.wav", "audio/wav", audioBytes);
  for (const media of [originalImage, originalVideo, originalAudio, gifReplacement, videoReplacement, audioReplacement])
    assert.equal(media.measurementSucceeded, true, `${media.name} is measurable and decodable`);

  document.scenes[0].layers.push(
    createLayer("image", { id: "image", name: "Image", src: originalImage.src, width: 20, height: 12 }),
    createLayer("video", { id: "video", name: "Video", src: originalVideo.src, width: 20, height: 12 }),
    createLayer("audio", { id: "audio", name: "Audio", src: originalAudio.src }),
  );
  record = await jsonResponse(await api(`/api/projects/${document.id}`, { method: "PUT", body: { document, revision: record.revision } }));
  const changed = await jsonResponse(await api(`/api/projects/${document.id}/operations`, {
    method: "POST",
    body: {
      revision: record.revision,
      operations: [
        { type: "replace_media", sceneId: "scene", layerId: "image", mediaId: gifReplacement.id },
        { type: "replace_media", sceneId: "scene", layerId: "video", mediaId: videoReplacement.id },
        { type: "replace_media", sceneId: "scene", layerId: "audio", mediaId: audioReplacement.id },
      ],
    },
  }));
  assert.deepEqual(changed.document.scenes[0].layers.map((layer) => layer.src), [gifReplacement.src, videoReplacement.src, audioReplacement.src]);

  const truncatedPng = await upload("truncated.png", "image/png", pngBytes.subarray(0, Math.max(32, Math.floor(pngBytes.length / 2))));
  const imageBytesAsVideo = await upload("image.mp4", "video/mp4", pngBytes);
  const audioBytesAsImage = await upload("audio.png", "image/png", audioBytes);
  const audioOnlyVideo = await upload("audio-only.mp4", "video/mp4", audioOnlyMp4);
  assert.equal(truncatedPng.measurementSucceeded, false, "a valid PNG signature with a truncated image body fails decode");
  assert.equal(imageBytesAsVideo.measurementSucceeded, false, "an image cannot pass as an MP4 container");
  assert.equal(audioBytesAsImage.measurementSucceeded, false, "audio streams cannot pass as an image");
  assert.equal(audioOnlyVideo.measurementSucceeded, false, "an MP4 container without video cannot replace video");

  for (const [layerId, media] of [["image", truncatedPng], ["video", audioOnlyVideo], ["video", imageBytesAsVideo], ["image", audioBytesAsImage]]) {
    const response = await api(`/api/projects/${document.id}/operations`, {
      method: "POST",
      body: {
        revision: changed.revision,
        operations: [{ type: "replace_media", sceneId: "scene", layerId, mediaId: media.id }],
      },
    });
    assert.equal(response.status, 400, `${media.name} is refused for ${layerId}`);
    const current = await jsonResponse(await api(`/api/projects/${document.id}`));
    assert.equal(current.revision, changed.revision, "an invalid source does not create a revision");
    assert.deepEqual(current.document.scenes[0].layers.map((layer) => layer.src), changed.document.scenes[0].layers.map((layer) => layer.src));
  }
});
