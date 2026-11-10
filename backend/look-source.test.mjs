// look {mode:"source"} shows a video layer's whole source frame with a % grid, the scene's crop
// (dashed), the subject boxes and the result beside it; mark_subject writes the agent's boxes;
// look sheet gives each shot its tiles when the scene's footage cuts. Runs on a real server with a
// temporary data folder and the Sintel test clip (tests/fixtures/footage/SOURCES.md), whose cuts
// are at file 1.25 s and 3.333 s. The framing reference's example (skills/kino/references/
// framing.md) runs as written.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { estimateImageTokens, estimateTextTokens, pngSize } from "./meter.mjs";
import { ffmpeg, makeVideo, run, skipWithoutMediaTools, startTestServer, withoutNext } from "./media.test.support.mjs";
import { jsonBlocks, skillSection } from "./skill.test.support.mjs";
import { standInHelper } from "./cutout.test.support.mjs";

const CLIP = fileURLToPath(new URL("../tests/fixtures/footage/sintel-village-dragon.mp4", import.meta.url));
const VISION_SKIPPED = "vision: skipped (Subject cut-out uses Apple Vision, which is only on macOS.)";

let server;
let folder;
let clip;
before(async () => {
  if (skipWithoutMediaTools) return;
  server = await startTestServer();
  folder = await mkdtemp(path.join(tmpdir(), "kino-look-source-"));
  clip = await upload(server, CLIP);
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function upload(target, file, type = "video/mp4") {
  const response = await target.api("/api/media", { method: "POST", headers: { "content-type": type, "x-file-name": path.basename(file) }, body: await readFile(file) });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

function agentOn(target) {
  return async (verb, body = {}) => {
    const response = await target.api(`/api/agent/${verb}`, { method: "POST", body });
    assert.equal(response.status, 200, `${verb} answers 200`);
    return response.json();
  };
}
const agent = (verb, body) => agentOn(server)(verb, body);

// A clip made by FFmpeg from a lavfi source, in the test's temporary folder.
async function makeClip(name, source, seconds) {
  const file = path.join(folder, name);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `${source}:duration=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
  return file;
}

const before0 = (text) => text.split("\nimage ")[0];
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual}, expected ${expected} ± ${tolerance}`);

test("framing.md's crop to 9:16 runs as written: a layer and a crop per shot, the source view, marked subjects and a sheet by shot", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  await agent("project", { action: "create", id: "framing", name: "Framing", width: 1080, height: 1920, duration: 3.333 });
  const [block] = jsonBlocks(skillSection("Framing: crop footage to 9:16"));
  const calls = JSON.parse(JSON.stringify(block).replaceAll("/api/media/<clip>.mp4", clip.src));
  const replies = [];
  for (const [index, { tool, ...input }] of calls.entries()) {
    const reply = await agent(tool, { project: "framing", ...input });
    assert.equal(reply.isError, undefined, `call ${index} (${tool}): ${reply.text}`);
    replies.push(reply);
  }
  const [, first, marked, dragon, , sheet] = replies;
  const look = (layer, t) => agent("look", { project: "framing", mode: "source", layer, t });
  const second = await look("shot1", 0.6);
  assert.match(first.text, /^source shot1 @0\.6s: file 0\.6 s of sintel-village-dragon\.mp4 \(384×216\), shot 1 of 2 \(file 0–1\.25 s, scene 0–1\.25 s\)$/m);
  assert.match(first.text, /^crop: x 34–66%, y 0–100% of the source \(dashed\); the result is on the right$/m);
  assert.match(first.text, /^boxes: none marked yet · /m);
  assert.match(first.text, /^mark the subject: edit mark_subject \{layer:"shot1", t:0\.6, box:\[x, y, w, h\]\} \(% of the source; x, y top-left\)$/m);
  near(first.data.crop[0], 34.19, 1, "first crop x0");
  near(first.data.crop[2], 65.84, 1, "first crop x1");
  assert.deepEqual(first.data.shot, { n: 1, of: 2, file: [0, 1.25], scene: [0, 1.25] });
  assert.equal(first.data.covers, 1);
  assert.match(marked.text, /mark_subject shot1: agent box \[17, 25, 38, 63\] at file 0\.6 s · 1 box on this layer/);
  // Shot 2 is its own layer, cropped by its own subject (the red dragon, at x 40–57%, y 12–34% of
  // the frame kino draws for file 2.2 s: frame 52, from 2.167 s).
  assert.match(dragon.text, /^source shot2 @2\.2s: file 2\.2 s of sintel-village-dragon\.mp4 \(384×216\), shot 2 of 2 \(file 1\.25–3\.33 s, scene 1\.25–3\.33 s\)$/m);
  const third = await look("shot2", 2.2);
  assert.match(third.text, /^crop: x 33–64%, y 0–100% of the source \(dashed\); the result is on the right$/m);
  assert.match(third.text, /^boxes: agent \[40, 12, 17, 22\] 100% in the crop · /m);
  assert.equal((await look("shot1", 1.2)).data.crop.map(Math.round).join(), "20,0,52,100", "shot 1 keeps its own crop to its end");
  // A listed end is the next shot's first frame: file 1.25 s is shot 2, 1.2 s (end − 0.05 s) shot 1.
  assert.equal((await look("shot2", 1.25)).data.shot.n, 2);
  assert.equal((await look("shot1", 1.2)).data.shot.n, 1);
  const framing = await readFile(new URL("../skills/kino/references/framing.md", import.meta.url), "utf8");
  assert.ok(framing.includes("A listed end is the next shot's first frame") && framing.includes("(end − 0.05 s,"), "framing.md says where a shot ends");
  assert.match(second.text, /^crop: x 20–52%, y 0–100% of the source \(dashed\); the result is on the right$/m);
  assert.match(second.text, /^boxes: agent \[17, 25, 38, 63\] 83% in the crop · /m);
  assert.doesNotMatch(second.text, /mark the subject/);
  near(second.data.crop[0], 20.19, 1, "moved crop x0");
  near(second.data.crop[2], 51.83, 1, "moved crop x1");
  assert.deepEqual(second.data.boxes.filter((entry) => entry.by === "agent").map(({ at, box }) => ({ at, box })), [{ at: 0.6, box: [17, 25, 38, 63] }]);
  near(second.data.boxes[0].inside, 0.83, 0.01, "share of the box in the crop");
  assert.deepEqual(second.data.file, { src: clip.src, name: "sintel-village-dragon.mp4", width: 384, height: 216, time: 0.6 });
  if (process.platform !== "darwin") {
    assert.ok(first.text.includes(VISION_SKIPPED) && second.text.includes(VISION_SKIPPED), "off a Mac, Vision is skipped and said so");
    assert.deepEqual(second.data.vision, { skipped: "Subject cut-out uses Apple Vision, which is only on macOS." });
  }
  assert.match(sheet.text, /^sheet s1: 2 shots in 12 tiles labeled shot · time: 1 \(0–1\.25s\) at 0\.13 0\.38 0\.63 0\.88 1\.13s · 2 \(1\.25–3\.33s\) at 1\.4 1\.7 1\.99 2\.29 2\.59 2\.89 3\.18s$/m);

  // Small answers: the text before the image line and the image (at the default 640 px panel).
  // A Mac without the cut-out helper built explains how to build it; that setup line is not counted.
  const counted = (reply) => before0(reply.text).replace(/vision: skipped \(The kino-cutout helper is not built;[^)]*\)/, "vision: skipped");
  for (const reply of [first, second]) {
    assert.ok(estimateTextTokens(counted(reply)) <= 170, `source text is ${estimateTextTokens(counted(reply))} tokens`);
    const size = pngSize(Buffer.from(reply.images[0].data, "base64"));
    assert.ok(size.height < size.width, "the source panel and the result side by side");
    assert.ok(estimateImageTokens(size) <= 600, `source image is ${estimateImageTokens(size)} image tokens (${size.width}×${size.height})`);
    assert.match(reply.data.path, /source-[0-9a-f]{12}\.png$/);
  }

  // A source look is not a look at the scene's frames: changed still compares the sheet's tiles,
  // by their labels.
  const unchanged = await agent("look", { project: "framing", mode: "changed" });
  assert.match(withoutNext(unchanged.text), /^nothing visible changed in s1 since your last look \(12 frames compared\)$/);
  await agent("edit", { project: "framing", ops: [{ op: "update_layer", layer: "shot1", properties: { x: -2200 } }] });
  const changed = await agent("look", { project: "framing", mode: "changed" });
  assert.match(changed.text, /^changed since your last look at s1: 1 · 0\.13s, 1 · 0\.38s, 1 · 0\.63s, 1 · 0\.88s, 1 · 1\.13s$/m);

  // The library lists the clip's shots: all of them when one video matches.
  const library = await agent("library", { project: "framing", topic: "media", search: "sintel" });
  assert.match(library.text, /'sintel-village-dragon\.mp4' video\/mp4 384×216 4\.42s · 3 shots$/m);
  assert.match(library.text, /^shots: 3: 1\) 0–1\.25 s 2\) 1\.25–3\.33 s 3\) 3\.33–4\.42 s · crop with look \{mode:"source", layer\}$/m);
});

test("variants {vary:\"format\"} composes a 16:9 footage scene again in 9:16, cropped on its marked subject and checked clean; a hand-built scene is refused", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  // The clip at 1920x1080, so the 9:16 crop is not a soft upscale.
  const file = path.join(folder, "sintel-1080.mp4");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", CLIP, "-an", "-vf", "scale=1920:1080", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]);
  const big = await upload(server, file);
  await agent("project", { action: "create", id: "reformat", name: "Reformat" });
  const composed = await agent("edit", { project: "reformat", ops: [{ op: "compose", footage: [big.src], duration: 6, treatment: "story", seed: 2 }] });
  assert.equal(composed.isError, undefined, composed.text);
  const made = await agent("edit", { project: "reformat", ops: [{ op: "variants", vary: "format", formats: ["9:16"] }] });
  assert.equal(made.isError, undefined, made.text);
  const receipt = JSON.parse(made.text);
  assert.deepEqual(Object.keys(receipt.finished), ["scene-1-v2", "next"]);
  assert.equal(receipt.finished["scene-1-v2"].errors, 0, made.text);
  assert.ok(receipt.created["shot-1-v2"], "the new scene's names take its suffix");
  const status = await agent("status", { project: "reformat", scene: "scene-1-v2" });
  assert.match(status.text, /1080×1920/);

  // A narrow subject (20% of the width) marked on the first shot, and a layer of your own: the
  // next 9:16 crops shot 1 around the subject to fill the frame, and the layer comes along. (Its
  // title can still fail contrast over the brighter full-frame footage: a known gap, COMPATIBILITY.md.)
  const marked = await agent("edit", { project: "reformat", ops: [
    { op: "mark_subject", layer: "shot-1", t: 0.1, box: [40, 10, 20, 60] },
    { op: "add_layer", scene: "s1", layerType: "rectangle", name: "tag", properties: { x: 1600, y: 80, width: 200, height: 80, fill: "#FFFFFF" } },
  ] });
  assert.equal(marked.isError, undefined, marked.text);
  const cropped = await agent("edit", { project: "reformat", ops: [{ op: "variants", scene: "s1", vary: "format", formats: ["9:16"] }] });
  assert.equal(cropped.isError, undefined, cropped.text);
  assert.match(cropped.text, /your 1 own layer came along/);
  const scene = (await (await server.api("/api/projects/reformat")).json()).document.scenes.find((entry) => entry.id === "scene-1-v3");
  const ids = scene.layers.map((layer) => layer.id);
  const shot = scene.layers.find((layer) => layer.id === "shot-1-v3");
  assert.ok(shot.type === "video" && !ids.includes("shot-1-v3-blur") && !ids.includes("shot-1-v3-clip"), ids.join());
  assert.ok(shot.height >= 1920 && shot.subjectBoxes.boxes.length === 1, "a full-frame crop that keeps the mark");
  assert.ok(ids.includes("tag-v3"), "your own layer came along");
  const kept = await agent("check", { project: "reformat", scene: "scene-1-v3", rules: ["crop_no_subject"] });
  assert.equal(kept.isError, undefined, kept.text);
  assert.doesNotMatch(kept.text, /crop_no_subject shot-1/, kept.text);

  await agent("project", { action: "create", id: "by-hand", name: "By hand" });
  await agent("edit", { project: "by-hand", ops: [{ op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 100, y: 100, width: 200, height: 200 } }] });
  const refused = await agent("edit", { project: "by-hand", ops: [{ op: "variants", scene: "s1", vary: "format" }] });
  assert.match(refused.text, /reformats a scene made by compose; 'Scene 1' was built by hand\. Build it with compose/);
});

test("library media lists every shot of one video by its id when two uploads share a name", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  const again = await upload(server, CLIP);
  const byName = await agent("library", { project: "framing", topic: "media", search: "sintel-village" });
  assert.equal(byName.text.match(/'sintel-village-dragon\.mp4'/g).length, 2, byName.text);
  assert.doesNotMatch(byName.text, /^shots: /m);
  assert.match(byName.text, /^search a video's id \(after \/api\/media\/\) to list all its shots$/m);
  const byId = await agent("library", { project: "framing", topic: "media", search: again.id });
  assert.deepEqual(withoutNext(byId.text).split("\n"), [
    `${again.src} 'sintel-village-dragon.mp4' video/mp4 384×216 4.42s · 3 shots`,
    'shots: 3: 1) 0–1.25 s 2) 1.25–3.33 s 3) 3.33–4.42 s · crop with look {mode:"source", layer}',
  ]);
});

test("look source and mark_subject refuse what they cannot do, in words", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  await agent("project", { action: "create", id: "refusals", name: "Refusals", width: 1080, height: 1920, duration: 4.4 });
  const made = await agent("edit", { project: "refusals", ops: [
    { op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src, x: -1167, y: 0, width: 3413, height: 1920, mediaSourceDuration: 4.417 } },
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Sintel", x: 100, y: 100, width: 880, height: 160, fontSize: 96 } },
    { op: "add_layer", layerType: "video", name: "ghost", properties: { src: "/api/media/00000000-0000-4000-8000-000000000000.mp4", visible: false } },
  ] });
  assert.equal(made.isError, undefined, made.text);
  const look = (input) => agent("look", { project: "refusals", mode: "source", ...input });
  const refusal = (reply) => { assert.equal(reply.isError, true, reply.text); return reply.data; };
  // No layer: one sheet of every clip and picture the project uses.
  const overview = await look({});
  assert.equal(overview.isError, undefined, overview.text);
  assert.match(overview.text, /^source: \d+ files?\./m);
  // An imported clip's file name (no layer yet) shows the whole clip in one sheet, in file seconds.
  const whole = await look({ layer: "sintel-village-dragon.mp4" });
  assert.match(whole.text, /^source sintel-village-dragon\.mp4 \(\d+×\d+, 4\.4\d* s\): the whole clip in 12 frames, labeled with file seconds\.$/m);
  assert.equal(whole.data.times.length, 12);
  // It names the clip's events (impacts, light, motion at the frame, drawing rate): footage/events.mjs.
  assert.match(whole.text, /^events \(file s\)[^:]*: .+\.$/m, whole.text);
  assert.deepEqual(refusal(await look({ layer: "title" })), { error: "bad_input", reason: "source needs a video layer; title is a text layer (zoom shows any layer)." });
  assert.deepEqual(refusal(await look({ layer: "ghost" })), { error: "not_found", reason: "ghost's file is not in kino's media library; import it with project {action:\"import\", file}." });
  const unknownMode = refusal(await agent("look", { project: "refusals", mode: "sourc" }));
  assert.ok(unknownMode.didYouMean.includes("source"), JSON.stringify(unknownMode));

  const mark = async (op) => (await agent("edit", { project: "refusals", ops: [{ op: "mark_subject", ...op }] }));
  const refused = async (op, start) => {
    const reply = await mark(op);
    assert.equal(reply.isError, true, reply.text);
    assert.ok(reply.data.reason.startsWith(`Operation 0 (mark_subject) was refused: ${start}`), reply.data.reason);
    assert.deepEqual(reply.data.example, { op: "mark_subject", layer: "footage", t: 1, box: [30, 10, 40, 80] });
  };
  await refused({ layer: "title", t: 1, box: [1, 1, 5, 5] }, "mark_subject needs a video layer; title is a text layer.");
  await refused({ layer: "footage", t: 9, box: [1, 1, 5, 5] }, "t is scene seconds, from 0 to 4.4.");
  await refused({ layer: "footage", t: "1", box: [1, 1, 5, 5] }, "t is scene seconds, from 0 to 4.4.");
  const boxRule = 'box is [x, y, w, h] in % of the source frame (look {mode:"source"} draws the grid), such as [40, 10, 25, 80]: each from 0 to 100, w and h above 0, x + w and y + h at most 100.';
  for (const box of [[60, 0, 50, 10], [10, 10, 0, 10], [10, 10, 10], "center", undefined]) await refused({ layer: "footage", t: 1, box }, boxRule);
  // A box in 0–1 fractions, as many vision tools give, is refused, not kept as a speck in the corner.
  await refused({ layer: "footage", t: 1, box: [0.17, 0.25, 0.38, 0.63] }, "box is in % of the source frame (0–100), not 0–1: [17, 25, 38, 63], not [0.17, 0.25, 0.38, 0.63].");
  // Removing: only a box that is there.
  assert.equal((await mark({ layer: "footage", t: 0.2, box: [20, 20, 30, 60] })).isError, undefined);
  assert.equal((await mark({ layer: "footage", t: 1, box: [22, 20, 30, 60] })).isError, undefined);
  await refused({ layer: "footage", t: 0.6, box: null }, "There is no box at file 0.6 s to remove (boxes at 0.2, 1 s).");
  const removed = await mark({ layer: "footage", t: 0.21, box: null });
  assert.match(removed.text, /mark_subject footage: removed the box at file 0\.21 s · 1 box on this layer/);
  // Marking the same moment again replaces its box.
  const again = await mark({ layer: "footage", t: 1.01, box: [24, 20, 30, 60] });
  assert.match(again.text, /agent box \[24, 20, 30, 60\] at file 1\.01 s · 1 box on this layer/);

  // A sheet with a file kino cannot find shots in says so; its Play range still cuts.
  const sheet = await agent("look", { project: "refusals", mode: "sheet" });
  assert.match(sheet.text, /^sheet s1: 3 shots in 1\d tiles labeled shot · time: /m);
  assert.doesNotMatch(sheet.text, /ghost|00000000/, "a hidden layer is not on the sheet");
  await agent("edit", { project: "refusals", ops: [{ op: "update_layer", layer: "ghost", properties: { visible: true } }] });
  assert.match((await agent("look", { project: "refusals", mode: "sheet" })).text, /^shots in 00000000-0000-4000-8000-000000000000\.mp4 unknown: /m);

  // A clip smaller than the frame, or hidden, is said so.
  await agent("edit", { project: "refusals", ops: [{ op: "update_layer", layer: "footage", properties: { x: 0, y: 656, width: 1080, height: 607.5 } }] });
  const small = await look({ layer: "footage", t: 1 });
  assert.match(small.text, /^crop: x 0–100%, y 0–100% of the source \(dashed; the clip covers 32% of the frame\); the result is on the right$/m);
  await agent("edit", { project: "refusals", ops: [{ op: "update_layer", layer: "footage", properties: { visible: false } }] });
  assert.match((await look({ layer: "footage", t: 1 })).text, /^source footage @1s \(not on screen at 1 s\): file 1 s of /m);
});

test("subject boxes stop at 600 a layer; the receipt and inspect stay small", { skip: skipWithoutMediaTools, timeout: 180_000 }, async () => {
  const long = await upload(server, await makeClip("long.mp4", "testsrc2=size=64x36:rate=10", 16));
  await agent("project", { action: "create", id: "many", name: "Many", width: 1920, height: 1080, duration: 16 });
  await agent("edit", { project: "many", ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: long.src, width: 1920, height: 1080 } }] });
  // 600 boxes, 0.025 s of the file apart (0 to 14.975 s), in four edits.
  for (let part = 0; part < 4; part += 1) {
    const ops = Array.from({ length: 150 }, (_, index) => ({ op: "mark_subject", layer: "footage", t: Number(((part * 150 + index) * 0.025).toFixed(3)), box: [10, 10, 20, 20] }));
    const reply = await agent("edit", { project: "many", ops });
    assert.equal(reply.isError, undefined, reply.text.slice(0, 400));
    // One line for the 150 marks, not one each (200 lines went over the 8k answer limit).
    const from = part * 3.75;
    assert.equal(reply.text.match(/mark_subject footage/g).length, 1, reply.text.slice(0, 400));
    assert.match(reply.text, new RegExp(`mark_subject footage: 150 agent boxes marked at file ${from}–${Number((from + 3.725).toFixed(2))} s · ${(part + 1) * 150} boxes on this layer`));
    assert.ok(estimateTextTokens(reply.text) < 600, `receipt is ${estimateTextTokens(reply.text)} tokens`);
  }
  // inspect sums the boxes up instead of printing all 600 (about 13k tokens).
  for (const fields of [undefined, ["subjectBoxes"]]) {
    const inspected = await agent("inspect", { project: "many", targets: ["footage"], ...(fields ? { fields } : {}) });
    assert.match(inspected.text, /subjectBoxes: 600 agent boxes at file 0–14\.97 s \(look \{mode:"source"\} draws them\)/);
    assert.ok(estimateTextTokens(inspected.text) < 300, `inspect is ${estimateTextTokens(inspected.text)} tokens`);
  }
  const full = await agent("edit", { project: "many", ops: [{ op: "mark_subject", layer: "footage", t: 15.5, box: [10, 10, 20, 20] }] });
  assert.equal(full.isError, true);
  assert.match(full.data.reason, /refused: footage has 600 subject boxes, the most kept; remove some with box:null\.$/);
  const replaced = await agent("edit", { project: "many", ops: [{ op: "mark_subject", layer: "footage", t: 0.025, box: [12, 10, 20, 20] }] });
  assert.match(replaced.text, /600 boxes on this layer/, "a box at a marked moment replaces it, even when full");
});

test("history revert takes a mark away; after replace_media the boxes belong to the old file", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  await agent("project", { action: "create", id: "undo", name: "Undo", width: 1080, height: 1920, duration: 4.4 });
  await agent("edit", { project: "undo", ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src, x: -1167, y: 0, width: 3413, height: 1920 } }] });
  // A note from you ends the agent's turn, so the mark is a turn of its own.
  await agent("notes", { project: "undo", action: "add", text: "Frame Sintel", by: "you" });
  const marked = await agent("edit", { project: "undo", ops: [{ op: "mark_subject", layer: "footage", t: 0.6, box: [17, 25, 38, 63] }] });
  assert.match((await agent("look", { project: "undo", mode: "source", layer: "footage", t: 0.6 })).text, /^boxes: agent \[17, 25, 38, 63\] 55% in the crop/m);
  await agent("notes", { project: "undo", action: "add", text: "Undo that", by: "you" });
  const reverted = await agent("history", { project: "undo", action: "revert", turn: marked.data.turn });
  assert.equal(reverted.isError, undefined, reverted.text);
  assert.match((await agent("look", { project: "undo", mode: "source", layer: "footage", t: 0.6 })).text, /^boxes: none marked yet · /m);

  await agent("edit", { project: "undo", ops: [{ op: "mark_subject", layer: "footage", t: 0.6, box: [17, 25, 38, 63] }] });
  const other = await upload(server, await makeClip("bars.mp4", "smptebars=size=384x216:rate=24", 4.4));
  const swapped = await agent("edit", { project: "undo", ops: [{ op: "replace_media", layer: "footage", mediaId: other.id }] });
  assert.equal(swapped.isError, undefined, swapped.text);
  const look = await agent("look", { project: "undo", mode: "source", layer: "footage", t: 0.6 });
  assert.match(look.text, /^boxes: 1 marked on another file \(before replace_media\): mark again · /m);
  assert.match(look.text, /^mark the subject: edit mark_subject/m);
  const fresh = await agent("edit", { project: "undo", ops: [{ op: "mark_subject", layer: "footage", t: 2, box: [40, 10, 20, 80] }] });
  assert.match(fresh.text, /at file 2 s · 1 box on this layer/, "the new file starts a new set");

  // A still in place of the marked clip: the boxes go with the video.
  const still = path.join(folder, "still.png");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "smptebars=size=64x36", "-frames:v", "1", still]);
  const image = await upload(server, still, "image/png");
  const toStill = await agent("edit", { project: "undo", ops: [{ op: "replace_media", layer: "footage", mediaId: image.id }] });
  assert.equal(toStill.isError, undefined, toStill.text);
  const inspected = await agent("inspect", { project: "undo", targets: ["footage"] });
  assert.match(inspected.text, /^L\d+ footage image in /m);
  assert.equal(inspected.text.includes("subjectBoxes"), false, inspected.text);
});

test("on a computer with a cut-out helper, look source adds its subject box (the stand-in keys red)", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  const vision = await startTestServer({ env: { KINO_CUTOUT_HELPER: await standInHelper() } });
  try {
    const call = agentOn(vision);
    // A red square at x 40–60%, y 30–70% of a 320 × 180 frame.
    const file = await makeClip("red-square.mp4", "color=c=black:size=320x180:rate=24", 1).then(async (plain) => {
      const boxed = path.join(folder, "red-square-boxed.mp4");
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", plain, "-vf", "drawbox=x=128:y=54:w=64:h=72:color=red:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", boxed]);
      return boxed;
    });
    const media = await upload(vision, file);
    await call("project", { action: "create", id: "vision", name: "Vision", width: 1920, height: 1080, duration: 1 });
    await call("edit", { project: "vision", ops: [{ op: "add_layer", layerType: "video", name: "square", properties: { src: media.src, width: 1920, height: 1080 } }] });
    const reply = await call("look", { project: "vision", mode: "source", layer: "square", t: 0.5 });
    assert.equal(reply.isError, undefined, reply.text);
    const [found] = reply.data.vision.boxes;
    assert.ok(found, reply.text);
    [40, 30, 20, 40].forEach((expected, index) => near(found.box[index], expected, 2, `vision box [${index}]`));
    assert.match(reply.text, /· vision \[[\d., ]+\] 100% in the crop$/m);
    assert.deepEqual(reply.data.boxes.map((entry) => entry.by), ["vision"]);
  } finally { await vision.stop(); }
});

test("a sheet shares its tiles among the shots at clip boundaries; a scene with no footage keeps 12 frames; shots lost from a record are found again", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  const first = await upload(server, await makeClip("moving.mp4", "testsrc2=size=160x90:rate=24", 2));
  const second = await upload(server, await makeClip("bars-short.mp4", "smptebars=size=160x90:rate=24", 2));
  await agent("project", { action: "create", id: "joined", name: "Joined", width: 1920, height: 1080, duration: 4 });
  await agent("edit", { project: "joined", ops: [
    { op: "add_layer", layerType: "video", name: "one", properties: { src: first.src, width: 1920, height: 1080, mediaSourceDuration: 2, mediaFreeze: "none" } },
    { op: "add_layer", layerType: "video", name: "two", properties: { src: second.src, width: 1920, height: 1080, mediaStart: 2, mediaSourceDuration: 2, mediaFreeze: "none" } },
  ] });
  const joined = await agent("look", { project: "joined", mode: "sheet" });
  assert.match(joined.text, /^sheet s1: 2 shots in 12 tiles labeled shot · time: 1 \(0–2s\) at 0\.17 0\.5 0\.83 1\.17 1\.5 1\.83s · 2 \(2–4s\) at 2\.17 2\.5 2\.83 3\.17 3\.5 3\.83s$/m);
  assert.deepEqual(joined.data.path ? joined.images.length : 0, 1);
  // A title that fades in at 3.5 s, inside the second shot: on the sheet, so changed sees it change.
  await agent("edit", { project: "joined", ops: [
    { op: "add_layer", layerType: "text", name: "cta", properties: { text: "Buy now", x: 200, y: 400, width: 1520, height: 200, fontSize: 120, fill: "#ffffff" } },
    { op: "add_animation", layer: "cta", preset: "preset-fade", start: 3.5, duration: 0.2 },
  ] });
  await agent("look", { project: "joined", mode: "sheet" });
  await agent("edit", { project: "joined", ops: [{ op: "update_layer", layer: "cta", properties: { fill: "#ff0000" } }] });
  assert.match((await agent("look", { project: "joined", mode: "changed" })).text, /^changed since your last look at s1: 2 · 3\.83s$/m);
  await agent("edit", { project: "joined", ops: [{ op: "remove_layer", layer: "cta" }] });
  // A stretch: only the shots in it, clipped; one shot alone is 12 frames as before.
  assert.match((await agent("look", { project: "joined", mode: "sheet", from: 1, to: 3 })).text, /^sheet s1: 2 shots in 12 tiles labeled shot · time: 1 \(1–2s\) at [\d. ]+s · 2 \(2–3s\) at [\d. ]+s$/m);
  assert.match((await agent("look", { project: "joined", mode: "sheet", from: 2.5, to: 3.5 })).text, /^sheet s1: 1=2\.5s 2=/m);

  await agent("project", { action: "create", id: "words", name: "Words", width: 1920, height: 1080, duration: 4 });
  await agent("edit", { project: "words", ops: [{ op: "add_layer", layerType: "text", name: "title", properties: { text: "Only words", x: 200, y: 400, width: 1520, height: 200, fontSize: 120 } }] });
  const words = await agent("look", { project: "words", mode: "sheet" });
  assert.match(words.text, /^sheet s1: 1=0s 2=0\.36s 3=0\.72s .* 12=3\.96s$/m);

  // An uncut 2 s clip from 1 s under a title: 3 shots (before, during and after it), 12 tiles.
  await agent("edit", { project: "words", ops: [{ op: "add_layer", layerType: "video", name: "late", properties: { src: first.src, width: 1920, height: 1080, mediaStart: 1, mediaSourceDuration: 2, mediaFreeze: "none" } }] });
  assert.match((await agent("look", { project: "words", mode: "sheet" })).text, /^sheet s1: 3 shots in 12 tiles labeled shot · time: 1 \(0–1s\) at 0\.17 0\.5 0\.83s · 2 \(1–3s\) at 1\.17 1\.5 1\.83 2\.17 2\.5 2\.83s · 3 \(3–4s\) at 3\.17 3\.5 3\.83s$/m);

  // A clip imported before kino found shots (its record has none): the sheet finds them and the
  // record keeps them.
  const record = path.join(server.dataDirectory, "media", `${clip.id}.json`);
  const saved = JSON.parse(await readFile(record, "utf8"));
  assert.equal(saved.shots.length, 3);
  delete saved.shots;
  delete saved.shotsFound;
  await writeFile(record, JSON.stringify(saved));
  await agent("project", { action: "create", id: "older", name: "Older", width: 1080, height: 1920, duration: 4.4 });
  await agent("edit", { project: "older", ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src, x: -1167, y: 0, width: 3413, height: 1920 } }] });
  assert.match((await agent("look", { project: "older", mode: "sheet" })).text, /^sheet s1: 3 shots in 12 tiles/m);
  const started = performance.now();
  let again = null;
  while (performance.now() - started < 10_000) {
    again = JSON.parse(await readFile(record, "utf8"));
    if (again.shots) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(again.shots, [{ start: 0, end: 1.25 }, { start: 1.25, end: 3.333 }, { start: 3.333, end: 4.417 }]);
  assert.ok(existsSync(path.join(server.dataDirectory, "media", clip.id)));
});

test("look source numbers a trimmed clip's shots as look sheet does, and names the file's own shot", { skip: skipWithoutMediaTools, timeout: 120_000 }, async () => {
  // From file 1.5 s in a 3 s scene: the scene shows file shot 2 (to 1.83 s) and shot 3, which ends
  // 0.08 s before the scene does (not a shot of its own).
  await agent("project", { action: "create", id: "trimmed", name: "Trimmed", width: 1080, height: 1920, duration: 3 });
  await agent("edit", { project: "trimmed", ops: [{ op: "add_layer", layerType: "video", name: "footage", properties: { src: clip.src, x: -1167, y: 0, width: 3413, height: 1920, mediaOffset: 1.5, mediaSourceDuration: 4.417 } }] });
  const early = await agent("look", { project: "trimmed", mode: "source", layer: "footage", t: 0.5 });
  assert.match(early.text, /, shot 1 of 2 \(file 1\.25–3\.33 s, scene 0–1\.83 s; the file's shot 2 of 3\)$/m);
  assert.deepEqual(early.data.shot, { n: 1, of: 2, file: [1.25, 3.333], scene: [0, 1.833], fileShot: { n: 2, of: 3 } });
  const late = await agent("look", { project: "trimmed", mode: "source", layer: "footage", t: 2.2 });
  assert.match(late.text, /, shot 2 of 2 \(file 3\.33–4\.42 s, scene 1\.83–3 s; the file's shot 3 of 3\)$/m);
  const sheet = await agent("look", { project: "trimmed", mode: "sheet" });
  assert.match(sheet.text, /^sheet s1: 2 shots in 12 tiles labeled shot · time: 1 \(0–1\.83s\) at [\d. ]+s · 2 \(1\.83–3s\) at [\d. ]+s$/m);
});

test("a sheet shows the first 24 shots and says how to see the rest", { skip: skipWithoutMediaTools, timeout: 180_000 }, async () => {
  // 26 shots of 0.75 s (18 frames, longer than a flash): red and blue in turn.
  const file = await makeVideo(path.join(folder, "turns.mp4"), { width: 160, height: 90, fps: 24, frames: 26 * 18, frameColor: (frame) => (Math.floor(frame / 18) % 2 ? [20, 40, 230] : [230, 30, 20]) });
  const turns = await upload(server, file);
  assert.equal(turns.shots?.length, 26, JSON.stringify(turns.shots));
  await agent("project", { action: "create", id: "turns", name: "Turns", width: 1920, height: 1080, duration: 19.5 });
  await agent("edit", { project: "turns", ops: [{ op: "add_layer", layerType: "video", name: "turns", properties: { src: turns.src, width: 1920, height: 1080, mediaSourceDuration: 19.5 } }] });
  const first = await agent("look", { project: "turns", mode: "sheet" });
  assert.match(first.text, /^sheet s1: 26 shots \(the first 24 here\) in 24 tiles labeled shot · time: 1 \(0–0\.75s\) at 0\.38s · 2 \(0\.75–1\.5s\) at 1\.13s .* 24 \(17\.25–18s\) at 17\.63s; look \{mode:"sheet", from:18\} for the rest$/m);
  const rest = await agent("look", { project: "turns", mode: "sheet", from: 18 });
  assert.match(rest.text, /^sheet s1: 2 shots in 12 tiles labeled shot · time: 25 \(18–18\.75s\) at [\d. ]+s · 26 \(18\.75–19\.5s\) at [\d. ]+s$/m);
});
