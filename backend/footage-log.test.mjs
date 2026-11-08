// Log footage on import: the probe finds Apple Log by its color tags, the media record keeps it,
// and the import answer's add_layer sets log. A clip tagged otherwise is left alone.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAgentClient, importedText } from "./agent/client.mjs";
import { footageLogOf, probeMedia } from "./media-probe.mjs";
import { sceneNeedsChromium } from "./raster-policy.mjs";
import { ffmpeg, run, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";

let server, client, folder;
before(async () => {
  if (skipWithoutMediaTools) return;
  server = await startTestServer();
  client = createAgentClient({ url: server.baseUrl, ownerToken: server.ownerToken }, { name: "footage-log-test" });
  folder = await mkdtemp(path.join(tmpdir(), "kino-footage-log-"));
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

// A 0.3 s 64x36 H.264 clip with the given color tags (setparams writes them into the file).
async function clip(name, tags) {
  const file = path.join(folder, name);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=10:duration=0.3",
    "-vf", `setparams=${tags}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
}

test("footageLogOf reads Apple Log from tags and leaves other footage alone", () => {
  const stream = (extra) => ({ codec_name: "prores", color_primaries: "bt2020", color_space: "bt2020nc", ...extra });
  assert.equal(footageLogOf(stream({ color_transfer: "unknown" }))?.profile, "apple-log");
  assert.equal(footageLogOf(stream({}))?.profile, "apple-log", "no transfer key at all");
  assert.equal(footageLogOf(stream({ color_transfer: "arib-std-b67" })), null, "HLG");
  assert.equal(footageLogOf(stream({ color_transfer: "smpte2084" })), null, "PQ");
  assert.equal(footageLogOf({ codec_name: "h264", color_primaries: "bt709", color_space: "bt709", color_transfer: "bt709" }), null);
  assert.equal(footageLogOf({ codec_name: "h264" }), null, "untagged");
  assert.equal(footageLogOf({ codec_name: "hevc", tags: { comment: "Apple Log" } })?.profile, "apple-log");
  assert.equal(footageLogOf({ codec_name: "hevc", tags: { comment: "Apple Log 2" } }), null, "a different gamut");
  const rec709 = { codec_name: "h264", color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709", tags: {} };
  assert.equal(footageLogOf(rec709, { comment: "Apple Log" }), null, "a stated Rec.709 curve wins");
  assert.equal(footageLogOf({ codec_name: "h264" }, { title: "Apple logo reveal" }), null);
  assert.equal(footageLogOf({ codec_name: "h264" }, { comment: "Shot for the Applelogistics ad" }), null);
  assert.equal(footageLogOf({ codec_name: "h264" }, { title: "Shooting Apple Log on iPhone" }), null, "a download's title");
  assert.equal(sceneNeedsChromium({ layers: [{ id: "v", type: "video", log: "apple-log", animations: [] }] }), true);
  assert.equal(sceneNeedsChromium({ layers: [{ id: "v", type: "video", animations: [] }] }), false);
});

test("an Apple Log clip imports with log set; a Rec.709 clip without", { skip: skipWithoutMediaTools }, async () => {
  const log = await clip("IMG_0001.mov", "color_primaries=bt2020:colorspace=bt2020nc:range=tv");
  const plain = await clip("plain.mp4", "color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv");
  assert.equal((await probeMedia(log)).log, "apple-log");
  assert.equal(Object.hasOwn(await probeMedia(plain), "log"), false);

  const media = await client.importFile(log);
  assert.equal(media.log, "apple-log", "kept through the .mov to .mp4 copy");
  const text = importedText(media);
  assert.match(text, /Log footage found \(h264 tagged BT\.2020 with no transfer curve, as Apple Log is\)/);
  assert.match(text, /properties:\{src:"[^"]+", x:0, y:0, width:64, height:36, mediaSourceDuration:[\d.]+, log:"apple-log"\}/);

  const other = await client.importFile(plain);
  assert.equal(Object.hasOwn(other, "log"), false);
  assert.doesNotMatch(importedText(other), /log/i);
});

test("the agent sets, clears and is refused log through edit ops", { skip: skipWithoutMediaTools }, async () => {
  const media = await client.importFile(await clip("edit.mov", "color_primaries=bt2020:colorspace=bt2020nc:range=tv"));
  const project = "footage-log";
  const call = (verb, input) => client.call(verb, { project, ...input });
  assert.equal((await client.call("project", { action: "create", id: project, name: "Log", width: 640, height: 360, duration: 2 })).isError, undefined);
  const added = await call("edit", { ops: [
    { op: "add_layer", layerType: "video", name: "clip", properties: { src: media.src, log: "apple-log" } },
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { width: 50, height: 50 } }] });
  assert.equal(added.isError, undefined, added.text);
  const clipLog = async () => (await call("inspect", { layer: "clip", fields: "log" })).text;
  assert.match(await clipLog(), /apple-log/);
  assert.equal((await call("edit", { ops: [{ op: "update_layer", layer: "clip", properties: { log: null } }] })).isError, undefined);
  assert.doesNotMatch(await clipLog(), /apple-log/);
  assert.equal((await call("edit", { ops: [{ op: "update_layers", layers: ["clip"], properties: { log: "apple-log" } }] })).isError, undefined);
  assert.match(await clipLog(), /apple-log/);
  const refused = await call("edit", { ops: [{ op: "update_layer", layer: "box", properties: { log: "apple-log" } }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /log/);
  const wrong = await call("edit", { ops: [{ op: "update_layer", layer: "clip", properties: { log: "slog3" } }] });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /apple-log/);
});
