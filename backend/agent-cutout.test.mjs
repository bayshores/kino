// cut_out through the agent service (POST /api/agent/<verb>) on a real server:
// - every example in skills/kino/references/cutout.md "Subject cut-out" runs as written, with
//   footage made in code: the layers it makes, their order, files, Play fields and receipts;
// - the title example renders with the subject in front of the title (MP4 export, checked pixel
//   by pixel where the subject is known to be; a PNG without the subject shows the title
//   crossing it), and history revert takes it away;
// - the op's own example (op-examples.mjs), refusals in plain words, frames with no subject,
//   and a long cut-out answering CUTOUT_RUNNING, then the finished one at once;
// - the cut_outs of one edit sharing one wait, a finished cut-out answering at once while another
//   is being made, and the next step without an engine (build the helper, or mask with a shape).
// The server uses the stand-in helper (cutout.test.stand-in.mjs, which keys red) so all of this
// runs on Linux CI too; the last test runs the title example with Apple Vision on macOS.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { runCutOut } from "./agent/cutout-operation.mjs";
import { EXAMPLE_PROJECT, OP_EXAMPLES } from "./agent/op-examples.mjs";
import { createCutoutMedia } from "./cutout/media.mjs";
import { cutoutHelperPath } from "./cutout/cutout.mjs";
import { makeBallClip, skipWithoutVision, standInHelper, visionHelper } from "./cutout.test.support.mjs";
import { ffmpeg, ffprobe, makeAnimatedGif, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

let server;
let folder;
const clips = {};
before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "kino-cutout-agent-"));
  if (skipWithoutMediaTools) return;
  server = await startTestServer({ env: { KINO_CUTOUT_HELPER: await standInHelper() } });
  // A red ball resting for a moment, then rolling right (320 × 180, 30 fps, 2 s). Each clip
  // rests for a different time, so each is a different file with a matte of its own.
  for (const [name, still] of [["runner", 0.5], ["dancer", 0.4], ["guest", 0.6]])
    clips[name] = await makeBallClip(path.join(folder, `${name}.mp4`), { width: 320, height: 180, seconds: 2, still, look: "red" });
  // talk has sound, which stays with the clip.
  const silent = await makeBallClip(path.join(folder, "talk-silent.mp4"), { width: 320, height: 180, seconds: 2, still: 0.5, look: "red" });
  clips.talk = { ...silent, path: path.join(folder, "talk.mp4") };
  await run(ffmpeg, ["-v", "error", "-y", "-i", silent.path, "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-c:a", "aac", "-shortest", clips.talk.path]);
  clips.portrait = await makeBallClip(path.join(folder, "portrait.png"), { width: 320, height: 180, seconds: 0, look: "red" });
  clips.city = { path: path.join(folder, "city.mp4") };
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", clips.city.path]);
});
after(async () => {
  await server?.stop();
  await queued?.stop();
  await rm(folder, { recursive: true, force: true });
});

// A server whose helper takes 40 ms a picture, so a 2 s clip takes about 2.7 s to cut out, and
// whose edits wait 2 s: each clip takes longer than an edit waits, as a long one does at 50 s.
let queued;
async function queuedServer() {
  queued ??= await startTestServer({ env: { KINO_CUTOUT_HELPER: await standInHelper({ KINO_STAND_IN_DELAY_MS: 40 }), KINO_CUTOUT_WAIT_S: "2" } });
  return queued;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function agentOn(target, verb, body = {}) {
  const response = await target.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}
const agent = (verb, body) => agentOn(server, verb, body);

async function upload(target, file, name, mime) {
  const response = await target.api("/api/media", { method: "POST", headers: { "content-type": mime, "x-file-name": name }, body: await readFile(file) });
  assert.equal(response.status, 201, await response.clone().text());
  const media = await response.json();
  return media.media ?? media;
}

async function sceneLayers(target, project) {
  const record = await (await target.api(`/api/projects/${project}`)).json();
  return { revision: record.revision, layers: record.document.scenes[0].layers, clipLinks: record.document.clipLinks ?? [] };
}

const mediaFile = (target, src) => path.join(target.dataDirectory, "media", src.split("/").pop());
const mediaRecord = async (target, src) => JSON.parse(await readFile(`${mediaFile(target, src)}.json`, "utf8"));
const byName = (layers, name) => layers.find((layer) => layer.name === name);
const names = (layers) => layers.filter((layer) => !layer.parentId).map((layer) => layer.name);

async function streams(file) {
  return JSON.parse(String(await run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", file]))).streams.map((stream) => stream.codec_type);
}

async function render(target, project, format, options) {
  const started = await agentOn(target, "render", { project, action: "start", quality: "draft", format, ...(options ? { options } : {}) });
  assert.equal(started.isError, undefined, started.text);
  const done = await agentOn(target, "render", { project, action: "wait", job: started.data.job, timeout_s: 110 });
  assert.equal(done.data.status, "done", done.text);
  return done.data.files[0].path;
}

/** RGB bytes of frame `index` of a file (an exported MP4, or a PNG's only frame). */
async function frameAt(file, index, { width, height }) {
  const pixels = await run(ffmpeg, ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${index})`, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  assert.equal(pixels.length, width * height * 3);
  return pixels;
}

// Inside the ball (2 px in from its edge, in the export's pixels): how many pixels are the title's
// white, and how many are the ball's red.
function insideBall(pixels, width, where, scale) {
  let white = 0, red = 0, all = 0;
  const cx = where.cx * scale, cy = where.cy * scale, r = where.r * scale - 2;
  for (let y = Math.ceil(cy - r); y <= cy + r; y += 1)
    for (let x = Math.ceil(cx - r); x <= cx + r; x += 1) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
      const at = (y * width + x) * 3;
      all += 1;
      if (pixels[at] > 200 && pixels[at + 1] > 200 && pixels[at + 2] > 200) white += 1;
      if (pixels[at] > 170 && pixels[at + 1] < 80 && pixels[at + 2] < 80) red += 1;
    }
  return { white, red, all };
}

test("the subject cut-out examples in the kino skill run as written", { skip: skipWithoutMediaTools, timeout: 240_000 }, async (t) => {
  const blocks = jsonBlocks(skillSection("Subject cut-out"));
  assert.equal(blocks.length, 5);
  const sources = {};
  for (const [name, clip] of Object.entries(clips)) {
    const file = path.basename(clip.path);
    sources[name] = (await upload(server, clip.path, file, file.endsWith(".png") ? "image/png" : "video/mp4")).src;
  }
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  const replies = [];
  for (const [index, block] of blocks.entries()) {
    let text = JSON.stringify(block);
    for (const [name, src] of Object.entries(sources)) text = text.replace(new RegExp(`/api/media/<${name}>\\.[a-z0-9]+`, "g"), src);
    assert.doesNotMatch(text, /\/api\/media\/</, `block ${index} uses only files made here`);
    await agent("project", { action: "create", id: `cutout-${index}`, name: `Cut-out ${index}`, width: 1920, height: 1080, duration: 2 });
    const reply = await client.call("edit", { project: `cutout-${index}`, ops: JSON.parse(text) });
    assert.equal(reply.isError, undefined, reply.text);
    assert.equal(reply.data.fixed, undefined, `kino did not have to fix block ${index}: ${reply.data.fixed}`);
    replies.push(reply);
    // The cli lets go of the layers it made (crew locks), so another agent can revert them.
    await client.call("notes", { project: `cutout-${index}`, action: "release" });
  }

  // Title behind the subject: runner, title, then the runner's subject on top.
  const { layers: title } = await sceneLayers(server, "cutout-0");
  assert.deepEqual(names(title), ["runner", "title", "runner-subject"]);
  const runner = byName(title, "runner"), subject = byName(title, "runner-subject");
  assert.equal(subject.type, "video");
  assert.match(subject.src, /\.webm$/);
  assert.deepEqual(await mediaRecord(server, subject.src).then((record) => [record.name, record.mime]), ["runner (subject).webm", "video/webm"]);
  for (const field of ["x", "y", "width", "height", "mediaStart", "mediaDuration", "mediaOffset", "rotation", "opacity"])
    assert.deepEqual(subject[field], runner[field], field);
  assert.equal(subject.allowOverlap, true, "the quality check knows the overlap is on purpose");
  assert.equal(runner.src, sources.runner, "the clip itself is unchanged");
  const receipt = replies[0].data.cutout;
  assert.deepEqual({ ...receipt, seconds: undefined }, { engine: "subject", output: "subject", frames: 60, cached: false, seconds: undefined });
  assert.match(replies[0].text, /"cutout":\{"engine":"subject","output":"subject","frames":60,"seconds":[\d.]+,"cached":false\}/);

  // Outline or glow: dancer, glow, outline, subject. The matte is found once and reused.
  const { layers: glow } = await sceneLayers(server, "cutout-1");
  assert.deepEqual(names(glow), ["dancer", "glow", "outline", "dancer-subject"]);
  assert.deepEqual(replies[1].data.cutout.map((entry) => [entry.output, entry.cached]), [["silhouette", false], ["silhouette", true], ["subject", true]]);
  assert.notEqual(byName(glow, "glow").src, byName(glow, "outline").src, "two silhouettes with different settings are two files");
  assert.equal((await mediaRecord(server, byName(glow, "glow").src)).name, "dancer (silhouette).webm");

  // New or blurred background: the clip blurred under its sharp subject; a backdrop between.
  const { layers: talk } = await sceneLayers(server, "cutout-2");
  assert.deepEqual(names(talk), ["talk", "talk-subject"]);
  assert.deepEqual([byName(talk, "talk").blur, byName(talk, "talk-subject").blur], [30, 0]);
  assert.deepEqual(await streams(mediaFile(server, byName(talk, "talk").src)), ["video", "audio"]);
  assert.deepEqual(await streams(mediaFile(server, byName(talk, "talk-subject").src)), ["video"], "the cut-out has no sound; the clip keeps playing it");
  const { layers: guest } = await sceneLayers(server, "cutout-3");
  assert.deepEqual(names(guest), ["guest", "backdrop", "guest-subject"]);
  // history revert takes the edit back like any other (a note from you ends the agent's turn).
  await agent("notes", { project: "cutout-3", action: "add", text: "Keep the original background", by: "you" });
  const reverted = await agent("history", { project: "cutout-3", action: "revert", turn: replies[3].data.turn });
  assert.equal(reverted.isError, undefined, reverted.text);
  assert.deepEqual(names((await sceneLayers(server, "cutout-3")).layers), []);

  // A matte for masks: the matte (a PNG, white subject on black) masks the city clip.
  const { layers: exposure } = await sceneLayers(server, "cutout-4");
  const matte = byName(exposure, "portrait-matte"), group = byName(exposure, "double exposure");
  assert.match(matte.src, /\.png$/);
  assert.equal((await mediaRecord(server, matte.src)).name, "portrait (matte).png");
  assert.equal(matte.isMask, true);
  assert.equal(matte.parentId, group.id);
  assert.equal(byName(exposure, "city").parentId, group.id);
  assert.deepEqual(names(exposure), ["portrait", "double exposure"]);

  // The render: inside the ball there is no white title, only the ball's red. Draft exports are
  // half size (960 × 540), so a clip pixel (320 × 180 shown at 1920 × 1080) is 3 export pixels.
  const size = { width: 960, height: 540 };
  const ball = clips.runner.where(30);
  // Without the cut-out, the title covers part of the ball: the MP4 checks below can fail.
  const hidden = await agent("edit", { project: "cutout-0", ops: [{ op: "update_layer", layer: "runner-subject", properties: { visible: false } }] });
  assert.equal(hidden.isError, undefined, hidden.text);
  const covered = insideBall(await frameAt(await render(server, "cutout-0", "png", { time: 1 }), 0, size), size.width, ball, 3);
  t.diagnostic(`without the cut-out: ${covered.white} white pixels inside the ball`);
  assert.ok(covered.white > 500, "the title crosses the ball at 1 s");
  await agent("edit", { project: "cutout-0", ops: [{ op: "update_layer", layer: "runner-subject", properties: { visible: true } }] });
  // The MP4 (30 fps draft): in front at rest and while rolling, frame by frame in step.
  const video = await render(server, "cutout-0", "mp4");
  for (const time of [0.2, 1.0, 1.4, 1.8]) {
    const where = clips.runner.where(Math.round(time * 30));
    const seen = insideBall(await frameAt(video, Math.round(time * 30), size), size.width, where, 3);
    t.diagnostic(`MP4 at ${time} s: ${seen.white} white, ${seen.red} red of ${seen.all}`);
    assert.equal(seen.white, 0, `the title stays behind the subject at ${time} s`);
    assert.ok(seen.red / seen.all > 0.95, `the subject is where the clip shows it at ${time} s`);
  }
});

test("the cut_out example op runs on the example project", { skip: skipWithoutMediaTools }, async () => {
  const { op, setup } = OP_EXAMPLES.cut_out;
  const video = await upload(server, clips.guest.path, "footage.mp4", "video/mp4");
  await agent("project", { action: "create", id: "example", name: "Example", width: EXAMPLE_PROJECT.width, height: EXAMPLE_PROJECT.height, duration: 2 });
  // Synced with a voice recording first: the cut-out's file keeps the link (out_of_sync).
  const voice = await upload(server, clips.runner.path, "voice.mp4", "video/mp4");
  const synced = [{ op: "add_layer", layerType: "audio", name: "voice", properties: { src: voice.src } }, { op: "sync_clips", layer: "footage", to: "voice", at: { layer: 0, to: 0 } }];
  const ops = JSON.parse(JSON.stringify([...EXAMPLE_PROJECT.ops, ...setup, ...synced, op]).replace(/\/api\/media\/<video>\.mp4/g, video.src));
  const reply = await agent("edit", { project: "example", ops });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.cutout.output, "subject");
  const { layers, clipLinks } = await sceneLayers(server, "example");
  assert.deepEqual(names(layers), ["footage", "card", "title", "footage-subject", "voice"]);
  assert.deepEqual(clipLinks.filter((link) => link.a === voice.src).map((link) => link.b), [video.src, byName(layers, "footage-subject").src]);
  // frame's camera carries the cut-out and the title between them, so the subject never shows twice.
  assert.equal(byName(layers, "footage-subject").cutoutOf, byName(layers, "footage").id);
  const framed = await agent("edit", { project: "example", ops: [{ op: "frame", layer: "footage", rect: [25, 25, 50, 50], at: 1 }] });
  assert.equal(framed.isError, undefined, framed.text);
  const after = (await sceneLayers(server, "example")).layers;
  assert.deepEqual(names(after), ["footage camera", "voice"]);
  assert.deepEqual(after.filter((layer) => layer.parentId).map((layer) => layer.name), ["footage", "card", "title", "footage-subject"]);
});

test("cut_out points keep the pointed object and the receipt says what was picked", { skip: skipWithoutMediaTools }, async () => {
  const video = await upload(server, clips.runner.path, "runner.mp4", "video/mp4");
  await agent("project", { action: "create", id: "picked", name: "Picked", width: 640, height: 360, duration: 2 });
  const reply = await agent("edit", { project: "picked", ops: [{ op: "add_layer", layerType: "video", name: "clip", properties: { src: video.src } },
    { op: "cut_out", layer: "clip", points: [[22, 52]], exclude: [[90, 10]], time: 0.2 }] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.cutout.picked, { frame: 6, objects: 1, lost: [], weak: [] });
  assert.ok(byName((await sceneLayers(server, "picked")).layers, "clip-subject"));
  const missed = await agent("edit", { project: "picked", ops: [{ op: "cut_out", layer: "clip", points: [[95, 5]], name: "none" }] });
  assert.equal(JSON.parse(missed.text).cutoutError, "CUTOUT_NO_SUBJECT");
  assert.match(JSON.parse(missed.text).reason, /no object under points \[95,5\] at 0 s of "clip"\. Point at an object/);
});

test("a log clip's subject keeps log; its silhouette and matte drop it (kino's own colors)", { skip: skipWithoutMediaTools }, async () => {
  const video = await upload(server, clips.runner.path, "runner.mp4", "video/mp4");
  await agent("project", { action: "create", id: "log-cut", name: "Log cut", width: 640, height: 360, duration: 2 });
  const reply = await agent("edit", { project: "log-cut", ops: [
    { op: "add_layer", layerType: "video", name: "clip", properties: { src: video.src, log: "apple-log" } },
    { op: "cut_out", layer: "clip" }, { op: "cut_out", layer: "clip", output: "silhouette", color: "#3366ff" }, { op: "cut_out", layer: "clip", output: "matte" }] });
  assert.equal(reply.isError, undefined, reply.text);
  const logs = Object.fromEntries((await sceneLayers(server, "log-cut")).layers.map((layer) => [layer.name, layer.log ?? null]));
  assert.deepEqual(logs, { clip: "apple-log", "clip-subject": "apple-log", "clip-silhouette": null, "clip-matte": null });
});

test("no object under points names the file time asked, in a file whose picture starts late", { skip: skipWithoutMediaTools }, async () => {
  // Sound from 0 s, picture from 0.5 s: time 1 is the picture's frame 15, 1 s into the file.
  const file = path.join(folder, "late.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-itsoffset", "0.5", "-i", clips.guest.path, "-f", "lavfi", "-i", "sine=frequency=330:duration=2.5",
    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", file]);
  const video = await upload(server, file, "late.mp4", "video/mp4");
  await agent("project", { action: "create", id: "late", name: "Late", width: 640, height: 360, duration: 2 });
  const missed = await agent("edit", { project: "late", ops: [{ op: "add_layer", layerType: "video", name: "clip", properties: { src: video.src } },
    { op: "cut_out", layer: "clip", points: [[95, 5]], time: 1 }] });
  assert.match(JSON.parse(missed.text).reason, /no object under points \[95,5\] at 1 s of "clip"/);
});

test("cut_out points report where the object was lost, and seeAt gives the scene time to look at", { skip: skipWithoutMediaTools }, async () => {
  // A red square on navy, hidden from 0.5 s to 1 s (10 fps); the layer starts Play 1 s into the scene.
  const file = path.join(folder, "blink.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x19285a:s=320x180:r=10:d=2",
    "-vf", "drawbox=x=100:y=60:w=60:h=60:color=0xe61919:t=fill:enable='not(between(t,0.45,1.05))'", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", file]);
  const video = await upload(server, file, "blink.mp4", "video/mp4");
  await agent("project", { action: "create", id: "blink", name: "Blink", width: 640, height: 360, duration: 3 });
  const reply = await agent("edit", { project: "blink", ops: [{ op: "add_layer", layerType: "video", name: "clip", properties: { src: video.src, mediaStart: 1 } },
    { op: "cut_out", layer: "clip", points: [[40, 50]] }] });
  assert.equal(reply.isError, undefined, reply.text);
  const { picked, note } = reply.data.cutout;
  assert.deepEqual(picked.lost, [[0.5, 1.1]]);
  assert.deepEqual(picked.weak, []);
  assert.deepEqual(picked.seeAt, [1.51]);
  assert.match(note, /lost in 1 span/);
});

test("cut_out refusals say what is wrong and what to send, and change nothing", { skip: skipWithoutMediaTools }, async () => {
  const video = await upload(server, clips.runner.path, "runner.mp4", "video/mp4");
  const svg = await upload(server, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), "logo.svg", "image/svg+xml").catch(() => null);
  await agent("project", { action: "create", id: "refusals", name: "Refusals", width: 640, height: 360, duration: 2 });
  const setup = await agent("edit", { project: "refusals", ops: [
    { op: "add_layer", layerType: "video", name: "clip", properties: { src: video.src } },
    { op: "add_layer", layerType: "text", name: "words", properties: { text: "Hello" } },
  ] });
  assert.equal(setup.isError, undefined, setup.text);
  const { revision } = await sceneLayers(server, "refusals");
  const refused = async (op, pattern, code) => {
    const reply = await agent("edit", { project: "refusals", ops: [op] });
    assert.equal(reply.isError, true, JSON.stringify(op));
    const answer = JSON.parse(reply.text);
    assert.match(answer.reason, pattern);
    assert.equal(answer.cutoutError, code);
  };
  await refused({ op: "cut_out", layer: "words" }, /cut_out finds the subject of a video or image layer, and "words" is a text layer/);
  await refused({ op: "cut_out", layer: "clip", output: "outline" }, /output must be "subject", "matte", "silhouette", not "outline"/);
  await refused({ op: "cut_out", layer: "clip", engine: "sam" }, /engine must be "auto", "subject", "person"/);
  await refused({ op: "cut_out", layer: "clip", grow: 500 }, /grow must be a number of pixels from -100 to 100/);
  await refused({ op: "cut_out", layer: "clip", feather: -2 }, /feather must be a number of pixels from 0 to 200/);
  await refused({ op: "cut_out", layer: "clip", color: "#ffffff" }, /color is the color of output "silhouette"/);
  await refused({ op: "cut_out", layer: "clip", output: "silhouette", color: "#ffffff80" }, /opaque hex color/);
  await refused({ op: "cut_out", layer: "clip", invert: true }, /invert is for output "matte"/);
  await refused({ op: "cut_out", layer: "clip", blur: 4 }, /cut_out has no blur/);
  await refused({ op: "cut_out", layer: "clip", points: [[120, 40]] }, /points must be 1 to 8 points \[x, y\] in % of the clip's own picture/);
  await refused({ op: "cut_out", layer: "clip", points: [[50, 50]], engine: "person" }, /points pick among the objects the subject engine finds/);
  await refused({ op: "cut_out", layer: "clip", time: 1 }, /time goes with points/);
  await refused({ op: "cut_out", layer: "clip", points: [[50, 50]], time: -1 }, /time must be seconds into the clip's file/);
  // Files with no photo to cut out.
  const gifFile = path.join(folder, "spin.gif");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(gifFile, makeAnimatedGif({ width: 8, height: 8, frames: [{ delayCs: 10, color: [255, 0, 0] }, { delayCs: 10, color: [0, 0, 255] }] })));
  const gif = await upload(server, gifFile, "spin.gif", "image/gif");
  await agent("edit", { project: "refusals", ops: [{ op: "add_layer", layerType: "image", name: "spin", properties: { src: gif.src } },
    ...(svg ? [{ op: "add_layer", layerType: "image", name: "logo", properties: { src: svg.src } }] : [])] });
  const { revision: withFiles } = await sceneLayers(server, "refusals");
  await refused({ op: "cut_out", layer: "spin" }, /"spin" is an animated GIF; cut_out works on videos and still images/);
  if (svg) await refused({ op: "cut_out", layer: "logo" }, /"logo" is an SVG drawing/);
  assert.equal((await sceneLayers(server, "refusals")).revision, withFiles, "refused edits change nothing");
  assert.ok(withFiles > revision);

  // A clip with nothing to cut out, and one where the subject comes in half-way.
  const empty = path.join(folder, "empty.mp4"), late = path.join(folder, "late.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1a2659:size=320x180:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", empty]);
  await run(ffmpeg, ["-v", "error", "-y", "-i", empty, "-i", clips.runner.path, "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", late]);
  const emptySrc = (await upload(server, empty, "empty.mp4", "video/mp4")).src, lateSrc = (await upload(server, late, "late.mp4", "video/mp4")).src;
  await agent("edit", { project: "refusals", ops: [{ op: "add_layer", layerType: "video", name: "sky", properties: { src: emptySrc } },
    { op: "add_layer", layerType: "video", name: "entrance", properties: { src: lateSrc } }] });
  await refused({ op: "cut_out", layer: "sky" }, /found no subject in any of its 30 frames of "sky"\. Pick a layer whose picture has a clear subject/, "CUTOUT_NO_SUBJECT");
  const partial = await agent("edit", { project: "refusals", ops: [{ op: "cut_out", layer: "entrance" }] });
  assert.equal(partial.isError, undefined, partial.text);
  assert.equal(partial.data.cutout.frames, 90);
  assert.equal(partial.data.cutout.note, "no subject was found in 30 of 90 frames; the layer is empty there");

  // behind: the text goes right above the clip and its person matte above the text; a clip with
  // no person keeps the text in front and says so (fallback), changing nothing else.
  const behind = await agent("edit", { project: "refusals", ops: [{ op: "cut_out", layer: "clip", behind: "words" }] });
  assert.equal(behind.isError, undefined, behind.text);
  assert.equal(behind.data.cutout.engine, "person");
  assert.equal(behind.data.cutout.behind, "words");
  const order = names((await sceneLayers(server, "refusals")).layers);
  assert.deepEqual(order.slice(order.indexOf("clip"), order.indexOf("clip") + 3), ["clip", "words", "clip-subject"]);
  const front = await agent("edit", { project: "refusals", ops: [{ op: "cut_out", layer: "sky", behind: "words" }] });
  assert.equal(front.isError, undefined, front.text);
  assert.match(front.data.cutout.fallback, /no person was found in "sky", so "words" stays in front/);
  assert.deepEqual(names((await sceneLayers(server, "refusals")).layers), order);
});

test("a cut-out that takes longer than an edit waits answers CUTOUT_RUNNING, then the finished one at once", { skip: skipWithoutMediaTools, timeout: 120_000 }, async (t) => {
  // Each picture takes 25 ms in this helper; the edit waits 0 s.
  const slow = await startTestServer({ env: { KINO_CUTOUT_HELPER: await standInHelper({ KINO_STAND_IN_DELAY_MS: 25 }), KINO_CUTOUT_WAIT_S: "0" } });
  t.after(() => slow.stop());
  const video = await upload(slow, clips.dancer.path, "dancer.mp4", "video/mp4");
  await agentOn(slow, "project", { action: "create", id: "slow", name: "Slow", width: 640, height: 360, duration: 2 });
  await agentOn(slow, "edit", { project: "slow", ops: [{ op: "add_layer", layerType: "video", name: "dancer", properties: { src: video.src } }] });
  const { revision } = await sceneLayers(slow, "slow");
  const ops = [{ op: "cut_out", layer: "dancer", output: "silhouette", grow: 6 }];
  const first = await agentOn(slow, "edit", { project: "slow", ops });
  assert.equal(first.isError, true);
  const answer = JSON.parse(first.text);
  assert.equal(answer.cutoutError, "CUTOUT_RUNNING");
  assert.match(answer.reason, /the cut-out of "dancer" is still being made \(\d+% done.*\); nothing was changed\. Send the same edit again/);
  assert.equal((await sceneLayers(slow, "slow")).revision, revision);
  let reply = first;
  for (let tries = 0; reply.isError && tries < 60; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    reply = await agentOn(slow, "edit", { project: "slow", ops });
    if (reply.isError) assert.equal(JSON.parse(reply.text).cutoutError, "CUTOUT_RUNNING", reply.text);
  }
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.cutout.output, "silhouette");
  const { layers } = await sceneLayers(slow, "slow");
  assert.deepEqual(names(layers), ["dancer", "dancer-silhouette"]);

  // Recovery: the library file deleted (say, by hand) is made again from the kept matte.
  const made = byName(layers, "dancer-silhouette").src;
  await rm(mediaFile(slow, made));
  let again = await agentOn(slow, "edit", { project: "slow", ops: [{ ...ops[0], name: "again" }] });
  for (let tries = 0; again.isError && tries < 60; tries += 1) {
    assert.equal(JSON.parse(again.text).cutoutError, "CUTOUT_RUNNING", again.text);
    await new Promise((resolve) => setTimeout(resolve, 250));
    again = await agentOn(slow, "edit", { project: "slow", ops: [{ ...ops[0], name: "again" }] });
  }
  assert.equal(again.isError, undefined, again.text);
  assert.equal(again.data.cutout.cached, true, "the subject was not looked for again");
  const remade = byName((await sceneLayers(slow, "slow")).layers, "again").src;
  assert.notEqual(remade, made);
  assert.deepEqual(await streams(mediaFile(slow, remade)), ["video"]);
});

test("the cut_outs of one edit share one wait, and the ones after it still start", { skip: skipWithoutMediaTools, timeout: 120_000 }, async (t) => {
  const busy = await queuedServer();
  const runner = await upload(busy, clips.runner.path, "runner.mp4", "video/mp4");
  const guest = await upload(busy, clips.guest.path, "guest.mp4", "video/mp4");
  await agentOn(busy, "project", { action: "create", id: "two", name: "Two", width: 640, height: 360, duration: 2 });
  await agentOn(busy, "edit", { project: "two", ops: [{ op: "add_layer", layerType: "video", name: "runner", properties: { src: runner.src } },
    { op: "add_layer", layerType: "video", name: "guest", properties: { src: guest.src } }] });
  const ops = [{ op: "cut_out", layer: "runner" }, { op: "cut_out", layer: "guest" }];
  const started = performance.now();
  const first = await agentOn(busy, "edit", { project: "two", ops });
  const seconds = (performance.now() - started) / 1000;
  t.diagnostic(`two cut_outs of about 2.7 s each with a 2 s wait: answered after ${seconds.toFixed(2)} s`);
  assert.equal(first.isError, true);
  const answer = JSON.parse(first.text);
  assert.equal(answer.cutoutError, "CUTOUT_RUNNING");
  assert.match(answer.alsoRefused[0].reason, /the cut-out of "guest" is still being made \(0% done/, "the second answers when the first's wait ends");
  // A wait for each would answer after 4 s (with the usual 50 s, after the 60 s tool-call limit).
  // The bound sits just under that, so a busy machine's slower answer does not fail it.
  assert.ok(seconds < 3.8, `answered after ${seconds} s`);
  // The second was started all the same: sending the edit again ends with both.
  let reply = first;
  for (let tries = 0; reply.isError && tries < 40; tries += 1) {
    assert.equal(JSON.parse(reply.text).cutoutError, "CUTOUT_RUNNING", reply.text);
    await pause(250);
    reply = await agentOn(busy, "edit", { project: "two", ops });
  }
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(names((await sceneLayers(busy, "two")).layers), ["runner", "runner-subject", "guest", "guest-subject"]);
});

test("a finished cut-out answers at once while another one is being made", { skip: skipWithoutMediaTools, timeout: 120_000 }, async (t) => {
  const busy = await queuedServer();
  const portrait = await upload(busy, clips.portrait.path, "portrait.png", "image/png");
  const dancer = await upload(busy, clips.dancer.path, "dancer.mp4", "video/mp4");
  for (const [id, layerType, src] of [["photo", "image", portrait.src], ["clip", "video", dancer.src]]) {
    await agentOn(busy, "project", { action: "create", id, name: id, width: 640, height: 360, duration: 2 });
    await agentOn(busy, "edit", { project: id, ops: [{ op: "add_layer", layerType, name: id, properties: { src } }] });
  }
  // The photo's cut-out is made (one picture, so quickly).
  const made = await agentOn(busy, "edit", { project: "photo", ops: [{ op: "cut_out", layer: "photo" }] });
  assert.equal(made.isError, undefined, made.text);
  // The clip's takes longer than an edit waits; the photo's is asked for again meanwhile.
  const clipReply = agentOn(busy, "edit", { project: "clip", ops: [{ op: "cut_out", layer: "clip" }] });
  await pause(300);
  const started = performance.now();
  const again = await agentOn(busy, "edit", { project: "photo", ops: [{ op: "cut_out", layer: "photo", name: "again" }] });
  t.diagnostic(`the finished cut-out answered after ${((performance.now() - started) / 1000).toFixed(2)} s`);
  assert.equal(again.isError, undefined, again.text);
  assert.equal(again.data.cutout.cached, true);
  const { layers } = await sceneLayers(busy, "photo");
  assert.equal(byName(layers, "again").src, byName(layers, "photo-subject").src, "the same library file");
  assert.equal(JSON.parse((await clipReply).text).cutoutError, "CUTOUT_RUNNING", "the clip was still being made all along");
});

test("without an engine, cut_out says to build the helper on a Mac, and to mask with a shape elsewhere", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kino-cutout-next-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const helper = process.env.KINO_CUTOUT_HELPER;
  t.after(async () => {
    Object.defineProperty(process, "platform", platform);
    if (helper === undefined) delete process.env.KINO_CUTOUT_HELPER;
    else process.env.KINO_CUTOUT_HELPER = helper;
    await rm(root, { recursive: true, force: true });
  });
  const id = `${randomUUID()}.mp4`;
  await writeFile(path.join(root, id), "a clip");
  const document = { scenes: [{ id: "scene", layers: [{ id: "clip", type: "video", name: "clip", src: `/api/media/${id}`, width: 320, height: 180 }] }] };
  const operation = { type: "cut_out", sceneId: "scene", layerId: "clip", cutoutId: "clip-cut", cutoutName: "clip-subject" };
  const refusal = async () => {
    const cutoutMedia = createCutoutMedia({ mediaRoot: root, cacheDir: path.join(root, "cutout"), addMedia: () => { throw new Error("nothing is made here"); } });
    const error = await runCutOut(document, operation, { mediaRoot: root, cutoutMedia }).then(() => null, (failure) => failure);
    assert.equal(error?.cutoutError, "CUTOUT_ENGINE_UNAVAILABLE", error?.message);
    return error.message;
  };
  const build = "Build the helper (npm run desktop:cutout) or set KINO_CUTOUT_HELPER, then send the edit again.";
  const shape = /Subject cut-out needs a Mac with macOS 13 or later \(Apple Vision; any subject needs macOS 14\)\. On this computer, mask the layer with a shape instead \(create_mask\)\.$/;

  // A Mac whose helper is not built or cannot run (the browser development path): build it.
  const broken = path.join(root, "kino-cutout");
  await writeFile(broken, "not a program");
  process.env.KINO_CUTOUT_HELPER = broken;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  const notBuilt = await refusal();
  assert.match(notBuilt, /^No cut-out engine is available\. The kino-cutout helper could not start: /);
  assert.ok(notBuilt.endsWith(` ${build}`), notBuilt);
  assert.doesNotMatch(notBuilt, /macOS 13|create_mask/);

  // A Mac with no helper built (CI and a fresh checkout): the reason says how, once.
  delete process.env.KINO_CUTOUT_HELPER;
  if (!cutoutHelperPath()) {
    const none = await refusal();
    assert.match(none, /The kino-cutout helper is not built; run npm run desktop:cutout \(builds only it, a few seconds\), or set KINO_CUTOUT_HELPER\. Then send the edit again\.$/);
  }

  // A Mac too old for Apple Vision (the helper says which macOS it has): a shape mask.
  process.env.KINO_CUTOUT_HELPER = await standInHelper({ KINO_STAND_IN_MACOS: "11.7" });
  const old = await refusal();
  assert.match(old, /^No cut-out engine is available\. The subject engine needs macOS 14 or later \(this Mac has 11\.7\)\. /);
  assert.match(old, shape);

  // Not a Mac.
  delete process.env.KINO_CUTOUT_HELPER;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const linux = await refusal();
  assert.match(linux, /^No cut-out engine is available\. Subject cut-out uses Apple Vision, which is only on macOS\. /);
  assert.match(linux, shape);
});

test("Apple Vision through the agent: the title example on a lit, textured ball", { skip: skipWithoutVision, timeout: 240_000 }, async (t) => {
  const mac = await startTestServer({ env: { KINO_CUTOUT_HELPER: await visionHelper() } });
  t.after(() => mac.stop());
  const clip = await makeBallClip(path.join(folder, "ball.mp4"), { width: 640, height: 360, seconds: 2, still: 0.5, background: "pattern", noise: 4 });
  const video = await upload(mac, clip.path, "ball.mp4", "video/mp4");
  const [block] = jsonBlocks(skillSection("Subject cut-out"));
  const ops = JSON.parse(JSON.stringify(block).replace("/api/media/<runner>.mp4", video.src));
  await agentOn(mac, "project", { action: "create", id: "ball", name: "Ball", width: 1920, height: 1080, duration: 2 });
  const reply = await agentOn(mac, "edit", { project: "ball", ops });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.cutout.engine, "subject");
  t.diagnostic(`Apple Vision: ${reply.data.cutout.frames} frames in ${reply.data.cutout.seconds} s`);
  // In the export the ball is in front of the title. Inside it the only other white is the ball's
  // own highlight, so the white pixels there are counted with the cut-out shown and hidden.
  const size = { width: 960, height: 540 };
  const whiteInBall = async () => {
    const png = await frameAt(await render(mac, "ball", "png", { time: 1 }), 0, size);
    let white = 0;
    const where = clip.where(30), scale = 1.5, r = where.r * scale - 3;
    for (let y = Math.ceil(where.cy * scale - r); y <= where.cy * scale + r; y += 1)
      for (let x = Math.ceil(where.cx * scale - r); x <= where.cx * scale + r; x += 1) {
        if (Math.hypot(x + 0.5 - where.cx * scale, y + 0.5 - where.cy * scale) > r) continue;
        const at = (y * size.width + x) * 3;
        if (png[at] > 235 && png[at + 1] > 235 && png[at + 2] > 235) white += 1;
      }
    return white;
  };
  const shown = await whiteInBall();
  await agentOn(mac, "edit", { project: "ball", ops: [{ op: "update_layer", layer: "runner-subject", properties: { visible: false } }] });
  const hidden = await whiteInBall();
  t.diagnostic(`white pixels inside the ball at 1 s: ${shown} with the cut-out, ${hidden} without`);
  assert.ok(hidden > 5000, "without the cut-out the title covers much of the ball");
  assert.ok(shown < hidden / 20, "with it, the title is behind the ball");
});

// The skill's "Follow an object" example, on the red ball clip (the stand-in tracks red).
test("track follows the ball and pin moves a label with it; a lost stretch holds still and track_lost names it", { skip: skipWithoutMediaTools }, async () => {
  const { evaluateLayer } = await import("../engine/animation.js");
  const { holdLowFrames, pathAt } = await import("../engine/pin.js");
  const { trackLost } = await import("../engine/quality/rules/footage.js");
  const video = await upload(server, clips.runner.path, "walk.mp4", "video/mp4");
  await agent("project", { action: "create", id: "tracked", name: "Tracked", width: 1920, height: 1080, duration: 2 });
  const [example] = jsonBlocks(skillSection("Follow an object"));
  const ops = JSON.parse(JSON.stringify(example).replace(/\/api\/media\/<walk>\.mp4/g, video.src));
  const reply = await agent("edit", { project: "tracked", ops });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.track.track, "phone");
  assert.ok(reply.data.track.frames >= 55, JSON.stringify(reply.data.track));
  const scene = (await (await server.api("/api/projects/tracked")).json()).document.scenes[0];
  const label = byName(scene.layers, "label");
  // The ball rolls right after 0.5 s: the label's center follows it, 80 px above.
  const center = (layer, t) => { const at = evaluateLayer(layer, t); return [at.x + at.width / 2, at.y + at.height / 2]; };
  const [early, late] = [center(label, 0.2), center(label, 1.9)];
  assert.ok(late[0] - early[0] > 450, `${early} -> ${late}`);
  assert.ok(Math.abs(early[1] - (pathAt(scene.tracks[0].samples, 0.2)[1] - 120)) < 1);
  // A stretch the tracker lost (confidence 0) holds the last good place, and the check names it.
  const pin = { ...label.pin, path: holdLowFrames(label.pin.path.map((sample) => (sample[0] > 1 && sample[0] < 1.6 ? [sample[0], 0, 0, 1, 1, 0] : sample))) };
  const lost = { ...label, pin };
  assert.deepEqual(center(lost, 1.4), center(lost, 1.05));
  const [finding] = trackLost({ items: [] }, { scene: { layers: [lost] } });
  assert.equal(finding.rule, "track_lost");
  assert.match(finding.message, /unsure at 1\.0\d?-1\.5\d? s/);
});

// stabilize: the plan's math (smoothing, one zoom that hides the edges), then the skill's "Steady
// shaky footage" example through the agent with the stand-in (a 2 px pan with a 3 px shake: a
// 6 px jerk in the 180 px tall clip, 36 px at 1080p).
test("stabilize smooths the path inside one zoom, and the skill example points the layer at a steadied copy", { skip: skipWithoutMediaTools }, async () => {
  const { planStabilize, shakeOf, zoomNeeded } = await import("./cutout/stabilize.mjs");
  assert.equal(zoomNeeded([0, 0, 0, 1], 1920, 1080), 1);
  assert.ok(Math.abs(zoomNeeded([96, 0, 0, 1], 1920, 1080) - 960 / 864) < 1e-9); // half width over what is left
  const shaky = Array.from({ length: 90 }, (_, i) => (i ? [2 + (i % 2 ? 30 : -30), 0, 0, 1] : [0, 0, 0, 1]));
  const plan = planStabilize(shaky, { width: 1920, height: 1080, fps: 30, smooth: 1 });
  assert.ok(plan.zoom > 1 && plan.zoom <= 1.15, String(plan.zoom));
  for (const correction of plan.corrections) assert.ok(zoomNeeded(correction, 1920, 1080) <= plan.zoom + 1e-6);
  const steadied = shaky.map((move, i) => (i ? [move[0] + plan.corrections[i][0] - plan.corrections[i - 1][0], 0, 0, 1] : move));
  assert.ok(shakeOf(steadied, { fps: 30, height: 1080 }) < shakeOf(shaky, { fps: 30, height: 1080 }) / 5);
  assert.equal(planStabilize(shaky.map(() => [200, 0, 0, 1]), { width: 1920, height: 1080, fps: 30, zoom: 1.05 }).zoom, 1.05);
  // One move Vision got wrong (24 px among 2 px moves) is replaced by the local median, so the jerk goes.
  const { jerkOf, rejectJumps } = await import("./cutout/stabilize.mjs");
  const glitch = Array.from({ length: 60 }, (_, i) => (i === 30 ? [26, 0, 0, 1] : [2, 0, 0, 1]));
  const cleaned = rejectJumps(glitch, { fps: 30 });
  assert.equal(cleaned.rejected, 1);
  assert.deepEqual([jerkOf(glitch, { height: 1080 }).worst, jerkOf(cleaned.moves, { height: 1080 }).worst], [24, 0]);

  const video = await upload(server, clips.guest.path, "walk.mp4", "video/mp4");
  await agent("project", { action: "create", id: "steady", name: "Steady", width: 1920, height: 1080, duration: 2 });
  await agent("edit", { project: "steady", ops: [{ op: "add_layer", layerType: "video", name: "walk", properties: { src: video.src } }] });
  const [example] = jsonBlocks(skillSection("Steady shaky footage"));
  const reply = await agent("edit", { project: "steady", ops: example });
  assert.equal(reply.isError, undefined, reply.text);
  const { src, zoom, jerk } = reply.data.stabilize;
  assert.notEqual(src, video.src);
  assert.ok(zoom >= 1 && zoom <= 1.15 && jerk.before.worst === 36 && jerk.after.worst === 0, JSON.stringify(reply.data.stabilize));
  const layer = (await (await server.api("/api/projects/steady")).json()).document.scenes[0].layers.find((item) => item.name === "walk");
  assert.equal(layer.src, src);
  const refused = await agent("edit", { project: "steady", ops: [{ op: "stabilize", layer: "walk", zoom: 2 }] });
  assert.match(refused.text, /zoom is the fixed crop zoom from 1 to 1.15/);
});
