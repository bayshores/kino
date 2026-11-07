import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ffprobe, readImage, run, skipWithoutMediaTools } from "./media.test.support.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_TMP = path.join(ROOT, ".local", "tmp");
const PROJECT_ID = "a6-agent-render";
const OWNER_TOKEN = "a6-agent-render-test-owner";
const FORMATS = ["mp4", "webm", "mov", "gif", "png", "apng", "png-sequence", "lottie"];

async function startServer(dataDirectory) {
  const env = { ...process.env };
  delete env.KINO_PUBLIC_URL;
  delete env.KINO_SHARE_TOKEN;
  Object.assign(env, {
    HOME: dataDirectory,
    MOTION_DATA_DIR: dataDirectory,
    MOTION_HOST: "127.0.0.1",
    MOTION_API_PORT: "0",
    KINO_OWNER_TOKEN: OWNER_TOKEN,
    TMPDIR: PRIVATE_TMP,
  });
  let output = "";
  const child = spawn(process.execPath, [path.join(ROOT, "backend", "index.mjs")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8000); });

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([once(child, "exit"), delay(1000, undefined, { ref: false })]);
      }
    }
  };

  let baseUrl;
  const deadline = Date.now() + 30_000;
  while (!baseUrl) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await stop();
      throw new Error(`The agent render server exited during startup. ${output}`);
    }
    const match = output.match(/kino service: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      baseUrl = match[1];
      if (await fetch(`${baseUrl}/api/health`).then((response) => response.ok, () => false)) break;
      baseUrl = undefined;
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The agent render server did not become ready. ${output}`);
    }
    await delay(50);
  }

  function api(endpoint, body) {
    const headers = new Headers({ "X-Kino-Owner": OWNER_TOKEN });
    const options = { method: body === undefined ? "GET" : "POST", headers };
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      options.body = JSON.stringify(body);
    }
    return fetch(`${baseUrl}${endpoint}`, options);
  }
  return { api, baseUrl, child, stop, output: () => output };
}

function assertAgentReply(reply, verb) {
  assert.notEqual(reply.isError, true, `${verb} failed: ${reply.text}\n${JSON.stringify(reply.data)}`);
  return reply;
}

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

test("the agent render endpoint exports, reuses, queues, cancels, and recovers real files", {
  skip: skipWithoutMediaTools,
  timeout: 120_000,
}, async (t) => {
  await mkdir(PRIVATE_TMP, { recursive: true, mode: 0o700 });
  const dataDirectory = await mkdtemp(path.join(PRIVATE_TMP, "a6-agent-render-data-"));
  let server = await startServer(dataDirectory);
  t.after(async () => {
    await server?.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  async function agent(verb, body = {}) {
    const response = await server.api(`/api/agent/${verb}`, body);
    assert.equal(response.status, 200, `${verb} answers through the HTTP route`);
    return assertAgentReply(await response.json(), verb);
  }

  async function saved() {
    const response = await server.api(`/api/projects/${PROJECT_ID}`);
    assert.equal(response.status, 200);
    return response.json();
  }

  async function renderAndWait(options) {
    const started = await agent("render", { project: PROJECT_ID, action: "start", ...options });
    assert.match(started.data.job, /^R\d+$/);
    const done = await agent("render", { project: PROJECT_ID, action: "wait", job: started.data.job, timeout_s: 55 });
    assert.equal(done.data.status, "done", done.text);
    assert.ok(Array.isArray(done.data.files) && done.data.files.length > 0, done.text);
    for (const file of done.data.files) {
      assert.ok(file.path.startsWith(dataDirectory), `render output stays in its isolated data root: ${file.path}`);
      assert.ok((await stat(file.path)).size > 0, `${file.scene} produced a real output file`);
      assert.ok(file.validation, `${file.scene} includes its file check report`);
      assert.equal(file.validation.ok, true, JSON.stringify(file.validation));
      assert.equal(file.size, (await stat(file.path)).size);
      if (Number.isInteger(file.renderedFrames))
        assert.ok(done.text.includes(`${file.renderedFrames} new frames`), "MCP text exposes the actual rendering count");
      if (file.outputAudit) assert.match(done.text, /decoded output audit passed/);
      if (file.cached) assert.equal(file.renderedFrames, 0, "a cache hit does no frame rendering");
      else if (options.format === "lottie") assert.equal(file.renderedFrames, undefined, "native vector timelines do not claim raster frames");
      else assert.ok(file.renderedFrames > 0, "a raster cache miss reports rendered frames");
    }
    return done;
  }

  const created = await agent("project", {
    action: "create", id: PROJECT_ID, name: "A6 render proof", width: 96, height: 64,
    duration: 0.4, background: "#101820",
  });
  assert.equal(created.data.project, PROJECT_ID);
  const firstSceneId = (await saved()).document.scenes[0].id;
  const addedScene = await agent("edit", { project: PROJECT_ID, ops: [
    { op: "add_scene", name: "Second", width: 96, height: 64, duration: 0.4, background: "#101820" },
  ] });
  assert.equal(addedScene.data.rev, 2);
  const sceneIds = (await saved()).document.scenes.map((scene) => scene.id);
  assert.equal(sceneIds.length, 2);
  const [sceneA, sceneB] = sceneIds;
  assert.equal(sceneA, firstSceneId);

  const populated = await agent("edit", { project: PROJECT_ID, ops: [
    { op: "add_layer", scene: sceneA, layerType: "rectangle", name: "shape-a", properties: { x: 20, y: 16, width: 34, height: 24, fill: "#ff6b4a" } },
    { op: "add_animation", layer: "shape-a", preset: "preset-fade", start: 0.1, duration: 0.3 },
    { op: "add_layer", scene: sceneB, layerType: "rectangle", name: "shape-b", properties: { x: 38, y: 20, width: 32, height: 22, fill: "#3cc8b4" } },
    { op: "add_animation", layer: "shape-b", preset: "preset-fade", start: 0.1, duration: 0.3 },
  ] });
  assert.equal(populated.isError, undefined);

  const startTime = performance.now();
  const draftStarted = await agent("render", {
    project: PROJECT_ID, action: "start", scene: sceneA, quality: "draft", format: "mp4",
  });
  const startMs = performance.now() - startTime;
  assert.ok(startMs < 1000, `bounded 96×64 draft render start returned in ${startMs.toFixed(1)} ms`);
  t.diagnostic(`bounded draft start returned in ${startMs.toFixed(1)} ms`);
  const draftJob = draftStarted.data.job;
  const status = await agent("render", { project: PROJECT_ID, action: "status", job: draftJob });
  assert.equal(status.data.job, draftJob);
  assert.ok(["queued", "inProgress", "done", "failed", "canceled"].includes(status.data.status));
  const queue = await agent("render", { project: PROJECT_ID, action: "queue" });
  assert.ok(queue.data.jobs.some((job) => job.job === draftJob), "queue lists the started agent job");
  const draftDone = await agent("render", { project: PROJECT_ID, action: "wait", job: draftJob, timeout_s: 55 });
  assert.equal(draftDone.data.status, "done", draftDone.text);
  const draftFile = draftDone.data.files.find((file) => file.scene === sceneA);
  assert.ok(draftFile);
  assert.deepEqual({ width: draftFile.width, height: draftFile.height, fps: draftFile.fps }, { width: 48, height: 32, fps: 30 });
  assert.equal(draftFile.validation.checks.dimensions, "pass");

  // Existing export settings remain available through agent render options. Transparent PNG
  // output must retain the scene's animated content and a requested still time.
  const transparentAtStart = await renderAndWait({ project: PROJECT_ID, scene: sceneA, quality: "final", format: "png",
    options: { transparent: true, time: 0 } });
  const transparentAtMiddle = await renderAndWait({ project: PROJECT_ID, scene: sceneA, quality: "final", format: "png",
    options: { transparent: true, time: 0.2 } });
  const startImage = await readImage(await readFile(transparentAtStart.data.files[0].path));
  const middleImage = await readImage(await readFile(transparentAtMiddle.data.files[0].path));
  assert.deepEqual([startImage.width, startImage.height], [96, 64]);
  assert.deepEqual(startImage.pixel(0, 0), [0, 0, 0, 0], "transparent export omits the scene background");
  const startShapePixel = startImage.pixel(27, 20);
  const middleShapePixel = middleImage.pixel(27, 20);
  assert.ok(middleShapePixel[3] > startShapePixel[3],
    `requested PNG time evaluates the fade (${startShapePixel[3]} alpha at 0s, ${middleShapePixel[3]} at 0.2s)`);
  assert.deepEqual(middleImage.pixel(0, 0), [0, 0, 0, 0], "transparent pixels remain transparent at the requested time");

  // With no quality overrides, final is full-size. A second render with the documented
  // defaults must produce the same deterministic APNG bytes: blur 0.5 and dither enabled.
  const finalApng = await renderAndWait({ project: PROJECT_ID, scene: sceneA, quality: "final", format: "apng" });
  const finalFile = finalApng.data.files.find((file) => file.scene === sceneA);
  assert.deepEqual({ width: finalFile.width, height: finalFile.height, fps: finalFile.fps }, { width: 96, height: 64, fps: 30 });
  assert.equal(finalFile.validation.checks.dimensions, "pass");
  assert.equal(finalFile.validation.facts.frameCount, 13, "APNG includes the exact timeline endpoint");
  const explicitFinal = await renderAndWait({ project: PROJECT_ID, scene: sceneA, quality: "final", format: "apng", motionBlur: 0.5, dither: true });
  assert.equal(await hashFile(finalFile.path), await hashFile(explicitFinal.data.files[0].path), "omitted final quality settings equal motionBlur 0.5 and dither true");
  // The shutter in degrees (180° is half a frame, the default) and more moments of it (motionSamples).
  const angleFinal = await renderAndWait({ project: PROJECT_ID, scene: sceneA, quality: "final", format: "apng", options: { shutterAngle: 180 } });
  assert.equal(await hashFile(finalFile.path), await hashFile(angleFinal.data.files[0].path), "shutterAngle 180 equals motionBlur 0.5");
  const eightSamples = await renderAndWait({ project: PROJECT_ID, scene: sceneA, quality: "final", format: "apng", options: { shutterAngle: 270, motionSamples: 8 } });
  assert.equal(eightSamples.data.files[0].validation.facts.frameCount, 13);
  const conflicting = await (await server.api("/api/agent/render", { project: PROJECT_ID, action: "start", scene: sceneA, quality: "final", format: "apng",
    options: { shutterAngle: 180, motionBlur: 0.25 } })).json();
  assert.equal(conflicting.isError, true);
  assert.match(conflicting.text, /shutterAngle 180 is motionBlur 0\.5/);
  const tooMany = await (await server.api("/api/agent/render", { project: PROJECT_ID, action: "start", scene: sceneA, quality: "final", format: "apng",
    options: { motionSamples: 64 } })).json();
  assert.match(tooMany.text, /Motion samples must be from 2 to 16/);

  for (const format of FORMATS) {
    const output = await renderAndWait({ project: PROJECT_ID, scene: sceneA, quality: "draft", format });
    assert.equal(output.data.files.length, 1, `${format} returns one independent scene file`);
    const file = output.data.files[0];
    const expectedDraftSize = format === "lottie" ? { width: 96, height: 64 } : { width: 48, height: 32 };
    assert.deepEqual({ width: file.width, height: file.height }, expectedDraftSize,
      `${format} uses its draft output dimensions`);
    if (format !== "png") assert.equal(file.fps, 30, `${format} uses draft frame rate`);
  }

  const firstAllScenes = await renderAndWait({ project: PROJECT_ID, scene: "all", quality: "final", format: "mp4" });
  assert.deepEqual(firstAllScenes.data.files.map((file) => file.scene).sort(), [sceneA, sceneB].sort());
  assert.equal(new Set(firstAllScenes.data.files.map((file) => file.path)).size, 2, "each scene is a separate file");

  const change = await agent("edit", { project: PROJECT_ID, ops: [
    { op: "update_layer", layer: "shape-b", properties: { fill: "#ffd166" } },
  ] });
  assert.ok(change.data.rev > populated.data.rev);
  const afterEdit = await renderAndWait({ project: PROJECT_ID, scene: "all", quality: "final", format: "mp4" });
  assert.deepEqual(afterEdit.data.cachedScenes, [sceneA]);
  assert.deepEqual(afterEdit.data.redrawnScenes, [sceneB]);
  const cached = afterEdit.data.files.find((file) => file.scene === sceneA);
  const redrawn = afterEdit.data.files.find((file) => file.scene === sceneB);
  assert.equal(cached.cached, true);
  assert.equal(cached.renderedFrames, 0);
  assert.equal(redrawn.cached, false);
  assert.ok(redrawn.renderedFrames > 0);
  t.diagnostic(`scene:"all" edit cache: cached=${cached.scene}, redrawn=${redrawn.scene}, renderedFrames=${cached.renderedFrames}/${redrawn.renderedFrames}`);

  // A higher-rate, blurred WebM job leaves enough real encoder work to exercise cancellation.
  const cancelStart = await agent("render", {
    project: PROJECT_ID, action: "start", scene: sceneA, quality: "final", format: "webm",
    fps: 120, motionBlur: 1, dither: true,
  });
  const canceled = await agent("render", { project: PROJECT_ID, action: "cancel", job: cancelStart.data.job });
  assert.equal(canceled.data.status, "canceled", canceled.text);
  const canceledStatus = await agent("render", { project: PROJECT_ID, action: "status", job: cancelStart.data.job });
  assert.equal(canceledStatus.data.status, "canceled");

  const completedJobId = afterEdit.data.job;
  const savedFiles = afterEdit.data.files.map((file) => ({ scene: file.scene, path: file.path, size: file.size }));
  await server.stop();
  server = await startServer(dataDirectory);
  const recovered = await agent("render", { project: PROJECT_ID, action: "status", job: completedJobId });
  assert.equal(recovered.data.status, "done");
  assert.deepEqual(recovered.data.files.map(({ scene, path: filePath, size }) => ({ scene, path: filePath, size })), savedFiles);
  for (const file of recovered.data.files) assert.ok((await stat(file.path)).size > 0, "completed output remains available after restart");

  // 29.97 fps (30000/1001), as an NLE expects: a 10 s scene is 300 frames at exactly 30000/1001.
  await agent("edit", { project: PROJECT_ID, ops: [{ op: "add_scene", name: "NTSC", width: 96, height: 64, duration: 10, background: "#101820" }] });
  const ntscScene = (await saved()).document.scenes.at(-1).id;
  assert.equal((await agent("check", { project: PROJECT_ID, scene: ntscScene, fps: "29.97", pixels: false })).isError, undefined);
  const ntsc = (await renderAndWait({ project: PROJECT_ID, scene: ntscScene, quality: "draft", format: "mp4", fps: "30000/1001" })).data.files[0];
  assert.equal(ntsc.fps, 30000 / 1001);
  const probed = JSON.parse(String(await run(ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=r_frame_rate,nb_read_frames", "-of", "json", ntsc.path]))).streams[0];
  assert.deepEqual({ rate: probed.r_frame_rate, frames: Number(probed.nb_read_frames) }, { rate: "30000/1001", frames: 300 });
  // Lottie counts frames like video: 3.003 s at 23.976 is 72 frames (op 72), and the file check agrees.
  await agent("edit", { project: PROJECT_ID, ops: [{ op: "add_scene", name: "Film", width: 96, height: 64, duration: 3.003, background: "#101820" }] });
  const filmScene = (await saved()).document.scenes.at(-1).id;
  const film = (await renderAndWait({ project: PROJECT_ID, scene: filmScene, quality: "draft", format: "lottie", fps: "23.976" })).data.files[0];
  assert.equal(film.validation.ok, true, JSON.stringify(film.validation));
  assert.equal(JSON.parse(await readFile(film.path, "utf8")).op, 72);
  const bad = await (await server.api("/api/agent/render", { project: PROJECT_ID, action: "start", scene: ntscScene, fps: 29.5 })).json();
  assert.match(bad.text, /23\.976, 29\.97 or 59\.94/);
});
