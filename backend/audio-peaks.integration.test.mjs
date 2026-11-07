import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDocument, createScene } from "../engine/model.js";
import { makeToneAfterSilence, skipWithoutMediaTools, startTestServer, ffmpeg, run } from "./media.test.support.mjs";

async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("peaks enforce the media capability before reading even a populated cache", async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  for (const id of ["peaks-file-a", "peaks-file-b"]) {
    await json(await server.api("/api/projects", { method: "POST", body: { document: createDocument({ id, scenes: [createScene({ layers: [] })] }) } }), 201);
  }
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=", "base64");
  const upload = await json(await server.api("/api/media?project=peaks-file-a", { method: "POST", headers: { "Content-Type": "image/png" }, body: bytes }), 201);
  const route = `${upload.src}/peaks`;
  const own = await json(await server.api(route));
  assert.equal(own.available, false);
  const view = await json(await server.api("/api/projects/peaks-file-a/shares", { method: "POST", body: { role: "view" } }), 201);
  assert.equal((await json(await server.api(route, { owner: false, share: view.token }))).available, false);
  const other = await json(await server.api("/api/projects/peaks-file-b/shares", { method: "POST", body: { role: "view" } }), 201);
  assert.equal((await server.api(route, { owner: false, share: other.token })).status, 403);
  assert.equal((await server.api(route, { owner: false })).status, 403);
  assert.equal((await server.api("/api/media/aaaa-bbbb.wav/peaks")).status, 404);
  const listed = await json(await server.api("/api/media"));
  assert.deepEqual(listed.media.map((entry) => entry.id), [upload.id], "sidecars never become upload records");
});

test("real audio and video peaks persist and the route's disk hit does not rewrite the cache", { skip: skipWithoutMediaTools }, async (t) => {
  const server = await startTestServer();
  t.after(server.stop);
  const filename = await makeToneAfterSilence(path.join(server.dataDirectory, "tone.wav"), { silence: 0.5, tone: 1.5 });
  const upload = await json(await server.api("/api/media", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: await readFile(filename) }), 201);
  const first = await json(await server.api(`${upload.src}/peaks`));
  assert.equal(first.available, true);
  assert.equal(first.peaks.length, 200);
  const cachePath = path.join(server.dataDirectory, "media", `${upload.id}.peaks`);
  const before = (await stat(cachePath)).mtimeMs;
  assert.deepEqual(await json(await server.api(`${upload.src}/peaks`)), first);
  assert.equal((await stat(cachePath)).mtimeMs, before);
  // Replacing a media upload gives it another ID and therefore another sidecar.
  const replacement = await json(await server.api("/api/media", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: await readFile(filename) }), 201);
  assert.notEqual(replacement.id, upload.id);
  assert.equal((await json(await server.api(`${replacement.src}/peaks`))).peaks.length, 200);
  assert.ok((await stat(path.join(server.dataDirectory, "media", `${replacement.id}.peaks`))).isFile());
  const video = path.join(server.dataDirectory, "video.mp4");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=16x16:r=10:d=2", "-i", filename, "-c:v", "libx264", "-c:a", "aac", "-shortest", video]);
  const videoUpload = await json(await server.api("/api/media", { method: "POST", headers: { "Content-Type": "video/mp4" }, body: await readFile(video) }), 201);
  assert.equal((await json(await server.api(`${videoUpload.src}/peaks`))).available, true);
  const silent = path.join(server.dataDirectory, "silent.mp4");
  await run(ffmpeg, ["-v", "error", "-i", video, "-an", "-c:v", "copy", silent]);
  const silentUpload = await json(await server.api("/api/media", { method: "POST", headers: { "Content-Type": "video/mp4" }, body: await readFile(silent) }), 201);
  assert.equal((await json(await server.api(`${silentUpload.src}/peaks`))).available, false);
  // Corrupt caches are recovered instead of surfacing a route failure.
  await writeFile(cachePath, "incomplete");
  assert.equal((await json(await server.api(`${upload.src}/peaks`))).available, true);
});
