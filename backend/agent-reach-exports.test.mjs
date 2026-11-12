import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { ffmpeg, ffprobe, near, readImage, readVideoFrames, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
// These tests are about reaching features; approvals (D3) are tested in dashboard tests and
// in agent-reach-workspace's approval test, so the person here allows them.
const REACH_ALLOW = ["delete-scene", "delete-project", "share-link", "final-render", "overwrite-export", "large-import"];

let server;
let projectId = "";
let projectNumber = 0;

before(async () => { server = await startTestServer({ allow: REACH_ALLOW }); });
after(() => server?.stop());

function colorScene(id, name, color, duration = 0.4) {
  return {
    id, name, width: 32, height: 16, duration, background: "#000000",
    layers: [{ id: `${id}-color`, name: `${name} color`, x: 2, y: 2, width: 28, height: 12, fill: color }],
  };
}

// Linear motion is an error the final-export check refuses; "natural" is symmetric, so the box
// is halfway at the middle either way.
function movingColorScene(id, name, color, duration = 0.4, easing = "linear") {
  const scene = colorScene(id, name, color, duration);
  scene.layers[0] = { ...scene.layers[0], x: 2, width: 8, height: 8, y: 2,
    animation: { id: `${id}-move`, name: "Move", kind: "custom", start: 0, duration,
      easing, from: { x: 2 }, to: { x: 22 } } };
  return scene;
}

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers through the agent service`);
  return response.json();
}

async function saved() {
  const response = await server.api(`/api/projects/${projectId}`);
  assert.equal(response.status, 200, "the agent-created project is saved");
  return response.json();
}

async function createProject(scenes = [colorScene("red-scene", "Red", "#ff0000"), colorScene("green-scene", "Green", "#00ff00")]) {
  projectId = `agent-export-proof-${++projectNumber}`;
  const created = await agent("project", {
    action: "create", id: projectId, name: "Agent export proof", width: 32, height: 16, duration: 1, background: "#000000",
  });
  assert.equal(created.isError, undefined, created.text);
  const dummySceneId = (await saved()).document.scenes[0].id;
  const ops = [];
  for (const scene of scenes) {
    ops.push({ op: "add_scene", properties: { id: scene.id, name: scene.name, width: scene.width, height: scene.height,
      duration: scene.duration, background: scene.background } });
    for (const layer of scene.layers) {
      const { animation, ...properties } = layer;
      ops.push({ op: "add_layer", scene: scene.id, layerType: "rectangle", properties });
      if (animation) ops.push({ op: "add_animation", scene: scene.id, layer: layer.id, animation });
    }
  }
  ops.push({ op: "delete_scene", scene: dummySceneId });
  const edited = await agent("edit", { project: projectId, ops });
  assert.equal(edited.isError, undefined, edited.text);
  const record = await saved();
  assert.deepEqual(record.document.scenes.map((scene) => scene.id), scenes.map((scene) => scene.id), "agent edit replaced the initial dummy scene");
  return { projectId, revision: record.revision, sceneIds: scenes.map((scene) => scene.id) };
}

async function manage(options) {
  return agent("project", { action: "manage", id: projectId, options: { resource: "exports", ...options } });
}

async function waitFor(batch, timeout_s = 30) {
  const reply = await manage({ action: "wait", batch, timeout_s });
  assert.equal(reply.isError, undefined, reply.text);
  assert.ok(["complete", "canceled"].includes(reply.data.status), `finished before timeout: ${reply.data.status}`);
  return reply.data;
}

async function probeMedia(file) {
  const raw = await run(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file]);
  return JSON.parse(raw.toString("utf8")).streams[0];
}

async function decodeFrames(file, width, height, decoder) {
  const raw = await run(ffmpeg, ["-v", "error", ...(decoder ? ["-c:v", decoder] : []), "-i", file,
    "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  const frameSize = width * height * 4;
  return Array.from({ length: Math.floor(raw.length / frameSize) }, (_, index) => {
    const frame = raw.subarray(index * frameSize, (index + 1) * frameSize);
    return { pixel: (x, y) => [...frame.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
  });
}

test("agent PNG export renders both scenes, saves under the agent directory, and builds a real ZIP", async () => {
  const { revision } = await createProject();
  // A draft is half the scene size unless options give a width, height or size: here they ask for full size.
  const started = await manage({ action: "start", quality: "draft", options: { profile: "png", width: 32, height: 16, time: 0 } });
  assert.equal(started.isError, undefined, started.text);
  assert.equal(started.data.rev, revision);
  assert.match(started.text, /A draft is half size at 30fps/);
  const exported = await waitFor(started.data.batch);
  assert.equal(exported.rev, revision, "the output records the saved document revision");
  assert.equal(exported.jobs.length, 2, "the default scene selection includes every ordinary scene");

  const pixels = [];
  for (const job of exported.jobs) {
    assert.equal(job.status, "completed");
    assert.ok(job.path.startsWith(path.join(server.dataDirectory, "agent", "exports")), "default output stays under agentDirectory");
    const image = await readImage(await readFile(job.path));
    assert.deepEqual([image.width, image.height], [32, 16], "a draft PNG given the scene's own width and height is that size");
    pixels.push(image.pixel(16, 8));
  }
  assert.deepEqual(pixels, [[255, 0, 0, 255], [0, 255, 0, 255]], "each saved PNG contains the rendered scene pixels");

  const zipped = await manage({ action: "zip", batch: started.data.batch });
  assert.equal(zipped.isError, undefined, zipped.text);
  const archive = await readFile(zipped.data.zip);
  assert.deepEqual(archive.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]), "zip is a real local-file archive");
  assert.ok(archive.includes(Buffer.from("Red.png")) && archive.includes(Buffer.from("Green.png")), "both scene files are archived");
  await manage({ action: "close", batch: started.data.batch });
  assert.ok(await readFile(exported.jobs[0].path), "closing the queue preserves delivered files");
});

test("agent Lottie profile passes settings through and saves actual animation JSON", async () => {
  await createProject([colorScene("lottie-scene", "Lottie", "#ff6b4a", 0.4)]);
  const output = path.join(server.dataDirectory, "requested-exports");
  const started = await manage({ action: "start", sceneIds: ["lottie-scene"], quality: "draft", out: output, options: {
    profile: "lottie", size: "1x", fps: 15, imageDPIRatio: "1x",
  } });
  assert.equal(started.isError, undefined, started.text);
  assert.equal(started.data.options.profile, "lottie");
  assert.equal(started.data.options.imageDPIRatio, "1x");
  assert.equal(started.data.output, output, "explicit output folders are honored");
  const exported = await waitFor(started.data.batch);
  const lottie = JSON.parse(await readFile(exported.jobs[0].path, "utf8"));
  assert.equal(lottie.w, 32);
  assert.equal(lottie.h, 16);
  assert.ok(lottie.layers.length > 0, "the Lottie file contains rendered scene layers");
  await manage({ action: "close", batch: started.data.batch });
});

test("PNG design view keeps the design pose while an ordinary still uses the animated pose", async () => {
  await createProject([movingColorScene("pose-scene", "Pose", "#ff0000", 0.4, "natural")]);
  // Final exports honor the size setting (a draft is always half size).
  const animatedStart = await manage({ action: "start", sceneIds: ["pose-scene"], quality: "final", options: {
    profile: "png", size: "2x", time: 0.2,
  } });
  assert.equal(animatedStart.isError, undefined, animatedStart.text);
  const animated = await waitFor(animatedStart.data.batch);
  const animatedImage = await readImage(await readFile(animated.jobs[0].path));
  assert.deepEqual([animatedImage.width, animatedImage.height], [64, 32], "the 2x size setting reaches the renderer");
  assert.deepEqual(animatedImage.pixel(8, 10), [0, 0, 0, 255], "the moving box has left its design position");
  assert.deepEqual(animatedImage.pixel(28, 10), [255, 0, 0, 255], "the ordinary still shows the pose at t=0.2");
  await manage({ action: "close", batch: animatedStart.data.batch });

  const designStart = await manage({ action: "start", sceneIds: ["pose-scene"], quality: "final", options: {
    profile: "png", size: "2x", time: 0.2, design: true,
  } });
  assert.equal(designStart.isError, undefined, designStart.text);
  assert.equal(designStart.data.options.design, true);
  const design = await waitFor(designStart.data.batch);
  const designImage = await readImage(await readFile(design.jobs[0].path));
  assert.deepEqual(designImage.pixel(8, 10), [255, 0, 0, 255], "design view shows the saved x position");
  assert.deepEqual(designImage.pixel(28, 10), [0, 0, 0, 255], "design view ignores the animated pose");
  await manage({ action: "close", batch: designStart.data.batch });
});

test("agent can deliver a PNG sequence after cancel and resume across two scenes", async () => {
  const { revision } = await createProject();
  const started = await manage({ action: "start", quality: "draft", options: {
    profile: "png-sequence", width: 32, height: 16, fps: 10,
  } });
  assert.equal(started.isError, undefined, started.text);
  const canceled = await manage({ action: "cancel", batch: started.data.batch });
  assert.equal(canceled.isError, undefined, canceled.text);
  assert.equal(canceled.data.status, "canceled", "cancel pauses the real export batch");
  const resumed = await manage({ action: "resume", batch: started.data.batch });
  assert.equal(resumed.isError, undefined, resumed.text);

  const exported = await waitFor(started.data.batch);
  assert.equal(exported.rev, revision);
  assert.deepEqual(exported.jobs.map((job) => job.status), ["completed", "completed"]);
  for (const [index, job] of exported.jobs.entries()) {
    assert.ok(job.files.length > 0, "sequence frames were copied to the destination folder");
    const image = await readImage(await readFile(job.files[0]));
    assert.deepEqual(image.pixel(8, 4), index === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]);
  }
  await manage({ action: "close", batch: started.data.batch });
  assert.ok(await readFile(exported.jobs[0].files[0]), "closing the queue preserves delivered sequence frames");
});

test("final export checks every selected scene and refuses a linear motion gate", async () => {
  const scene = movingColorScene("gated-scene", "Gated", "#ff6b4a");
  await createProject([colorScene("clean-scene", "Clean", "#3cc8b4"), scene]);
  const refused = await manage({ action: "start", sceneIds: ["clean-scene", "gated-scene"], quality: "final", options: {
    profile: "png", width: 32, height: 16,
  } });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.error, "check_failed");
  assert.match(refused.data.reason, /linear_motion/);
});

test("agent GIF and MP4 profiles retain their export options and produce probeable media", { skip: skipWithoutMediaTools }, async () => {
  await createProject([movingColorScene("media-scene", "Media", "#3cc8b4", 0.4, "natural")]);
  const gifStart = await manage({ action: "start", sceneIds: ["media-scene"], quality: "final", options: {
    profile: "gif", size: "1x", fps: 5, quality: 75, loop: false,
    playbackDirection: "reverse", gifEncoder: "gifski",
  } });
  assert.equal(gifStart.isError, undefined, gifStart.text);
  assert.equal(gifStart.data.options.profile, "gif");
  assert.equal(gifStart.data.options.size, "1x");
  assert.equal(gifStart.data.options.fps, 5);
  assert.equal(gifStart.data.options.quality, 75);
  assert.equal(gifStart.data.options.loop, false);
  assert.equal(gifStart.data.options.playbackDirection, "reverse");
  const gif = await waitFor(gifStart.data.batch);
  assert.equal(gif.jobs[0].status, "completed", gif.jobs[0].error);
  const gifProbe = await probeMedia(gif.jobs[0].path);
  assert.equal(gifProbe.codec_name, "gif");
  assert.deepEqual([gifProbe.width, gifProbe.height], [32, 16]);
  const gifFrames = await readVideoFrames(gif.jobs[0].path, { width: 32, height: 16 });
  assert.ok(gifFrames.length >= 2, "the GIF contains its reversed animation frames");
  assert.ok(near(gifFrames[0].pixel(23, 5), [60, 200, 180, 255], 30), "reverse playback starts from the scene's end pose");
  assert.ok(near(gifFrames.at(-1).pixel(3, 5), [60, 200, 180, 255], 30), "reverse playback ends at the first pose");
  await manage({ action: "close", batch: gifStart.data.batch });

  // A draft MP4 given size 1x is the scene's size, at the fps asked for up to 30.
  const mp4Start = await manage({ action: "start", sceneIds: ["media-scene"], quality: "draft", options: {
    profile: "mp4", size: "1x", fps: 60,
  } });
  assert.equal(mp4Start.isError, undefined, mp4Start.text);
  const mp4 = await waitFor(mp4Start.data.batch);
  assert.equal(mp4.jobs[0].status, "completed", mp4.jobs[0].error);
  const mp4Probe = await probeMedia(mp4.jobs[0].path);
  assert.equal(mp4Probe.codec_name, "h264");
  assert.equal(mp4Probe.width, 32);
  assert.equal(mp4Probe.height, 16);
  assert.equal(mp4Probe.r_frame_rate, "30/1");
  assert.equal(Number(mp4Probe.nb_read_frames), 12, "0.4 s at 30fps");
  await manage({ action: "close", batch: mp4Start.data.batch });
});

test("agent WebM, transparent WebM, MOV, transparent MOV and APNG profiles render and decode", { skip: skipWithoutMediaTools }, async () => {
  await createProject([movingColorScene("container-scene", "Container", "#3cc8b4", 0.4, "natural")]);
  const cases = [
    { profile: "webm", format: "webm", transparent: false },
    { profile: "webm-transparent", format: "webm", transparent: true },
    { profile: "mov", format: "mov", transparent: false },
    { profile: "mov-transparent", format: "mov", transparent: true },
    { profile: "apng", format: "apng", transparent: false, loop: false, playbackDirection: "boomerang" },
  ];
  for (const entry of cases) {
    const options = { profile: entry.profile, size: "1x", fps: entry.format === "apng" ? 5 : 15,
      ...(entry.transparent ? { transparent: true } : {}),
      ...(entry.loop !== undefined ? { loop: entry.loop, playbackDirection: entry.playbackDirection } : {}) };
    const started = await manage({ action: "start", sceneIds: ["container-scene"], quality: "final", options });
    assert.equal(started.isError, undefined, `${entry.profile}: ${started.text}`);
    assert.equal(started.data.options.profile, entry.profile);
    assert.equal(started.data.options.size, "1x");
    assert.equal(started.data.options.transparent ?? false, entry.transparent);
    if (entry.loop !== undefined) {
      assert.equal(started.data.options.loop, false);
      assert.equal(started.data.options.playbackDirection, "boomerang");
    }
    const exported = await waitFor(started.data.batch);
    assert.equal(exported.jobs[0].status, "completed", `${entry.profile}: ${exported.jobs[0].error}`);
    const stream = await probeMedia(exported.jobs[0].path);
    assert.equal(stream.codec_name, entry.format === "webm" ? "vp9" : entry.format === "mov" ? "prores" : "apng", entry.profile);
    assert.deepEqual([stream.width, stream.height], [32, 16], `${entry.profile} honors 1x size`);
    assert.equal(stream.r_frame_rate, `${options.fps}/1`, `${entry.profile} honors its frame rate`);
    assert.ok(Number(stream.nb_read_frames) >= 2, `${entry.profile} contains animation frames`);
    if (entry.transparent) {
      assert.equal(stream.tags?.alpha_mode, entry.format === "webm" ? "1" : undefined,
        `${entry.profile} preserves its alpha indication`);
      const frames = await decodeFrames(exported.jobs[0].path, 32, 16, entry.format === "webm" ? "libvpx-vp9" : undefined);
      assert.ok(frames.length > 0);
      assert.ok(frames[0].pixel(0, 0)[3] < 8, `${entry.profile} clears the canvas background`);
      assert.ok(frames[0].pixel(5, 5)[3] > 240, `${entry.profile} keeps the colored shape opaque`);
    } else {
      const frames = await readVideoFrames(exported.jobs[0].path, { width: 32, height: 16 });
      assert.ok(frames.length > 0, `${entry.profile} decodes into frames`);
      assert.ok(near(frames[0].pixel(3, 5), [60, 200, 180, 255], 30), `${entry.profile} draws the first pose`);
    }
    await manage({ action: "close", batch: started.data.batch });
  }
});

test("a relative out folder is refused for render and exports, since it would land wherever kino started", async () => {
  await createProject([colorScene("out-scene", "Out", "#ff0000")]);
  const exported = await manage({ action: "start", quality: "draft", out: "relative-exports", options: { profile: "png" } });
  assert.equal(exported.isError, true);
  assert.equal(exported.data.error, "bad_input");
  assert.match(exported.data.reason, /absolute folder path/);
  const rendered = await agent("render", { project: projectId, action: "start", out: "relative-renders" });
  assert.equal(rendered.isError, true);
  assert.equal(rendered.data.error, "bad_input");
  assert.match(rendered.data.reason, /absolute folder path/);
  const rules = await agent("library", { topic: "rules", name: "workspace" });
  assert.match(rules.text, /out\?:absolute folder\}.*A draft is half size at 30fps/);
});

test("a PNG sequence never replaces frames already in its out folder", async () => {
  await createProject([colorScene("seq-scene", "Seq", "#ff0000")]);
  const output = path.join(server.dataDirectory, "existing-frames");
  await mkdir(output, { recursive: true });
  // Frames 1 to 3 of an earlier "Seq" sequence; its frame 0 is gone.
  const earlier = ["Seq.00001.png", "Seq.00002.png", "Seq.00003.png"];
  for (const name of earlier) await writeFile(path.join(output, name), "keep-me");
  const started = await manage({ action: "start", sceneIds: ["seq-scene"], quality: "draft", out: output, options: { profile: "png-sequence" } });
  assert.equal(started.isError, undefined, started.text);
  const exported = await waitFor(started.data.batch);
  assert.equal(exported.jobs[0].status, "completed", exported.jobs[0].error ?? exported.deliveryError);
  assert.equal(exported.jobs[0].files.length, 12, "0.4 s at the draft's 30fps");
  assert.ok(exported.jobs[0].files.every((file) => path.basename(file).startsWith("Seq_1.")), "the export takes the next free name");
  for (const name of earlier) assert.equal(await readFile(path.join(output, name), "utf8"), "keep-me", `${name} is left alone`);
  assert.equal((await readdir(output)).length, 15);
  await manage({ action: "close", batch: started.data.batch });
});
