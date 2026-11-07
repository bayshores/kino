import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { presetAnimation } from "../engine/animation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerSecret = "kino-batch-integration-owner";
const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function batchDirectories(directory) {
  return new Set((await readdir(directory)).filter((name) => name.startsWith("kino-batch-")));
}

async function waitForBatchDirectories(predicate, { getDirectories = batchDirectories, timeout = 10_000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await getDirectories();
    if (predicate(latest)) return latest;
    await delay(interval);
  }
  throw new Error(`Timed out waiting for batch temporary directories: ${[...(latest ?? [])].join(", ")}`);
}

async function expectStatus(response, status, reason) {
  if (response.status !== status) {
    const detail = await response.clone().text();
    assert.equal(response.status, status, `${reason}: ${detail}`);
  }
}

function rectangleScene({ id, name, color, duration = 0.1, width = 32, height = 18 }) {
  return createScene({
    id,
    name,
    width,
    height,
    duration,
    background: "#101010",
    layers: [createLayer("rectangle", {
      id: `shape-${id}`,
      name: "Color block",
      x: 4,
      y: 4,
      width: Math.min(24, width - 8),
      height: Math.min(10, height - 8),
      fill: color,
      stroke: "#000000",
      strokeWidth: 0,
    })],
  });
}

function makeMainDocument() {
  const fast = rectangleScene({ id: "duplicate-a", name: "Same / Name", color: "#ff0000" });
  const second = rectangleScene({ id: "duplicate-b", name: "Same / Name", color: "#00ff00" });
  const unicode = rectangleScene({ id: "unicode-scene", name: "海と風 ✨", color: "#0000ff" });
  const slowLayers = Array.from({ length: 24 }, (_, index) => createLayer("rectangle", {
    id: `slow-shape-${index}`,
    name: `Moving field ${index}`,
    x: (index * 19) % 480,
    y: (index * 37) % 250,
    width: 32 + (index % 5) * 8,
    height: 18 + (index % 7) * 5,
    fill: `#${((index * 0x12345 + 0x2468ac) & 0xffffff).toString(16).padStart(6, "0")}`,
    stroke: "#000000",
    strokeWidth: 0,
  }));
  const slow = createScene({
    id: "slow-scene",
    name: "Long render",
    width: 512,
    height: 288,
    duration: 12,
    background: "#151515",
    layers: slowLayers,
  });
  return createDocument({
    id: "batch-main-project",
    name: "Batch Gallery",
    scenes: [fast, second, unicode, slow],
  });
}

function makeLottieDocument() {
  const valid = rectangleScene({ id: "lottie-valid", name: "Valid shape", color: "#ff8800" });
  // A line-by-line text animation whose width change rewraps the text: at 12 px the line break
  // splits the "->" ligature into two glyphs, and at 200 px it is one glyph again. Lottie text
  // outlines cannot change their glyph count, so this scene's Lottie job fails. (A solid to
  // gradient Color animation, and then a change in the number of lines, used to fail here;
  // both export now.)
  const caption = createLayer("text", {
    id: "unsupported-line-reflow",
    name: "Unsupported line reflow",
    x: 2,
    y: 2,
    width: 28,
    height: 12,
    text: "Pain-> wraps",
    fontSize: 8,
    fill: "#ffffff",
  });
  const reflow = presetAnimation("fade-in", caption, 0);
  reflow.duration = 0.2;
  reflow.unit = "lines";
  reflow.from.width = 12;
  reflow.to.width = 200;
  caption.animations = [reflow];
  const invalid = createScene({
    id: "lottie-invalid",
    name: "Unsupported text reflow",
    width: 32,
    height: 18,
    duration: 0.4,
    background: "#101010",
    layers: [caption],
  });
  return createDocument({ id: "batch-lottie-project", name: "Partial Lottie", scenes: [valid, invalid] });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectStoredZip(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  assert.notEqual(end, -1, "archive has a ZIP end record");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory entry is intact");
    const centralFlags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const centralCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    assert.equal(method, 0, "batch archive stores the actual exported bytes without compression");
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local file header is intact");
    assert.equal(buffer.readUInt32LE(localOffset + 14), centralCrc, "local and central CRC fields agree");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataOffset, dataOffset + compressedSize);
    assert.equal(compressedSize, size);
    assert.equal(data.length, size);
    assert.equal(crc32(data), centralCrc, `${name} bytes match the ZIP CRC`);
    if (Buffer.from(name, "utf8").some((byte) => byte > 0x7f)) assert.ok(centralFlags & 0x0800, `${name} is marked as UTF-8`);
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodePng(buffer) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const output = [];
    let errors = "";
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(`FFmpeg could not decode a batch PNG (${code ?? signal}): ${errors.trim()}`));
    });
    child.stdin.end(buffer);
  });
}

function pixel(rgba, width, x, y) {
  const offset = (y * width + x) * 4;
  return [...rgba.subarray(offset, offset + 4)];
}

function assertColor(actual, expected, message) {
  const channels = { red: [0, 1, 2], green: [1, 0, 2], blue: [2, 0, 1] }[expected];
  assert.ok(channels, `known expected color ${expected}`);
  assert.ok(actual[channels[0]] > 230 && actual[channels[1]] < 25 && actual[channels[2]] < 25,
    `${message}: decoded RGBA ${actual.join(",")}`);
}

function filenameFromDisposition(value) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value || "")?.[1];
  return encoded ? decodeURIComponent(encoded) : null;
}

test("real batch exports preserve snapshots, failures, cancellation, archives, and share scoping", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-batches-http-"));
  const batchTempDirectory = path.join(dataDirectory, "tmp");
  await mkdir(batchTempDirectory, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.KINO_PUBLIC_URL;
  delete env.KINO_SHARE_TOKEN;
  env.MOTION_DATA_DIR = dataDirectory;
  env.TMPDIR = batchTempDirectory;
  env.MOTION_HOST = "127.0.0.1";
  env.MOTION_API_PORT = String(port);
  env.KINO_OWNER_TOKEN = ownerSecret;
  let child;
  let serverOutput = "";

  async function stopServer() {
    if (!child) return;
    const current = child;
    child = null;
    if (current.exitCode === null) {
      const exited = once(current, "exit");
      current.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
      if (current.exitCode === null) current.kill("SIGKILL");
    }
  }

  async function startServer() {
    child = spawn(process.execPath, ["backend/index.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-5_000); });
    child.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-5_000); });
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Service exited during startup. ${serverOutput}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return;
      } catch (error) { lastError = error; }
      await delay(100);
    }
    throw new Error(`Service did not become ready: ${lastError?.message || serverOutput}`);
  }

  async function api(endpoint, options = {}) {
    const { owner = true, share, body: inputBody, headers: extraHeaders, ...requestOptions } = options;
    const headers = new Headers(extraHeaders);
    if (owner) headers.set("X-Kino-Owner", ownerSecret);
    if (share) headers.set("X-Kino-Share", share);
    let requestBody = inputBody;
    if (inputBody !== undefined && typeof inputBody !== "string" && !Buffer.isBuffer(inputBody)) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(inputBody);
    }
    return fetch(`${baseUrl}${endpoint}`, { ...requestOptions, headers, body: requestBody });
  }

  async function createProject(document) {
    const response = await api("/api/projects", { method: "POST", body: { document } });
    await expectStatus(response, 201, "owner creates a project");
    return response.json();
  }

  async function createShare(projectId, role, label) {
    const response = await api(`/api/projects/${projectId}/shares`, {
      method: "POST", body: { role, label },
    });
    await expectStatus(response, 201, `owner creates ${role} share`);
    return response.json();
  }

  async function createBatch(document, sceneIds, options, { share, requestId } = {}) {
    const response = await api("/api/export-batches", {
      method: "POST", ...(share ? { owner: false, share } : {}),
      body: { document, sceneIds, options, ...(requestId ? { requestId } : {}) },
    });
    await expectStatus(response, 202, "batch request is accepted");
    return (await response.json()).batch;
  }

  async function getBatch(id, options = {}) {
    const response = await api(`/api/export-batches/${id}`, options);
    await expectStatus(response, 200, "export queue is readable");
    return (await response.json()).batch;
  }

  async function waitForBatch(id, predicate, { share, timeout = 30_000, interval = 10 } = {}) {
    const deadline = Date.now() + timeout;
    let latest;
    while (Date.now() < deadline) {
      latest = await getBatch(id, share ? { owner: false, share } : {});
      if (predicate(latest)) return latest;
      await delay(interval);
    }
    throw new Error(`Timed out waiting for export queue ${id}: ${JSON.stringify(latest?.jobs)}`);
  }

  async function getJobFile(batchId, jobId, kind = "file", options = {}) {
    return api(`/api/export-batches/${batchId}/jobs/${jobId}/${kind}`, options);
  }

  async function action(batchId, input, options = {}) {
    const response = await api(`/api/export-batches/${batchId}/actions`, {
      method: "POST", ...options, body: input,
    });
    await expectStatus(response, 200, `queue action ${input.type} succeeds`);
    return (await response.json()).batch;
  }

  t.after(async () => {
    await stopServer();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();
  const originalDocument = makeMainDocument();
  const project = await createProject(originalDocument);
  assert.equal(project.revision, 1);

  for (const sceneIds of [["missing-scene"], ["duplicate-a", "duplicate-a"]]) {
    await expectStatus(await api("/api/export-batches", {
      method: "POST",
      body: { document: originalDocument, sceneIds, options: { format: "png", width: 32, height: 18 } },
    }), 400, "unknown or duplicate scene selection is rejected");
  }
  await expectStatus(await api(`/api/export-batches/${"0".repeat(36)}`), 404, "unknown queue IDs are rejected");

  const mainBatchRequestId = randomUUID();
  const mainBatchRequests = await Promise.all([1, 2].map(() => createBatch(
    originalDocument, ["duplicate-a", "duplicate-b", "unicode-scene"],
    { format: "png", width: 32, height: 18, time: 0 },
    { requestId: mainBatchRequestId },
  )));
  assert.equal(mainBatchRequests[0].id, mainBatchRequests[1].id,
    "concurrent identical request IDs coalesce into the same real export queue");
  const mainBatch = mainBatchRequests[0];
  const mainComplete = await waitForBatch(mainBatch.id, (batch) => batch.status === "complete");
  assert.deepEqual(mainComplete.jobs.map(({ status }) => status), ["completed", "completed", "completed"]);
  assert.ok(mainComplete.jobs.every(({ thumbnailReady }) => thumbnailReady), "each completed job produced its own real preview image");

  const firstFileResponse = await getJobFile(mainBatch.id, mainComplete.jobs[0].id);
  await expectStatus(firstFileResponse, 200, "completed PNG is downloadable");
  const firstFileBytes = Buffer.from(await firstFileResponse.arrayBuffer());
  const firstPng = await decodePng(firstFileBytes);
  assert.equal(firstPng.length, 32 * 18 * 4);
  assertColor(pixel(firstPng, 32, 12, 9), "red", "downloaded first scene is actual red raster output");

  const thumbnailResponse = await getJobFile(mainBatch.id, mainComplete.jobs[0].id, "thumbnail");
  await expectStatus(thumbnailResponse, 200, "thumbnail is independently downloadable");
  assert.equal(thumbnailResponse.headers.get("content-type"), "image/png");
  const thumbnailBytes = Buffer.from(await thumbnailResponse.arrayBuffer());
  const thumbnail = await decodePng(thumbnailBytes);
  const thumbnailWidth = thumbnailBytes.readUInt32BE(16);
  const thumbnailHeight = thumbnailBytes.readUInt32BE(20);
  assert.equal(thumbnail.length, thumbnailWidth * thumbnailHeight * 4);
  assert.ok(thumbnailWidth <= 150 && thumbnailHeight <= 84 && thumbnailWidth > 0 && thumbnailHeight > 0);
  assert.ok(Math.abs(thumbnailWidth / thumbnailHeight - 32 / 18) < 0.02, "thumbnail preserves the scene aspect ratio");
  assertColor(pixel(thumbnail, thumbnailWidth, Math.floor(thumbnailWidth * 0.44), Math.floor(thumbnailHeight / 2)), "red",
    "thumbnail is a real render of the same scene");
  await expectStatus(await getJobFile(mainBatch.id, "missing-job"), 404, "unknown job IDs are rejected");

  const archiveResponse = await api(`/api/export-batches/${mainBatch.id}/archive`);
  await expectStatus(archiveResponse, 200, "completed jobs form a downloadable archive");
  assert.equal(archiveResponse.headers.get("content-type"), "application/zip");
  const archiveEntries = inspectStoredZip(Buffer.from(await archiveResponse.arrayBuffer()));
  assert.deepEqual(archiveEntries.map(({ name }) => name), [
    "Same-Name (1).png",
    "Same-Name (2).png",
    "海と風.png",
  ]);
  assertColor(pixel(await decodePng(archiveEntries[0].data), 32, 12, 9), "red", "first ZIP entry contains exported bytes");

  const renamed = await action(mainBatch.id, {
    type: "rename", jobId: mainComplete.jobs[0].id, name: "Renamed 東京 / output",
  });
  assert.equal(renamed.jobs.find(({ id }) => id === mainComplete.jobs[0].id).name, "Renamed 東京 / output");
  const renamedResponse = await getJobFile(mainBatch.id, mainComplete.jobs[0].id);
  await expectStatus(renamedResponse, 200, "renamed export remains downloadable");
  assert.equal(filenameFromDisposition(renamedResponse.headers.get("content-disposition")), "Renamed 東京 - output.png");
  assert.deepEqual(Buffer.from(await renamedResponse.arrayBuffer()), firstFileBytes, "renaming changes the download name but preserves rendered bytes");

  await action(mainBatch.id, { type: "remove", jobId: mainComplete.jobs[1].id });
  await expectStatus(await getJobFile(mainBatch.id, mainComplete.jobs[1].id), 404, "a removed scene is no longer in the queue");

  const updatedDocument = structuredClone(originalDocument);
  updatedDocument.name = "Database Current Gallery";
  updatedDocument.scenes[0].layers[0].fill = "#00ff00";
  const savedUpdate = await api(`/api/projects/${originalDocument.id}`, {
    method: "PUT", body: { document: updatedDocument, revision: project.revision },
  });
  await expectStatus(savedUpdate, 200, "the saved project changes after the batch snapshot");
  const updatedProject = await savedUpdate.json();
  assert.equal(updatedProject.document.scenes[0].layers[0].fill, "#00ff00");

  const lottieDocument = makeLottieDocument();
  await createProject(lottieDocument);
  // The agent's exports (project manage exports) draw the saved project, not an earlier snapshot.
  // A draft is half the 32x18 scene, so the color block's middle is at (6, 4) of 16x9.
  const agentOut = path.join(dataDirectory, "agent-exports");
  async function exports(projectId, options) {
    const response = await api("/api/agent/project", {
      method: "POST", body: { action: "manage", id: projectId, options: { resource: "exports", ...options } },
    });
    await expectStatus(response, 200, "the agent export answers");
    const reply = await response.json();
    assert.notEqual(reply.isError, true, reply.text);
    return reply.data;
  }
  async function agentExport(projectId, options) {
    const started = await exports(projectId, { action: "start", quality: "draft", out: agentOut, ...options });
    const done = await exports(projectId, { action: "wait", batch: started.batch, timeout_s: 30 });
    assert.equal(done.status, "complete", JSON.stringify(done.jobs));
    return done;
  }
  async function agentZip(projectId, done) {
    const zipped = await exports(projectId, { action: "zip", batch: done.batch });
    await exports(projectId, { action: "close", batch: done.batch });
    return inspectStoredZip(await readFile(zipped.zip));
  }

  const selected = await agentExport(originalDocument.id, { sceneIds: ["duplicate-a", "unicode-scene"], options: { format: "png", time: 0 } });
  assert.deepEqual(selected.jobs.map(({ status }) => status), ["completed", "completed"]);
  const selectedEntries = await agentZip(originalDocument.id, selected);
  assert.deepEqual(selectedEntries.map(({ name }) => name), ["Same-Name.png", "海と風.png"]);
  assertColor(pixel(await decodePng(selectedEntries[0].data), 16, 6, 4), "green",
    "the agent ZIP contains real output from the selected saved scene");
  assertColor(pixel(await decodePng(selectedEntries[1].data), 16, 6, 4), "blue",
    "the agent ZIP contains real output from the selected Unicode-named scene");

  const all = await agentExport(originalDocument.id, { options: { format: "png", time: 0 } });
  assert.deepEqual(all.jobs.map(({ status }) => status), Array(4).fill("completed"));
  assert.deepEqual((await agentZip(originalDocument.id, all)).map(({ name }) => name), [
    "Same-Name (1).png", "Same-Name (2).png", "海と風.png", "Long-render.png",
  ]);

  const partial = await agentExport(lottieDocument.id, { options: { format: "lottie", fps: 5 } });
  assert.deepEqual(partial.jobs.map(({ status }) => status), ["completed", "failed"]);
  assert.match(partial.jobs[1].error, /changes its shaped glyph count/i);
  const partialEntries = await agentZip(lottieDocument.id, partial);
  assert.deepEqual(partialEntries.map(({ name }) => name), ["Valid-shape.json"]);
  assert.equal(JSON.parse(partialEntries[0].data.toString("utf8")).v, "5.12.2");

  const sequence = await agentExport(originalDocument.id, {
    sceneIds: ["duplicate-a", "unicode-scene"], options: { format: "png-sequence", fps: 4, duration: 0.5 },
  });
  assert.deepEqual(sequence.jobs.map(({ sceneId }) => sceneId), ["duplicate-a", "unicode-scene"]);
  const sequenceFiles = sequence.jobs.flatMap((job) => job.files);
  assert.ok(sequenceFiles.length > 2, "the agent saves multiple real frames per selected scene");
  assert.deepEqual(new Set(sequenceFiles.map((file) => path.dirname(file))), new Set([agentOut]), "frames land in the chosen folder");
  assert.equal(new Set(sequenceFiles.map((file) => path.basename(file))).size, sequenceFiles.length, "each frame has its own name");
  for (const file of sequenceFiles) {
    const bytes = await readFile(file);
    assert.equal(bytes.readUInt32BE(16), 16);
    assert.equal(bytes.readUInt32BE(20), 9);
    assert.equal((await decodePng(bytes)).length, 16 * 9 * 4);
  }
  assertColor(pixel(await decodePng(await readFile(sequence.jobs[0].files.at(-1))), 16, 6, 4), "green",
    "the sequence holds the saved scene's real final frame");
  assertColor(pixel(await decodePng(await readFile(sequence.jobs[1].files[0])), 16, 6, 4), "blue",
    "the sequence holds the selected Unicode scene");
  await exports(originalDocument.id, { action: "close", batch: sequence.batch });

  // Canceling and closing an agent export removes its work folder and saves no partial file.
  const filesBeforeCancel = await readdir(agentOut);
  const batchDirsBeforeCancel = await batchDirectories(batchTempDirectory);
  const slow = await exports(originalDocument.id, {
    action: "start", quality: "draft", out: agentOut, sceneIds: ["slow-scene"], options: { format: "gif", fps: 20 },
  });
  await waitForBatchDirectories(
    (directories) => [...directories].some((directory) => !batchDirsBeforeCancel.has(directory)),
    { getDirectories: () => batchDirectories(batchTempDirectory) },
  );
  const canceledExport = await exports(originalDocument.id, { action: "cancel", batch: slow.batch });
  assert.equal(canceledExport.status, "canceled");
  await exports(originalDocument.id, { action: "close", batch: slow.batch });
  let batchDirsAfterCancel;
  try {
    batchDirsAfterCancel = await waitForBatchDirectories(
      (directories) => [...directories].every((directory) => batchDirsBeforeCancel.has(directory)),
      // Cancellation drains the current render before removing its files. Native
      // image work can take longer while the full suite shares CPU with exports.
      { getDirectories: () => batchDirectories(batchTempDirectory), timeout: 30_000, interval: 20 },
    );
  } catch (error) {
    const latest = await batchDirectories(batchTempDirectory).catch(() => new Set());
    const safeServerOutput = serverOutput.replaceAll(ownerSecret, "[redacted]").trim() || "(none captured)";
    error.message += [
      `Batch directories before cancel: ${JSON.stringify([...batchDirsBeforeCancel].sort())}`,
      `Batch directories after timeout: ${JSON.stringify([...latest].sort())}`,
      `Service output: ${safeServerOutput}`,
    ].join("\n");
    throw error;
  }
  assert.deepEqual([...batchDirsAfterCancel].sort(), [...batchDirsBeforeCancel].sort(),
    "closing the canceled export removes the temporary export queue and its files");
  assert.deepEqual(await readdir(agentOut), filesBeforeCancel,
    "a canceled export leaves no partial file in the chosen output folder");

  const restarted = await action(mainBatch.id, {
    type: "restart", options: { format: "png", width: 64, height: 36, time: 0 },
  });
  assert.equal(restarted.name, "Batch Gallery", "the batch retains its original document snapshot name");
  assert.deepEqual(restarted.jobs.map(({ id }) => id), [mainComplete.jobs[0].id, mainComplete.jobs[2].id]);
  const restartedComplete = await waitForBatch(mainBatch.id, (batch) => batch.status === "complete");
  const restartedJob = restartedComplete.jobs.find(({ id }) => id === mainComplete.jobs[0].id);
  assert.equal(restartedJob.width, 64);
  assert.equal(restartedJob.height, 36);
  const restartedFile = await getJobFile(mainBatch.id, restartedJob.id);
  await expectStatus(restartedFile, 200, "restarted snapshot can be downloaded");
  const restartedPng = await decodePng(Buffer.from(await restartedFile.arrayBuffer()));
  assert.equal(restartedPng.length, 64 * 36 * 4);
  assertColor(pixel(restartedPng, 64, 20, 18), "red", "restart uses the original batch snapshot despite a later saved edit");

  const lottieBatch = await createBatch(lottieDocument, ["lottie-valid", "lottie-invalid"], { format: "lottie", fps: 5 });
  const lottieComplete = await waitForBatch(lottieBatch.id, (batch) => batch.status === "complete");
  assert.deepEqual(lottieComplete.jobs.map(({ status }) => status), ["completed", "failed"], "one unsupported scene does not discard its valid neighbor");
  assert.match(lottieComplete.jobs[1].error, /changes its shaped glyph count/i);
  const lottieFileResponse = await getJobFile(lottieBatch.id, lottieComplete.jobs[0].id);
  await expectStatus(lottieFileResponse, 200, "valid scene Lottie remains downloadable");
  const lottie = JSON.parse(await lottieFileResponse.text());
  assert.equal(lottie.v, "5.12.2");
  assert.equal(lottie.w, 32);
  await expectStatus(await getJobFile(lottieBatch.id, lottieComplete.jobs[1].id), 409, "failed Lottie has no fake success file");

  const cancelDocument = createDocument({
    id: "batch-cancel-project",
    name: "Cancel and resume",
    scenes: [
      rectangleScene({ id: "quick-scene", name: "Quick", color: "#ff0000", duration: 0.2, width: 64, height: 36 }),
      createScene({ id: "slow-cancel-scene", name: "Slow render", width: 512, height: 288, duration: 12, background: "#121212",
        layers: Array.from({ length: 24 }, (_, index) => createLayer("rectangle", {
          id: `cancel-shape-${index}`, name: `Shape ${index}`, x: (index * 19) % 480, y: (index * 37) % 250,
          width: 32 + (index % 5) * 8, height: 18 + (index % 7) * 5,
          fill: `#${((index * 0x23579 + 0x123456) & 0xffffff).toString(16).padStart(6, "0")}`,
          stroke: "#000000", strokeWidth: 0,
        })),
      }),
    ],
  });
  const cancelBatch = await createBatch(cancelDocument, ["quick-scene", "slow-cancel-scene"], {
    format: "gif", fps: 20, width: 512, height: 288,
  });
  const cancellationPoint = await waitForBatch(cancelBatch.id, (batch) =>
    batch.jobs[0]?.status === "completed" && batch.jobs[1]?.status === "inProgress" &&
    batch.jobs[1].stage === "render" && batch.jobs[1].progress > 0 && batch.jobs[1].progress < 1,
    { timeout: 20_000, interval: 5 },
  );
  const preservedFirstId = cancellationPoint.jobs[0].id;
  const resumedId = cancellationPoint.jobs[1].id;
  const beforeCancelFile = await getJobFile(cancelBatch.id, preservedFirstId);
  await expectStatus(beforeCancelFile, 200, "first GIF has completed before cancellation");
  const preservedBytes = Buffer.from(await beforeCancelFile.arrayBuffer());
  const canceled = await action(cancelBatch.id, { type: "cancel" });
  assert.equal(canceled.jobs[0].status, "completed");
  assert.equal(canceled.jobs[1].status, "canceled");
  assert.deepEqual(Buffer.from(await (await getJobFile(cancelBatch.id, preservedFirstId)).arrayBuffer()), preservedBytes,
    "cancel leaves completed output bytes intact");

  const resumed = await action(cancelBatch.id, { type: "resume" });
  assert.equal(resumed.jobs.find(({ id }) => id === preservedFirstId).status, "completed");
  const cancelComplete = await waitForBatch(cancelBatch.id, (batch) => batch.status === "complete", { timeout: 30_000 });
  assert.equal(cancelComplete.jobs.find(({ id }) => id === preservedFirstId).status, "completed");
  assert.equal(cancelComplete.jobs.find(({ id }) => id === resumedId).status, "completed");
  assert.deepEqual(Buffer.from(await (await getJobFile(cancelBatch.id, preservedFirstId)).arrayBuffer()), preservedBytes,
    "resume keeps the prior completed scene unchanged");
  const resumedGif = Buffer.from(await (await getJobFile(cancelBatch.id, resumedId)).arrayBuffer());
  assert.match(resumedGif.toString("ascii", 0, 6), /^GIF8[79]a$/);

  const viewA = await createShare(originalDocument.id, "view", "View A");
  const viewB = await createShare(originalDocument.id, "view", "View B");
  const foreignDocument = createDocument({
    id: "batch-foreign-project",
    name: "Foreign project",
    scenes: [rectangleScene({ id: "foreign-scene", name: "Private", color: "#ffffff" })],
  });
  await createProject(foreignDocument);
  const foreignShare = await createShare(foreignDocument.id, "view", "Foreign view");
  await expectStatus(await api("/api/export-batches", {
    method: "POST", owner: false, share: viewA.token,
    body: { document: foreignDocument, sceneIds: ["foreign-scene"], options: { format: "png", width: 32, height: 18 } },
  }), 403, "a guest cannot create a queue from another project's document");
  await expectStatus(await api(`/api/export-batches/${mainBatch.id}`, { owner: false, share: viewA.token }), 403,
    "a guest cannot read an owner-created queue");

  const forgedDocument = structuredClone(originalDocument);
  forgedDocument.name = "Forged blue document";
  forgedDocument.scenes[0].layers[0].fill = "#0000ff";
  const guestBatch = await createBatch(forgedDocument, ["duplicate-a"], { format: "png", width: 32, height: 18, time: 0 }, { share: viewA.token });
  assert.equal(guestBatch.name, "Database Current Gallery", "view-only export snapshots the saved authoritative project");
  const guestComplete = await waitForBatch(guestBatch.id, (batch) => batch.status === "complete", { share: viewA.token });
  assert.equal(guestComplete.jobs[0].name, "Same / Name");
  const guestFile = await getJobFile(guestBatch.id, guestComplete.jobs[0].id, "file", { owner: false, share: viewA.token });
  await expectStatus(guestFile, 200, "the original share can read its queue output");
  const guestPng = await decodePng(Buffer.from(await guestFile.arrayBuffer()));
  assertColor(pixel(guestPng, 32, 12, 9), "green", "view-only export uses saved pixels instead of forged request content");
  await expectStatus(await api(`/api/export-batches/${guestBatch.id}`, { owner: false, share: viewB.token }), 403,
    "another grant for the same project cannot read this queue");
  await expectStatus(await api(`/api/export-batches/${guestBatch.id}`, { owner: false, share: foreignShare.token }), 403,
    "a grant for another project cannot read this queue");
  await expectStatus(await api(`/api/export-batches/${guestBatch.id}/jobs/${guestComplete.jobs[0].id}/thumbnail`, { owner: false, share: viewB.token }), 403,
    "another grant cannot read the queue thumbnail");

  await expectStatus(await api(`/api/projects/${originalDocument.id}/shares/${viewA.grant.id}`, { method: "DELETE" }), 200,
    "owner revokes the queue's share grant");
  for (const endpoint of [
    `/api/export-batches/${guestBatch.id}`,
    `/api/export-batches/${guestBatch.id}/jobs/${guestComplete.jobs[0].id}/file`,
    `/api/export-batches/${guestBatch.id}/jobs/${guestComplete.jobs[0].id}/thumbnail`,
    `/api/export-batches/${guestBatch.id}/archive`,
  ]) {
    await expectStatus(await api(endpoint, { owner: false, share: viewA.token }), 403,
      "revoked guest cannot read queue state, files, thumbnails, or archives");
  }
  await getBatch(guestBatch.id);
  await expectStatus(await api(`/api/export-batches/${guestBatch.id}/archive`), 200, "owner can still archive completed files");
});
