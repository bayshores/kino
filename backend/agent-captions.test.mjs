// Milestone A7 through the agent service (POST /api/agent/<verb>) on a real server: captions from
// a real SRT file (burned into the render and written beside it as .srt and .vtt, both within one
// frame of the file), beats found in an imported click track, and a sequence with a crossfade
// seen through look. Also the command-line/MCP client reading a caption file.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { parseSrt, parseVtt } from "../engine/subtitles.js";
import { ffmpeg, near, readImage, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";

const SINTEL = fileURLToPath(new URL("../tests/fixtures/captions/sintel_en.srt", import.meta.url));
const OFFSET = -107;
const FPS = 30;
const round = (seconds) => Math.round(seconds * 1000) / 1000;

let server;
let folder;
before(async () => {
  server = await startTestServer();
  folder = await mkdtemp(path.join(tmpdir(), "kino-a7-"));
});
after(async () => {
  await server?.stop();
  await rm(folder, { recursive: true, force: true });
});

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

// look review until every moment is reviewed: a final render of a whole video needs it (review.mjs).
async function reviewAll(project) {
  for (let round = 0; round < 40; round += 1) if (!(await agent("look", { project, mode: "review", inline: false })).data.left) return;
}

// Only the listed frames of a video, decoded to RGBA: Map frame number → pixel reader.
async function videoFramesAt(file, numbers, { width, height }) {
  const wanted = [...new Set(numbers)].sort((a, b) => a - b);
  const select = wanted.map((number) => `eq(n\\,${number})`).join("+");
  const raw = await run(ffmpeg, ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", `select='${select}'`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  const size = width * height * 4;
  assert.equal(raw.length, size * wanted.length, "every asked-for frame was decoded");
  return new Map(wanted.map((number, index) => {
    const frame = raw.subarray(index * size, (index + 1) * size);
    return [number, { pixel: (x, y) => [...frame.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] }];
  }));
}

async function saved(projectId) {
  return (await server.api(`/api/projects/${projectId}`)).json();
}

// The Sintel events on the scene's clock, cut to a scene of `duration` seconds.
async function sintelEvents(duration) {
  return parseSrt(await readFile(SINTEL, "utf8"))
    .map((event) => ({ ...event, start: event.start + OFFSET, end: event.end + OFFSET }))
    .filter((event) => event.end > 0 && event.start < duration)
    .map((event) => ({ ...event, start: Math.max(0, round(event.start)), end: Math.min(duration, round(event.end)) }));
}

test("a real SRT file becomes captions that show, render and export within 1 frame of the file", { skip: skipWithoutMediaTools }, async () => {
  const created = await agent("project", { action: "create", id: "subs", name: "Subs", width: 360, height: 640, duration: 20 });
  assert.equal(created.isError, undefined, created.text);
  const text = await readFile(SINTEL, "utf8");
  const reply = await agent("edit", { project: "subs", ops: [
    { op: "update_scene", properties: { background: "#3A4A5A" } },
    { op: "add_captions", text, offset: OFFSET },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  const events = await sintelEvents(20);
  assert.equal(reply.data.captions.format, "srt");
  assert.equal(reply.data.captions.pages, events.length);
  assert.equal(reply.data.captions.first, 0.25);
  assert.match(reply.text, /"captions":\{"name":"captions","format":"srt"/);

  const record = await saved("subs");
  const lineCues = record.document.cues.filter((cue) => cue.kind === "line");
  assert.deepEqual(lineCues.map((cue) => cue.time), events.map((event) => event.start));

  // No saved reference edits in this test: the reference gate is waived (agent-review tests it).
  await agent("edit", { project: "subs", ops: [{ op: "waive_check", code: "reference", target: "*", reason: "a captions test" }] });
  await reviewAll("subs");
  const started = await agent("render", { project: "subs", action: "start", quality: "final", fps: FPS });
  assert.equal(started.isError, undefined, started.text);
  const done = await agent("render", { action: "wait", job: started.data.job, timeout_s: 110 });
  assert.equal(done.data.status, "done", done.text);
  assert.match(done.text, / · captions \S+\.srt, \S+\.vtt/);
  const [srtPath, vttPath] = done.data.captionFiles;
  for (const [file, parse] of [[srtPath, parseSrt], [vttPath, parseVtt]]) {
    const exported = parse(await readFile(file, "utf8"));
    assert.equal(exported.length, events.length, file);
    exported.forEach((event, index) => {
      assert.equal(event.text.replace(/\s+/g, " "), events[index].text.replace(/\s+/g, " "));
      assert.ok(Math.abs(event.start - events[index].start) <= 1 / FPS + 1e-6, `${path.extname(file)} event ${index + 1} starts at ${event.start}, the file says ${events[index].start}`);
      assert.ok(Math.abs(event.end - events[index].end) <= 1 / FPS + 1e-6, `${path.extname(file)} event ${index + 1} ends at ${event.end}, the file says ${events[index].end}`);
    });
  }

  // The burned-in box: background the frame before each page starts and the frame after it
  // ends, the box the frame after it starts.
  const scene = record.document.scenes[0];
  const background = [0x3a, 0x4a, 0x5a];
  const checks = events.flatMap((event, index) => {
    const page = scene.layers.find((layer) => layer.name === `captions-${index + 1}`);
    const at = { x: Math.round(page.x + 3), y: Math.round(page.y + page.height / 2) };
    const first = Math.round(event.start * FPS);
    const last = Math.round(event.end * FPS);
    return [
      ...(first > 0 ? [{ frame: first - 1, ...at, box: false, why: `page ${index + 1}: no box the frame before ${event.start}s` }] : []),
      { frame: first + 1, ...at, box: true, why: `page ${index + 1}: box shown the frame after ${event.start}s` },
      { frame: last + 1, ...at, box: false, why: `page ${index + 1}: box gone the frame after ${event.end}s` },
    ];
  });
  const frames = await videoFramesAt(done.data.path, checks.map((check) => check.frame), { width: 360, height: 640 });
  for (const check of checks) assert.equal(!near(frames.get(check.frame).pixel(check.x, check.y), background, 12), check.box, check.why);
  await rm(done.data.path, { force: true });
});

test("caption files go with videos only, and stop where a shorter render stops", { skip: skipWithoutMediaTools }, async () => {
  await agent("project", { action: "create", id: "cut", name: "Cut", width: 320, height: 180, duration: 4 });
  const text = "1\n00:00:00,000 --> 00:00:01,000\nfirst\n\n2\n00:00:01,500 --> 00:00:03,000\nsecond\n";
  const reply = await agent("edit", { project: "cut", ops: [{ op: "add_captions", text }] });
  assert.equal(reply.isError, undefined, reply.text);
  const render = async (body) => {
    const started = await agent("render", { project: "cut", action: "start", ...body });
    assert.equal(started.isError, undefined, started.text);
    const done = await agent("render", { action: "wait", job: started.data.job, timeout_s: 60 });
    assert.equal(done.data.status, "done", done.text);
    return done;
  };
  // A 2 s video of the 4 s scene: the second caption ends with the video.
  const short = await render({ format: "mp4", options: { duration: 2 } });
  for (const [file, parse] of [[short.data.captionFiles[0], parseSrt], [short.data.captionFiles[1], parseVtt]]) {
    const events = parse(await readFile(file, "utf8"));
    assert.deepEqual(events.map((event) => event.text), ["first", "second"], file);
    assert.ok(Math.abs(events[1].start - 1.5) <= 1 / 15 + 1e-6, `the second caption starts at ${events[1].start}`);
    assert.equal(events[1].end, 2, "the second caption ends where the video does");
  }
  // A still and a reversed GIF have no caption track: no .srt or .vtt beside them.
  for (const body of [{ format: "png" }, { format: "gif", options: { playbackDirection: "reverse" } }]) {
    const done = await render(body);
    assert.equal(done.data.captionFiles, undefined, body.format);
    assert.doesNotMatch(done.text, / · captions /, body.format);
    for (const extension of [".srt", ".vtt"]) {
      const beside = done.data.path.replace(/\.[a-z0-9]+$/i, extension);
      await assert.rejects(readFile(beside), { code: "ENOENT" }, `${beside} was not written`);
    }
  }
});

test("detect_beats finds the beat of an imported click track and writes beat cues and the rhythm", { skip: skipWithoutMediaTools }, async () => {
  const file = path.join(folder, "clicks120.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='if(gte(t,0.25),sin(2*PI*1500*mod(t-0.25,0.5))*exp(-mod(t-0.25,0.5)*60),0)':s=44100:d=8", file]);
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "audio/wav", "x-file-name": "clicks120.wav" }, body: await readFile(file) });
  assert.equal(upload.status, 201, await upload.clone().text());
  const media = await upload.json();
  const src = media.src ?? media.media?.src;

  await agent("project", { action: "create", id: "beats", name: "Beats", width: 640, height: 360, duration: 6 });
  const reply = await agent("edit", { project: "beats", ops: [
    { op: "add_layer", layerType: "audio", name: "music", properties: { src, mediaStart: 1 } },
    { op: "detect_beats", layer: "music" },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  const { beats } = reply.data;
  assert.ok(Math.abs(beats.bpm - 120) <= 1, `found ${beats.bpm} BPM`);
  assert.equal(beats.firstBeat, 1.25);
  const record = await saved("beats");
  const beatCues = record.document.cues.filter((cue) => cue.kind === "beat");
  assert.ok(beatCues.length >= 9);
  for (const cue of beatCues) {
    const error = Math.abs(cue.time - (1.25 + Math.round((cue.time - 1.25) / 0.5) * 0.5));
    assert.ok(error <= 0.02, `${cue.name} at ${cue.time} is ${Math.round(error * 1000)} ms off the click`);
  }
  assert.deepEqual(record.document.rhythm, { bpm: beats.bpm, offset: 1.25 });
  // Weighted hits reach the saved project: each onset has a weight and a band; the receipt counts accents.
  assert.match(beats.accents, /^\d+ \(top per section\)$/);
  assert.ok(record.document.cues.filter((cue) => cue.kind === "onset").every((cue) => typeof cue.weight === "number" && cue.band));

  // The agent reads the cues back with inspect.
  const listed = await agent("inspect", { project: "beats", targets: ["cues[kind=beat]"] });
  assert.equal(listed.isError, undefined, listed.text);
  assert.match(listed.text, new RegExp(`^rev \\d+\nrhythm ${beats.bpm} bpm, first beat at 1.25s\nbeat ${beatCues.length}: beat-1 1.25, beat-2 1.75, `));
  assert.equal(listed.data.cues, beatCues.length);
  const badKind = await agent("inspect", { project: "beats", targets: ["cues[kind=drums]"] });
  assert.match(badKind.text, /kind is one of marker, beat, onset, accent, word, line/);

  // An animation put on beat-2 (1.75 s). It keeps that time when the beats move, and the receipt says so.
  const keyed = await agent("edit", { project: "beats", ops: [
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 10, y: 10, width: 50, height: 50 } },
    { op: "add_animation", layer: "box", preset: "preset-fade", at: "cue:beat-2", duration: 0.5 },
  ] });
  assert.equal(keyed.isError, undefined, keyed.text);
  assert.ok(keyed.data.created["box.in"], keyed.text);

  // A new sound set earlier in the same edit is the one analysed: 150 a minute from 0.1 s.
  const faster = path.join(folder, "clicks150.wav");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='if(gte(t,0.1),sin(2*PI*1500*mod(t-0.1,0.4))*exp(-mod(t-0.1,0.4)*60),0)':s=44100:d=8", faster]);
  const second = await server.api("/api/media", { method: "POST", headers: { "content-type": "audio/wav", "x-file-name": "clicks150.wav" }, body: await readFile(faster) });
  assert.equal(second.status, 201, await second.clone().text());
  const secondMedia = await second.json();
  const swapped = await agent("edit", { project: "beats", ops: [
    { op: "update_layer", layer: "music", properties: { src: secondMedia.src ?? secondMedia.media?.src } },
    { op: "detect_beats", layer: "music" },
  ] });
  assert.equal(swapped.isError, undefined, swapped.text);
  assert.ok(Math.abs(swapped.data.beats.bpm - 150) <= 1, `found ${swapped.data.beats.bpm} BPM in the new sound`);
  assert.equal(swapped.data.beats.firstBeat, 1.1);
  const swappedRecord = await saved("beats");
  assert.deepEqual(swappedRecord.document.rhythm, { bpm: swapped.data.beats.bpm, offset: 1.1 });
  // beat-2 is now at 1.5 s: the animation that started on it is named, with how far its cue moved.
  assert.deepEqual(swapped.data.beats.cuesMoved, [{ animation: keyed.data.created["box.in"], cue: "beat-2", at: 1.75, moved: -0.25 }]);
  const box = swappedRecord.document.scenes[0].layers.find((layer) => layer.name === "box");
  assert.equal(box.animations[0].start, 1.75, "the animation keeps its time");
  // The agent moves it onto the new beat-2, as the rules say.
  const moved = await agent("edit", { project: "beats", ops: [
    { op: "update_animation", animation: swapped.data.beats.cuesMoved[0].animation, properties: { start: "cue:beat-2" } },
  ] });
  assert.equal(moved.isError, undefined, moved.text);
  const movedRecord = await saved("beats");
  assert.equal(movedRecord.document.scenes[0].layers.find((layer) => layer.name === "box").animations[0].start, 1.5);

  // A sound that is not in the media library is refused, and nothing is saved.
  const refused = await agent("edit", { project: "beats", ops: [
    { op: "add_layer", layerType: "audio", name: "stray", properties: { src: "/api/media/00000000-0000-4000-8000-000000000000.wav" } },
    { op: "detect_beats", layer: "stray" },
  ] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /not in kino's media library/);
  assert.equal((await saved("beats")).revision, movedRecord.revision);
});

test("add_sequence plays scenes in order with a crossfade, seen through look", async () => {
  await agent("project", { action: "create", id: "seq", name: "Seq", width: 320, height: 180, duration: 2 });
  const reply = await agent("edit", { project: "seq", ops: [
    { op: "update_scene", properties: { name: "One", background: "#FF6B4A" } },
    { op: "add_scene", name: "Two", width: 320, height: 180, duration: 2, background: "#3CC8B4" },
    { op: "add_sequence", properties: { name: "Film" }, scenes: ["One", "Two"], transition: { type: "crossfade", duration: 1 } },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.sequence, {
    name: "Film", duration: 3, parts: [{ scene: "One", start: 0, end: 2 }, { scene: "Two", start: 1, end: 3 }],
    transitions: ["crossfade 1s"], madeComponents: ["One", "Two"],
  });
  const film = (await saved("seq")).document.scenes.find((scene) => scene.name === "Film");
  const colorAt = async (t) => {
    const frame = await agent("look", { project: "seq", scene: film.id, mode: "frame", t, width: 320 });
    assert.equal(frame.isError, undefined, frame.text);
    return (await readImage(Buffer.from(frame.images[0].data, "base64"))).pixel(160, 90);
  };
  assert.ok(near(await colorAt(0.5), [0xff, 0x6b, 0x4a]), "part one before the crossfade");
  // Halfway through, every channel lies between the two parts' colors.
  const middle = await colorAt(1.5);
  const between = (value, a, b) => value > Math.min(a, b) + 8 && value < Math.max(a, b) - 8;
  assert.ok(between(middle[0], 0xff, 0x3c) && between(middle[1], 0x6b, 0xc8) && between(middle[2], 0x4a, 0xb4), `a mix during the crossfade, got ${middle}`);
  assert.ok(near(await colorAt(2.5), [0x3c, 0xc8, 0xb4]), "part two after it");
});

test("the kino command line and MCP tools read a caption file and send its text", async () => {
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  await agent("project", { action: "create", id: "file", name: "File", width: 1080, height: 1920, duration: 10 });
  const reply = await client.call("edit", { project: "file", ops: [{ op: "add_captions", file: SINTEL, offset: OFFSET }] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.captions.format, "srt");
  assert.equal(reply.data.captions.pages, (await sintelEvents(10)).length);

  const wrongType = path.join(folder, "notes.md");
  await writeFile(wrongType, "# not captions");
  const refusedType = await client.call("edit", { project: "file", ops: [{ op: "add_captions", file: wrongType }] });
  assert.equal(refusedType.isError, true);
  assert.match(refusedType.text, /\.srt, \.vtt or \.txt/);
  const relative = await client.call("edit", { project: "file", ops: [{ op: "add_captions", file: "captions.srt" }] });
  assert.match(relative.text, /absolute path/);
  // `appear:"fade"` fades each page in and out; `animation:"fade"` is read as the same thing.
  for (const [field, name] of [["appear", "faded"], ["animation", "guessed"]]) {
    const faded = await agent("edit", { project: "file", ops: [{ op: "add_captions", text: "Plan, build and ship.", start: 1, end: 4, name, [field]: "fade" }] });
    assert.equal(faded.isError, undefined, faded.text);
    if (field === "animation") assert.match(faded.text, /animation → appear/);
    const page = (await saved("file")).document.scenes[0].layers.find((layer) => layer.name === `${name}-1`);
    assert.deepEqual(page.animations.map((animation) => [animation.kind, animation.start]), [["show", 1], ["in", 1], ["out", 3.8], ["hide", 4]], field);
  }
  // Over HTTP the file is never read by the server.
  const overHttp = await agent("edit", { project: "file", ops: [{ op: "add_captions", file: SINTEL }] });
  assert.equal(overHttp.isError, true);
  assert.match(overHttp.text, /send the file's text as text/);
});

test("the captions, beats and sequences examples in the kino skill run as written", { skip: skipWithoutMediaTools }, async () => {
  const [examples] = jsonBlocks(skillSection("Captions, beats and sequences"));
  assert.equal(examples.length, 10);

  // The placeholders: a caption file and an imported music file.
  const captions = path.join(folder, "captions.srt");
  await writeFile(captions, "1\n00:00:00,500 --> 00:00:02,500\nOne place for the whole team.\n\n2\n00:00:03,000 --> 00:00:05,000\nShip on Friday.\n");
  const music = path.join(folder, "music.m4a");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='0.8*sin(2*PI*55*mod(t,0.5))*exp(-mod(t,0.5)*25)':s=44100:d=6", "-c:a", "aac", "-b:a", "128k", music]);
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "audio/mp4", "x-file-name": "music.m4a" }, body: await readFile(music) });
  const media = await upload.json();
  const src = media.src ?? media.media?.src;
  const ops = JSON.parse(JSON.stringify(examples).replace("/absolute/path/captions.srt", captions).replace("/api/media/<id>.m4a", src));

  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  await agent("project", { action: "create", id: "skill", name: "Skill", width: 1080, height: 1920, duration: 6 });
  const setup = await agent("edit", { project: "skill", ops: ["intro", "demo", "cta"].map((name) => ({ op: "add_scene", name, width: 1080, height: 1920, duration: 3 })) });
  assert.equal(setup.isError, undefined, setup.text);
  // The setup's agent lets go of the scenes it made (crew locks), so the cli can change them.
  await agent("notes", { project: "skill", action: "release" });
  const reply = await client.call("edit", { project: "skill", ops: ops.map((op) => (op.op === "add_sequence" ? op : { scene: "s1", ...op })) });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.captions.map((report) => [report.name, report.format, report.pages]), [["captions", "srt", 2], ["tagline", "text", 1]]);
  assert.ok(Math.abs(reply.data.beats.bpm - 120) <= 1);
  assert.equal(reply.data.sequence.duration, 8.2);
});
