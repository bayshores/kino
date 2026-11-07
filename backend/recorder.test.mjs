// Screen recordings (backend/recorder/recorder.mjs) with the stand-in helper
// (recorder.test.stand-in.mjs), so all of it runs on Linux CI:
// - record start, mark, stop: the video joins the media library, its pointer and click data are
//   kept next to it, the work folder goes away, and a folder a crash left behind is kept too;
// - the agent path: project {action:"record"} answers, the recording added as a video layer
//   (skills/kino/references/recording.md "Editing a recording", as written) carries its data,
//   the screen-recording move draws kino's pointer, and a render shows it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createRecorder } from "./recorder/recorder.mjs";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const folders = [];
after(async () => { for (const folder of folders) await rm(folder, { recursive: true, force: true }); });

// The stand-in as a program (a recorder helper path is one executable).
async function standIn(env = {}) {
  const script = path.join(ROOT, "backend", "recorder.test.stand-in.mjs");
  const settings = Object.entries({ KINO_FFMPEG: ffmpeg, ...env }).map(([name, value]) => `${name}=${JSON.stringify(String(value))} `).join("");
  const hash = createHash("sha256").update(process.execPath).update(settings).update(await readFile(script)).digest("hex").slice(0, 16);
  const program = path.join(tmpdir(), `kino-recorder-stand-in-${hash}`);
  if (!existsSync(program)) {
    const partial = `${program}.${process.pid}`;
    await writeFile(partial, `#!/bin/sh\n${settings}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    await chmod(partial, 0o755);
    await rename(partial, program);
  }
  return program;
}

test("record start, mark and stop keep the video and its pointer data; a folder a crash left is kept next time", { skip: skipWithoutMediaTools }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-recorder-"));
  folders.push(dataRoot);
  const mediaRoot = path.join(dataRoot, "media");
  await mkdir(mediaRoot);
  let count = 0;
  const addMedia = async (file, { name, extra }) => {
    const id = `m${(count += 1)}.mp4`;
    await copyFile(file, path.join(mediaRoot, id));
    return { id, src: `/api/media/${id}`, name, ...extra };
  };
  const changes = [];
  const helper = await standIn();
  const recorder = createRecorder({ dataRoot, mediaRoot, addMedia, onChange: (state) => changes.push(state), helperPath: async () => helper });
  const started = await recorder.step({ step: "start", target: { app: "Notes" }, maxSeconds: 30 });
  assert.match(started.text, /^recording rec-\d{14}-[0-9a-f]{4}: display 1 \(stops itself after 30 s\)/);
  await assert.rejects(recorder.step({ step: "start" }), /already running/);
  assert.match((await recorder.step({ step: "mark", label: "open Export" })).text, /^mark "open Export" at \d/);
  await assert.rejects(recorder.step({ step: "mark" }), /mark needs label/);
  const done = await recorder.step({ step: "stop" });
  assert.equal(done.src, "/api/media/m1.mp4");
  assert.deepEqual([done.seconds, done.clicks, done.marks.map((mark) => mark.label)], [4, 1, ["open Export"]]);
  assert.match(done.text, /4 s, 320×200 pt, 1 clicks, 1 marks; src \/api\/media\/m1\.mp4\. Add it as a video layer/);
  const kept = JSON.parse(await readFile(path.join(mediaRoot, "m1.mp4.recording.json"), "utf8"));
  assert.deepEqual(kept.clicks, [[0.8, 200, 120, "left", "agent"]]);
  assert.deepEqual(await readdir(path.join(dataRoot, "recordings")), []);
  assert.deepEqual(changes.map((state) => state && "on"), ["on", null]);
  assert.equal((await recorder.step({ step: "status" })).state, "idle");

  // A folder left by a crash (recording.json still says recording) is kept at the next start.
  const left = path.join(dataRoot, "recordings", "rec-old.kinorec");
  await mkdir(left);
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x40:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(left, "screen.mp4")]);
  await writeFile(path.join(left, "recording.json"), JSON.stringify({ version: 1, state: "recording", frame: { width: 64, height: 40 }, scale: 1, duration: 0, video: { file: "screen.mp4" } }));
  await writeFile(path.join(left, "events.jsonl"), `${JSON.stringify({ t: 0.9, type: "move", x: 3, y: 4 })}\n{"t":1.0,"ty`);
  const fresh = createRecorder({ dataRoot, mediaRoot, addMedia, helperPath: async () => helper });
  assert.equal((await fresh.step({ step: "start" })).recovered, 1);
  assert.equal(JSON.parse(await readFile(path.join(mediaRoot, "m2.mp4.recording.json"), "utf8")).duration, 0.9);
  await fresh.step({ step: "stop" });
  await fresh.close();
  await recorder.close();
});

test("an agent records the screen, adds the recording and the screen-recording move draws kino's pointer in the render", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  const server = await startTestServer({ env: { KINO_RECORDER_HELPER: await standIn() } });
  try {
    const agent = async (verb, body) => (await server.api(`/api/agent/${verb}`, { method: "POST", body })).json();
    await agent("project", { action: "create", id: "demo", width: 640, height: 400, duration: 4 });
    assert.match((await agent("project", { action: "record", options: { step: "windows" } })).text, /^7: Notes "Plan" 200×120 pt/);
    assert.match((await agent("project", { action: "record", options: { step: "start" } })).text, /^recording rec-/);
    const stopped = await agent("project", { action: "record", options: { step: "stop" } });
    assert.equal(stopped.isError, undefined, stopped.text);
    const { src } = stopped.data;
    // The recording reference's example, as written, with this recording and a 640 × 400 scene.
    const [ops] = jsonBlocks(skillSection("Editing a recording"));
    const edit = await agent("edit", { project: "demo", ops: JSON.parse(JSON.stringify(ops).replaceAll("/api/media/<recording>.mp4", src).replace('"width":1920,"height":1080', '"width":640,"height":400')) });
    assert.equal(edit.isError, undefined, edit.text);
    const record = await (await server.api("/api/projects/demo")).json();
    const layers = record.document.scenes[0].layers;
    assert.deepEqual(layers.find((layer) => layer.name === "screen").recording.clicks, [[0.8, 200, 120, "left", "agent"]]);
    assert.ok(layers.some((layer) => layer.pin?.path?.length && layer.type === "group"), "the pointer group follows the smoothed path");
    // Zoomed in on the click at 1.6 s: the blue screen with kino's black pointer on it.
    const started = await agent("render", { project: "demo", action: "start", quality: "draft", format: "png", options: { time: 1.6 } });
    const done = await agent("render", { project: "demo", action: "wait", job: started.data.job, timeout_s: 100 });
    assert.equal(done.data.status, "done", done.text);
    const pixels = await run(ffmpeg, ["-v", "error", "-i", done.data.files[0].path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    let dark = 0;
    for (let at = 0; at < pixels.length; at += 3) if (pixels[at] < 40 && pixels[at + 1] < 40 && pixels[at + 2] < 40) dark += 1;
    assert.ok(dark > 80, `${dark} pointer pixels`);
  } finally {
    await server.stop();
  }
});
