// isolate_voice through the agent service (POST /api/agent/<verb>) on a real server, measured on a
// real speech clip mixed with music and hiss (tests/voice-mix.mjs), never just "a file exists":
// - the skill's example (references/sound.md) on a video: the picture is copied packet for
//   packet, the voice and the new background layer add up to the original sound, and a later op
//   in the edit names the layer;
// - rnnoise on an audio layer: the voice is closer to the clean speech than the mixture was, an mp4
//   export plays the voice stem at the layer's Play start, history revert brings the original
//   sound back (in the export too), and a second run is a cache hit;
// - refusals in plain words with the next step; "auto" works with downloads off;
// - DPDFNet, only when KINO_VOICE_MODEL names the model (CI sets it).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";
import { SAMPLE_RATE, SPEECH_CLIP, buildMixture, decodeSamples, siSdr, writeWav } from "../tests/voice-mix.mjs";

let server;
let folder;
// 2 s of speech with 0.5 s of music and hiss before and after it: 3 s in all.
let speech, mixture, mixtureWav;
before(async () => {
  server = await startTestServer({ env: { KINO_VOICE_DOWNLOAD: "0" } });
  folder = await mkdtemp(path.join(tmpdir(), "kino-voice-agent-"));
  if (skipWithoutMediaTools) return;
  ({ speech, mixture } = buildMixture((await decodeSamples(SPEECH_CLIP)).subarray(0, 2 * SAMPLE_RATE)));
  mixtureWav = path.join(folder, "dialogue.wav");
  await writeWav(mixtureWav, mixture);
});
after(async () => {
  await server?.stop();
  await rm(folder, { recursive: true, force: true });
});

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

async function layers(project) {
  const record = await (await server.api(`/api/projects/${project}`)).json();
  return { revision: record.revision, layers: record.document.scenes[0].layers, clipLinks: record.document.clipLinks ?? [] };
}

const mediaFile = (src) => path.join(server.dataDirectory, "media", src.split("/").pop());
const mediaRecord = async (src) => JSON.parse(await readFile(`${mediaFile(src)}.json`, "utf8"));

// The video packets of a file, one checksum each: equal lists mean the same picture, not encoded again.
async function videoPackets(file) {
  const text = String(await run(ffmpeg, ["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "framemd5", "-"]));
  return text.split("\n").filter((line) => line && !line.startsWith("#"));
}

// SI-SDR of the part of `signal` that starts at sample `at` against `reference`, at the best
// small shift (an encoder may move sound by a few samples).
function scoreAt(reference, signal, at, search = 240) {
  let best = { db: -Infinity, lag: 0 };
  for (let lag = -search; lag <= search; lag += 1) {
    const start = at + lag;
    if (start < 0 || start + reference.length > signal.length) continue;
    const db = siSdr(reference, signal.subarray(start, start + reference.length));
    if (db > best.db) best = { db, lag };
  }
  return best;
}

async function renderMp4(project) {
  const started = await agent("render", { project, action: "start", quality: "draft", format: "mp4" });
  assert.equal(started.isError, undefined, started.text);
  const done = await agent("render", { project, action: "wait", job: started.data.job, timeout_s: 110 });
  assert.equal(done.data.status, "done", done.text);
  return done.data.files[0].path;
}

test("the voice example in the kino skill runs as written on a video", { skip: skipWithoutMediaTools }, async (t) => {
  const [examples] = jsonBlocks(skillSection("Sound: separating voice from background"));
  assert.equal(examples.length, 3);

  // An interview: a moving test picture with the mixture as its sound.
  const videoPath = path.join(folder, "interview.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=15:duration=3", "-i", mixtureWav,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", videoPath]);
  const video = await upload(server, videoPath, "interview.mp4", "video/mp4");
  const ops = JSON.parse(JSON.stringify(examples).replace("/api/media/<interview>.mp4", video.src));

  await agent("project", { action: "create", id: "interview", name: "Interview", width: 96, height: 64, duration: 3 });
  const client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  const reply = await client.call("edit", { project: "interview", ops });
  assert.equal(reply.isError, undefined, reply.text);
  // The cli lets go of the layers it made (crew locks), so the next agent can change them.
  await client.call("notes", { project: "interview", action: "release" });
  const { voice } = reply.data;
  assert.ok(["dpdfnet", "apple", "rnnoise"].includes(voice.engine), reply.text);
  assert.equal(voice.keep, "both");
  assert.equal(voice.cached, false);
  assert.ok(voice.seconds >= 0);
  assert.match(reply.text, /"voice":\{"engine":"\w+","seconds":[\d.]+,"cached":false,"keep":"both"/);
  t.diagnostic(`engine auto used ${voice.engine} in ${voice.seconds} s${voice.note ? ` (${voice.note})` : ""}`);

  const { layers: saved } = await layers("interview");
  const interview = saved.find((layer) => layer.name === "interview");
  const background = saved.find((layer) => layer.name === "interview-background");
  assert.equal(interview.type, "video");
  assert.equal(background.type, "audio");
  assert.equal(background.volume, 0.3, "the op after isolate_voice turned the background down by name");
  assert.equal(Math.abs(saved.indexOf(background) - saved.indexOf(interview)), 1, "the background sits right beside the video");
  for (const field of ["mediaStart", "mediaDuration", "mediaOffset"]) assert.equal(background[field], interview[field], field);
  assert.notEqual(interview.src, video.src);
  assert.match(interview.src, /\.mp4$/);
  assert.match(background.src, /\.m4a$/);
  assert.deepEqual([(await mediaRecord(interview.src)).name, (await mediaRecord(background.src)).name],
    ["interview (voice).mp4", "interview (background).m4a"]);

  // The picture is the same packets; the voice and the background add up to the original sound.
  assert.deepEqual(await videoPackets(mediaFile(interview.src)), await videoPackets(mediaFile(video.src)));
  const original = await decodeSamples(mediaFile(video.src));
  const voiceSound = await decodeSamples(mediaFile(interview.src));
  const backgroundSound = await decodeSamples(mediaFile(background.src));
  let largest = 0;
  for (let i = 0; i < original.length; i += 1) largest = Math.max(largest, Math.abs(voiceSound[i] + backgroundSound[i] - original[i]));
  assert.ok(largest < 1e-4, `voice + background = the original sound (largest difference ${largest})`);

  // The same file again, with a fade on it: a cache hit, the same library files, and the fade
  // is copied to the new background layer. Synced with a room recording first, both new files keep the link.
  const room = await upload(server, mixtureWav, "room.wav", "audio/wav");
  const again = await agent("edit", { project: "interview", ops: [
    { op: "add_layer", layerType: "video", name: "take two", properties: { src: video.src, mediaStart: 0.25 } },
    { op: "add_layer", layerType: "audio", name: "room", properties: { src: room.src, volume: 0 } },
    { op: "sync_clips", layer: "room", to: "take two", at: { layer: 0, to: 0 } },
    { op: "add_animation", layer: "take two", animation: { kind: "in", start: 0.25, duration: 0.5, from: { volume: 0 }, to: { volume: 1 } } },
    { op: "isolate_voice", layer: "take two", keep: "both" },
  ] });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(again.data.voice.cached, true);
  const { layers: later, clipLinks } = await layers("interview");
  assert.deepEqual(clipLinks.filter((link) => link.b === room.src).map((link) => link.a).sort(), [video.src, interview.src, background.src].sort());
  const take = later.find((layer) => layer.name === "take two");
  const takeBackground = later.find((layer) => layer.name === "take two-background");
  assert.deepEqual([take.src, takeBackground.src], [interview.src, background.src]);
  assert.equal(takeBackground.mediaStart, 0.25);
  assert.deepEqual(takeBackground.animations.map((animation) => [animation.kind, animation.start, animation.from.volume, animation.to.volume]), [["in", 0.25, 0, 1]]);
  assert.notEqual(takeBackground.animations[0].id, take.animations[0].id);
});

test("rnnoise on an audio layer: a cleaner voice in the export, undone through history, and cached", { skip: skipWithoutMediaTools }, async (t) => {
  const source = await upload(server, mixtureWav, "dialogue.wav", "audio/wav");
  await agent("project", { action: "create", id: "dialogue", name: "Dialogue", width: 64, height: 36, duration: 4 });
  const added = await agent("edit", { project: "dialogue", ops: [
    { op: "add_layer", layerType: "audio", name: "dialogue", properties: { src: source.src, mediaStart: 0.5, volume: 0.8 } },
  ] });
  assert.equal(added.isError, undefined, added.text);
  const [before] = (await layers("dialogue")).layers;
  // A note from you ends the agent's turn, so the isolation is a turn of its own.
  await agent("notes", { project: "dialogue", action: "add", text: "Clean up the dialogue", by: "you" });

  const isolated = await agent("edit", { project: "dialogue", ops: [{ op: "isolate_voice", layer: "dialogue", engine: "rnnoise" }] });
  assert.equal(isolated.isError, undefined, isolated.text);
  assert.equal(isolated.data.voice.engine, "rnnoise");
  assert.equal(isolated.data.voice.keep, "voice");
  assert.equal(isolated.data.voice.cached, false);
  const [layer] = (await layers("dialogue")).layers;
  assert.equal(layer.id, before.id);
  assert.deepEqual([layer.name, layer.mediaStart, layer.volume, layer.mediaOffset], ["dialogue", 0.5, 0.8, before.mediaOffset]);
  assert.match(layer.src, /\.m4a$/);
  assert.deepEqual(await mediaRecord(layer.src).then((record) => [record.name, record.mime]), ["dialogue (voice).m4a", "audio/mp4"]);

  // Closer to the clean speech than the mixture was.
  const voice = await decodeSamples(mediaFile(layer.src));
  assert.equal(voice.length, mixture.length);
  const gain = siSdr(speech, voice) - siSdr(speech, mixture);
  t.diagnostic(`rnnoise: SI-SDR ${siSdr(speech, mixture).toFixed(2)} → ${siSdr(speech, voice).toFixed(2)} dB (+${gain.toFixed(2)})`);
  assert.ok(gain > 2, `rnnoise raised SI-SDR by ${gain.toFixed(2)} dB`);

  // The mp4 export plays the voice stem from the Play start (0.5 s), not the mixture.
  const at = Math.round(0.5 * SAMPLE_RATE);
  const exported = await decodeSamples(await renderMp4("dialogue"));
  const asVoice = scoreAt(voice, exported, at);
  const asMixture = scoreAt(mixture, exported, at);
  t.diagnostic(`export vs voice stem ${asVoice.db.toFixed(2)} dB (shift ${asVoice.lag}), vs mixture ${asMixture.db.toFixed(2)} dB`);
  assert.ok(asVoice.db > 18, `the export's sound is the voice stem (${asVoice.db.toFixed(2)} dB)`);
  assert.ok(asVoice.db > asMixture.db + 6, "and clearly not the mixture");

  // history revert puts the original sound back, in the document and in the export.
  await agent("notes", { project: "dialogue", action: "add", text: "Put the original sound back", by: "you" });
  const reverted = await agent("history", { project: "dialogue", action: "revert", turn: isolated.data.turn });
  assert.equal(reverted.isError, undefined, reverted.text);
  const [restored] = (await layers("dialogue")).layers;
  assert.deepEqual([restored.id, restored.src, restored.mediaStart, restored.volume], [before.id, source.src, 0.5, 0.8]);
  const exportedAgain = await decodeSamples(await renderMp4("dialogue"));
  const undone = scoreAt(mixture, exportedAgain, at);
  t.diagnostic(`export after revert vs mixture ${undone.db.toFixed(2)} dB`);
  assert.ok(undone.db > 18 && undone.db > scoreAt(voice, exportedAgain, at).db + 6, "after revert the export plays the mixture again");

  // The same file again: the cache gives the same library file at once.
  const again = await agent("edit", { project: "dialogue", ops: [
    { op: "add_layer", layerType: "audio", name: "again", properties: { src: source.src } },
    { op: "isolate_voice", layer: "again", engine: "rnnoise" },
  ] });
  assert.equal(again.isError, undefined, again.text);
  assert.equal(again.data.voice.cached, true);
  assert.equal((await layers("dialogue")).layers.find((item) => item.name === "again").src, layer.src);
});

test("refusals say what to send instead, and auto works with the model download off", { skip: skipWithoutMediaTools }, async (t) => {
  // A server without the model and with downloads off.
  const offline = await startTestServer({ env: { KINO_VOICE_DOWNLOAD: "0", KINO_VOICE_MODEL: "" } });
  t.after(() => offline.stop());
  const call = (verb, body) => agentOn(offline, verb, body);
  const source = await upload(offline, mixtureWav, "dialogue.wav", "audio/wav");
  await call("project", { action: "create", id: "offline", name: "Offline", width: 64, height: 36, duration: 3 });
  const made = await call("edit", { project: "offline", ops: [
    { op: "add_layer", layerType: "audio", name: "dialogue", properties: { src: source.src } },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Hi" } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const revision = async () => (await (await offline.api("/api/projects/offline")).json()).revision;
  const saved = await revision();

  const noModel = await call("edit", { project: "offline", ops: [{ op: "isolate_voice", layer: "dialogue", engine: "dpdfnet" }] });
  assert.equal(noModel.isError, true);
  assert.equal(noModel.data.error, "op_failed");
  t.diagnostic(noModel.data.reason);
  if (noModel.data.voiceError === "VOICE_MODEL_UNAVAILABLE") {
    assert.match(noModel.data.reason, /downloads are turned off\. Send engine:"(apple|rnnoise)" \(engine:"auto" uses (apple|rnnoise) here until the model is on this computer\), or start kino without KINO_VOICE_DOWNLOAD=0/);
  } else {
    // A computer without the optional sherpa-onnx package.
    assert.equal(noModel.data.voiceError, "VOICE_ENGINE_UNAVAILABLE", noModel.text);
    assert.match(noModel.data.reason, /Send engine:"auto"/);
  }
  const text = await call("edit", { project: "offline", ops: [{ op: "isolate_voice", layer: "title" }] });
  assert.equal(text.isError, true);
  assert.match(text.data.reason, /isolate_voice splits the sound of an audio or video layer, and "title" is a text layer/);
  // A video without sound.
  const silentPath = path.join(folder, "silent.mp4");
  await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=15:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silentPath]);
  const silent = await upload(offline, silentPath, "silent.mp4", "video/mp4");
  const mute = await call("edit", { project: "offline", ops: [
    { op: "add_layer", layerType: "video", name: "b-roll", properties: { src: silent.src } },
    { op: "isolate_voice", layer: "b-roll", engine: "rnnoise" },
  ] });
  assert.equal(mute.isError, true);
  assert.equal(mute.data.voiceError, "VOICE_NO_SOUND");
  assert.match(mute.data.reason, /"b-roll" has no sound to split\. Pick an audio or video layer whose file has sound\./);
  const keep = await call("edit", { project: "offline", ops: [{ op: "isolate_voice", layer: "dialogue", keep: "vocals" }] });
  assert.equal(keep.isError, true);
  assert.match(keep.data.reason, /keep must be "voice", "background" or "both", not "vocals"/);
  assert.ok(keep.data.didYouMean.includes("voice"), keep.text);
  const amount = await call("edit", { project: "offline", ops: [{ op: "isolate_voice", layer: "dialogue", amount: 2 }] });
  assert.match(amount.data.reason, /amount must be a number from 0 to 1/);
  assert.equal(await revision(), saved, "nothing was saved");

  // auto skips DPDFNet (no model) and says so.
  const auto = await call("edit", { project: "offline", ops: [{ op: "isolate_voice", layer: "dialogue", keep: "background" }] });
  assert.equal(auto.isError, undefined, auto.text);
  assert.ok(["apple", "rnnoise"].includes(auto.data.voice.engine));
  assert.match(auto.data.voice.note, /Skipped dpdfnet/);
});

test("DPDFNet through the op cleans the voice by more than 8 dB", { skip: skipWithoutMediaTools || (!process.env.KINO_VOICE_MODEL && "set KINO_VOICE_MODEL to the DPDFNet model file to run it") }, async (t) => {
  const source = await upload(server, mixtureWav, "dialogue.wav", "audio/wav");
  await agent("project", { action: "create", id: "dpdfnet", name: "DPDFNet", width: 64, height: 36, duration: 3 });
  const reply = await agent("edit", { project: "dpdfnet", ops: [
    { op: "add_layer", layerType: "audio", name: "dialogue", properties: { src: source.src } },
    { op: "isolate_voice", layer: "dialogue", engine: "dpdfnet" },
  ] });
  assert.equal(reply.isError, undefined, reply.text);
  assert.equal(reply.data.voice.engine, "dpdfnet");
  const [layer] = (await layers("dpdfnet")).layers;
  const voice = await decodeSamples(mediaFile(layer.src));
  const gain = siSdr(speech, voice) - siSdr(speech, mixture);
  t.diagnostic(`DPDFNet: +${gain.toFixed(2)} dB SI-SDR`);
  assert.ok(gain > 8, `DPDFNet raised SI-SDR by ${gain.toFixed(2)} dB`);
});
