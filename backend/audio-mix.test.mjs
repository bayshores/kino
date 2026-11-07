// The dashboard's live sound, GET /api/dashboard/mix: the scene's sound mixed exactly as an MP4
// export mixes it (export.mjs sceneSoundClips and soundMixArgs), so pressing play in the
// dashboard sounds like the render. Every sound here is made up with FFmpeg sine tones.
//
// The checks read the WAV the route answers: silence before a sound starts, the right part of the
// file after an offset and a trim, volume, silence while a video is hidden or inside a hidden
// group, a Volume fade, and the same sound as an exported MP4's sound track.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { volumeAt } from "../engine/animation.js";
import { createDocument, createLayer, createScene } from "../engine/model.js";
import { exportScene } from "./export.mjs";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

const RATE = 48000;
// Every made-up sound is a sine at this amplitude (about -12 dBFS), so a few of them together
// stay under the master limiter's ceiling and pass it unchanged.
const LEVEL = 0.25;
const SINE_RMS = LEVEL / Math.SQRT2;

let server;
let folder;
const media = {};

// A sound from FFmpeg's aevalsrc expression (quoted, so its commas stay inside it).
async function makeSound(name, expression, seconds, rate = RATE) {
  const file = path.join(folder, name);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    `aevalsrc='${expression}':s=${rate}:d=${seconds}`, "-c:a", "pcm_s16le", file]);
  return file;
}

async function upload(file, type) {
  const response = await server.api("/api/media", { method: "POST", headers: { "content-type": type, "x-file-name": path.basename(file) }, body: await readFile(file) });
  assert.equal(response.status, 201, await response.clone().text());
  const answer = await response.json();
  return answer.src ?? answer.media?.src;
}

before(async () => {
  if (skipWithoutMediaTools) return;
  server = await startTestServer();
  folder = await mkdtemp(path.join(tmpdir(), "kino-audio-mix-"));
  // Three steps of half a second each: 300 Hz, then 600 Hz, then 900 Hz.
  media.steps = await upload(await makeSound("steps.wav", `${LEVEL}*sin(2*PI*t*if(lt(t,0.5),300,if(lt(t,1),600,900)))`, 1.5), "audio/wav");
  media.tone = await upload(await makeSound("tone.wav", `${LEVEL}*sin(2*PI*440*t)`, 4), "audio/wav");
  media.cd = await upload(await makeSound("cd.wav", `${LEVEL}*sin(2*PI*440*t)`, 4, 44100), "audio/wav");
  // A video with its own sound: a 550 Hz tone under a test picture.
  const sound = await makeSound("clip-sound.wav", `${LEVEL}*sin(2*PI*550*t)`, 3);
  const clip = path.join(folder, "clip.mp4");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=32x24:rate=30:duration=3", "-i", sound,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", clip]);
  media.clip = await upload(clip, "video/mp4");
});

after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

// The samples of a WAV file, as numbers from -1 to 1, one array per channel.
function readWav(buffer) {
  let offset = 12, format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") format = { channels: buffer.readUInt16LE(offset + 10), rate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) };
    if (id === "data") {
      assert.ok(format, "the WAV says its format before its samples");
      assert.equal(format.bits, 16);
      const frames = Math.floor(size / (2 * format.channels));
      const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
      for (let frame = 0; frame < frames; frame += 1)
        for (let channel = 0; channel < format.channels; channel += 1)
          channels[channel][frame] = buffer.readInt16LE(offset + 8 + (frame * format.channels + channel) * 2) / 32768;
      return { rate: format.rate, channels };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("The WAV has no samples.");
}

const index = (seconds) => Math.round(seconds * RATE);
function rms(samples, from, to) {
  let sum = 0;
  for (let at = index(from); at < index(to); at += 1) sum += samples[at] ** 2;
  return Math.sqrt(sum / (index(to) - index(from)));
}
// The pitch of a steady tone from how often it crosses zero.
function pitch(samples, from, to) {
  let crossings = 0;
  for (let at = index(from) + 1; at < index(to); at += 1) if ((samples[at - 1] < 0) !== (samples[at] < 0)) crossings += 1;
  return crossings / 2 / (to - from);
}

let projects = 0;
// Saves a one-scene project and asks the route for its sound.
async function mixOf(scene, { fps = 30, headers } = {}) {
  const id = `mix-${++projects}`;
  const created = await server.api("/api/projects", { method: "POST", body: { document: createDocument({ id, name: id, scenes: [scene] }) } });
  assert.equal(created.status, 201, await created.clone().text());
  const response = await server.api(`/api/dashboard/mix?project=${id}&scene=${scene.id}&fps=${fps}`, { headers });
  return { id, response };
}

async function wavOf(scene, options) {
  const { id, response } = await mixOf(scene, options);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const sound = readWav(Buffer.from(await response.arrayBuffer()));
  assert.equal(sound.rate, RATE);
  assert.equal(sound.channels.length, 2, "the mix is stereo, like the MP4's sound");
  return { id, response, sound, left: sound.channels[0] };
}

const sceneOf = (layers, duration = 3) => createScene({ id: "main", name: "Main", width: 64, height: 36, duration, background: "#000000", layers });

test("the mix is silent before a sound starts, reads it from its offset, and stops at its trim", { skip: skipWithoutMediaTools }, async () => {
  // Play from 1 s, reading the file from 0.5 s for 0.5 s: only the 600 Hz step is heard.
  const { sound, left } = await wavOf(sceneOf([createLayer("audio", { id: "steps", name: "Steps", src: media.steps,
    mediaStart: 1, mediaOffset: 0.5, mediaDuration: 0.5, mediaSourceDuration: 1.5 })]));
  assert.equal(left.length, 3 * RATE, "the mix lasts the scene's 90 frames at 30 fps");
  assert.ok(rms(left, 0, 0.98) < 1e-3, `silent before 1 s (${rms(left, 0, 0.98)})`);
  assert.ok(Math.abs(pitch(left, 1.05, 1.45) - 600) < 10, `the 600 Hz step plays from 1 s (${pitch(left, 1.05, 1.45)} Hz)`);
  assert.ok(Math.abs(rms(left, 1.05, 1.45) - SINE_RMS) < 0.01, "at its own level");
  assert.ok(rms(left, 1.52, 3) < 1e-3, `silent after the trim at 1.5 s (${rms(left, 1.52, 3)})`);
  // The sound starts within a millisecond of 1 s.
  const first = left.findIndex((value) => Math.abs(value) > 0.02);
  assert.ok(Math.abs(first / RATE - 1) < 0.001, `starts at ${first / RATE} s`);
  // A mono file is heard the same in both ears.
  assert.ok(Math.abs(rms(sound.channels[1], 1.05, 1.45) - rms(left, 1.05, 1.45)) < 1e-3);
});

test("a layer's volume turns its sound down", { skip: skipWithoutMediaTools }, async () => {
  const { left } = await wavOf(sceneOf([createLayer("audio", { id: "tone", name: "Tone", src: media.tone, mediaSourceDuration: 4, volume: 0.5 })], 2));
  const level = rms(left, 0.2, 1.8);
  assert.ok(Math.abs(level - SINE_RMS * 0.5) < 0.004, `volume 0.5 halves the level (${level}, want ${SINE_RMS * 0.5})`);
  assert.ok(Math.abs(pitch(left, 0.2, 1.8) - 440) < 5);
});

test("a 44.1 kHz sound heard to the very end still makes a mix exactly the scene's length", { skip: skipWithoutMediaTools }, async () => {
  // The dashboard loops the mix at the scene's end, so a mix even 5 ms short would put the sound
  // 5 ms further ahead of the picture on every loop. Music is often 44.1 kHz.
  const { left } = await wavOf(sceneOf([createLayer("audio", { id: "cd", name: "CD", src: media.cd, mediaSourceDuration: 4 })], 2));
  assert.equal(left.length, 2 * RATE, "the mix lasts the scene's 60 frames at 30 fps");
  assert.ok(Math.abs(rms(left, 1.9, 1.995) - SINE_RMS) < 0.01, "and the sound plays to the end");
});

test("a video's sound is silent while a Hide hides it, and sound inside a hidden group is not heard", { skip: skipWithoutMediaTools }, async () => {
  const video = createLayer("video", { id: "clip", name: "Clip", src: media.clip, mediaSourceDuration: 3, width: 32, height: 24,
    animations: [{ id: "hide-1", name: "Hide", kind: "hide", start: 1 }, { id: "show-1", name: "Show", kind: "show", start: 2 }] });
  const group = createLayer("group", { id: "box", name: "Box", visible: false, width: 64, height: 36 });
  const hiddenTone = createLayer("audio", { id: "tone", name: "Tone", parentId: "box", src: media.tone, mediaSourceDuration: 4 });
  const { left } = await wavOf(sceneOf([video, group, hiddenTone]));
  assert.ok(Math.abs(pitch(left, 0.1, 0.95) - 550) < 8, `the video is heard, and only the video, before the Hide (${pitch(left, 0.1, 0.95)} Hz)`);
  assert.ok(Math.abs(rms(left, 0.1, 0.95) - SINE_RMS) < 0.01, "at its own level, with no tone from the hidden group");
  assert.ok(rms(left, 1.01, 1.99) < 1e-3, `silent from the Hide at 1 s to the Show at 2 s (${rms(left, 1.01, 1.99)})`);
  assert.ok(Math.abs(pitch(left, 2.05, 2.95) - 550) < 8, "heard again after the Show");

  // A scene whose only sound is inside a hidden group has nothing to play.
  const silent = await mixOf(sceneOf([createLayer("group", { id: "box", name: "Box", visible: false, width: 64, height: 36 }), hiddenTone]));
  assert.equal(silent.response.status, 204, "nothing is heard, so there is no sound to download");
});

test("a Volume fade in the mix follows the layer's volume over time", { skip: skipWithoutMediaTools }, async () => {
  const fade = { id: "fade-in", name: "Fade in", kind: "in", start: 0.5, duration: 1, easing: "linear", from: { volume: 0 }, to: { volume: 1 } };
  const { id, left } = await wavOf(sceneOf([createLayer("audio", { id: "tone", name: "Tone", src: media.tone, mediaSourceDuration: 4, animations: [fade] })], 2));
  const saved = await (await server.api(`/api/projects/${id}`)).json();
  const layer = saved.document.scenes[0].layers.find((item) => item.id === "tone");
  const levels = [];
  for (const time of [0.25, 0.6, 0.8, 1, 1.2, 1.4, 1.75]) {
    // 20 ms of sound around `time`: the level there, against the tone's level times the volume.
    const level = rms(left, time - 0.01, time + 0.01), want = SINE_RMS * volumeAt(layer, time);
    levels.push(`${time} s ${level.toFixed(3)}/${want.toFixed(3)}`);
    assert.ok(Math.abs(level - want) < 0.008, `at ${time} s the level is ${level}, want ${want}`);
  }
  assert.ok(volumeAt(layer, 0.25) === 0 && volumeAt(layer, 1.75) === 1, "the fade starts silent and ends at full volume");
  console.log(`# fade levels (got/want): ${levels.join(", ")}`);
});

// T4 mix: spoken lines recorded 12 dB apart are each leveled to -16 LUFS from their measured words
// (export.mjs voiceLevelDb, a <file>.lufs curve), so they come out within 1 dB of each other.
test("spoken lines are leveled to one loudness from their measured words", { skip: skipWithoutMediaTools }, async () => {
  const line = async (name, level) => {
    const src = await upload(await makeSound(name, `${level}*sin(2*PI*440*t)`, 2), "audio/wav");
    const file = path.join(server.dataDirectory, "media", src.split("/").pop());
    await writeFile(`${file}.words-test`, JSON.stringify({ words: [{ text: "hello", start: 0.2, end: 1.8 }] }));
    return src;
  };
  const loud = await line("loud-line.wav", LEVEL), quiet = await line("quiet-line.wav", LEVEL / 4);
  const { left } = await wavOf(sceneOf([
    createLayer("audio", { id: "loud", name: "Loud", src: loud, mediaSourceDuration: 2, mediaDuration: 2 }),
    createLayer("audio", { id: "quiet", name: "Quiet", src: quiet, mediaStart: 2, mediaSourceDuration: 2, mediaDuration: 2 }),
  ], 4));
  const spread = 20 * Math.log10(rms(left, 0.5, 1.5) / rms(left, 2.5, 3.5));
  assert.ok(Math.abs(spread) <= 1, `the lines are ${spread.toFixed(2)} dB apart`);
  // One clip holding both lines (12 dB apart, a pause between) is leveled line by line too.
  const both = await upload(await makeSound("both-lines.wav", `if(lt(t,2),${LEVEL},if(lt(t,2.6),0,${LEVEL / 4}))*sin(2*PI*440*t)`, 4.6), "audio/wav");
  const bothFile = path.join(server.dataDirectory, "media", both.split("/").pop());
  await writeFile(`${bothFile}.words-test`, JSON.stringify({ words: [{ text: "walk", start: 0.2, end: 1.8 }, { text: "careful", start: 2.8, end: 4.4 }] }));
  const one = (await wavOf(sceneOf([createLayer("audio", { id: "both", name: "Both", src: both, mediaSourceDuration: 4.6, mediaDuration: 4.6 })], 4.6))).left;
  const lines = 20 * Math.log10(rms(one, 0.5, 1.5) / rms(one, 3, 4));
  assert.ok(Math.abs(lines) <= 1.5, `the lines of one clip are ${lines.toFixed(2)} dB apart`);
});

test("the mix sounds like the exported MP4's sound track", { skip: skipWithoutMediaTools }, async () => {
  const scene = sceneOf([
    createLayer("audio", { id: "steps", name: "Steps", src: media.steps, mediaStart: 0.4, mediaOffset: 0.25, mediaSourceDuration: 1.5 }),
    createLayer("audio", { id: "tone", name: "Tone", src: media.tone, mediaSourceDuration: 4, volume: 0.8,
      animations: [{ id: "fade-out", name: "Fade out", kind: "out", start: 1.5, duration: 1, easing: "smooth", from: { volume: 1 }, to: { volume: 0 } }] }),
    createLayer("video", { id: "clip", name: "Clip", src: media.clip, mediaSourceDuration: 3, width: 32, height: 24, volume: 0.6,
      animations: [{ id: "hide-1", name: "Hide", kind: "hide", start: 2.2 }] }),
  ]);
  const { id, left } = await wavOf(scene);
  const saved = await (await server.api(`/api/projects/${id}`)).json();
  const outputPath = path.join(folder, "export.mp4");
  await exportScene(saved.document.scenes[0], { format: "mp4", profile: "mp4.alt", fps: 30 }, { mediaRoot: path.join(server.dataDirectory, "media"), outputPath });
  const raw = await run(ffmpeg, ["-v", "error", "-i", outputPath, "-map", "0:a:0", "-ac", "2", "-ar", String(RATE), "-f", "f32le", "pipe:1"]);
  const stereo = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const exported = stereo.filter((_, at) => at % 2 === 0);
  // AAC works in blocks of 1024 samples, so its decoded length may differ by up to one block.
  assert.ok(Math.abs(exported.length - left.length) <= 1024, `lengths ${exported.length} and ${left.length}`);

  // The two line up with no delay: the best match of the first 2.5 s is at 0 samples apart.
  let best = { lag: 0, score: -Infinity };
  for (let lag = -480; lag <= 480; lag += 1) {
    let score = 0;
    for (let at = index(0.3); at < index(2.5); at += 4) score += left[at] * (exported[at + lag] ?? 0);
    if (score > best.score) best = { lag, score };
  }
  assert.ok(Math.abs(best.lag) <= 1, `the export's sound is ${best.lag} samples away from the mix`);

  // The loudness over time matches, 10 ms at a time, within what AAC changes.
  let worst = 0, total = 0, windows = 0;
  for (let from = 0; from + 0.01 <= 2.99; from += 0.01) {
    const difference = Math.abs(rms(left, from, from + 0.01) - rms(exported, from, from + 0.01));
    worst = Math.max(worst, difference);
    total += difference;
    windows += 1;
  }
  console.log(`# mix vs export: worst 10 ms level difference ${worst.toFixed(4)}, mean ${(total / windows).toFixed(5)}, lag ${best.lag}`);
  assert.ok(worst < 0.02, `the worst 10 ms level difference is ${worst}`);
  assert.ok(total / windows < 0.003, `the mean 10 ms level difference is ${total / windows}`);
});

test("the route says when the sound is unchanged, follows sound edits, and explains bad requests", { skip: skipWithoutMediaTools }, async () => {
  const scene = sceneOf([
    createLayer("audio", { id: "tone", name: "Tone", src: media.tone, mediaSourceDuration: 4 }),
    createLayer("rectangle", { id: "card", name: "Card", x: 4, y: 4, width: 20, height: 20, fill: "#ff0000" }),
  ], 2);
  const { id, response } = await wavOf(scene);
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{32}"$/);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(response.headers.get("x-mix-rev"), "1");
  const mixUrl = `/api/dashboard/mix?project=${id}&scene=main`;
  const again = await server.api(mixUrl, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304, "the same sound is not sent again");
  const head = await server.api(mixUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const edit = async (ops) => {
    const reply = await (await server.api("/api/agent/edit", { method: "POST", body: { project: id, ops } })).json();
    assert.equal(reply.isError, undefined, reply.text);
  };
  // Moving the card changes the picture, not the sound: the new revision has the same mix.
  await edit([{ op: "update_layer", layer: "card", properties: { x: 30 } }]);
  const moved = await server.api(mixUrl, { headers: { "if-none-match": etag } });
  assert.equal(moved.status, 304, "a picture-only edit keeps the same sound");
  assert.equal(moved.headers.get("x-mix-rev"), "2");
  // Turning the tone down changes the sound.
  await edit([{ op: "update_layer", layer: "tone", properties: { volume: 0.5 } }]);
  const quieter = await server.api(mixUrl, { headers: { "if-none-match": etag } });
  assert.equal(quieter.status, 200);
  assert.notEqual(quieter.headers.get("etag"), etag);
  assert.ok(Math.abs(rms(readWav(Buffer.from(await quieter.arrayBuffer())).channels[0], 0.2, 1.8) - SINE_RMS * 0.5) < 0.004);
  // An older revision still has its own sound.
  const first = await server.api(`${mixUrl}&rev=1`);
  assert.equal(first.headers.get("etag"), etag);

  for (const [query, status, message] of [
    [`project=${id}&scene=main&fps=0`, 400, /fps is a whole number/],
    [`project=${id}&scene=nowhere`, 404, /not in rev/],
    [`project=${id}&scene=main&rev=99`, 400, /saved revision/],
    ["project=missing&scene=main", 404, /could not be found/],
  ]) {
    const response = await server.api(`/api/dashboard/mix?${query}`);
    assert.equal(response.status, status, query);
    assert.match((await response.json()).error, message);
  }
  const stranger = await server.api(mixUrl, { owner: false });
  assert.ok([401, 403].includes(stranger.status), "only the owner hears the dashboard's sound");
});

// ---- Clip speed (engine/mediaTime.js, backend/sound-remap.mjs) ----

test("a clip with a speed keeps its pitch (atempo) or lets it follow (like tape), and the mix stays the scene's length", { skip: skipWithoutMediaTools }, async () => {
  const heard = [];
  for (const [speed, mediaPitch, want] of [[2, "keep", 440], [2, "follow", 880], [0.5, "keep", 440], [0.5, "follow", 220]]) {
    const { left } = await wavOf(sceneOf([createLayer("audio", { id: "tone", name: "Tone", src: media.tone, mediaSourceDuration: 4, mediaSpeed: speed, mediaPitch })], 2));
    assert.equal(left.length, 2 * RATE, `${speed}× ${mediaPitch}: the mix lasts the scene's 60 frames`);
    const got = pitch(left, 0.2, 1.8);
    heard.push(`${speed}× ${mediaPitch} ${got.toFixed(1)} Hz`);
    assert.ok(Math.abs(got - want) < 5, `${speed}× ${mediaPitch}: ${got} Hz, want ${want}`);
    assert.ok(Math.abs(rms(left, 0.2, 1.8) - SINE_RMS) < 0.015, `${speed}× ${mediaPitch}: at its own level (${rms(left, 0.2, 1.8)})`);
  }
  console.log(`# speed and pitch: ${heard.join(", ")}`);
});

test("a reversed clip plays its part from the end back, at its own speed or faster", { skip: skipWithoutMediaTools }, async () => {
  // The steps file is 300 Hz, then 600 Hz, then 900 Hz, half a second each.
  const backwards = (await wavOf(sceneOf([createLayer("audio", { id: "steps", name: "Steps", src: media.steps, mediaSourceDuration: 1.5, mediaReverse: true })], 2))).left;
  assert.equal(backwards.length, 2 * RATE);
  for (const [from, to, want] of [[0.05, 0.45, 900], [0.55, 0.95, 600], [1.05, 1.45, 300]])
    assert.ok(Math.abs(pitch(backwards, from, to) - want) < 8, `${from}-${to} s: ${pitch(backwards, from, to)} Hz, want ${want}`);
  assert.ok(rms(backwards, 1.52, 2) < 1e-3, "silent after the part ends at 1.5 s");
  // Twice as fast with the pitch kept: each step lasts a quarter of a second.
  const fast = (await wavOf(sceneOf([createLayer("audio", { id: "steps", name: "Steps", src: media.steps, mediaSourceDuration: 1.5, mediaReverse: true, mediaSpeed: 2 })], 2))).left;
  for (const [from, to, want] of [[0.03, 0.22, 900], [0.28, 0.47, 600], [0.53, 0.72, 300]])
    assert.ok(Math.abs(pitch(fast, from, to) - want) < 12, `2×: ${from}-${to} s: ${pitch(fast, from, to)} Hz, want ${want}`);
  assert.ok(rms(fast, 0.77, 2) < 1e-3, "silent after the part ends at 0.75 s");
});

test("a Speed animation slides the pitch like tape, and a 44.1 kHz file still mixes to exactly the scene's length", { skip: skipWithoutMediaTools }, async () => {
  // Linear from 1× to 0.5× over the 2 s scene: the speed at t is 1 − t / 4, and so is the pitch.
  const ramp = { id: "cd.speed", name: "Speed", kind: "custom", start: 0, duration: 2, easing: "linear", from: { speed: 1 }, to: { speed: 0.5 } };
  const { left } = await wavOf(sceneOf([createLayer("audio", { id: "cd", name: "CD", src: media.cd, mediaSourceDuration: 4, animations: [ramp] })], 2));
  assert.equal(left.length, 2 * RATE, "the mix lasts the scene's 60 frames");
  const heard = [];
  for (const [from, to] of [[0.1, 0.3], [0.9, 1.1], [1.7, 1.9]]) {
    const want = 440 * (1 - (from + to) / 2 / 4), got = pitch(left, from, to);
    heard.push(`${from}-${to} s ${got.toFixed(1)}/${want.toFixed(1)} Hz`);
    assert.ok(Math.abs(got - want) < want * 0.02, `${from}-${to} s: ${got} Hz, want ${want}`);
  }
  assert.ok(Math.abs(rms(left, 1.9, 1.995) - SINE_RMS) < 0.015, "and plays to the very end");
  console.log(`# ramp pitch (got/want): ${heard.join(", ")}`);
  // A constant speed on the same 44.1 kHz file.
  const steady = (await wavOf(sceneOf([createLayer("audio", { id: "cd", name: "CD", src: media.cd, mediaSourceDuration: 4, mediaSpeed: 1.5 })], 2))).left;
  assert.equal(steady.length, 2 * RATE);
  assert.ok(Math.abs(rms(steady, 1.9, 1.995) - SINE_RMS) < 0.015, "1.5× plays to the very end too");
});

test("the mix follows a speed edit, and an exported MP4 has the same sped-up and reversed sound", { skip: skipWithoutMediaTools }, async () => {
  const scene = sceneOf([
    createLayer("audio", { id: "tone", name: "Tone", src: media.tone, mediaSourceDuration: 4, mediaSpeed: 2 }),
    createLayer("audio", { id: "steps", name: "Steps", src: media.steps, mediaSourceDuration: 1.5, mediaReverse: true, mediaStart: 1.5, volume: 0.5 }),
    // The video's own 550 Hz sound at half speed, its pitch kept.
    createLayer("video", { id: "clip", name: "Clip", src: media.clip, mediaSourceDuration: 3, mediaSpeed: 0.5, width: 32, height: 24, volume: 0.6 }),
  ]);
  const { id, response, left } = await wavOf(scene);
  assert.equal(left.length, 3 * RATE);
  const etag = response.headers.get("etag");
  // The same files at the same places, only the pitch setting changed: a new sound.
  const reply = await (await server.api("/api/agent/edit", { method: "POST", body: { project: id, ops: [{ op: "update_layer", layer: "tone", properties: { mediaPitch: "follow" } }] } })).json();
  assert.equal(reply.isError, undefined, reply.text);
  const followed = await server.api(`/api/dashboard/mix?project=${id}&scene=main`, { headers: { "if-none-match": etag } });
  assert.equal(followed.status, 200, "a speed setting is part of the sound");
  assert.notEqual(followed.headers.get("etag"), etag);
  const mix = readWav(Buffer.from(await followed.arrayBuffer())).channels[0];

  const saved = await (await server.api(`/api/projects/${id}`)).json();
  const outputPath = path.join(folder, "speed-export.mp4");
  await exportScene(saved.document.scenes[0], { format: "mp4", profile: "mp4.alt", fps: 30 }, { mediaRoot: path.join(server.dataDirectory, "media"), outputPath });
  const raw = await run(ffmpeg, ["-v", "error", "-i", outputPath, "-map", "0:a:0", "-ac", "2", "-ar", String(RATE), "-f", "f32le", "pipe:1"]);
  const stereo = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const exported = stereo.filter((_, at) => at % 2 === 0);
  assert.ok(Math.abs(exported.length - mix.length) <= 1024, `lengths ${exported.length} and ${mix.length}`);
  // The loudness over time matches the mix, 10 ms at a time, within what AAC changes.
  let worst = 0;
  for (let from = 0; from + 0.01 <= 2.99; from += 0.01) worst = Math.max(worst, Math.abs(rms(mix, from, from + 0.01) - rms(exported, from, from + 0.01)));
  assert.ok(worst < 0.02, `the worst 10 ms level difference is ${worst}`);
  // On its own the followed tone is 880 Hz: the export's first second is that tone and the video's.
  const spectrum = (samples, frequency) => {
    let [re, im] = [0, 0];
    for (let at = index(0.2); at < index(1.2); at += 1) { re += samples[at] * Math.cos(2 * Math.PI * frequency * at / RATE); im += samples[at] * Math.sin(2 * Math.PI * frequency * at / RATE); }
    return Math.hypot(re, im) / (index(1.2) - index(0.2));
  };
  for (const samples of [mix, exported]) {
    assert.ok(spectrum(samples, 880) > 0.08, `the 2× tone follows to 880 Hz (${spectrum(samples, 880)})`);
    assert.ok(spectrum(samples, 550) > 0.05, `the half-speed video keeps 550 Hz (${spectrum(samples, 550)})`);
    assert.ok(spectrum(samples, 440) < 0.01 && spectrum(samples, 275) < 0.01, "and nothing is at the old or the halved pitch");
  }
});
