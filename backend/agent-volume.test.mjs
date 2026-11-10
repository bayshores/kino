// Volume animations and duck_audio through the agent service (POST /api/agent/<verb>) on a real
// server: the skill's sound examples (references/sound.md) run as written, names resolve, a cue
// start works, and a layer without sound refuses a Volume animation in plain words. Also the clip
// speed example (references/media.md: a Speed ramp on a video).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { ffmpeg, makeVideo, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";
import { easingAt } from "../engine/easing.js";
import { mediaFrameState } from "../engine/playback.js";
import { mixCheck } from "./agent/sound-map.mjs";

let server;
let folder;
before(async () => {
  server = await startTestServer();
  folder = await mkdtemp(path.join(tmpdir(), "kino-volume-"));
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

// A made-up sound (an FFmpeg sine tone) imported like any file; answers its /api/media src.
// A WAV, so the measured levels are the same with every FFmpeg version (FFmpeg 6 also decodes an
// AAC file's end padding, which moved a measured duck by 0.001).
async function importTone(name, frequency, seconds) {
  const file = path.join(folder, name);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    `sine=frequency=${frequency}:sample_rate=44100:duration=${seconds}`, "-c:a", "pcm_s16le", file]);
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "audio/wav", "x-file-name": name }, body: await readFile(file) });
  assert.equal(upload.status, 201, await upload.clone().text());
  const media = await upload.json();
  return media.src ?? media.media?.src;
}

async function musicLayer(projectId) {
  const record = await (await server.api(`/api/projects/${projectId}`)).json();
  return record.document.scenes[0].layers.find((layer) => layer.name === "music");
}

test("the sound examples in the kino skill run as written", { skip: skipWithoutMediaTools }, async () => {
  const [examples] = jsonBlocks(skillSection("Sound: volume, fades and ducking"));
  assert.equal(examples.length, 6);

  const music = await importTone("music.wav", 220, 6);
  const voice = await importTone("voice.wav", 660, 2);
  const ops = JSON.parse(JSON.stringify(examples).replace("/api/media/<music>.m4a", music).replace("/api/media/<voice>.m4a", voice));

  await agent("project", { action: "create", id: "sound", name: "Sound", width: 640, height: 360, duration: 6 });
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  const reply = await client.call("edit", { project: "sound", ops });
  assert.equal(reply.isError, undefined, reply.text);
  // The voice plays from 2 s to 4 s: one dip, from the fade down at 1.85 s to the end of the fade up at 4.8 s.
  // Without `to`, the files are measured: the music sits 9 LU under the voice (volume 0.372).
  assert.deepEqual(reply.data.duck, { layer: "music", to: 0.372, dips: 1, summary: "music ducked to 0.372 at 1.85-4.8 s (voice)", times: [[1.85, 4.8]], depth: "music 9 LU under the voice (measured)" });
  assert.match(reply.text, /"duck":\{"layer":"music","to":0\.372,"dips":1,"summary":"music ducked to 0\.372 at 1\.85-4\.8 s \(voice\)"/);

  const layer = await musicLayer("sound");
  const volume = layer.animations.filter((animation) => "volume" in animation.to);
  assert.deepEqual(volume.map((animation) => [animation.kind, animation.start, animation.from.volume, animation.to.volume]), [
    ["in", 0, 0, 1], ["out", 5, 1, 0], ["custom", 1.85, 1, 0.372], ["custom", 4, 0.372, 1],
  ]);
  assert.deepEqual(volume.slice(2).map((animation) => animation.name), ["Duck down", "Duck up"]);
  // Muffled until the drop: a Lowpass animation from 400 to 20000 Hz.
  const lowpass = layer.animations.filter((animation) => "lowpass" in animation.to);
  assert.deepEqual(lowpass.map((animation) => [animation.kind, animation.start, animation.easing, animation.from.lowpass, animation.to.lowpass]), [["in", 1, "ease-in", 400, 20000]]);
});

test("the skill's fit_music example runs as written: the drop on the payoff, the song's own ending at the end", { skip: skipWithoutMediaTools }, async () => {
  const [examples] = jsonBlocks(skillSection("Sound: music as structure"));
  // A made-up song at 120 bpm (a bar is 2 s): a hi-hat on each beat, the kick and bass in from 16 s to 32 s and from 40 s.
  const file = path.join(folder, "song.m4a");
  const expr = "0.25*sin(2*PI*5000*t)*exp(-40*mod(t,0.5))+0.9*(gte(t,16)*lt(t,32)+gte(t,40))*sin(2*PI*55*t)*exp(-6*mod(t,0.5))";
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `aevalsrc=${expr.replaceAll(",", "\\,")}:s=44100:d=48`, "-c:a", "aac", "-b:a", "128k", file]);
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "audio/mp4", "x-file-name": "song.m4a" }, body: await readFile(file) });
  const media = await upload.json();
  const ops = JSON.parse(JSON.stringify(examples).replace("/api/media/<song>.m4a", media.src ?? media.media?.src));
  await agent("project", { action: "create", id: "fit", name: "Fit", width: 640, height: 360, duration: 12 });
  const reply = await agent("edit", { project: "fit", ops });
  assert.equal(reply.isError, undefined, reply.text);
  const payoff = reply.data.music.sections.find((line) => line.endsWith("(payoff)"));
  assert.ok(/ s drop, weight [\d.]+ \(payoff\)$/.test(payoff) && Math.abs(parseFloat(payoff) - 8) <= 1 / 30, reply.data.music.sections.join("; "));
  assert.equal(reply.data.music.sections.at(-1), "12 s ending");
  const record = await (await server.api("/api/projects/fit")).json();
  const pieces = record.document.scenes[0].layers.filter((layer) => layer.type === "audio");
  assert.equal(pieces.length, reply.data.music.pieces);
  assert.ok(record.document.cues.some((cue) => cue.name === "song-drop-1" && Math.abs(cue.time - 8) <= 1 / 30));

  // A format's music is fit the same way, its drop on the format's hero (here the quote).
  await agent("project", { action: "create", id: "fit-format", name: "Fit format", width: 640, height: 360, duration: 12 });
  const format = await agent("edit", { project: "fit-format", ops: [{ op: "format", name: "testimonial", slots: { name: "Orbit", quote: "We stopped double-booking", person: "Maya Lin", cta: "Try Orbit", music: "song.m4a" } }] });
  assert.equal(format.isError, undefined, format.text);
  const formatted = await (await server.api("/api/projects/fit-format")).json();
  const quote = formatted.document.cues.find((cue) => cue.name === "quote").time;
  assert.ok(formatted.document.cues.some((cue) => cue.name === "song-drop-1" && Math.abs(cue.time - quote) <= 1 / 30), JSON.stringify(formatted.document.cues));
  assert.match(JSON.stringify(format.data ?? format.text), /cut to the beat by fit_music/);
});

test("look sound measures the ducked mix: loudness every 0.5 s and the dip", { skip: skipWithoutMediaTools }, async () => {
  // The project the skill's examples made above: a 6 s tone (the bed) ducked under a 2 s tone.
  const reply = await agent("look", { project: "sound", mode: "motion", ref: "sound" });
  assert.equal(reply.isError, undefined, reply.text);
  assert.match(reply.text, /^sound \S+ 6 s: short-term loudness every 0\.5 s, loudest -\d+(\.\d)? LUFS at [\d.]+ s$/m);
  assert.match(reply.text, /^dips: music 1\.\d-4\.\d -\d+(\.\d)? dB$/m, "the duck, not the fade out");
  // Momentary loudness stands in before the 3 s short-term window has a reading: no silent "-".
  assert.doesNotMatch(reply.text.match(/^st: (.*)$/m)[1], /(^| )-( |$)/);
  assert.equal(reply.text.match(/^st: (.*)$/m)[1].split(" ").length, 12);
  assert.match(reply.text, /^cuts \(\d+\):/m, "the scene-cut list");
  assert.match(reply.text, /^mix check: /m, "the listen before done");
  assert.equal(reply.images.length, 1);
  // A Volume animation that lowers a bed is heard in the next look.
  const bed = await importTone("bed.wav", 220, 4);
  await agent("project", { action: "create", id: "bed", name: "Bed", width: 640, height: 360, duration: 4 });
  const fade = { kind: "in", start: 0, duration: 0.5, easing: "linear", from: { volume: 0 }, to: { volume: 0.5 } };
  const added = await agent("edit", { project: "bed", ops: [{ op: "add_layer", layerType: "audio", name: "bed", properties: { id: "bed", src: bed, mediaSourceDuration: 4 }, animations: [fade] }] });
  assert.equal(added.isError, undefined, added.text);
  const opening = async () => (await agent("look", { project: "bed", mode: "motion", ref: "sound" })).text.match(/^st: (.*)$/m)[1].split(" ").slice(2, 6).map(Number);
  const before = await opening();
  const id = (await (await server.api("/api/projects/bed")).json()).document.scenes[0].layers[0].animations[0].id;
  const edit = await agent("edit", { project: "bed", ops: [{ op: "update_animation", animation: id, properties: { to: { volume: 0.15 } } }] });
  assert.equal(edit.isError, undefined, edit.text);
  const after = await opening();
  before.forEach((level, index) => assert.ok(after[index] <= level - 8, `${after} after ${before}`));
});

test("mix check: a buried line, clipping, a level jump at a clip edge, a silent gap and a wide range are each named", () => {
  const curve = (level) => Array.from({ length: 100 }, (_, index) => ({ t: (index + 1) / 10, m: level(index / 10), s: level(index / 10) }));
  const loud = curve((t) => (t < 4 ? -30 : t < 5.5 ? -70 : t < 7.2 ? -30 : -12)); // momentary lags 0.2 s
  loud[80].tp = 1.2;
  const map = { duration: 10, mix: loud, music: curve(() => -20), rest: curve(() => -18), lines: [[1, 3]], edges: [7, 3] };
  const kinds = mixCheck(map).map((entry) => entry.kind);
  assert.deepEqual([...new Set(kinds)].sort(), ["clip", "gap", "jump", "range", "voice"]);
  const calm = curve(() => -16);
  assert.deepEqual(mixCheck({ duration: 10, mix: calm, music: curve(() => -26), rest: calm, lines: [[1, 3]], edges: [5] }), []);
});

test("the skill's clip speed example runs as written: 1× → 0.25× → 1×, no motion findings", { skip: skipWithoutMediaTools }, async () => {
  const [examples] = jsonBlocks(skillSection("Clip speed: slow motion, reverse, choppy"));
  assert.equal(examples.length, 3);

  // Generated footage: 4 s at 30 frames a second, each frame its own grey.
  const file = await makeVideo(path.join(folder, "clip.mp4"), { width: 64, height: 36, fps: 30, frames: 120, frameColor: (n) => [n * 2, n * 2, n * 2] });
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "clip.mp4" }, body: await readFile(file) });
  assert.equal(upload.status, 201, await upload.clone().text());
  const media = await upload.json();
  const ops = JSON.parse(JSON.stringify(examples).replace("/api/media/<clip>.mp4", media.src ?? media.media?.src));

  await agent("project", { action: "create", id: "speed", name: "Speed", width: 640, height: 360, duration: 4 });
  const reply = await agent("edit", { project: "speed", ops });
  assert.equal(reply.isError, undefined, reply.text);
  const record = await (await server.api("/api/projects/speed")).json();
  const clip = record.document.scenes[0].layers.find((layer) => layer.name === "clip");
  assert.equal(clip.mediaInterpolation, "blend");
  assert.deepEqual(clip.animations.map((animation) => [animation.start, animation.from.speed, animation.to.speed]), [[1, 1, 0.25], [2.5, 0.25, 1]]);

  // The file time at 2 s is the area under the speed curve, added up here in 0.1 ms steps with
  // the easing itself: 1 s at 1×, the eased ramp down, then 0.5 s at 0.25×.
  let ramp = 0;
  for (let step = 0; step < 5000; step += 1) ramp += (1 - 0.75 * easingAt("smooth", (step + 0.5) / 5000)) * 0.0001;
  assert.ok(Math.abs(mediaFrameState(clip, 2).sourceTime - (1 + ramp + 0.125)) < 0.001, `${mediaFrameState(clip, 2).sourceTime} vs ${1 + ramp + 0.125}`);

  // A speed ramp is not a move: no motion rule names the clip (the tiny test file is drawn
  // past its pixels, so soft_upscale, which is no motion rule, is left out).
  const checked = await agent("check", { project: "speed", pixels: false });
  assert.deepEqual(checked.data.findings.filter((finding) => [clip.id, clip.name].includes(finding.ref) && finding.rule !== "soft_upscale").map((finding) => finding.rule), []);
});

test("the skill's split_layer example runs as written: 0.3 s of the file skipped, the new piece named in the same edit", { skip: skipWithoutMediaTools }, async () => {
  const [examples] = jsonBlocks(skillSection("Cutting and skipping inside a clip"));
  const file = await makeVideo(path.join(folder, "split.mp4"), { width: 64, height: 36, fps: 30, frames: 120, frameColor: (n) => [n * 2, n * 2, n * 2] });
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "split.mp4" }, body: await readFile(file) });
  assert.equal(upload.status, 201, await upload.clone().text());
  const media = await upload.json();
  const ops = JSON.parse(JSON.stringify(examples).replace("/api/media/<clip>.mp4", media.src ?? media.media?.src));
  await agent("project", { action: "create", id: "split", name: "Split", width: 640, height: 360, duration: 4 });
  const reply = await agent("edit", { project: "split", ops });
  assert.equal(reply.isError, undefined, reply.text);
  const layers = (await (await server.api("/api/projects/split")).json()).document.scenes[0].layers;
  const [clip, rest] = ["clip", "clip 2"].map((name) => layers.find((layer) => layer.name === name));
  assert.equal(mediaFrameState(rest, 2).sourceTime, 2.3, "after the skip the file runs 0.3 s ahead");
  assert.deepEqual([clip.mediaDuration, rest.mediaStart, rest.volume], [1.2, 1.2, 0.5]);
});

test("two duck_audio ops on one layer in one edit: the receipt reports only the dips that stay", { skip: skipWithoutMediaTools }, async () => {
  const [music, lineA, lineB, late] = await Promise.all([
    importTone("twice-music.wav", 220, 12), importTone("line-a.wav", 440, 2), importTone("line-b.wav", 550, 2), importTone("late.wav", 660, 2)]);
  await agent("project", { action: "create", id: "twice", name: "Twice", width: 640, height: 360, duration: 12 });
  const added = await agent("edit", { project: "twice", ops: [
    { op: "add_layer", layerType: "audio", name: "music", properties: { src: music, mediaSourceDuration: 12 } },
    { op: "add_layer", layerType: "audio", name: "line-a", properties: { src: lineA, mediaSourceDuration: 2, mediaStart: 1 } },
    { op: "add_layer", layerType: "audio", name: "line-b", properties: { src: lineB, mediaSourceDuration: 2, mediaStart: 3.2 } },
    { op: "add_layer", layerType: "audio", name: "late", properties: { src: late, mediaSourceDuration: 2, mediaStart: 8 } },
  ] });
  assert.equal(added.isError, undefined, added.text);
  // The second duck_audio replaces the first one's dips. The receipt also said "music ducked to
  // 0.3 at 0.85-6 s (line-a, line-b)", dips that inspect no longer shows.
  const reply = await agent("edit", { project: "twice", ops: [
    { op: "duck_audio", layer: "music", under: ["line-a", "line-b"], to: 0.3 },
    { op: "duck_audio", layer: "music", under: ["late"], to: 0.3 },
    { op: "duck_audio", layer: "line-a", under: ["late"], to: 0.5 },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.deepEqual(reply.data.duck, [
    // The report that stays says whose dips it replaced (before, the first report was dropped
    // without a word). A given `to` is kept in a long dip too (asked 0.12, it once got 0.398).
    { layer: "music", to: 0.3, dips: 1, summary: "music ducked to 0.3 at 7.85-10.8 s (late)", times: [[7.85, 10.8]],
      replaced: "This duck_audio replaced the dips of op 0 (music ducked to 0.3 at 0.85-6 s (line-a, line-b)): a later duck_audio on a layer replaces the earlier dips. To keep both, send one duck_audio with every layer in under." },
    { layer: "line-a", to: 0.5, dips: 1, summary: "line-a ducked to 0.5 at 7.85-10.8 s (late)", times: [[7.85, 10.8]] },
  ]);
  const layer = await musicLayer("twice");
  assert.deepEqual(layer.animations.map((animation) => [animation.name, animation.start]), [["Duck down", 7.85], ["Duck up", 10]]);
});

// When one edit ducks two layers the receipt's duck is a list (above), but sound.md and the
// duck_audio rules said to read duck.summary, which then is undefined. They now say it is a list.
test("the skill and the duck_audio rules say duck is a list when one edit ducks several layers", async () => {
  assert.match(skillSection("Sound: volume, fades and ducking"), /When one edit\s+ducks several layers, `duck` is a list with one such report per layer \(`duck\[0\]\.summary`/);
  assert.match(skillSection("Sound: separating voice from background"), /`duck\[n\]\.summary` when it ducks several layers/);
  const op = await agent("library", { topic: "op", name: "duck_audio" });
  assert.match(op.text, /the receipt's duck gives the dips, their times and a summary in words \(a list, one per layer, when an edit ducks several layers\)/);
  const rules = await agent("library", { topic: "rules", name: "sound" });
  assert.match(rules.text, /when one edit ducks several layers, duck is a list of these, one per layer/);
});

test("a Volume animation can start on a cue, and a text layer refuses one in plain words", { skip: skipWithoutMediaTools }, async () => {
  const music = await importTone("cue-music.wav", 330, 4);
  await agent("project", { action: "create", id: "cued", name: "Cued", width: 640, height: 360, duration: 4 });
  const reply = await agent("edit", { project: "cued", ops: [
    { op: "add_layer", layerType: "audio", name: "music", properties: { src: music } },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Hello" } },
    { op: "set_cues", cues: [{ name: "drop", time: 2.5 }] },
    { op: "add_animation", layer: "music", animation: { kind: "out", start: "cue:drop", duration: 1, from: { volume: 1 }, to: { volume: 0 } } },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  const layer = await musicLayer("cued");
  assert.equal(layer.animations[0].start, 2.5, "cue:drop resolves to the cue's time");

  const refused = await agent("edit", { project: "cued", ops: [
    { op: "add_animation", layer: "title", animation: { kind: "custom", start: 0, duration: 1, from: { volume: 0.6 }, to: { volume: 0.2 } } },
  ] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /a Volume animation needs a video or audio layer; a text layer has no sound/);

  const notSound = await agent("edit", { project: "cued", ops: [{ op: "duck_audio", layer: "title", under: ["music"] }] });
  assert.equal(notSound.isError, true);
  assert.match(notSound.text, /duck_audio: \\"title\\" is a text layer and has no sound; duck an audio or video layer/);
});
