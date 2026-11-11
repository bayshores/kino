// Cleaning a voiceover through the agent service (POST /api/agent/<verb>) on a real server: the
// skill's example (references/sound.md "Cleaning a voiceover") runs as written. Speech models do
// not ship with the tests, so whisper-cli is a stand-in (tests/fake-whisper-cli.mjs) that hears
// test tones as words; everything else is the real path: decoding, chunks, the two passes, word
// times snapped to the sound, quiet cut points, the saved transcript, cut_speech's pieces and
// ripple, and captions from the cut voice.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";
import { toneWords, writeFakeWhisper } from "../tests/fake-whisper-cli.mjs";
import { writeWav } from "../tests/voice-mix.mjs";
import { TRANSCRIPT_VERSION, whisperSetup } from "./speech/transcribe.mjs";

// "So we will, we will um try. Like, the Acmes app.": a repeat (1-2), a filler (5), a 1.15 s pause
// before "Like," and a misheard name. Tone 11 is one the stand-in does not write down, so kino
// lists it as (unclear) at index 7, and the words after it are 8-11.
const WORDS = ["So", "we", "will,", "we", "will", "um", "try.", "Like,", "the", "Acmes", "app."];
const TONES = [[0, 0.5, 0.8], [1, 0.95, 1.15], [2, 1.3, 1.55], [3, 1.7, 1.9], [4, 2.05, 2.3], [5, 2.5, 2.8], [6, 2.95, 3.25],
  [11, 3.5, 3.85], [7, 5.0, 5.3], [8, 5.45, 5.6], [9, 5.75, 6.1], [10, 6.25, 6.6]];
const DURATION = 7.2;

let server;
let folder;
let wav;
before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "kino-speech-agent-"));
  const env = await writeFakeWhisper(folder, WORDS);
  server = await startTestServer({ env });
  wav = path.join(folder, "voiceover.wav");
  if (!skipWithoutMediaTools) await writeWav(wav, toneWords(TONES, DURATION));
});
after(async () => {
  await server?.stop();
  await rm(folder, { recursive: true, force: true });
});

async function upload(target, file, name) {
  const response = await target.api("/api/media", { method: "POST", headers: { "content-type": "audio/wav", "x-file-name": name }, body: await readFile(file) });
  assert.equal(response.status, 201, await response.clone().text());
  const media = await response.json();
  return media.media ?? media;
}

async function sceneOf(target, project) {
  const record = await (await target.api(`/api/projects/${project}`)).json();
  return { document: record.document, scene: record.document.scenes[0] };
}

test("the voiceover example in the kino skill runs as written", { skip: skipWithoutMediaTools }, async (t) => {
  const [calls] = jsonBlocks(skillSection("Cleaning a voiceover"));
  assert.deepEqual(calls.map((call) => call.tool), ["edit", "inspect", "edit"]);
  const media = await upload(server, wav, "voiceover.wav");
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  const made = await client.call("project", { action: "create", id: "vo", name: "Voiceover", width: 640, height: 360, duration: 8 });
  assert.equal(made.isError, undefined, made.text);
  // Something after the slips, to see ripple move it: a title that fades in at 5 s.
  const title = await client.call("edit", { project: "vo", ops: [{ op: "add_layer", layerType: "text", name: "title", properties: { text: "Acme" } },
    { op: "add_animation", layer: "title", animation: { kind: "in", start: 5, duration: 0.5, from: { opacity: 0 }, to: { opacity: 1 } } }] });
  assert.equal(title.isError, undefined, title.text);

  const replies = [];
  for (const { tool, ...call } of calls) {
    const body = JSON.parse(JSON.stringify(call).replace("/api/media/<voiceover>.wav", media.src));
    const started = performance.now();
    const reply = await client.call(tool, { project: "vo", ...body });
    assert.equal(reply.isError, undefined, `${tool}: ${reply.text}`);
    replies.push({ reply, ms: Math.round(performance.now() - started) });
  }
  const [, { reply: listed, ms }, { reply: cut }] = replies;
  t.diagnostic(`inspect speech (first, stand-in whisper) ${ms} ms\n${listed.text}`);

  // The words, their indices and scene times (within 0.1 s of each tone's start), and the slips.
  // The tones are in time order, so tone n is transcript word n (the unclear one is 7).
  const starts = Object.fromEntries([...listed.text.matchAll(/(\d+):(\S+) ([\d.]+)/g)].map((match) => [match[1], Number(match[3])]));
  for (const [order, [, start]] of TONES.entries())
    assert.ok(Math.abs(starts[order] - start) <= 0.1, `word ${order} starts at ${starts[order]}, the tone at ${start}`);
  assert.match(listed.text, /repeat 1-2 "we will,"/);
  assert.match(listed.text, /filler 5 "um"/);
  assert.match(listed.text, /maybe 8 "Like,"/);
  assert.match(listed.text, /unclear 7 "\(unclear\)"/);
  assert.match(listed.text, /pause 8 \(1\.\d+s\)/);
  assert.match(listed.text, /10:Acmes/);
  assert.equal(listed.data.words, 12);

  // cut_speech: the slips and the long pause are gone, the voice is in pieces, later times moved.
  const { speech, captions } = cut.data;
  t.diagnostic(`cut_speech: ${JSON.stringify(speech)}`);
  assert.equal(speech.words, 3);
  assert.ok(speech.pauses >= 1, "the long pause was shortened");
  // About 0.75 s (we will,) + 0.45 s (um) + 0.75 s (the 1.15 s pause down to 0.4 s).
  assert.ok(speech.removed > 1.5 && speech.removed < 2.5, `removed ${speech.removed}`);
  assert.equal(speech.pieces, 4);
  assert.match(speech.moved, /1 other layer/);
  const { scene } = await sceneOf(server, "vo");
  const pieces = scene.layers.filter((layer) => layer.src === media.src).sort((a, b) => a.mediaStart - b.mediaStart);
  assert.deepEqual(pieces.map((piece) => piece.name), ["vo", "vo-2", "vo-3", "vo-4"]);
  for (let i = 1; i < pieces.length; i += 1)
    assert.ok(Math.abs(pieces[i].mediaStart - (pieces[i - 1].mediaStart + pieces[i - 1].mediaDuration)) < 0.002, "pieces play back to back");
  const fade = scene.layers.find((layer) => layer.name === "title").animations[0];
  assert.ok(Math.abs(fade.start - (5 - speech.removed)) < 0.002, `the title's fade moved from 5 s to ${fade.start}`);

  // Captions from the cut voice: no um, no unclear, the name fixed, word cues where the words play now.
  assert.equal(captions.speech.layer, "vo");
  assert.equal(captions.speech.fixed, 1);
  const { document, scene: captioned } = await sceneOf(server, "vo");
  const text = captioned.layers.filter((layer) => layer.role === "caption").map((layer) => layer.text).join(" ");
  assert.match(text, /Acme app\./);
  assert.doesNotMatch(text, /\bum\b|Acmes|unclear/);
  const again = await client.call("inspect", { project: "vo", targets: ["speech:vo"] });
  assert.match(again.text, /saved transcript/);
  assert.doesNotMatch(again.text, /\b5:um\b|\b1:we\b/);
  const like = Number(/(\d+):Like, ([\d.]+)/.exec(again.text)[2]);
  const cue = document.cues.find((item) => item.kind === "word" && /like/i.test(item.name));
  assert.ok(cue && Math.abs(cue.time - like) < 0.05, `the "Like" word cue at ${cue?.time}, the word at ${like}`);

  // The transcript is kept beside the library file, not as a .json record the library would list.
  const files = await readdir(path.join(server.dataDirectory, "media"));
  assert.ok(files.some((name) => /\.words-small\.en$/.test(name)), files.join(", "));
  const library = await client.call("library", { project: "vo", topic: "media" });
  assert.equal(library.isError, undefined, library.text);

  // A later piece lists only its own words; the first names the cut words; restore:"all" rejoins the voice.
  const piece = await client.call("inspect", { project: "vo", targets: ["speech:vo-2"] });
  t.diagnostic(`inspect speech:vo-2\n${piece.text}`);
  assert.match(piece.text, /speech "vo-2"/);
  assert.match(piece.text, /piece 2 of 4 of "vo"/);
  assert.doesNotMatch(piece.text, /\b0:So\b/);
  assert.match(again.text, /cut 1-2 "we will,", 5 "um"/);
  const restored = await client.call("edit", { project: "vo", ops: [{ op: "cut_speech", layer: "vo", restore: "all" }] });
  assert.equal(restored.isError, undefined, restored.text);
  t.diagnostic(`restore: ${JSON.stringify(restored.data.speech)}`);
  assert.equal(restored.data.speech.pieces, 1);
  assert.ok(Math.abs(restored.data.speech.restored - speech.removed) < 0.002, `restored ${restored.data.speech.restored} of ${speech.removed}`);
  const { scene: whole } = await sceneOf(server, "vo");
  const voices = whole.layers.filter((layer) => layer.src === media.src);
  assert.deepEqual(voices.map((layer) => layer.name), ["vo"]);
  assert.ok(!voices[0].animations.some((animation) => /^Join/.test(animation.name)));
  assert.ok(Math.abs(whole.layers.find((layer) => layer.name === "title").animations[0].start - 5) < 0.002, "the title's fade is back at 5 s");

  // place_broll through the service: the clip comes in 0.2 s before "Acmes" (tone at 5.75 s) and
  // stays to the end of the sentence; a clip whose words are never said is reported.
  const broll = await client.call("edit", { project: "vo", ops: [
    { op: "add_layer", layerType: "video", name: "app-shot", properties: { src: media.src } },
    { op: "add_layer", layerType: "video", name: "rocket", properties: { src: media.src } },
    { op: "place_broll", speech: "vo", clips: { "app-shot": "the Acmes app", rocket: "rocket launch" } }] });
  assert.equal(broll.isError, undefined, broll.text);
  t.diagnostic(`place_broll: ${JSON.stringify(broll.data.broll)}`);
  const shot = (await sceneOf(server, "vo")).scene.layers.find((layer) => layer.name === "app-shot");
  assert.ok(Math.abs(shot.mediaStart - 5.55) < 0.1 && shot.mediaStart + shot.mediaDuration > 6.6, `app-shot ${shot.mediaStart} + ${shot.mediaDuration}`);
  assert.match(JSON.stringify(broll.data), /rocket: no word of \\"rocket launch\\" is said/);

  // keep_line through the service: the line is found in the saved transcript; only it stays audible, with a subtitle.
  const kept = await client.call("edit", { project: "vo", ops: [{ op: "keep_line", layer: "vo", line: "the Acmes app" }] });
  assert.equal(kept.isError, undefined, kept.text);
  t.diagnostic(`keep_line: ${JSON.stringify(kept.data.keepLine)}`);
  assert.ok(Math.abs(kept.data.keepLine.scene[0] - 5.45) < 0.1 && Math.abs(kept.data.keepLine.scene[1] - 6.6) < 0.1, JSON.stringify(kept.data.keepLine.scene));
  const voice = (await sceneOf(server, "vo")).scene.layers.find((layer) => layer.name === "vo");
  assert.deepEqual(voice.animations.filter((animation) => /^Line /.test(animation.name)).map((animation) => animation.name), ["Line mute", "Line up", "Line down"]);
  assert.equal(kept.data.keepLine.duck, "none", "no music layer in this project: no dip");
});

test("a muted clip's spoken lines are named once (edit receipt or status); keep_line and isolate_voice in one edit keep the line over the voice-only sound", { skip: skipWithoutMediaTools }, async () => {
  const media = await upload(server, wav, "clip-sound.wav");
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  assert.equal((await client.call("project", { action: "create", id: "lines", width: 320, height: 180, duration: 8 })).isError, undefined);
  const added = await client.call("edit", { project: "lines", ops: [{ op: "add_layer", layerType: "audio", name: "vo", properties: { src: media.src, mediaStart: 0 } }] });
  assert.equal(added.isError, undefined, added.text);
  assert.equal((await client.call("inspect", { project: "lines", targets: ["speech:vo"] })).isError, undefined);
  // Heard at volume 1: nothing to say. At volume 0 the clip's saved lines are named, with the call that keeps one.
  const said = (reply) => (reply.data.notes ?? []).join("\n");
  const muted = await client.call("edit", { project: "lines", ops: [{ op: "update_layer", layer: "vo", properties: { volume: 0 } }] });
  assert.equal(muted.isError, undefined, muted.text);
  assert.match(said(muted), /your clips say 2 lines and none is heard: vo "So we will, we will" 0\.5-2\.3 s · vo "Like, the Acmes app\." 5-6\.6 s/);
  assert.ok(said(muted).includes('edit {"ops":[{"op":"keep_line","layer":"vo","line":"So we will, we will"},{"op":"isolate_voice","layer":"vo"}]}'), said(muted));
  // Once: the next edit and status do not repeat it.
  const again = await client.call("edit", { project: "lines", ops: [{ op: "update_layer", layer: "vo", properties: { volume: 0 } }] });
  assert.doesNotMatch(said(again), /your clips say/);
  assert.doesNotMatch((await client.call("status", { project: "lines" })).text, /your clips say/);
  // The documented call: keep_line, then isolate_voice, in one edit.
  const kept = await client.call("edit", { project: "lines", ops: [{ op: "keep_line", layer: "vo", line: "the Acmes app" }, { op: "isolate_voice", layer: "vo", engine: "rnnoise" }] });
  assert.equal(kept.isError, undefined, kept.text);
  assert.ok(kept.data.keepLine, JSON.stringify(kept.data));
  const { scene } = await sceneOf(server, "lines");
  const voice = scene.layers.find((layer) => layer.name === "vo");
  assert.notEqual(voice.src, media.src, "the layer plays the voice-only file now");
  assert.deepEqual(voice.animations.filter((animation) => /^Line /.test(animation.name)).map((animation) => animation.name), ["Line mute", "Line up", "Line down"]);
});

test("short lines the layer does not play never hide the one it plays; a line just past the trim is named with file seconds and a call that moves the trim; keep_line reads a transcript heard with older names", { skip: skipWithoutMediaTools }, async () => {
  const other = path.join(folder, "long-clip.wav");
  await writeWav(other, toneWords(TONES, DURATION + 0.1));
  const media = await upload(server, other, "long-clip.wav");
  // Saved under names the brief no longer has: four short lines, then the long one the layer plays.
  const said = [["Go", "now."], ["Hey", "you."], ["Stop", "it."], ["Run", "fast."], ["The", "whole", "long", "line", "is", "here."]];
  const starts = [0.1, 0.6, 1.1, 1.9, 3.0];
  const words = said.flatMap((line, index) => line.map((text, at) => ({ text, start: starts[index] + at * 0.3, end: starts[index] + at * 0.3 + 0.2, p: 0.9 })));
  const file = path.join(server.dataDirectory, "media", media.src.split("/").pop());
  await writeFile(`${file}.words-small.en-0123abcd`, JSON.stringify({ version: TRANSCRIPT_VERSION, words }));
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  assert.equal((await client.call("project", { action: "create", id: "long-lines", width: 320, height: 180, duration: 8 })).isError, undefined);
  const added = await client.call("edit", { project: "long-lines", ops: [{ op: "add_layer", layerType: "audio", name: "vo", properties: { src: media.src, mediaStart: 0, mediaOffset: 2.8, mediaDuration: 2.4, volume: 0 } }] });
  assert.equal(added.isError, undefined, added.text);
  const note = (added.data.notes ?? []).join("\n");
  assert.match(note, /your clips say 2 lines and none is heard: vo "The whole long line is here\." 0\.2-1\.9 s · vo "Run fast\." plays 2\.8-5\.2, line at 1\.9-2\.4\./);
  // The brief now names someone, so whisper would hear the clip with other names: keep_line finds the line the agent was shown.
  assert.equal((await client.call("notes", { project: "long-lines", action: "brief", fields: { message: { text: "made for Zuri riders", by: "guessed" } } })).isError, undefined);
  const kept = await client.call("edit", { project: "long-lines", ops: [...["reference", "treatments"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a test of keep_line" })), { op: "keep_line", layer: "vo", line: "The whole long line is here." }] });
  assert.equal(kept.isError, undefined, kept.text);
  assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.startsWith(`${path.basename(file)}.words`)), [`${path.basename(file)}.words-small.en-0123abcd`]);
  // A line the trim cuts off: the named call moves the trim and keeps the line, pasted as written.
  assert.equal((await client.call("project", { action: "create", id: "cut-line", width: 320, height: 180, duration: 8 })).isError, undefined);
  const cut = await client.call("edit", { project: "cut-line", ops: [{ op: "add_layer", layerType: "audio", name: "vo", properties: { src: media.src, mediaStart: 1, mediaOffset: 3.6, mediaDuration: 2.4, volume: 0 } }] });
  const { ops } = JSON.parse((cut.data.notes ?? []).join("\n").match(/edit (\{.*\})\. The song/)[1]);
  assert.deepEqual(ops.slice(0, 2), [{ op: "update_layer", layer: "vo", properties: { mediaOffset: 2.8 } }, { op: "keep_line", layer: "vo", line: "The whole long line is here." }]);
  const pasted = await client.call("edit", { project: "cut-line", ops: [{ op: "waive_check", code: "reference", target: "*", reason: "a test of keep_line" }, ...ops.filter((op) => op.op !== "isolate_voice")] });
  assert.deepEqual(pasted.data.keepLine?.file, [3, 4.7], pasted.text);
});

test("the dashboard's own check (listen:false) never transcribes; an agent's full check does", { skip: skipWithoutMediaTools }, async () => {
  const key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
  const media = await upload(server, wav, "dashboard-voice.wav");
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  assert.equal((await client.call("project", { action: "create", id: "listen", width: 320, height: 180, duration: 8 })).isError, undefined);
  const added = await client.call("edit", { project: "listen", ops: [{ op: "add_layer", layerType: "audio", name: "voice", properties: { src: media.src, mediaStart: 0 } }] });
  assert.equal(added.isError, undefined, added.text);
  const id = path.basename(media.src);
  const transcripts = async () => (await readdir(path.join(server.dataDirectory, "media"))).filter((name) => name.startsWith(id) && name.includes(".words-"));
  const quiet = await server.api("/api/dashboard/act/check", { method: "POST", headers: { "x-kino-review": key }, body: { project: "listen", quiet: true, listen: false } });
  assert.equal(quiet.status, 200, await quiet.clone().text());
  assert.deepEqual(await transcripts(), [], "the dashboard's check made no transcript");
  assert.equal((await client.call("check", { project: "listen" })).isError, undefined);
  assert.equal((await transcripts()).length, 1, "a full check transcribes the voice");
});

test("without whisper-cli or a model, the refusal says how to install them and nothing is downloaded", { skip: skipWithoutMediaTools }, async () => {
  const missing = await startTestServer({ env: { KINO_WHISPER_CLI: path.join(folder, "no-such-whisper-cli"), KINO_WHISPER_MODEL: path.join(folder, "ggml-small.en.bin") } });
  try {
    const media = await upload(missing, wav, "voiceover.wav");
    const client = createAgentClient({ url: missing.baseUrl, ownerToken: missing.ownerToken }, { name: "cli" });
    await client.call("project", { action: "create", id: "vo", name: "Voiceover", width: 640, height: 360, duration: 8 });
    const added = await client.call("edit", { project: "vo", ops: [{ op: "add_layer", layerType: "audio", name: "vo", properties: { src: media.src } }] });
    assert.equal(added.isError, undefined, added.text);
    const listed = await client.call("inspect", { project: "vo", targets: ["speech:vo"] });
    assert.equal(listed.isError, true);
    assert.match(listed.text, /whisper-cli was not found .*brew install whisper-cpp/);
    const cut = await client.call("edit", { project: "vo", ops: [{ op: "cut_speech", layer: "vo", words: [1] }] });
    assert.equal(cut.isError, true);
    assert.match(cut.text, /whisper-cli was not found/);
    const text = await client.call("edit", { project: "vo", ops: [{ op: "add_layer", layerType: "text", name: "t", properties: { text: "Hi" } }, { op: "add_captions", speech: "t" }] });
    assert.equal(text.isError, true);
    assert.match(text.text, /audio or video/);
  } finally {
    await missing.stop();
  }
  // No model: whisperSetup names the place to put one (the inspect and edit refusals carry it).
  assert.throws(() => whisperSetup({ env: { KINO_WHISPER_MODEL: path.join(folder, "missing.bin") } }), (error) => error.code === "SPEECH_MODEL_MISSING" && /~\/\.kino\/models/.test(error.message));
  assert.throws(() => whisperSetup({ env: {}, home: folder, exists: () => false }), /No whisper model file\. Install whisper\.cpp/);
});
