// Syncing two clips through the agent service (POST /api/agent/<verb>) on a real server: the
// skill's example (references/media.md "Syncing two clips of the same moment") runs as written on
// two videos made here that recorded one "place" (short sounds at uneven moments): a 20 s screen
// recording and a quieter 12 s phone clip of its seconds 3 to 15. Also: a clip with no sound
// track, two clips of different places (both refused, nothing changed), and the at fallback.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAgentClient } from "./agent/client.mjs";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";
import { SAMPLE_RATE, writeWav } from "../tests/voice-mix.mjs";

const PHONE_FROM = 3; // the phone clip starts 3 s into the screen recording

// The same "random" numbers from the same seed, from 0 to 1.
function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// What a microphone records of a place from `from` for `seconds`: clicks and beeps at uneven
// moments (the same ones for the same seed), at its own loudness, with its own hiss.
function recording(seed, from, seconds, { gain = 0.6, hiss = 0.01, hissSeed = 1 } = {}) {
  const random = randomFrom(seed);
  const noise = randomFrom(hissSeed);
  const samples = Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, () => hiss * (noise() - 0.5));
  for (let at = 0.2; at < from + seconds; at += 0.15 + random() * 0.9) {
    const hz = 300 + random() * 3000;
    const length = Math.round((0.02 + random() * 0.15) * SAMPLE_RATE);
    const loud = gain * (0.3 + random() * 0.7);
    const start = Math.round((at - from) * SAMPLE_RATE);
    for (let i = 0; i < length; i += 1) {
      const index = start + i;
      if (index >= 0 && index < samples.length) samples[index] += loud * Math.exp(-i / (length / 4)) * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
    }
  }
  return samples;
}

let server;
let folder;
let client;
const files = {};
before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "kino-sync-agent-"));
  server = await startTestServer();
  client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "cli" });
  if (skipWithoutMediaTools) return;
  const video = async (name, seconds, size, sound) => {
    const file = path.join(folder, name);
    const picture = ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=10:duration=${seconds}`];
    if (!sound) await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...picture, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
    else {
      const wav = path.join(folder, `${name}.wav`);
      await writeWav(wav, sound);
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...picture, "-i", wav, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    }
    files[name] = file;
  };
  await video("screen.mp4", 20, "50x108", recording(5, 0, 20, { hissSeed: 2 }));
  await video("phone.mp4", 12, "54x96", recording(5, PHONE_FROM, 12, { gain: 0.05, hiss: 0.002, hissSeed: 3 }));
  await video("elsewhere.mp4", 12, "54x96", recording(9, 0, 12, { hissSeed: 4 }));
  await video("silent.mp4", 12, "54x96", null);
});
after(async () => {
  await server?.stop();
  await rm(folder, { recursive: true, force: true });
});

async function upload(name) {
  const response = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": name }, body: await readFile(files[name]) });
  assert.equal(response.status, 201, await response.clone().text());
  const media = await response.json();
  return (media.media ?? media).src;
}

async function layersOf(project) {
  const record = await (await server.api(`/api/projects/${project}`)).json();
  return Object.fromEntries(record.document.scenes[0].layers.map((layer) => [layer.name, layer]));
}

test("the sync example in the kino skill runs as written", { skip: skipWithoutMediaTools }, async (t) => {
  const calls = jsonBlocks(skillSection("Syncing two clips of the same moment")).flat();
  assert.deepEqual(calls.map((call) => call.tool), ["edit", "look"]);
  const sources = { "<screen>.mp4": await upload("screen.mp4"), "<phone>.mp4": await upload("phone.mp4") };
  const made = await client.call("project", { action: "create", id: "pair", name: "Pair", width: 1920, height: 1080, duration: 20 });
  assert.equal(made.isError, undefined, made.text);
  const replies = [];
  for (const { tool, ...call } of calls) {
    let text = JSON.stringify(call);
    for (const [placeholder, src] of Object.entries(sources)) text = text.replace(`/api/media/${placeholder}`, src);
    const started = performance.now();
    const reply = await client.call(tool, { project: "pair", ...JSON.parse(text) });
    assert.equal(reply.isError, undefined, `${tool}: ${reply.text}`);
    replies.push({ reply, ms: Math.round(performance.now() - started) });
  }
  const { sync } = replies[0].reply.data;
  t.diagnostic(`sync_clips (first, decoding both files) ${replies[0].ms} ms: ${JSON.stringify(sync)}`);
  assert.equal(sync.by, "sound");
  assert.ok(sync.confidence >= 0.5, `confidence ${sync.confidence}`);
  assert.ok(sync.overlap >= 11, `overlap ${sync.overlap}`);
  const layers = await layersOf("pair");
  // The phone's file starts 3 s into the screen recording's: it now starts at 3 s of the scene.
  assert.ok(Math.abs(layers.phone.mediaStart - PHONE_FROM) <= 0.02, `phone starts at ${layers.phone.mediaStart}`);
  assert.equal(layers.phone.mediaOffset, 0);
  assert.equal(layers.screen.mediaStart ?? 0, 0, "to stays where it is");
  assert.match(sync.inStep, /^3(\.0\d)?–15(\.0\d)? s of the scene$/);
  // The curves are kept beside each file, not as a .json record the library would list.
  const kept = await readdir(path.join(server.dataDirectory, "media"));
  assert.equal(kept.filter((name) => name.endsWith(".sync")).length, 2, kept.join(", "));

  // Synced again from the other side, with search: the screen recording moves instead.
  const back = await client.call("edit", { project: "pair", ops: [{ op: "update_layer", layer: "phone", properties: { mediaStart: 0 } }, { op: "sync_clips", layer: "screen", to: "phone", search: 5 }] });
  assert.equal(back.isError, undefined, back.text);
  const moved = await layersOf("pair");
  assert.ok(Math.abs(moved.screen.mediaOffset - PHONE_FROM) <= 0.02, `screen reads from ${moved.screen.mediaOffset} s`);
});

test("clips that cannot be matched by sound are refused, nothing changes, and at syncs them", { skip: skipWithoutMediaTools }, async () => {
  const sources = { screen: await upload("screen.mp4"), elsewhere: await upload("elsewhere.mp4"), silent: await upload("silent.mp4") };
  await client.call("project", { action: "create", id: "apart", name: "Apart", width: 640, height: 360, duration: 20 });
  const added = await client.call("edit", { project: "apart", ops: Object.entries(sources).map(([name, src]) => ({ op: "add_layer", layerType: "video", name, properties: { src, mediaSourceDuration: name === "screen" ? 20 : 12 } })) });
  assert.equal(added.isError, undefined, added.text);

  const other = await client.call("edit", { project: "apart", ops: [{ op: "sync_clips", layer: "elsewhere", to: "screen" }] });
  assert.equal(other.isError, true);
  assert.match(other.data.reason, /could not be matched by sound: confidence 0\.\d+, needs 0\.4/);
  assert.match(other.data.reason, /Nothing was changed\. Tell the person .*ask for a sync point/);
  assert.match(other.data.reason, /at: \{layer: <seconds into its file>, to: <seconds into to's file>\}/);

  const silent = await client.call("edit", { project: "apart", ops: [{ op: "sync_clips", layer: "silent", to: "screen" }] });
  assert.equal(silent.isError, true);
  assert.match(silent.data.reason, /"silent" has no sound track, so the clips cannot be matched by sound\. Nothing was changed/);
  const layers = await layersOf("apart");
  assert.equal(layers.elsewhere.mediaStart ?? 0, 0);
  assert.equal(layers.silent.mediaStart ?? 0, 0);

  // The moment the person names: 2 s into the silent clip is 9.5 s into the screen recording.
  const named = await client.call("edit", { project: "apart", ops: [{ op: "sync_clips", layer: "silent", to: "screen", at: { layer: 2, to: 9.5 } }] });
  assert.equal(named.isError, undefined, named.text);
  assert.equal(named.data.sync.by, "at");
  assert.equal(named.data.sync.same, '0 s of "silent" = 7.5 s of "screen"');
  const after = await layersOf("apart");
  assert.equal(after.silent.mediaStart, 7.5);
  assert.equal(after.silent.mediaOffset, 0);
  // The link is saved by file, and a check holds the screen's sound to the picture of its moment
  // (the phone clip filling the frame, read from 3 s later in its file).
  const saved = (await (await server.api("/api/projects/apart")).json()).document;
  assert.deepEqual(saved.clipLinks, [{ a: sources.screen, b: sources.silent, lag: -7.5 }]);
  const retimed = await client.call("edit", { project: "apart", ops: [{ op: "update_layer", layer: "silent", properties: { mediaOffset: 3, x: 0, y: 0, width: 640, height: 360 } }] });
  assert.equal(retimed.isError, undefined, retimed.text);
  const checked = await client.call("check", { project: "apart", rules: ["out_of_sync"], pixels: false });
  const late = checked.data.findings.filter((finding) => finding.rule === "out_of_sync");
  assert.equal(late.length, 1, JSON.stringify(checked.data.findings));
  assert.equal(late[0].severity, "error");
  assert.deepEqual(late[0].fix.properties, { mediaOffset: 0 });

  const unknown = await client.call("edit", { project: "apart", ops: [{ op: "sync_clips", layer: "silent", to: "screen", offset: 2 }] });
  assert.match(unknown.data.reason, /sync_clips has no offset; it takes layer, to, search and at/);
});
