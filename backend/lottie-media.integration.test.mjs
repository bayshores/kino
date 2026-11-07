import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { gzipSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDocument, createLayer, createScene } from "../engine/model.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerSecret = "kino-lottie-media-integration-owner";
const ffmpeg = process.env.KINO_FFMPEG ?? process.env.OPEN_MOTION_FFMPEG ?? "ffmpeg";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(command + " failed (" + (code ?? signal) + "): " + stderr.trim()));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectStatus(response, status, reason) {
  if (response.status !== status) {
    const detail = await response.clone().text();
    assert.equal(response.status, status, reason + ": " + detail);
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function firstStoredZipEntry(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  assert.notEqual(end, -1, "the export ZIP has an end record");
  assert.equal(buffer.readUInt16LE(end + 10), 1, "one selected Lottie scene produces one ZIP member");
  let offset = buffer.readUInt32LE(end + 16);
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "ZIP central directory entry is present");
  const crc = buffer.readUInt32LE(offset + 16);
  const compressedSize = buffer.readUInt32LE(offset + 20);
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const localOffset = buffer.readUInt32LE(offset + 42);
  const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
  assert.equal(offset + 46 + nameLength + extraLength + commentLength, end);
  assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "ZIP local file header is present");
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const data = buffer.subarray(dataOffset, dataOffset + compressedSize);
  assert.equal(crc32(data), crc, "ZIP payload CRC matches the central directory");
  return { name, data };
}

function imageAsset(animation) {
  const asset = animation.assets?.find((item) => typeof item.p === "string" && item.p.startsWith("data:image/png;base64,"));
  assert.ok(asset, "Lottie JSON embeds the uploaded image as a PNG data URI");
  const bytes = Buffer.from(asset.p.slice("data:image/png;base64,".length), "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "embedded image has a PNG signature");
  return { asset, bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function decodePng(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const output = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error("FFmpeg could not decode embedded PNG (" + (code ?? signal) + "): " + stderr.trim()));
    });
    child.stdin.end(bytes);
  });
}

function audioLayer(source) {
  return createLayer("audio", {
    id: "real-audio",
    name: "Omitted soundtrack",
    src: source,
    mediaDuration: 0.25,
  });
}

function makeLottieDocument(imageSource, audioSource) {
  const image = createLayer("image", {
    id: "embedded-image",
    name: "Raster asset",
    x: 12,
    y: 10,
    width: 20,
    height: 12,
    src: imageSource,
  });
  const scene = createScene({
    id: "lottie-image-scene",
    name: "Embedded Raster",
    width: 80,
    height: 60,
    duration: 0.5,
    background: "#202020",
    layers: [image, audioLayer(audioSource)],
  });
  return createDocument({ id: "lottie-media-project", name: "Lottie Media", scenes: [scene] });
}

test("real Lottie image DPI, audio omission, gzip metadata, batches, and agent exports", async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "kino-lottie-media-"));
  const tempDirectory = path.join(dataDirectory, "tmp");
  const mediaDirectory = path.join(dataDirectory, "media-fixtures");
  await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
  await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const baseUrl = "http://127.0.0.1:" + port;
  const env = { ...process.env };
  delete env.KINO_PUBLIC_URL;
  delete env.KINO_SHARE_TOKEN;
  env.MOTION_DATA_DIR = dataDirectory;
  env.TMPDIR = tempDirectory;
  env.MOTION_HOST = "127.0.0.1";
  env.MOTION_API_PORT = String(port);
  env.KINO_OWNER_TOKEN = ownerSecret;
  const exportDirectory = path.join(dataDirectory, "agent-exports");
  let apiProcess;
  let serverOutput = "";

  async function stopServer() {
    if (!apiProcess) return;
    const current = apiProcess;
    apiProcess = null;
    if (current.exitCode === null) {
      const exited = once(current, "exit");
      current.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
      if (current.exitCode === null) current.kill("SIGKILL");
    }
  }

  async function api(route, { method = "GET", body, headers: extraHeaders, signal } = {}) {
    const headers = new Headers(extraHeaders);
    headers.set("X-Kino-Owner", ownerSecret);
    let requestBody = body;
    if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }
    return fetch(baseUrl + route, { method, headers, body: requestBody, signal });
  }

  async function startServer() {
    apiProcess = spawn(process.execPath, ["backend/index.mjs"], {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    apiProcess.stdout.setEncoding("utf8");
    apiProcess.stderr.setEncoding("utf8");
    apiProcess.stdout.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-5_000); });
    apiProcess.stderr.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-5_000); });
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() < deadline) {
      if (apiProcess.exitCode !== null) throw new Error("API service exited during startup. " + serverOutput);
      try {
        const response = await fetch(baseUrl + "/api/health");
        if (response.ok) return;
      } catch (error) { lastError = error; }
      await delay(100);
    }
    throw new Error("API service did not become ready: " + (lastError?.message || serverOutput));
  }

  async function batchSnapshot(id) {
    const response = await api("/api/export-batches/" + id);
    if (!response.ok) throw new Error("Batch read failed: " + await response.text());
    return (await response.json()).batch;
  }

  async function waitForBatch(id) {
    const deadline = Date.now() + 20_000;
    let latest;
    while (Date.now() < deadline) {
      latest = await batchSnapshot(id);
      if (latest.status === "complete") return latest;
      await delay(10);
    }
    throw new Error("Timed out waiting for Lottie batch: " + JSON.stringify(latest?.jobs));
  }

  t.after(async () => {
    await stopServer();
    assert.deepEqual(await readdir(tempDirectory), [], "server shutdown cleans temporary Lottie and batch files");
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await startServer();
  const imageTiles = [];
  for (let y = 0; y < 72; y += 1) {
    for (let x = 0; x < 120; x += 1) {
      const value = (Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x119de1f3)) & 0xffffff;
      const color = value.toString(16).padStart(6, "0");
      imageTiles.push('<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="#' + color + '"/>');
    }
  }
  const imageSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="72" viewBox="0 0 120 72">' + imageTiles.join("") + '</svg>';
  const fixturePng = Buffer.from(new Resvg(imageSvg, { font: { loadSystemFonts: false } }).render().asPng());
  assert.equal(fixturePng.readUInt32BE(16), 120);
  assert.equal(fixturePng.readUInt32BE(20), 72);
  const imageFixturePath = path.join(mediaDirectory, "generated-image.png");
  await writeFile(imageFixturePath, fixturePng);
  const audioFixturePath = path.join(mediaDirectory, "generated-tone.wav");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.25",
    "-ac", "1", "-c:a", "pcm_s16le", audioFixturePath,
  ]);
  const audioFixture = await readFile(audioFixturePath);
  assert.equal(audioFixture.toString("ascii", 0, 4), "RIFF");

  const imageUpload = await api("/api/media", {
    method: "POST",
    headers: { "Content-Type": "image/png", "X-File-Name": "generated-image.png" },
    body: fixturePng,
  });
  await expectStatus(imageUpload, 201, "Resvg PNG fixture uploads as real media");
  const imageMedia = await imageUpload.json();
  const audioUpload = await api("/api/media", {
    method: "POST",
    headers: { "Content-Type": "audio/wav", "X-File-Name": "generated-tone.wav" },
    body: audioFixture,
  });
  await expectStatus(audioUpload, 201, "FFmpeg tone uploads as real audio media");
  const audioMedia = await audioUpload.json();
  const document = makeLottieDocument(imageMedia.src, audioMedia.src);
  const projectResponse = await api("/api/projects", { method: "POST", body: { document } });
  await expectStatus(projectResponse, 201, "owner saves an image and audio Lottie project");
  const project = await projectResponse.json();
  assert.equal(project.document.id, document.id);

  const sourcePng = { width: 120, height: 72 };
  const expectedSizes = {
    "1x": { width: 20, height: 12 },
    "2x": { width: 40, height: 24 },
    "3x": { width: 60, height: 36 },
    original: sourcePng,
  };

  async function exportDirect(imageDPIRatio) {
    const options = { format: "lottie", ...(imageDPIRatio ? { imageDPIRatio } : {}) };
    return api("/api/export", {
      method: "POST",
      body: { document, sceneId: "lottie-image-scene", options },
    });
  }

  await expectStatus(await exportDirect("4x"), 400, "unsupported Lottie DPI ratio is rejected");
  await expectStatus(await api("/api/export", {
    method: "POST",
    body: { document, sceneId: "lottie-image-scene", options: { format: "png", imageDPIRatio: "2x" } },
  }), 400, "image DPI options are rejected for non-Lottie exports");

  async function inspectDirectExport(response, expectedSize, label) {
    await expectStatus(response, 200, label + " is rendered");
    assert.match(response.headers.get("content-type") || "", /application\/json/i);
    const warnings = JSON.parse(response.headers.get("x-kino-export-warnings") || "[]");
    assert.deepEqual(warnings.map(({ code }) => code), ["lottie-audio-omitted"]);
    const bytes = Buffer.from(await response.arrayBuffer());
    const lottie = JSON.parse(bytes.toString("utf8"));
    assert.equal(lottie.w, 80, "Lottie composition width stays at the scene width");
    assert.equal(lottie.h, 60, "Lottie composition height stays at the scene height");
    const image = imageAsset(lottie);
    assert.deepEqual({ width: image.width, height: image.height }, expectedSize, label + " embedded bitmap resolution");
    const pixels = await decodePng(image.bytes);
    assert.equal(pixels.length, image.width * image.height * 4, label + " embedded PNG decodes independently");
    const advertisedGzipSize = Number(response.headers.get("x-kino-gzip-size"));
    assert.equal(advertisedGzipSize, gzipSync(bytes).length, label + " gzip-size response header matches independent gzip");
    assert.ok(advertisedGzipSize > 0);
    return { bytes, lottie, image, warnings, gzipSize: advertisedGzipSize };
  }

  const variants = new Map();
  for (const ratio of ["1x", "2x", "3x", "original"]) {
    const exported = await inspectDirectExport(await exportDirect(ratio), expectedSizes[ratio], "direct " + ratio);
    variants.set(ratio, exported);
  }
  const defaultExport = await inspectDirectExport(await exportDirect(), expectedSizes["3x"], "direct default");
  assert.deepEqual(defaultExport.image.bytes, variants.get("3x").image.bytes,
    "omitting imageDPIRatio uses the same 3x embedded bitmap");
  assert.deepEqual(
    [...variants.values()].map(({ image }) => image.width + "x" + image.height),
    ["20x12", "40x24", "60x36", "120x72"],
    "each supported DPI choice produces its real expected bitmap resolution",
  );

  const batchCreate = await api("/api/export-batches", {
    method: "POST",
    body: {
      document,
      sceneIds: ["lottie-image-scene"],
      options: { format: "lottie", imageDPIRatio: "2x" },
    },
  });
  await expectStatus(batchCreate, 202, "Lottie image batch is accepted");
  const batch = (await batchCreate.json()).batch;
  const completedBatch = await waitForBatch(batch.id);
  const batchJob = completedBatch.jobs[0];
  assert.equal(batchJob.status, "completed");
  assert.deepEqual(batchJob.warnings?.map(({ code }) => code), ["lottie-audio-omitted"]);
  assert.ok(batchJob.gzipSize > 0, "batch job exposes the Lottie gzip size");
  const batchFileResponse = await api("/api/export-batches/" + batch.id + "/jobs/" + batchJob.id + "/file");
  await expectStatus(batchFileResponse, 200, "completed Lottie batch JSON is downloadable");
  const batchBytes = Buffer.from(await batchFileResponse.arrayBuffer());
  const batchLottie = JSON.parse(batchBytes.toString("utf8"));
  assert.equal(batchJob.gzipSize, gzipSync(batchBytes).length, "batch gzip metadata matches its downloaded JSON");
  assert.deepEqual({ width: imageAsset(batchLottie).width, height: imageAsset(batchLottie).height }, expectedSizes["2x"]);
  assert.equal(batchJob.size, batchBytes.length, "batch output size reports the real downloaded Lottie file");
  const tempBeforeAgent = await readdir(tempDirectory);
  assert.equal(tempBeforeAgent.filter((name) => name.startsWith("kino-batch-")).length, 1);

  // The agent's exports (project manage exports) save the same Lottie files and metadata.
  async function exports(options) {
    const response = await api("/api/agent/project", {
      method: "POST", body: { action: "manage", id: document.id, options: { resource: "exports", ...options } },
    });
    await expectStatus(response, 200, "the agent export answers");
    return response.json();
  }
  async function agentExport(imageDPIRatio) {
    const started = await exports({ action: "start", sceneIds: ["lottie-image-scene"], quality: "draft", out: exportDirectory,
      options: { format: "lottie", imageDPIRatio } });
    assert.notEqual(started.isError, true, started.text);
    const done = await exports({ action: "wait", batch: started.data.batch, timeout_s: 30 });
    assert.equal(done.data.status, "complete", done.text);
    return done.data;
  }

  const agentOne = await agentExport("1x");
  const agentJob = agentOne.jobs[0];
  assert.equal(agentJob.sceneId, "lottie-image-scene");
  assert.equal(agentJob.status, "completed");
  assert.deepEqual(agentJob.warnings?.map(({ code }) => code), ["lottie-audio-omitted"]);
  assert.ok(agentJob.gzipSize > 0);
  const agentBytes = await readFile(agentJob.path);
  assert.equal((await stat(agentJob.path)).size, agentJob.size);
  assert.equal(agentJob.gzipSize, gzipSync(agentBytes).length);
  const agentJson = JSON.parse(agentBytes.toString("utf8"));
  assert.deepEqual({ width: imageAsset(agentJson).width, height: imageAsset(agentJson).height }, expectedSizes["1x"]);
  assert.equal(agentJson.w, 80);
  assert.equal(agentJson.h, 60);
  await exports({ action: "close", batch: agentOne.batch });

  const agentTwo = await agentExport("2x");
  const zipped = await exports({ action: "zip", batch: agentTwo.batch });
  assert.notEqual(zipped.isError, true, zipped.text);
  const zippedLottie = firstStoredZipEntry(await readFile(zipped.data.zip));
  const zippedJson = JSON.parse(zippedLottie.data.toString("utf8"));
  assert.deepEqual({ width: imageAsset(zippedJson).width, height: imageAsset(zippedJson).height }, expectedSizes["2x"]);
  assert.equal(zippedJson.w, 80);
  assert.equal(zippedJson.h, 60);
  assert.deepEqual(agentTwo.jobs[0].warnings?.map(({ code }) => code), ["lottie-audio-omitted"]);
  assert.equal(agentTwo.jobs[0].gzipSize, gzipSync(zippedLottie.data).length,
    "the export metadata describes the real Lottie JSON inside its ZIP");
  await exports({ action: "close", batch: agentTwo.batch });
  assert.deepEqual(await readdir(tempDirectory), tempBeforeAgent,
    "closing the agent's exports removes their server-side Lottie batch temp directories");

  const deletedBatch = await api("/api/export-batches/" + batch.id, { method: "DELETE" });
  await expectStatus(deletedBatch, 200, "owner closes the inspected batch");
  assert.deepEqual(await readdir(tempDirectory), [], "the closed batch and resized image files leave no temporary output");

  const invalidRatio = await exports({ action: "start", sceneIds: ["lottie-image-scene"], quality: "draft", out: exportDirectory,
    options: { format: "lottie", imageDPIRatio: "4x" } });
  // The ratio is refused before anything is queued.
  assert.equal(invalidRatio.isError, true);
  assert.match(invalidRatio.text, /must be 1x, 2x, 3x, or original/);
});
