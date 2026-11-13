// look {mode:"review"} and the review gate (backend/agent/review.mjs): the review picks the
// moments that matter and shows them as full-size 2×2 pages with the check findings at those
// times; a second review shows only what an edit changed; a final render of the whole video is
// refused until every moment was reviewed as it is now, and is allowed after, with a waiver, or
// from the kino app. Edit receipts name the findings an edit brought into the stretch it changed.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { makeVideo, nextCallOf, skipWithoutMediaTools, startTestServer } from "./media.test.support.mjs";
import { frameSignature, nearDuplicate, newFindingsLine, reviewEvents, reviewSizes } from "./agent/review.mjs";
import { captionSpoilers, captionWindows, directionMiss, heardLines, heardText, musicSections, openStoryBugs, packetKind, parseViewer, viewerGap, viewerTimes, writePacket } from "./agent/viewer.mjs";
import { addNeeds, answerNeed, emptyNeeds, finishNeed, needsCall, needsLine, openNeeds, parseNeedItems, splitImported } from "./agent/needs.mjs";
import { unfilledSlot } from "./agent/next-call.mjs";
import { addVerdict, anchorLines, barOf, barPairs, barTimeAt, parseVerdict } from "./agent/bar.mjs";
import { CRITIQUE_PROTOCOL, critiqueProtocol, barGap, blocksRender, critiqueDirectionKey, critiqueOf, critiqueQuestions, critiqueSpine, critiqueTimes, lineText, openCritique, parseCritique, staleCritique, upLines } from "./agent/critique.mjs";
import { VIEWER_WAIVERS } from "./agent/translate.mjs";
import { serviceFor } from "./agent-ask.test.support.mjs";
import { skipBoardOn } from "./stops.test.support.mjs";
import { createDocument, createLayer, createScene } from "../engine/model.js";

// A viewer-facing finding is kept only on the person's words, on named layers: not "*", not a scene,
// not a glob that reaches every layer. The test cards here are the layers named dot*.
const viewerWaiver = (code) => (VIEWER_WAIVERS.has(code) ? { target: ["ending_seen", "text_slides"].includes(code) ? "s1" : "dot*", quote: "keep the still test card as it is" } : { target: code === "soft_upscale" ? "street" : "*" });

// A 1280×720 scene: a title fades in at 0.2–0.6 s, a box flies across at 1–2 s, a caption comes
// in at 4 s, and nothing happens after 4.4 s (a quiet stretch to 8 s).
const SCENE = {
  id: "s", width: 1280, height: 720, duration: 8, background: "#101418",
  layers: [
    { id: "title", type: "text", text: "Ship faster", x: 100, y: 80, width: 600, height: 90, animations: [{ id: "a1", kind: "in", start: 0.2, duration: 0.4, from: { opacity: 0 }, to: { opacity: 1 } }] },
    { id: "box", type: "rectangle", x: 0, y: 400, width: 120, height: 120, fill: "#ffcc00", animations: [{ id: "a2", kind: "custom", start: 1, duration: 1, from: { x: 0 }, to: { x: 900 } }] },
    { id: "drift", type: "rectangle", x: 600, y: 600, width: 40, height: 40, fill: "#ffffff", animations: [{ id: "a3", kind: "custom", start: 1, duration: 2, from: { x: 600 }, to: { x: 610 } }] },
    { id: "caption", type: "text", text: "Plans in one view", x: 100, y: 560, width: 800, height: 60, animations: [{ id: "a4", kind: "in", start: 4, duration: 0.4, from: { opacity: 0 }, to: { opacity: 1 } }] },
  ],
};

test("review events: first and last frame, landed text, the start, middle and end of a big move, quiet stretches; a small drift is no event", () => {
  const events = reviewEvents(SCENE);
  const at = (pattern) => events.filter((event) => event.names.some((name) => pattern.test(name))).map((event) => event.time);
  assert.deepEqual(at(/first frame/), [0]);
  assert.deepEqual(at(/last frame/), [7.97]);
  assert.deepEqual(at(/text in "Ship faster"/), [0.64]);
  assert.deepEqual(at(/box move starts/), [1.1]);
  assert.deepEqual(at(/box move middle/), [1.5]);
  assert.deepEqual(at(/box move ends/), [2.02]);
  assert.deepEqual(at(/drift/), [], "a 10 px drift is not a big move");
  assert.deepEqual(at(/text in "Plans in one view"/), [4.44]);
  assert.ok(at(/quiet stretch/).length >= 1, "the 3.5 s after the caption with nothing in it get a frame");
  const cut = reviewEvents(SCENE, { shots: [{ start: 0, end: 6 }, { start: 6, end: 8 }] });
  assert.ok(cut.some((event) => event.time === 6.03 && event.names.includes("cut to shot 2")), "the first frame after a cut");
  assert.deepEqual(events.map((event) => event.time), [...events.map((event) => event.time)].sort((a, b) => a - b));
  const stretch = reviewEvents(SCENE, { from: 1, to: 3 });
  assert.ok(stretch.every((event) => event.time >= 1 && event.time <= 3) && stretch.length === 3);
});

test("review sizes: risky moments full size, a finding once at its first moment, montage cuts compact; near-duplicate thumbnails", () => {
  const events = [["a", "first"], ["b", "quiet"], ["c", "quick cut"], ["d", "text"], ["e", "quick cut"]].map(([key, kind], time) => ({ key, time, kinds: [kind] }));
  const sizes = reviewSizes(events, [{ rule: "text_wrap", ref: "cap", severity: "warn", at: 1.9, until: 4.2 }]);
  assert.deepEqual([...sizes.values()], ["full", "compact", "full", "full", "compact"]);
  const many = reviewSizes(Array.from({ length: 400 }, (_, time) => ({ key: time, time, kinds: ["cut"] })));
  assert.ok([...many.values()].filter((size) => size === "full").length < 40, "a long montage keeps full size for a few");
  const grey = new Uint8Array(48 * 27).fill(100);
  assert.equal(nearDuplicate(grey, grey.map((value, index) => (index % 7 ? value : value + 2)), { strict: true }), true);
  assert.equal(nearDuplicate(grey, grey.map((value, index) => (index < 100 ? 200 : value))), false);
});

test("a frame signature changes only when what is on screen then changes", () => {
  const moved = structuredClone(SCENE);
  moved.layers[3].animations[0].start = 4.5;
  assert.equal(frameSignature(SCENE, 1.5), frameSignature(moved, 1.5), "the caption is not on screen at 1.5 s");
  assert.notEqual(frameSignature(SCENE, 4.44), frameSignature(moved, 4.44), "it is at 4.44 s");
  const recolored = structuredClone(SCENE);
  recolored.layers[1].fill = "#ff0000";
  assert.notEqual(frameSignature(SCENE, 1.5), frameSignature(recolored, 1.5));
  const caption = structuredClone(SCENE);
  caption.layers[3].fill = "#ff0000";
  assert.equal(frameSignature(SCENE, 1.5), frameSignature(caption, 1.5), "the caption is still at opacity 0 then");
  assert.notEqual(frameSignature(SCENE, 4.44), frameSignature(caption, 4.44));
});

test("newFindingsLine names only findings that are new and inside the changed stretch, at most 5", () => {
  const before = [{ severity: "warn", rule: "overlap", ref: "a", at: 1 }];
  const after = [
    { severity: "warn", rule: "overlap", ref: "a", at: 1 },
    { severity: "error", rule: "contrast", ref: "b", at: 4.2, until: 5 },
    { severity: "warn", rule: "overlap", ref: "c", at: 9 },
    { severity: "info", rule: "blip", ref: "d", at: 4 },
    { severity: "warn", rule: "safe_zone", ref: "e", at: 4.5, waived: "on purpose" },
  ];
  assert.equal(newFindingsLine(before, after, new Map([["s", [4, 6]]])), "E contrast b @4.2s");
  assert.equal(newFindingsLine(before, after, new Map()), null);
  const many = Array.from({ length: 7 }, (_, index) => ({ severity: "warn", rule: "overlap", ref: `l${index}`, at: 4 }));
  assert.match(newFindingsLine([], many, new Map([["s", [0, 8]]])), /^overlap l0 @4s, .*overlap l4 @4s \(\+2 more\)$/);
});

let server;
let key;
before(async () => {
  server = await startTestServer();
  key = (await (await server.api("/api/dashboard/review-key", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: server.baseUrl } })).json()).key;
});
after(() => server?.stop());

async function agent(verb, body = {}) {
  const response = await server.api(`/api/agent/${verb}`, { method: "POST", body: { client: "test-agent", ...body } });
  assert.equal(response.status, 200, `${verb} answers 200`);
  return response.json();
}

// The reference gate is waived unless a test asks for it (references: true).
async function project(id, duration = 6, { references = false } = {}) {
  await agent("project", { action: "create", id, width: 640, height: 360, duration, background: "#15191e" });
  const built = await agent("edit", { project: id, ops: [
    ...(references ? [] : ["reference", "treatments"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a review test" }))),
    { op: "add_layer", layerType: "text", name: "title", properties: { text: "Ship faster", x: 60, y: 40, width: 420, height: 60, fontSize: 40, fill: "#ffffff" }, animations: [{ preset: "preset-fade", start: 0.2, duration: 0.5 }] },
    { op: "add_layer", layerType: "rectangle", name: "box", properties: { x: 0, y: 200, width: 80, height: 80, fill: "#ffcc00" } },
    { op: "add_animation", layer: "box", preset: "move", start: 1, duration: 1, easing: "smooth", from: { x: 0 }, to: { x: 480 } },
  ] });
  assert.equal(built.isError, undefined, built.text);
  await agent("check", { project: id, fix: "auto" });
  return id;
}

async function reviewAll(id, input = {}) {
  const answers = [];
  for (let round = 0; round < 20; round += 1) {
    const answer = await agent("look", { project: id, mode: "review", ...input });
    assert.equal(answer.isError, undefined, answer.text);
    answers.push(answer);
    if (!answer.data.left) break;
  }
  return answers;
}

test("look review: risky moments on a full-size page (at most 2×2 at 1280 px), the rest compact, time and event under each; a second review shows only what an edit changed", async () => {
  const id = await project("review-pages");
  await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "text", name: "late", properties: { text: "Later", x: 60, y: 280, width: 300, height: 50, fontSize: 36, fill: "#ffffff" }, animations: [{ preset: "preset-fade", start: 4.5, duration: 0.4 }] }] });
  const [first, ...rest] = await reviewAll(id);
  assert.equal(first.data.mode, "review");
  assert.ok(first.data.events >= 5, first.text);
  assert.ok(first.data.full >= 1 && first.data.full <= 4, "at most 4 full-size frames a call");
  assert.ok(first.images.length <= 2, "a full-size page and a compact page at most");
  const page = await loadImage(Buffer.from(first.images[0].data, "base64"));
  // 640×360 scenes are drawn at their own size; a 1280-wide frame is the most.
  assert.ok(page.width >= 640 * 2 && page.height >= 360, `${page.width}×${page.height}`);
  // Each tile is the whole frame, outlined in gray just outside it, so a dark frame's edges show.
  const pixels = createCanvas(page.width, page.height).getContext("2d");
  pixels.drawImage(page, 0, 0);
  for (const x of [0, 643]) assert.deepEqual([...pixels.getImageData(x, 100, 1, 1).data].slice(0, 3), [0x8a, 0x8f, 0x99]);
  assert.match(first.text, /Each tile is the whole frame \(gray outline\), not a crop\./);
  assert.match(first.text, /page 1 \(full size\) \S+review-\w+\.png: 1=0s first frame/);
  assert.match(first.text, /next: look \{"mode":"review"\}$|Every moment is reviewed/);
  // Every moment shown, at either size, counts: the review ends in one or two calls here.
  assert.ok(rest.length <= 1, `${rest.length + 1} calls`);
  const done = rest.at(-1) ?? first;
  assert.equal(done.data.left, 0);
  const again = await agent("look", { project: id, mode: "review" });
  assert.match(again.text, /all \d+ moments reviewed as they are now; nothing changed since/);
  assert.equal(again.images?.length ?? 0, 0);

  // Move the late line: only the moments it is on screen in (from 4.5 s) come back.
  await agent("edit", { project: id, ops: [{ op: "update_layer", layer: "late", properties: { y: 300 } }] });
  const changed = await agent("look", { project: id, mode: "review" });
  assert.ok(changed.data.shown >= 1, changed.text);
  assert.ok(changed.data.times.every((time) => time >= 4.5), `only moments from 4.5 s: ${changed.data.times}`);
  assert.ok(changed.data.shown + changed.data.left < first.data.events);
});

test("look review: a cut between full-frame plates gets one seam strip, 5 frames from -0.2 s to +0.2 s; a small layer shown elsewhere gets none", async () => {
  const id = await project("review-seams");
  const plate = (name, fill) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: 0, y: 0, width: 640, height: 360, fill } });
  const badge = (name, start) => [{ op: "add_layer", layerType: "rectangle", name, properties: { x: 500, y: 20, width: 60, height: 60, fill: "#ff0000" } }, { op: "add_animation", layer: name, preset: "show", start }];
  await agent("edit", { project: id, ops: [plate("dark", "#202020"), plate("flash", "#ffffff"), { op: "add_animation", layer: "flash", preset: "show", start: 3 }, ...badge("early", 1.5), ...badge("late", 3.05)] });
  const [first] = await reviewAll(id);
  const line = first.text.split("\n").find((entry) => entry.startsWith("seams "));
  assert.match(line ?? "", /seams \S+review-\w+\.png: a row a cut \(\d+\), frames at -0\.2 -0\.1 0 \+0\.1 \+0\.2 s/, first.text);
  const seams = await loadImage(Buffer.from(first.images.at(-1).data, "base64"));
  assert.ok(seams.width > seams.height * 4, `one row of 5: ${seams.width}×${seams.height}`);
});

test("check and look review print the bare background between two full-frame shots with the call that closes it; the call clears it", async () => {
  const id = await project("review-bare");
  const plate = (name, fill) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: 0, y: 0, width: 640, height: 360, fill } });
  const edit = await agent("edit", { project: id, ops: [plate("dark", "#202020"), { op: "add_animation", layer: "dark", preset: "hide", start: 3 },
    plate("next", "#303030"), { op: "add_animation", layer: "next", preset: "show", start: 3 }, { op: "add_animation", layer: "next", preset: "preset-fade", start: 3, duration: 0.2 }] });
  assert.equal(edit.isError, undefined, edit.text);
  const line = (text) => text.split("\n").find((entry) => entry.startsWith("bare background @"));
  const checked = await agent("check", { project: id, pixels: false });
  assert.match(line(checked.text) ?? "", /^bare background @3s: 3 frames \(3–3\.1 s\) show the scene background #15191e \(brightness 25\) between dark \(brightness 32\) and next \(brightness 48\), cover 3% at the lowest \(30 fps/, checked.text);
  assert.doesNotMatch(checked.text, /^[EW] bare/m, "a fact line, not a finding");
  const [first] = await reviewAll(id);
  assert.ok(line(first.text), first.text);
  // The call it names: the shot before stays until the next is whole.
  const call = /close it with \{op:"update_animation", animation:"([^"]+)", properties:\{start:([\d.]+)\}\}/.exec(line(checked.text));
  assert.ok(call, line(checked.text));
  const closed = await agent("edit", { project: id, ops: [{ op: "update_animation", animation: call[1], properties: { start: Number(call[2]) } }] });
  assert.equal(closed.isError, undefined, closed.text);
  assert.equal(line((await agent("check", { project: id, pixels: false })).text), undefined);
});

test("look review folds into the final render: one call renders, its receipt names the moments not reviewed, and a full review clears the note", async () => {
  const id = await project("review-gate");
  const first = await agent("render", { project: id, action: "start", quality: "final", format: "gif", wait: true });
  assert.equal(first.isError, undefined, first.text);
  assert.match(first.text, /Open notes \(not gates; fix what you agree with and render again\): review: \d+ of \d+ moments in s1 not reviewed as they are now \(0s first frame/);
  await reviewAll(id);
  const after = await agent("render", { project: id, action: "start", quality: "final", format: "gif", wait: true });
  assert.equal(after.isError, undefined, after.text);
  assert.doesNotMatch(after.text, /review: \d+ of/);
});

test("the review gate: a waiver or a render the person starts in the app goes ahead; a short scene is not gated", async () => {
  const waived = await project("review-waived");
  await agent("edit", { project: waived, ops: [{ op: "waive_check", code: "review", target: "*", reason: "the person watched it in the app" }] });
  const byWaiver = await agent("render", { project: waived, action: "start", quality: "final", format: "gif", wait: true });
  assert.equal(byWaiver.isError, undefined, byWaiver.text);

  const fromApp = await project("review-app");
  const response = await server.api("/api/dashboard/act/render", { method: "POST", headers: { "x-kino-review": key }, body: { project: fromApp, action: "start", quality: "final", format: "gif" } });
  const started = await response.json();
  assert.equal(started.isError, undefined, started.text);
  assert.match(started.text, /queued/);

  const sting = await project("review-sting", 3);
  const short = await agent("render", { project: sting, action: "start", quality: "final", format: "gif", wait: true });
  assert.equal(short.isError, undefined, short.text);
});

test("the reference gate: with no saved reference a final render is refused; with one it waits for look versus of its revision, which shows yours beside the reference", async () => {
  const id = await project("versus-gate", 6, { references: true });
  await agent("edit", { project: id, ops: [{ op: "waive_check", code: "review", target: "*", reason: "tested above" }] });
  const none = await agent("render", { project: id, action: "start", quality: "final", format: "gif" });
  assert.equal(none.data.error, "reference_needed", none.text);
  assert.match(none.data.reason, /^No saved reference edits: a final render needs 2\+ reference edits/);
  assert.deepEqual(nextCallOf(none), { tool: "library", input: { topic: "inspire", search: "<an edit like yours>" } });
  // A briefed video's gate offers the same filled search as the order step.
  const named = await project("versus-named", 6, { references: true });
  await agent("notes", { project: named, action: "brief", fields: { message: { text: 'A "Quillby" launch for hosts', by: "guessed" } } });
  await agent("edit", { project: named, ops: [{ op: "waive_check", code: "review", target: "*", reason: "tested above" }] });
  const filled = await agent("render", { project: named, action: "start", quality: "final", format: "gif" });
  assert.equal(filled.data.error, "reference_needed", filled.text);
  assert.deepEqual(nextCallOf(filled), { tool: "library", input: { topic: "inspire", search: "Quillby edit" } });
  // A measured reference with stills, kept where kino keeps them (no download).
  const folder = path.join(server.dataDirectory, "inspire");
  await mkdir(path.join(folder, "stills", "kinoTest001"), { recursive: true });
  const still = createCanvas(640, 360);
  still.getContext("2d").fillRect(0, 0, 640, 360);
  for (const n of [1, 2, 3]) await writeFile(path.join(folder, "stills", "kinoTest001", `${n}.jpg`), still.toBuffer("image/jpeg"));
  await writeFile(path.join(folder, "kinoTest001.json"), JSON.stringify({ id: "yt:kinoTest001", title: "A reference", channel: "promo", state: "measured", version: 2, seconds: 9,
    stills: [1, 2, 3].map((n) => ({ at: n * 3 - 1.5, file: `${n}.jpg` })), seen: [{ at: 1.4, kinds: ["type", "overlay"], words: "last call" }] }));
  // A save without a take is refused, with the ready call first; with one, versus shows it back.
  const bare = await agent("library", { project: id, topic: "inspire", name: "save yt:kinoTest001" });
  assert.match(bare.data.reason, /^library \{"topic":"inspire","name":"save yt:kinoTest001","take":"<structure, pacing, type, transitions or sound: what this edit takes>"\}: a save says what this edit takes from it/, bare.text);
  const saved = await agent("library", { project: id, topic: "inspire", name: "save yt:kinoTest001", take: "type: one word a cut" });
  assert.equal(saved.isError, undefined, saved.text);
  assert.match(saved.text, /\(1 saved\)\. Takes: type: one word a cut\./);

  // Not seen beside the reference yet: the final render runs look versus itself and its answer carries the rows.
  const ran = await agent("render", { project: id, action: "start", quality: "final", format: "gif" });
  assert.equal(ran.isError, undefined, ran.text);
  assert.match(ran.text, /kino ran look versus for rev \d+ \(the reference gate\):\nversus rev \d+: 3 rows, yours \(left\) beside a saved reference/, ran.text);
  const versus = await agent("look", { project: id, mode: "versus" });
  assert.equal(versus.isError, undefined, versus.text);
  assert.match(versus.text, /^versus rev \d+: 3 rows, yours \(left\) beside a saved reference/);
  assert.match(versus.text, /no judge round for rev \d+/);
  // The reference's stills are flat black: no edges, so softness is said but not compared.
  assert.match(versus.text, /^softness: (edge sharpness [\d.]+ .*your 1 saved reference [\d.]+|not compared, .*no edges)/m);
  assert.match(versus.text, /^accent: [\d.]+% of the frame .*your 1 saved reference [\d.]+%/m);
  assert.match(versus.text, /^you take from yt:kinoTest001 \(promo\): type: one word a cut\. Is it on screen\?$/m);
  // The reference is only black stills (an end card); the edit's frames are cards: each row sits at
  // the same place (opening, middle, ending) beside another kind, with no gap numbers.
  assert.deepEqual(versus.data.rows.map((row) => [row.match, row.role, row.refAt]), [["place", "opening", 1.5], ["place", "place", 4.5], ["place", "ending", 7.5]], versus.text);
  assert.match(versus.text, /row 1 @1s: opening beside theirs, other kind \(.*no gap numbers\) \(promo @1\.5s\)\.\n  theirs on screen @1\.5s: type, overlay "last call"\n/, versus.text);
  const page = await loadImage(Buffer.from(versus.images[0].data, "base64"));
  assert.deepEqual([page.width, page.height], [644, 548], "3 rows of two 320x180 pictures");
  assert.doesNotMatch(versus.text, /references: |inside your/, "one reference is no range: reference_range says nothing");
  // Two references that are bright, with text and a voice before their loudest change: yours is measured against that range.
  for (const [key, contrast] of [["kinoTest002", 0.44], ["kinoTest003", 0.5]]) {
    await mkdir(path.join(folder, "stills", key), { recursive: true });
    for (const n of [1, 2, 3]) await writeFile(path.join(folder, "stills", key, `${n}.jpg`), still.toBuffer("image/jpeg"));
    await writeFile(path.join(folder, `${key}.json`), JSON.stringify({ id: `yt:${key}`, title: "A reference", channel: "promo", state: "measured", version: 2, seconds: 9,
      stills: [1, 2, 3].map((n) => ({ at: n * 3 - 1.5, file: `${n}.jpg` })),
      fingerprint: { seconds: 20, look: { brightness: 0.95, darkShare: 0, contrast }, text: { counts: { a: 8, b: 8 } } }, heard: { change: { at: 10, kind: "drop" }, voice: [[1, 4]], by: "whisper" } }));
    assert.equal((await agent("library", { project: id, topic: "inspire", name: `save yt:${key}`, take: "sound: a voice before the drop" })).isError, undefined);
  }
  // check lists it as a warning with its fix; versus measures it itself and says it in one line.
  const checked = await agent("check", { project: id });
  assert.match(checked.text, /W reference_range s1 @[\d.]+: s1 is darker than its saved references .*match_references/, checked.text);
  // Contrast: the flat scene has less than the references' 0.44 to 0.5, and the row's fix is one color-grade step.
  assert.match(checked.text, /W reference_range s1: s1 has less contrast than its saved references .*color-grade.*contrast:1\.[1-5]/, checked.text);
  const ranged = await agent("look", { project: id, mode: "versus" });
  assert.match(ranged.text, /outside your 2 references: .*(brightness|dark).*\(theirs: .*\)\. check lists each fix\./, ranged.text);
  // A small fix after it asks for no new versus (one counts for 10 revisions).
  await agent("edit", { project: id, ops: [{ op: "update_layer", layer: "box", properties: { fill: "#ffaa00" } }] });
  const allowed = await agent("render", { project: id, action: "start", quality: "final", format: "gif", wait: true });
  assert.equal(allowed.isError, undefined, allowed.text);
  // A waiver lets a new revision go without another versus.
  await agent("edit", { project: id, ops: [{ op: "waive_check", code: "reference", target: "*", reason: "the person chose this look" }] });
  const waived = await agent("render", { project: id, action: "start", quality: "final", format: "gif", wait: true });
  assert.equal(waived.isError, undefined, waived.text);
  // A third reference measured before contrast was kept: its black stills give it contrast 0, which
  // puts the scene (0.22) inside the range, 0 to 0.5: no contrast row.
  await mkdir(path.join(folder, "stills", "kinoTest004"), { recursive: true });
  for (const n of [1, 2, 3]) await writeFile(path.join(folder, "stills", "kinoTest004", `${n}.jpg`), still.toBuffer("image/jpeg"));
  await writeFile(path.join(folder, "kinoTest004.json"), JSON.stringify({ id: "yt:kinoTest004", title: "A reference", channel: "promo", state: "measured", version: 2, seconds: 9,
    stills: [1, 2, 3].map((n) => ({ at: n * 3 - 1.5, file: `${n}.jpg` })),
    fingerprint: { seconds: 20, look: { brightness: 0.95, darkShare: 0 } } }));
  assert.equal((await agent("library", { project: id, topic: "inspire", name: "save yt:kinoTest004", take: "pacing: long holds" })).isError, undefined);
  const inside = await agent("check", { project: id });
  assert.match(inside.text, /W reference_range s1 @[\d.]+: s1 is darker than its saved references/, "the brightness row is still there");
  assert.doesNotMatch(inside.text, /contrast than its saved references/, inside.text);
});

test("an edit receipt names the findings it brought into the stretch it changed", async () => {
  const id = await project("review-receipt");
  const receipt = await agent("edit", { project: id, ops: [
    { op: "add_layer", layerType: "text", name: "tiny", properties: { text: "fine print here", x: 60, y: 40, width: 300, height: 20, fontSize: 6, fill: "#ffffff" } },
  ] });
  assert.equal(receipt.isError, undefined, receipt.text);
  assert.match(receipt.data.newFindings ?? "", /tiny/, receipt.text);
  const quiet = await agent("edit", { project: id, ops: [{ op: "update_layer", layer: "box", properties: { fill: "#ff8800" } }] });
  assert.equal(quiet.data.newFindings, undefined, "a change that brings no finding says nothing");
});

test("needs: a question with 1 to 3 options and one recommended; only the person answers; have waits for sent, an option for made", () => {
  const FACE = { what: "a front shot of his face on arrival", why: "the payoff lands on his reaction", ask: "Do you have a clip of his face when he arrives?",
    options: [{ do: "Hold the wide shot and cut on the door", cost: "no face at the payoff", recommended: true }, { do: "Use the phone selfie from 0:42", cost: "blurry, vertical" }] };
  assert.throws(() => parseNeedItems([{ ...FACE, ask: "Get a shot of his face when he arrives" }]), /a question the person can say no to/);
  assert.throws(() => parseNeedItems([{ ...FACE, options: FACE.options.map((option) => ({ ...option, recommended: true })) }]), /exactly one recommended/);
  assert.throws(() => parseNeedItems([{ ...FACE, options: [] }]), /1 to 3 things/);
  // A need about a clip the library already holds is not asked: file (its name, src or source address) finds the import and names what matched.
  const library = [{ id: "ab12.mp4", src: "/api/media/ab12.mp4", name: "arrival.mp4", credit: { page: "https://www.youtube.com/watch?v=Zz9", id: "yt:Zz9" } }];
  const [byName, bySource, byId, unknown, noFile] = [{ ...FACE, file: "Arrival.MP4" }, { ...FACE, file: "youtube.com/watch?v=Zz9" }, { ...FACE, file: "yt:Zz9" }, { ...FACE, file: "other.mp4" }, FACE]
    .map((item) => splitImported(parseNeedItems([item]), library));
  assert.deepEqual([byName.have[0].how, bySource.have[0].how, byId.have[0].how, byName.have[0].src, byName.ask.length], ["name", "source address", "source id", "/api/media/ab12.mp4", 0]);
  assert.deepEqual([unknown.ask.length, unknown.have.length, noFile.ask.length, "file" in noFile.ask[0]], [1, 0, 1, false], "no match, or no file named, asks as before");
  const needs = emptyNeeds();
  const [m1, m2] = addNeeds(needs, parseNeedItems([FACE, { ...FACE, what: "a song that builds to the arrival" }]), { rev: 3, at: "t" });
  assert.deepEqual([m1.id, m1.status, needs.checked.enough], ["M1", "open", false]);
  assert.match(needsLine(needs), /^needs: M1 "Do you have a clip of his face when…" \(2 options\) · M2/);
  assert.throws(() => addNeeds(needs, [], { rev: 4, at: "t" }), /M1, M2 not finished/);
  assert.throws(() => answerNeed(needs, { id: "M1", answer: "drop" }), /Only the person answers M1/, "the agent alone cannot drop it");
  assert.throws(() => answerNeed(needs, { id: "M1", answer: "option 1", by: "you" }), /Only the person/, "nor pick for them without their words");
  assert.equal(answerNeed(needs, { id: "M1", answer: "your call", by: "you", quote: "you decide" }).answer.option, 1, "your call takes the recommended option");
  assert.throws(() => finishNeed(needs, { id: "M1", status: "made", layers: [] }), /made needs layers/);
  assert.equal(finishNeed(needs, { id: "M1", status: "made", layers: ["L2"] }).status, "made");
  assert.equal(answerNeed(needs, { id: "m2", answer: "have", you: true }).status, "waiting");
  assert.equal(needsLine(needs), "needs: M2 waiting for theirs");
  assert.equal(finishNeed(needs, { id: "M2", status: "sent", media: "/api/media/x.mp4" }).status, "sent");
  assert.deepEqual(openNeeds(needs), []);
  addNeeds(needs, [], { rev: 5, at: "t" });
  assert.equal(needs.checked.enough, true);
  // Their own idea, none of the options: answer "other" with a plan, then made like an option.
  const [m3] = addNeeds(needs, parseNeedItems([FACE]), { rev: 6, at: "t" });
  assert.throws(() => answerNeed(needs, { id: m3.id, answer: "other", by: "you", quote: "mute only that word" }), /plan \(with answer "other"/);
  assert.equal(answerNeed(needs, { id: m3.id, answer: "other", by: "you", quote: "mute only that word", plan: "Mute the swear word, keep the rest" }).status, "planned");
  assert.equal(needsLine(needs), 'needs: M3 make "Mute the swear word, keep the rest"');
  assert.throws(() => finishNeed(needs, { id: "M3", status: "made", layers: [] }), /do "Mute the swear word/);
  assert.equal(finishNeed(needs, { id: "M3", status: "made", layers: ["L4"] }).status, "made");
  // The check-material step drafts its ask from the pick: footage of its who, for its tension; what
  // to make now stays a slot only the material fills, so the draft is refused unedited.
  const pick = { picked: { index: 0 }, list: [{ who: "a tired editor", tension: "will the cut be done before the client calls?" }] };
  const drafted = needsCall(pick).input;
  assert.match(drafted.items[0].what, /a tired editor/);
  assert.equal(drafted.items[0].why, pick.list[0].tension);
  assert.equal(unfilledSlot(drafted)?.path, "items[0].options[0].do");
  const filled = { ...drafted.items[0], options: [{ ...drafted.items[0].options[0], do: "type over the screen recording of the app" }, drafted.items[0].options[1]] };
  assert.equal(parseNeedItems([filled]).length, 1);
  assert.equal(needsCall({ list: pick.list, picked: null }).input.items[0].what, "<missing piece>", "no pick: placeholders");
  // Web search on: finding footage of the who is an option (cost: found clips, no rights talk), the files still lead.
  const found = needsCall(pick, { search: true }).input.items[0].options;
  assert.match(found[1].do, /^library \{topic:"footage", search:"a tired editor </);
  assert.match(found[1].cost, /^found clips, not your own shots/);
  assert.doesNotMatch(found[1].cost, /license|rights|private/);
  assert.deepEqual([found.length, found[0].recommended, drafted.items[0].options.some((option) => /topic:"footage"/.test(option.do))], [3, true, false], "search off: no such option");
  assert.throws(() => parseNeedItems([{ ...filled, options: [filled.options[0], found[1]] }]), /options\[1\]\.do still has <doing what the tension needs>/);
  // An edit of a subject in footage asks which clip shows the turn, never for footage of the viewer
  // "from a phone"; a product video with the same pick keeps the product ask.
  const viewer = { picked: { index: 0 }, list: [{ who: "you, the viewer", tension: "how many times has he fallen?", turn: "the count stops; he does not" }] };
  const subjectItem = needsCall(viewer, { search: true, subject: true }).input.items[0];
  assert.deepEqual([subjectItem.what, subjectItem.ask], ["a shot of the subject: the count stops; he does not", 'Which clip shows it: "the count stops; he does not"?']);
  assert.doesNotMatch(JSON.stringify(subjectItem), /phone|screen recording|you, the viewer/);
  assert.equal(parseNeedItems([{ ...subjectItem, options: [{ ...subjectItem.options[0], do: "freeze on the shot where he stands" }, subjectItem.options[2]] }]).length, 1);
  assert.equal(needsCall(viewer, { subject: false }).input.items[0].ask, "Do you have footage of you, the viewer, even from a phone?");
});

test("viewer packet text: heard lines by voice and pause, a caption's words over a misheard line, the song muffled then full; a report's open story bugs", () => {
  assert.deepEqual(viewerTimes(1.6), [0, 0.5, 1, 1.5]);
  const scene = { duration: 10, layers: [
    { id: "page", type: "group", animations: [{ kind: "show", start: 1 }, { kind: "hide", start: 3 }] },
    { id: "cap", type: "text", role: "caption", parentId: "page", text: "“Zuri, find the closest bakery”" },
    { id: "label", type: "text", text: "Not a caption" },
  ] };
  const captions = captionWindows(scene);
  assert.deepEqual(captions, [{ id: "cap", start: 1, end: 3, text: "Zuri, find the closest bakery" }]);
  const words = [["ask", 1.1, "zuri,"], ["ask", 1.4, "find"], ["ask", 1.7, "the"], ["ask", 2, "closest"], ["ask", 2.3, "baker"], ["ask", 5, "thanks."], ["app", 1.5, "Hello"]]
    .map(([voice, start, text]) => ({ voice, start, end: start + 0.25, text }));
  const lines = heardLines(words, captions);
  assert.deepEqual(lines.map((line) => [line.voice, line.start, line.text]), [["ask", 1.1, "Zuri, find the closest bakery"], ["app", 1.5, "Hello"], ["ask", 5, "thanks."]]);
  const music = musicSections({ start: 0, end: 4 }, (time) => (time < 2 ? 400 : 0), 0.5);
  assert.deepEqual(music, [{ start: 0, end: 2, what: "song (muffled)" }, { start: 2, end: 4, what: "song (full)" }]);
  const text = heardText({ duration: 10, sheets: 3, lines, music });
  assert.match(text, /^Video length 10 s\. Frames every 0\.5 s on 3 sheets, 9 to a sheet/);
  assert.match(text, / {3}1\.1- {2}2\.5s {2}\[ask\] Zuri, find the closest bakery\n/);
  assert.match(text, /Music:\n {4}0\.0- {2}2\.0s {2}song \(muffled\)/);
  // Two pieces of one recording: each stretch says its seconds of the song, and the join is named.
  const pieces = [{ start: 0, end: 7, offset: 0 }, { start: 6.9, end: 20, offset: 68 }].flatMap((range) => musicSections(range, () => 0, 0.1, "song.wav"));
  assert.deepEqual(pieces[1].song, [68, 81.1]);
  const joined = heardText({ duration: 20, sheets: 5, lines: [], music: pieces });
  assert.match(joined, /song \(full\), 0 to 7 s of the recording\n {4}6\.9s {2}the song jumps from 6\.9 s to 68 s of its recording\n/);
  assert.doesNotMatch(heardText({ duration: 20, sheets: 5, lines: [], music: [pieces[0], ...musicSections({ start: 7, end: 20, offset: 7 }, () => 0, 0.1, "song.wav")] }), /jumps/, "the recording plays on");

  const beats = [{ from: 0, to: 4, intent: "the viewer knows what he asks for" }, { from: 4, to: 10, intent: "the viewer feels relief at the arrival" }];
  assert.throws(() => parseViewer({ report: "x".repeat(50), matches: [{ beat: 1, got: "yes" }] }, beats), /beat 2 has no/);
  const report = parseViewer({ report: "I saw a man ask an app for a store. ".repeat(3), matches: [{ beat: 1, got: "yes" }, { beat: 2, got: "no", note: "the walk just stops" }], bugs: [{ at: 2, what: "too much text at once" }] }, beats);
  assert.deepEqual(openStoryBugs(report, beats), [{ at: 2, what: "too much text at once" }, { at: 4, what: "beat 2 missed: the walk just stops" }]);
  const story = { intents: { s: { beats } }, viewers: [{ ...report, rev: 5, sceneId: "s" }] };
  assert.match(viewerGap(story, "s", 6).why, /^rev 5's viewer report has 2 open story bugs: @2s too much text/);
  assert.equal(viewerGap({ ...story, viewers: [{ rev: 5, sceneId: "s", matches: [{ beat: 1, got: "partly" }], bugs: [] }] }, "s", 6), null, "partly is not a bug");
  assert.match(viewerGap({ ...story, viewers: [{ rev: 5, sceneId: "s", matches: [], bugs: [] }] }, "s", 30).why, /more than 10 revisions ago/);
  assert.equal(viewerGap({}, "s", 1).why, "no viewer report yet");
  // Bugs on the cut the viewer watched ask for a fix, not another viewer; after 2 rounds (reports
  // on different revisions) one edit for them and nothing holds (a test run made 6 packets), but a
  // cut changed over 10 revisions since is watched again.
  assert.equal(viewerGap(story, "s", 5).fix, true);
  assert.equal(viewerGap(story, "s", 6).fix, undefined);
  const twice = { ...story, viewers: [{ ...report, rev: 3, sceneId: "s" }, { ...report, rev: 5, sceneId: "s" }] };
  assert.deepEqual([viewerGap(twice, "s", 5).fix, viewerGap(twice, "s", 5).last], [true, true]);
  assert.equal(viewerGap(twice, "s", 6), null);
  assert.match(viewerGap(twice, "s", 30).why, /more than 10 revisions ago/);
  // The keep-watching scores and drags: a dip under the start score or a drag over 5 s is an open
  // story bug at warning level (with its times), shown but holding no render.
  const scored = parseViewer({ report: `${"I saw a man ask an app for a store. ".repeat(3)}\nKEEP start=7 middle=5 end=8\nDRAG 3-9.5s\nDRAG 1-3s\nCARED t=8.2`, matches: [{ beat: 1, got: "yes" }, { beat: 2, got: "yes" }] }, beats, 12);
  assert.deepEqual([scored.scores, scored.drags.length, scored.cared], [{ start: 7, middle: 5, end: 8 }, 2, 8.2]);
  assert.deepEqual(openStoryBugs(scored, beats).map((bug) => [bug.at, bug.to, bug.warn]), [[3, 9.5, true], [4, 8, true]]);
  assert.match(openStoryBugs(scored, beats)[1].what, /fell from 7 at the start to 5 in the middle/);
  assert.equal(viewerGap({ ...story, viewers: [{ ...scored, rev: 5, sceneId: "s" }] }, "s", 6), null, "warnings hold no render");
  assert.deepEqual(openStoryBugs({ ...scored, scores: { start: 6, middle: 6, end: 7 }, drags: [] }, beats), [], "no dip, no long drag");
  // A start 3 or more under the best later score is a warning too (a dark opening: 5, 8, 6); 7, 8 is not.
  const [slow] = openStoryBugs({ ...scored, scores: { start: 5, middle: 8, end: 6 }, drags: [] }, beats);
  assert.deepEqual([slow.at, slow.warn], [0, true]);
  assert.match(slow.what, /at the start 5, 8 later: the opening holds least/);
  assert.deepEqual(openStoryBugs({ ...scored, scores: { start: 7, middle: 8, end: 7 }, drags: [] }, beats), []);
  // The moment the viewer cared most, outside every signature, is a direction miss.
  assert.match(directionMiss(scored, [{ from: 1, to: 3 }]), /^direction miss: the viewer cared most about 8\.2 s, outside every signature \(1-3 s\)/);
  assert.equal(directionMiss(scored, [{ from: 7, to: 9 }]), null);
  assert.equal(directionMiss(scored, []), null);
  // With a bar the viewer compares two cuts blind (the bar is A or B by packet): no PREFER line
  // is refused, and preferring the bar is an advisory story bug (blind viewers have picked by position).
  const watched = { report: `${"I saw a man ask an app for a store. ".repeat(3)}`, matches: [{ beat: 1, got: "yes" }, { beat: 2, got: "yes" }] };
  assert.throws(() => parseViewer(watched, beats, 12, { bar: true }), /no PREFER line/);
  const preferred = parseViewer({ ...watched, report: `${watched.report}\nPREFER B · its captions follow the voice` }, beats, 12, { bar: true });
  assert.equal(preferred.prefer.cut, "B");
  assert.deepEqual(openStoryBugs({ ...preferred, prefer: { ...preferred.prefer, bar: true } }, beats).map((bug) => [bug.at, bug.what, bug.warn ?? false]), [[0, "the viewer preferred the bar: its captions follow the voice", true]]);
  assert.deepEqual(openStoryBugs({ ...preferred, prefer: { ...preferred.prefer, bar: false } }, beats), []);
  // A caption added for a viewer bug can give away the ending. A caption shown
  // before the last beat that names what only the last beat's intent says is a spoiler.
  const ending = [{ from: 0, to: 6, intent: "the viewer knows zuri guides him blind" }, { from: 6, to: 10, intent: "the viewer sees him reach the bakery" }];
  assert.deepEqual(captionSpoilers(scene, [...ending].reverse()), [{ id: "cap", start: 1, text: "Zuri, find the closest bakery", words: ["bakery"] }], "beats in any order");
  assert.deepEqual(captionSpoilers(scene, [{ ...ending[0], to: 0.5 }, { ...ending[1], from: 0.5 }]), [], "shown after the last beat starts");
  // A speech caption (the voice says the word while it shows) and a waived caption are not spoilers.
  assert.deepEqual(captionSpoilers(scene, ending, { heard: [{ start: 2.3, end: 2.6, text: "bakery." }] }), []);
  assert.deepEqual(captionSpoilers(scene, ending, { waived: ["cap"] }), []);
});

test("a new packet deletes older packets of its kind and scene and look images past 30 min; a viewer's packet stays", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "kino-packets-"));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const name of ["viewer-s-r1", "critique-s-r1", "critique-s-r2-0-4", "critique-t-r1", "critique-s-r3"]) await mkdir(path.join(parent, name));
  for (const name of ["frame-0123456789ab.png", "frame-ba9876543210.png"]) await writeFile(path.join(parent, name), "");
  for (const name of ["viewer-s-r1", "critique-s-r1", "critique-s-r2-0-4", "critique-t-r1", "frame-0123456789ab.png"]) await utimes(path.join(parent, name), old, old);
  await writePacket(path.join(parent, "critique-s-r4"), [], "packet", "packet.txt");
  // Look images go past 30 min too (out/<project> has no other cleanup); a newer one stays.
  assert.deepEqual((await readdir(parent)).sort(), ["critique-s-r3", "critique-s-r4", "critique-t-r1", "frame-ba9876543210.png", "viewer-s-r1"]);
  assert.equal(packetKind("critique-s-r2-1.5-3"), "critique-s");
  await rm(parent, { recursive: true, force: true });
});

test("the viewer gate: a 16 s video with footage needs intents, a packet and a fresh viewer's report with no open story bugs, or a waiver", { skip: skipWithoutMediaTools }, async () => {
  const id = "viewer-gate";
  const file = await makeVideo(path.join(server.dataDirectory, "street.mp4"), { width: 64, height: 36, fps: 2, frames: 32, frameColor: (n) => [n * 6, 80, 120] });
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "street.mp4" }, body: await readFile(file) });
  const media = await upload.json();
  await agent("project", { action: "create", id, width: 320, height: 180, duration: 16 });
  const built = await agent("edit", { project: id, ops: [
    { op: "waive_check", code: "reference", target: "*", reason: "a viewer test" },
    { op: "waive_check", code: "review", target: "*", reason: "a viewer test" },
    { op: "waive_check", code: "plain_beats", target: "s1", reason: "test fixture" },
    { op: "add_layer", layerType: "video", name: "street", properties: { src: media.src ?? media.media?.src, x: 0, y: 0, width: 320, height: 180 } },
    { op: "waive_check", code: "soft_upscale", target: "street", reason: "a tiny test clip" },
  ] });
  assert.equal(built.isError, undefined, built.text);
  const start = { project: id, action: "start", quality: "final", format: "gif" };
  // No brief: no intents step (the whole scene is one beat), the viewer packet is the next call.
  // The viewer pass folds into the final render: it renders, and its receipt says the pass is open.
  const noIntents = await agent("render", start);
  assert.equal(noIntents.isError, undefined, noIntents.text);
  assert.match(noIntents.text, /Open notes \(not gates[^)]*\): viewer: s1: /);
  await agent("render", { project: id, action: "cancel", job: noIntents.data.job });
  // Intents sent with the packet are saved before it, in one call.
  const packet = await agent("look", { project: id, mode: "viewer", beats: [{ from: 0, to: 8, intent: "the viewer sees the street change color" }, { from: 8, to: 16, intent: "the viewer expects it to keep going" }] });
  assert.equal(packet.isError, undefined, packet.text);
  assert.equal(packet.data.sheets.length, 4, "32 frames, 9 to a sheet");
  const sheet = await loadImage(await readFile(packet.data.sheets[0]));
  assert.deepEqual([sheet.width, sheet.height], [3 * 480 + 8, 3 * 270 + 8]);
  assert.match(await readFile(packet.data.heard, "utf8"), /^Video length 16 s\./);
  assert.match(packet.text, /Start a fresh subagent that never saw the brief/);
  assert.match(packet.data.prompt, /You are seeing a video for the first time/);
  assert.doesNotMatch(packet.text, /street change color/, "the packet never shows the intents");

  const rev = packet.data.rev;
  const report = "Sheet 1: a colored frame that slowly shifts from blue to pink. I expect it to keep shifting.";
  const failing = await agent("notes", { project: id, action: "viewer", rev, report, matches: [{ beat: 1, got: "yes" }, { beat: 2, got: "no", note: "nothing suggests more" }] });
  assert.match(failing.text, /1 open story bug:\n {2}@8s beat 2 missed: nothing suggests more/);
  const blocked = await agent("render", start);
  assert.match(blocked.text, /viewer: s1: .*open story bug/);
  await agent("render", { project: id, action: "cancel", job: blocked.data.job });
  const passing = await agent("notes", { project: id, action: "viewer", rev, report, matches: [{ beat: 1, got: "yes" }, { beat: 2, got: "partly" }] });
  assert.match(passing.text, /no open story bugs/);
  // The needs gate: a video with no brief owes no material check, but a need the agent asked waits for the person.
  const unchecked = await agent("render", start);
  assert.notEqual(unchecked.data?.error, "needs_unchecked", unchecked.text);
  if (unchecked.data?.job) await agent("render", { project: id, action: "cancel", job: unchecked.data.job });
  // A clip the person already imported is not asked for again: the answer names the import that matched, and no need is made.
  const have = await agent("notes", { project: id, action: "needs", items: [{ what: "a street clip of the walk", why: "the viewer never sees the street itself", file: "street.mp4",
    ask: "Do you have footage of the street?", options: [{ do: "Use the street clip as it is", cost: "one angle only", recommended: true }] }] });
  assert.equal(have.isError, undefined, have.text);
  assert.match(have.text, /nothing left to ask the person\.\na street clip of the walk: already imported as street\.mp4 \(\/api\/media\/[^)]+\), matched by name, so not asked/);
  assert.deepEqual([have.data.added, have.data.imported.length], [[], 1]);
  const asked = await agent("notes", { project: id, action: "needs", items: [{ what: "a close shot of the street sign", why: "the viewer never learns where this is",
    ask: "Do you have a photo of the street sign?", options: [{ do: "Add a title card with the street name", cost: "a card, not the place", recommended: true }] }] });
  assert.equal(asked.isError, undefined, asked.text);
  const open = await agent("render", start);
  assert.equal(open.data.error, "needs_open");
  assert.match(open.data.reason, /M1 unanswered/);
  assert.match((await agent("status", { project: id })).text, /needs: M1 "Do you have a photo of the street.*\(1 option\)/);
  const alone = await agent("notes", { project: id, action: "needs", id: "M1", answer: "drop" });
  assert.match(alone.text, /Only the person answers M1/, "the agent cannot drop a need alone");
  const person = await server.api("/api/dashboard/act/notes", { method: "POST", headers: { "x-kino-review": key }, body: { project: id, action: "needs", id: "M1", answer: "drop" } });
  assert.equal((await person.json()).isError, undefined, "the person drops it from the dashboard");
  const allowed = await agent("render", start);
  assert.ok(!["viewer_needed", "needs_open", "needs_unchecked"].includes(allowed.data?.error), allowed.text);
  if (allowed.data?.job) await agent("render", { project: id, action: "cancel", job: allowed.data.job });
  // A bar: the bar's frames at the same density (as many sheets as this cut), blind as A or B;
  // the report needs PREFER, and preferring the bar warns but holds no render.
  const kept = (await agent("status", { project: id })).data?.rev ?? rev;
  await agent("notes", { project: id, action: "verdict", rev: kept, words: "the best so far", best: true });
  const both = await agent("look", { project: id, mode: "viewer" });
  assert.equal(both.data.sheets.length, 8, "4 sheets a cut");
  assert.match(await readFile(both.data.heard, "utf8"), /^Cut A\nVideo length 16 s[\s\S]*\nCut B\nVideo length 16 s/);
  assert.match(both.data.prompt, /cut A on sheets 01 to 04, cut B on sheets 05 to 08/);
  assert.match((await agent("notes", { project: id, action: "viewer", rev: both.data.rev, report, matches: [{ beat: 1, got: "yes" }, { beat: 2, got: "yes" }] })).text, /no PREFER line/);
  const side = both.data.rev % 2 ? "A" : "B";
  const prefers = await agent("notes", { project: id, action: "viewer", rev: both.data.rev, report: `${report}\nPREFER ${side} · it moves more`, matches: [{ beat: 1, got: "yes" }, { beat: 2, got: "yes" }] });
  assert.match(prefers.text, /no open story bugs[\s\S]*warn @0s the viewer preferred the bar: it moves more/);
});

test("critic lines: only P0|P1|P2 t= · where · problem → change · what stays; scores and loose prose refused; none is empty", () => {
  const line = parseCritique(["- P0 t=4.2 · cut to shot 3 · nowhere to look → start the title 0.2 s after the cut · the cut time", "P2 t=9 | end card | logo small -> scale logo to 160 px | the color"], 12);
  assert.deepEqual(line.map((entry) => [entry.level, entry.at, entry.change]), [["P0", 4.2, "start the title 0.2 s after the cut"], ["P2", 9, "scale logo to 160 px"]]);
  assert.equal(lineText(line[0]), "P0 t=4.2 · cut to shot 3 · nowhere to look → start the title 0.2 s after the cut · the cut time");
  assert.deepEqual(parseCritique(["none"], 12), []);
  assert.throws(() => parseCritique(["The cut at 4 s feels abrupt."], 12), /lines\[0\] is not "P0\|P1\|P2 t=/);
  // "·" or "=>" where the arrow goes (as a critic once wrote) is read and saved with the arrow; 3 parts are not.
  const dotted = parseCritique(["P0 t=4.2 · cut to shot 3 · nowhere to look · start the title 0.2 s after the cut · the cut time", "P1 t=5 · logo · small => scale to 160 px · the color"], 12);
  assert.deepEqual([lineText(dotted[0]), dotted[1].change], [lineText(line[0]), "scale to 160 px"]);
  assert.throws(() => parseCritique(["P1 t=2 · the cut · feels abrupt"], 12), /lines\[0\] is not/);
  assert.throws(() => parseCritique(["P1 t=2 · all · pacing 6/10 → tighten · story"], 12), /score/);
  // The word "score" is not a rating, and numbered or bold lines are read as the critic meant them.
  assert.deepEqual(parseCritique(["1. **P1** t=3 · game score · hangs at the edge → move it 40 px in · its font"], 12).map((entry) => [entry.level, entry.where]), [["P1", "game score"]]);
  assert.throws(() => parseCritique(["P1 t=30 · end · late → cut · story"], 12), /past the end/);
  // A span counts from its start (a first pass lost three calls to "t=19.0-25.7" refusals).
  assert.deepEqual(parseCritique(["P1 t=1.5-9 · step shots · small → scale to 62% · the dissolves", "UP t=2 to 4s · add a push · serves the turn"], 12).map((entry) => entry.at), [1.5, 2]);
  // A P0 that cuts or shrinks a designed moment (a reveal, a bible move) is a question, not a gate;
  // a P0 that fixes a real defect, or keeps the moment, still blocks.
  const moments = parseCritique(["P0 t=5 · the map reveal · too long, the story stalls → cut it to a hard cut · the voice",
    "P0 t=7 · shot 4 · route-draw runs past the beat → shorten it to 0.5 s · the music", "P0 t=8 · end card · text unreadable → raise it to 64 px · the logo",
    "P0 t=9 · payoff · lands late → move it 0.3 s earlier · the slam"], 12, { moves: ["route-draw"] });
  assert.deepEqual(moments.map((entry) => entry.ask === true), [true, true, false, false]);
  const asked = openCritique({ rounds: [{ rev: 2, lines: moments }] });
  assert.deepEqual(asked.lines.map((entry) => entry.at), [8, 9], "only the real defects block");
  assert.match(lineText(moments[0]), /^ask P0 t=5/);
  // A real defect at a designed moment, or "cut" as the noun, still blocks.
  assert.deepEqual(parseCritique(["P0 t=4 · payoff title · the eye has nowhere to land after the cut → start the title 0.2 s after the cut · the cut time",
    "P0 t=5 · the reveal · white text unreadable on the light map → add a drop shadow · the map",
    "P0 t=6 · payoff · the title is clipped at the frame edge → shrink it to 120 px · the slam"], 12).map((entry) => entry.ask === true), [false, false, false]);
  assert.deepEqual(critiqueTimes({ findings: [{ at: 2, rule: "edge_linger", severity: "error" }], spine: [{ role: "hook", from: 0, to: 2.1 }], duration: 12 }).map((entry) => [entry.time, entry.why]),
    [[0, "hook starts"], [2, "E edge_linger, hook ends"]]);
  // The round cap counts per story: only a spine rewritten from scratch starts it again, never a
  // retimed or reworded beat (a test run reworded its end beat and its round 2 said "round 1 of 2").
  const spine = (purpose, to = 4) => ({ style: { spine: [{ role: "hook", from: 0, to, purpose }, { role: "end", from: to, to: 8, purpose: "zuri, the name and where it was built" }] } });
  const state = { brief: spine("land the promise"), critique: { s: { packets: [], rounds: [{ rev: 3, lines: [], direction: critiqueDirectionKey(spine("land the promise")), spine: critiqueSpine(spine("land the promise")) }] } } };
  assert.equal(critiqueOf(state, "s").rounds.length, 1);
  assert.equal(critiqueOf({ ...state, brief: spine("land the promise", 5) }, "s").rounds.length, 1, "a beat that only moved");
  const reworded = { style: { spine: [{ role: "hook", from: 0, to: 4, purpose: "land the big promise" }, { role: "end", from: 4, to: 8, purpose: "zuri, the line, and where it was built" }] } };
  assert.equal(critiqueOf({ ...state, brief: reworded }, "s").rounds.length, 1, "reworded beats are the same story");
  const rewritten = { style: { spine: [{ role: "hook", from: 0, to: 4, purpose: "show the app" }, { role: "end", from: 4, to: 8, purpose: "the logo" }] } };
  assert.equal(critiqueOf({ ...state, brief: rewritten }, "s").rounds.length, 0);
  assert.equal(critiqueOf({ ...state, brief: rewritten, critique: { s: { packets: [], rounds: [{ ...state.critique.s.rounds[0], spine: undefined }] } } }, "s").rounds.length, 1, "a round saved without its spine counts");
  const blocked = { ...state, brief: rewritten, critique: { s: { packets: [], rounds: [{ ...state.critique.s.rounds[0], lines: parseCritique(["P0 t=1 · box · slow → faster · its path"], 12) }] } } };
  assert.equal(openCritique(critiqueOf(blocked, "s"))?.rounds, 0, "a new spine resets the count, not the open P0");
  // The elevation pass: UP lines are suggestions in their own list, beside "none"; never a gate.
  const raised = parseCritique(["none", "UP t=6 · add a slow push into the reply box with the rest dimmed · serves the payoff beat", "UP t=2 · add poster: the phone over the street · serves the idea"], 12);
  assert.deepEqual(upLines(raised).map((entry) => [entry.at, entry.add, entry.serves]), [[6, "a slow push into the reply box with the rest dimmed", "the payoff beat"], [2, "poster: the phone over the street", "the idea"]]);
  assert.equal(openCritique({ rounds: [{ rev: 1, lines: raised }] }), null);
  assert.equal(lineText(raised[0]), "UP t=6 · add a slow push into the reply box with the rest dimmed · serves the payoff beat");
  // A signature range is polished, never deleted: a P0 or UP that cuts or shrinks it is a question.
  const signatures = [{ from: 4, to: 7 }];
  const guarded = parseCritique(["P0 t=5 · shot 3 · the scan drags → cut it to 1 s · the voice", "P0 t=5 · shot 3 · the label is unreadable → raise it to 64 px · the scan",
    "UP t=6 · add nothing: remove the scan, end on the logo · serves the end", "P0 t=9 · shot 5 · the move stalls → cut it to 1 s · the voice"], 12, { signatures });
  assert.deepEqual(guarded.map((entry) => entry.ask === true), [true, false, true, false]);
  // An UP that would cut a signature is kept as a question, never a suggestion; a music drop or a cut to a shot is polish.
  assert.deepEqual([guarded[2].cutsSignature, upLines(guarded).length], [true, 0]);
  assert.deepEqual(critiqueQuestions({ rounds: [{ rev: 3, lines: guarded }] }).lines.map((entry) => entry.level), ["P0", "UP"]);
  // A cut or flattening of a designed move (a fast cut run, the rewind) at any
  // level is a question for the person, not an edit; a plain size fix is not.
  const v2 = parseCritique(["P1 t=36.4 · walk cut run · seven cuts 0.45 s apart read as a stutter → make 36.0-41.0 one continuous take · the voice",
    "P1 t=4.07 · rewind · strobes like a flash → hold each rewind shot at least 0.2 s · the hook", "P1 t=6 · caption · too small → scale to 64 px · the color"], 64);
  assert.deepEqual(v2.map((entry) => entry.ask === true), [true, true, false]);
  assert.equal(openCritique({ rounds: [{ rev: 4, lines: v2 }] }), null);
  // A real defect at a designed move (unreadable in time, hidden words, sync) still blocks.
  const defects = parseCritique(["P0 t=3.1 · typed title · it types too fast to read before the cut → slow it down to 0.06 s a letter · the hook",
    "P0 t=5 · whip transition · hard to read the price → hold it 0.4 s longer · the whip", "P0 t=7 · flash · the white flash hides the voice line, the words are not readable → soften the flash · the beat",
    "P0 t=9 · transition · the voice is out of sync after the transition → slow it down · the cut"], 64);
  assert.deepEqual(defects.map(blocksRender), [true, true, true, true]);
  // GENERIC (no moment only this product could have) blocks like a P0 until answered; OWN names one.
  const generic = parseCritique(["GENERIC · any tracker app could show this → the route drawing live on the real map", "OWN t=13 · the lights-out with only the phone lit"], 64);
  assert.deepEqual(openCritique({ rounds: [{ rev: 4, lines: generic }] }).lines.map(lineText), ["GENERIC · any tracker app could show this → the route drawing live on the real map"]);
  assert.equal(lineText(generic[1]), "OWN t=13 · the lights-out with only the phone lit");
  // A P0 about a shot deleted since its packet, or a time past the end now, is dropped with a line saying
  // so; one whose shot stays, one saved without shots and the GENERIC line stand.
  const [gone, kept, past] = parseCritique(["P0 t=4.6 · climb to scarf seam · brightness dips → lift the scarf shot · the cut", "P0 t=12.4 · grin · streaks → hard cut · the grin", "P0 t=14 · end card · fades → cut · the word"], 15);
  const round = { rounds: [{ rev: 19, lines: [{ ...gone, shots: [{ id: "L9", name: "scarf" }] }, { ...kept, shots: [{ id: "L4", name: "grin" }] }, past, generic[0]] }] };
  const now = { duration: 12.5, ids: new Set(["L4"]) };
  assert.deepEqual(openCritique(round, now).lines.map((line) => line.at), [12.4, 0]);
  assert.deepEqual(staleCritique(round, now).map(({ line, why }) => `${line.at}: ${why}`), ["4.6: scarf is deleted", "14: t=14 is past the 12.5 s end now"]);
  assert.equal(openCritique(round).lines.length, 4, "without what stands now, nothing is dropped");
  // An edit of a subject in footage asks the same question about the subject; the lines parse the same.
  assert.match(critiqueProtocol({ subject: true }), /^First line, always: is there a moment only this subject and its footage could have/m);
  assert.doesNotMatch(critiqueProtocol({ subject: true }), /this product/);
  assert.equal(critiqueProtocol(), CRITIQUE_PROTOCOL);
  const polish = parseCritique(["UP t=5 · add a music drop on the scan · serves the reveal", "P0 t=5 · shot 3 · nowhere to look → cut to the reply box 0.2 s later · the voice"], 12, { signatures });
  assert.deepEqual(polish.map((entry) => [entry.ask ?? false, entry.cutsSignature ?? false]), [[false, false], [false, false]]);
  // The shot the ask points to: a line that moves or cuts it is labeled, never asked, blocked or reordered.
  const climb = ["P0 t=1.5 · problem beat 1.5–5.5 s · the beat shows a frozen bowed-head hold, stairs do not appear until 9.0 s → move the stair-climb shot (9.0–10.4 s) to 2.0–3.4 s and cut the frozen bowed-head hold to 0.5 s · the DEAD AGAIN hook 0–1.5 s",
    "P1 t=9 · stairs climb 9.0–10.4 s · dark hands and legs → after moving it to the problem beat (see P0 t=1.5), fill 9.0–10.4 s with the mouth shot · the mouth close-up"];
  const pointed = parseCritique(climb, 15, { asked: { word: "stairs" } });
  assert.deepEqual(pointed.map((entry) => [entry.asked, entry.ask]), [["stairs", undefined], ["stairs", undefined]]);
  assert.match(lineText(pointed[0]), /the DEAD AGAIN hook 0–1\.5 s · changes the shot the ask points to \("stairs"\)$/);
  assert.deepEqual(parseCritique(climb, 15).map((entry) => entry.asked), [undefined, undefined], "without the ask's word nothing is labeled");
  assert.equal(parseCritique(["P1 t=3.2 · climb shot · blocky → swap in a cleaner frame range of the same stair climb · the climb"], 15, { asked: { word: "stairs" } })[0].asked, undefined);
  // A shot's seconds are half-open: a seam line at the shot's end is not caught; one inside it is.
  assert.equal(parseCritique(["P0 t=4.6 · seam · dark → trim it to 0.3 s · the cut"], 15, { asked: { word: "x", from: 3.2, to: 4.6 } })[0].asked, undefined);
  assert.equal(parseCritique(["P0 t=4.5 · seam · dark → trim it to 0.3 s · the cut"], 15, { asked: { word: "x", from: 3.2, to: 4.6 } })[0].asked, "x");
  // The bar: BAR better passes, BAR worse (or same) blocks like
  // a P0, and a round with no BAR line leaves the bar gate open. Every critic is asked the
  // anti-AI-edit questions.
  const compared = parseCritique(["BAR worse · captions jump in fixed chunks at 3-9 s where the bar breaks phrases on the voice", "BAR better · cuts land on the voice"], 64);
  assert.deepEqual(openCritique({ rounds: [{ rev: 4, lines: compared }] }).lines.map(lineText), ["BAR worse · captions jump in fixed chunks at 3-9 s where the bar breaks phrases on the voice"]);
  assert.equal(lineText(compared[1]), "BAR better · cuts land on the voice");
  const bar = barOf(addVerdict(addVerdict([], parseVerdict({ of: "v1", rev: 391, words: "the best so far", best: true }, "v4")), parseVerdict({ rev: 195, words: "god awful", wrong: "stacked devices" }, "v4")));
  assert.deepEqual([bar.of, bar.rev], ["v1", 391]);
  assert.match(barGap({ rounds: [{ rev: 4, lines: polish }] }, bar).why, /did not compare it with the bar/);
  assert.equal(barGap({ rounds: [{ rev: 4, lines: compared }] }, bar), null);
  assert.equal(barGap({ rounds: [{ rev: 4, lines: polish }] }, null), null);
  assert.match(anchorLines([bar, { of: "v4", rev: 195, words: "god awful", wrong: "stacked devices" }]).join("\n"), /v1 rev 391 \(THE BAR[\s\S]*v4 rev 195: "god awful"; what was wrong: stacked devices/);
  assert.match(CRITIQUE_PROTOCOL, /come from the story[\s\S]*captions break as spoken phrases[\s\S]*land on an action or the voice[\s\S]*template[\s\S]*as much as your saved references do at theirs/);
  // Story points: shared beats pair by role, otherwise even fractions of each cut.
  assert.deepEqual(barPairs({ duration: 30, barDuration: 60, spine: [{ role: "hook", from: 0, to: 4 }, { role: "turn", from: 4, to: 20 }, { role: "payoff", from: 20, to: 30 }], barSpine: [{ role: "hook", from: 0, to: 10 }, { role: "turn", from: 10, to: 40 }, { role: "payoff", from: 40, to: 60 }] }).map((pair) => [pair.at, pair.barAt]), [[2, 5], [12, 25], [25, 50]]);
  assert.deepEqual(barPairs({ duration: 9, barDuration: 18 }).slice(0, 2).map((pair) => [pair.at, pair.barAt]), [[0.5, 1], [1.5, 3]]);
  // The viewer's bar frames: one at the same story point as each frame of this cut (same density).
  const story = { duration: 30, barDuration: 60, spine: [{ role: "hook", from: 0 }, { role: "turn", from: 4 }, { role: "payoff", from: 20 }], barSpine: [{ role: "hook", from: 0 }, { role: "turn", from: 10 }, { role: "payoff", from: 40 }] };
  assert.deepEqual([0, 2, 4, 12, 25].map((time) => barTimeAt(time, story)), [0, 5, 10, 25, 50]);
  assert.equal(barTimeAt(3, { duration: 10, barDuration: 20 }), 6);
});

test("a viewer-facing finding is the agent's to fix: its waiver needs the person's own words, never \"your call\" or target *", async () => {
  const id = await project("viewer-waiver", 12);
  await agent("edit", { project: id, ops: [{ op: "add_layer", layerType: "rectangle", name: "card", properties: { x: 0, y: 0, width: 640, height: 360, fill: "#202020" } }] });
  const bare = await agent("edit", { project: id, ops: [{ op: "waive_check", code: "screen_unreadable", target: "card", reason: "the whole app on purpose" }] });
  assert.match(bare.text, /screen_unreadable is what viewers see: fix it/);
  // A repeated ending (seen in an earlier project) too; mid-video repeats (seen_before) stay the agent's.
  const ending = await agent("edit", { project: id, ops: [{ op: "waive_check", code: "ending_seen", target: "card", reason: "our house ending" }] });
  assert.match(ending.text, /ending_seen is what viewers see: fix it/);
  const handed = await agent("edit", { project: id, ops: [{ op: "waive_check", code: "frozen_picture", target: "card", quote: "your call", reason: "bursts" }] });
  assert.match(handed.text, /your call\W{0,3} is not one/);
  const all = await agent("edit", { project: id, ops: [{ op: "waive_check", code: "text_slides", target: "*", quote: "keep the title cards, I like them", reason: "their pick" }] });
  assert.match(all.text, /names the layers the person kept, not target:\W{0,3}\*/);
  // text_slides finds a whole scene and names no layer: a layer waiver would be saved and cover nothing, so it is refused.
  const onLayer = await agent("edit", { project: id, ops: [{ op: "waive_check", code: "text_slides", target: "card", quote: "keep the title cards, I like them", reason: "their pick" }] });
  assert.match(onLayer.text, /covers a whole scene and names no layer.*Name the scene/);
  const kept = await agent("edit", { project: id, ops: [{ op: "waive_check", code: "text_slides", target: "s1", quote: "keep the title cards, I like them", reason: "their pick" }] });
  assert.equal(kept.isError, undefined, kept.text);
  const record = await (await server.api(`/api/projects/${id}`)).json();
  const waiver = (record.document ?? record).checkWaivers.find((entry) => entry.code === "text_slides");
  assert.equal(waiver.reason, 'their pick (the person: "keep the title cards, I like them")');
});

test("look critique: a packet for a fresh critic (protocol, brief, trace, seam pages, one page a call); a P0 blocks final until fixed and re-read, or waived", async () => {
  const id = await project("critique-gate", 12);
  const plate = (name, fill) => ({ op: "add_layer", layerType: "rectangle", name, properties: { x: 0, y: 0, width: 640, height: 360, fill } });
  // A still end of the whole card has no layer a waiver can name (the person's-words waivers name
  // layers), so a small ticker drawn over the plates keeps the card moving to the end.
  const ticker = [{ op: "add_layer", layerType: "rectangle", name: "ticker", properties: { x: 0, y: 340, width: 60, height: 12, fill: "#ffffff" } },
    { op: "add_animation", layer: "ticker", preset: "move", start: 0, duration: 12, easing: "smooth", from: { x: 0 }, to: { x: 560 } }];
  await agent("edit", { project: id, ops: [plate("dark", "#202020"), plate("light", "#2c3e50"), { op: "add_animation", layer: "light", preset: "show", start: 6 }, ...ticker] });
  await reviewAll(id);
  const packet = await agent("look", { project: id, mode: "critique" });
  assert.equal(packet.isError, undefined, packet.text);
  assert.match(packet.text, /^critique packet s1 rev \d+: \d+ pages? \(1 seam, \d+ moments?\) and packet\.txt in /);
  assert.match(packet.text, /moment only this product could have[\s\S]*answer ONLY with lines in this form[\s\S]*P0\|P1\|P2 t=<seconds>[\s\S]*does the eye know where to look/);
  assert.match(packet.text, /Brief \(no story spine yet\)[\s\S]*Pages \(read in order[\s\S]*seams, a row a cut/);
  assert.ok(packet.text.length < 12000, `small answer: ${packet.text.length} characters`);
  assert.equal(packet.images.length, 1, "one page a call");
  assert.match(await readFile(packet.data.packet, "utf8"), /Motion trace \(from the model/);
  assert.ok(packet.data.pages.length >= 1 && packet.data.pages.every((file) => file.endsWith(".jpg")));
  // Beside the look images, where a sandboxed critic subagent may read.
  assert.equal(path.dirname(packet.data.folder), path.dirname(packet.images[0].path));
  const rev = packet.data.rev;
  // page:n of the same rev is the saved page, not every page drawn again.
  const again = await agent("look", { project: id, mode: "critique", page: 1, inline: false });
  assert.match(again.text, /^critique packet s1 rev \d+: page 1 of \d+ \(saved\)/);
  assert.equal(again.images[0].path, packet.data.pages[0]);
  assert.equal((await agent("notes", { project: id, action: "critique", rev, lines: ["looks great, 8/10"] })).data.error, "bad_input");
  const saved = await agent("notes", { project: id, action: "critique", rev, lines: ["P0 t=6 · cut to light · the frame flashes → fade light in over 0.3 s · the cut time", "P2 t=1 · box · plain → round its corners to 12 · its path"] });
  assert.match(saved.text, /^critique round 1 of 1 saved for s1 rev \d+: P0 1 · P1 0 · P2 1; fix list, worst first/);
  // One round, a fix list: the final render goes ahead and its receipt lists the open P0.
  const open = await agent("render", { project: id, action: "start", quality: "final", format: "gif" });
  assert.equal(open.isError, undefined, open.text);
  assert.match(open.text, /Open notes \(not gates[^)]*\): .*critique: s1: rev \d+'s critic found 1 P0 line: P0 t=6 · cut to light/);
  await agent("render", { project: id, action: "cancel", job: open.data.job });
  assert.equal((await agent("notes", { project: id, action: "critique", rev, lines: ["none"] })).data.error, "bad_input");
  // A second round is not asked for: the answer points at the fix, then the final render.
  await agent("edit", { project: id, ops: [{ op: "update_layer", layer: "light", properties: { fill: "#34495e" } }] });
  const second = await agent("look", { project: id, mode: "critique", inline: false });
  assert.equal(second.data.error, "critique_rounds", second.text);
  assert.match(second.text, /fix list[\s\S]*does not wait on them/);
  // A waiver lets an open P0 go (a deliberate choice).
  const other = await project("critique-waived", 12);
  const third = await agent("look", { project: other, mode: "critique", inline: false });
  await agent("edit", { project: other, ops: [{ op: "waive_check", code: "critique", target: "*", reason: "the person wants the slow move" }] });
  // A round with no P0 on a packet the video was edited past is refused; a P0 on it is kept.
  assert.match((await agent("notes", { project: other, action: "critique", rev: third.data.rev, lines: ["none"] })).text, /changed since the rev \d+ packet/);
  assert.match((await agent("notes", { project: other, action: "critique", rev: third.data.rev, lines: ["P2 t=1 · box · plain → round its corners to 12 · its path"] })).text, /changed since/, "P1/P2 lines alone clear the gate too");
  // With an idea saved, the fix list is read against it (no idea: the head is as before, above).
  await agent("notes", { project: other, action: "brief", fields: { idea: "the box arrives on time" } });
  const against = await agent("notes", { project: other, action: "critique", rev: third.data.rev, lines: ["P0 t=1 · box · too slow → move it in 0.5 s · its path"] });
  assert.match(against.text, /P0 1 · P1 0 · P2 0; fix list against the idea "the box arrives on time", worst first:/);
  await reviewAll(other);
  const waived = await agent("render", { project: other, action: "start", quality: "final", format: "gif" });
  assert.notEqual(waived.data?.error, "critique_open", waived.text);
  if (waived.data?.job) await agent("render", { project: other, action: "cancel", job: waived.data.job });
  // A bar (notes verdict best): the packet opens with this cut and the bar at the same story
  // points, the person's verdicts as anchors; a round must compare (BAR), and BAR worse blocks.
  const barred = await project("critique-bar", 12);
  await agent("edit", { project: barred, ops: [plate("dark", "#202020"), ...ticker] });
  await reviewAll(barred);
  const verdict = await agent("notes", { project: barred, action: "verdict", of: other, rev: third.data.rev, words: "the best so far", best: true });
  assert.match(verdict.text, /^bar saved: critique-waived rev \d+: "the best so far"/);
  const compared = await agent("look", { project: barred, mode: "critique", inline: false });
  assert.match(compared.text, /BAR better\|worse[\s\S]*THIS CUT at the story points[\s\S]*THE BAR \(critique-waived rev/);
  assert.match(await readFile(compared.data.packet, "utf8"), /critique-waived rev \d+ \(THE BAR, the best so far\): "the best so far"/);
  assert.match((await agent("notes", { project: barred, action: "critique", rev: compared.data.rev, lines: ["none"] })).text, /has a bar/);
  await agent("notes", { project: barred, action: "critique", rev: compared.data.rev, lines: ["BAR worse · the box arrives late at 2 s where the bar lands on the beat"] });
  const worse = await agent("render", { project: barred, action: "start", quality: "final", format: "gif" });
  assert.match(worse.text, /critique: s1: rev \d+'s critic found 1 P0 line: BAR worse/);
  if (worse.data?.job) await agent("render", { project: barred, action: "cancel", job: worse.data.job });
});

test("a briefed video of 15 s or more with 10 layers is a real edit: its open warnings hold the final render", async () => {
  const id = await project("few-layers-long", 16);
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start" })).isError, undefined);
  await agent("edit", { project: id, ops: Array.from({ length: 10 }, (_, n) => ({ op: "add_layer", layerType: "rectangle", name: `bar${n}`, properties: { x: 40 + n * 60, y: 300, width: 40, height: 40, fill: "#ffffff" } })) });
  await reviewAll(id);
  const held = await agent("render", { project: id, action: "start", quality: "final", format: "gif" });
  assert.ok(held.data.error, held.text);
  assert.match(held.data.reason, /fix \d+ findings? \(/, "its open warnings are listed among what the final needs");
  // The critic is asked too, though the video has under 30 layers.
  assert.match(held.data.reason, /look critique/);
});

test("a real edit (a brief, over 30 layers) is offered one critic round; the final render never waits on it, and an open P0 rides on its receipt", async () => {
  const id = await project("critique-needed", 12);
  // A gate test of the critic: this video's own controls skip the storyboard (the person's words
  // in quote), so no server-wide setting changes and nothing needs putting back.
  const controls = { skip_under: { board: 30 }, quote: "no storyboard for this one" };
  assert.equal((await agent("notes", { project: id, action: "brief", no_playback: "just start", fields: { ask: "no storyboard for this one", controls } })).isError, undefined);
  const style = { wants: [], avoids: ["flash"], lines: [{ text: "the title type", ref: "yt:dQw4w9WgXcQ" }], by: "guessed", waived: "a gate test, no one watching", spine: [{ role: "hook", from: 0, to: 12, purpose: "the promise" }], fonts: { caption: { family: "Inter", size: 40 } } };
  const locked = await agent("notes", { project: id, action: "brief", fields: { style } });
  assert.equal(locked.isError, undefined, locked.text);
  await agent("edit", { project: id, ops: [...Array.from({ length: 29 }, (_, n) => ({ op: "add_layer", layerType: "rectangle", name: `dot${n}`, properties: { x: 20 + n * 20, y: 320, width: 8, height: 8, fill: "#ffffff" } })),
    // The box drifts to the end and the title leaves at 3 s: a scene-wide finding (held_static on the whole card, text_slides, ending_seen) has no layer to waive, so none arises. The box's own slow stretch is kept in the person's words.
    { op: "add_animation", layer: "box", preset: "move", start: 2, duration: 10, easing: "smooth", from: { x: 480 }, to: { x: 40 } },
    { op: "add_animation", layer: "title", preset: "hide", start: 3 },
    { op: "waive_check", code: "held_static", target: "box", quote: "keep the still test card as it is", reason: "a still test card" }] });
  await reviewAll(id);
  const final = () => agent("render", { project: id, action: "start", quality: "final", format: "gif" });
  // A real edit's open warnings hold its final render too, one line a rule; this card's are on purpose.
  const warned = await final();
  assert.equal(warned.data.error, "check_failed", warned.text);
  assert.match(warned.data.reason, /block a final render \(fix each\):\n {2}[a-z_]+/);
  await agent("edit", { project: id, ops: [...["no_music", "static_scene", "default_font", "page_chrome", "seen_before"].map((code) => ({ op: "waive_check", code, target: "*", reason: "a gate test card" })), { op: "waive_check", code: "type_seen", target: "*", reason: "set like the title in yt:dQw4w9WgXcQ" }] });
  await reviewAll(id);
  const cancel = async (reply) => { if (reply.data?.job) await agent("render", { project: id, action: "cancel", job: reply.data.job }); };
  const needed = await final();
  assert.equal(needed.isError, undefined, needed.text);
  assert.match(needed.text, /critique: s1 has had no critic round/);
  await cancel(needed);
  const first = await agent("look", { project: id, mode: "critique", inline: false });
  const last = await agent("notes", { project: id, action: "critique", rev: first.data.rev, lines: ["P0 t=1 · box · too slow → move it in 0.5 s · its path"] });
  // A P0 is a fix to make, not the person's stop; the final render lists it while it stands.
  assert.deepEqual(nextCallOf(last), { tool: "edit", input: { ops: ["<the edit for: move it in 0.5 s>"] } });
  const open = await final();
  assert.match(open.text, /critique: s1: rev \d+'s critic found 1 P0 line: P0 t=1 · box/);
  await cancel(open);
});

test("one helper a round: look critique carries the viewer's sheets when both gates ask; one notes critique answer passes both; a P0 asks round 2; separate answers still pass", { skip: skipWithoutMediaTools }, async (t) => {
  const file = await makeVideo(path.join(server.dataDirectory, "walk.mp4"), { width: 64, height: 36, fps: 2, frames: 32, frameColor: (n) => [n * 6, 80, 120] });
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "video/mp4", "x-file-name": "walk.mp4" }, body: await readFile(file) });
  const media = await upload.json();
  const beats = [{ from: 0, to: 8, intent: "the viewer sees the street change color" }, { from: 8, to: 16, intent: "the viewer expects it to keep going" }];
  const yes = [{ beat: 1, got: "yes" }, { beat: 2, got: "yes" }];
  const report = "Sheet 1: a colored frame that slowly shifts from blue to pink. I expect it to keep shifting.\nKEEP start=6 middle=6 end=6\nDRAG none\nCARED t=4";
  // A real edit (a brief, over 30 layers) of 16 s with footage: both the viewer and the critic gate ask.
  async function build(id) {
    await skipBoardOn(server);
    await agent("project", { action: "create", id, width: 320, height: 180, duration: 16 });
    await agent("notes", { project: id, action: "brief", no_playback: "just start" });
    const style = { wants: [], avoids: [], lines: [], by: "guessed", waived: "a gate test, no one watching", spine: [{ role: "hook", from: 0, to: 16, purpose: "the street" }], fonts: { caption: { family: "Inter", size: 40 } } };
    assert.equal((await agent("notes", { project: id, action: "brief", fields: { style } })).isError, undefined);
    const built = await agent("edit", { project: id, ops: [
      { op: "add_layer", layerType: "video", name: "street", properties: { src: media.src ?? media.media?.src, x: 0, y: 0, width: 320, height: 180 } },
      ...Array.from({ length: 30 }, (_, n) => ({ op: "add_layer", layerType: "rectangle", name: `dot${n}`, properties: { x: 10 + n * 10, y: 170, width: 4, height: 4, fill: "#ffffff" } })),
      // The waivers come last: a viewer waiver names layers, so they must exist first.
      ...["reference", "review", "soft_upscale", "plain_beats", "held_static", "no_music", "static_scene", "default_font", "page_chrome", "seen_before", "ending_seen", "text_slides", "needs", "treatments", "no_rhythm", "few_techniques"].map((code) => ({ op: "waive_check", code, ...viewerWaiver(code), reason: "a gate test" })),
    ] });
    assert.equal(built.isError, undefined, built.text);
    await agent("check", { project: id, fix: "auto" });
    assert.equal((await agent("notes", { project: id, action: "intents", beats })).isError, undefined);
    return id;
  }
  const final = (id) => agent("render", { project: id, action: "start", quality: "final", format: "gif" });
  // The person's stops (board, rough, color, sound) come first; the gate list names the rest.
  const passes = async (id) => {
    const reply = await final(id);
    assert.ok(!["viewer_needed", "critique_needed", "critique_open"].includes(reply.data?.error), reply.text);
    assert.doesNotMatch(reply.data?.reason ?? "", /viewer|critique|critic/, "neither gate is open");
    if (reply.data?.job) await agent("render", { project: id, action: "cancel", job: reply.data.job });
  };
  const size = (packet, texts) => texts.reduce((sum, text) => sum + text.length, packet.text.length);
  // The helper's step: part 1 into viewer.txt, then packet.txt appears (kino polls every 0.25 s).
  const appears = async (file) => {
    for (let n = 0; n < 40; n += 1) { if (await readFile(file, "utf8").catch(() => null) != null) return true; await new Promise((done) => setTimeout(done, 100)); }
    return false;
  };

  // The old way still works: a viewer packet and a critic packet, two helpers, two answers.
  const old = await build("one-helper-old");
  const viewerPacket = await agent("look", { project: old, mode: "viewer" });
  assert.match(viewerPacket.text, /look \{mode:"critique"\} carries these sheets/);
  await agent("notes", { project: old, action: "viewer", rev: viewerPacket.data.rev, report, matches: yes });
  const criticPacket = await agent("look", { project: old, mode: "critique", inline: false });
  assert.equal(criticPacket.data.viewer, undefined, "the viewer already watched this rev: a critic packet only");
  await agent("notes", { project: old, action: "critique", rev: criticPacket.data.rev, lines: ["none"] });
  await passes(old);
  const before = { helpers: 2, images: viewerPacket.data.sheets.length + criticPacket.data.pages.length,
    chars: size(viewerPacket, [await readFile(viewerPacket.data.heard, "utf8")]) + size(criticPacket, [await readFile(criticPacket.data.packet, "utf8")]) };

  // Both gates ask: the refusal and the gate list name one helper for both.
  const one = await build("one-helper");
  const packet = await agent("look", { project: one, mode: "critique", inline: false });
  assert.equal(packet.isError, undefined, packet.text);
  assert.equal(packet.data.viewer.sheets, 4, "32 frames, 9 to a sheet");
  assert.match(packet.data.prompt, /Part 1, the viewer: read .*heard\.txt[\s\S]*first time[\s\S]*Write that report, whole, to .*viewer\.txt\. Only then does packet\.txt appear[\s\S]*Part 2, the critic: read .*packet\.txt[\s\S]*fresh-eyes critic[\s\S]*Your answer is part 2's lines only/);
  assert.doesNotMatch(packet.text, /report:"<its part 1/, "the main agent never pastes the report");
  assert.doesNotMatch(await readFile(packet.data.viewer.heard, "utf8"), /street change color|the street/, "the viewer part never sees the intents or the brief");
  // The brief is held back: no packet.txt until viewer.txt has the viewer's part.
  assert.equal(await readFile(packet.data.packet, "utf8").catch(() => null), null, "packet.txt is not there before viewer.txt");
  const rev = packet.data.rev;
  assert.match((await agent("notes", { project: one, action: "critique", rev, lines: ["none"], matches: yes })).text, /viewer\.txt is empty: its helper wrote no part 1/);
  await writeFile(path.join(packet.data.folder, "viewer.txt"), "");
  assert.equal(await appears(packet.data.packet), false, "an empty viewer.txt holds it back");
  await writeFile(path.join(packet.data.folder, "viewer.txt"), report);
  assert.ok(await appears(packet.data.packet), "packet.txt appears once viewer.txt is written");
  assert.match(await readFile(packet.data.packet, "utf8"), /Moments, on the viewer sheets/);
  const after = { helpers: 1, images: packet.data.pages.length, chars: size(packet, [await readFile(packet.data.packet, "utf8"), await readFile(packet.data.viewer.heard, "utf8")]) };
  t.diagnostic(`a round: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  // One call records both: the report comes from viewer.txt, not the answer.
  const both = await agent("notes", { project: one, action: "critique", rev, lines: ["none"], matches: yes });
  assert.match(both.text, /critique round 1 of 1 saved[\s\S]*viewer report saved for s1 rev \d+: beats yes 2 · partly 0 · no 0 · keep 6\/6\/6/);
  await passes(one);

  // A helper that cannot write files answers part 1 only: kino saves it and frees packet.txt.
  const nowrite = await build("one-helper-nowrite");
  const held = await agent("look", { project: nowrite, mode: "critique", inline: false });
  const freed = await agent("notes", { project: nowrite, action: "critique", rev: held.data.rev, report });
  assert.match(freed.text, /viewer part saved for s1 rev \d+; packet\.txt is ready[\s\S]*fresh-eyes critic/);
  assert.match(await readFile(held.data.packet, "utf8"), /Moments, on the viewer sheets/);
  assert.match((await agent("notes", { project: nowrite, action: "critique", rev: held.data.rev, lines: ["none"], matches: yes })).text, /viewer report saved/);
  await passes(nowrite);

  // A P0 is a fix list: the answer names the fix, and the final render goes ahead with it listed.
  const p0 = await build("one-helper-p0");
  const first = await agent("look", { project: p0, mode: "critique", inline: false });
  await writeFile(path.join(first.data.folder, "viewer.txt"), report);
  const saved = await agent("notes", { project: p0, action: "critique", rev: first.data.rev, lines: ["P0 t=1 · dot0 · hangs at the edge → move it to x=40 · its size"], matches: yes });
  assert.match(saved.text, /P0 1[\s\S]*fix list/);
  await agent("edit", { project: p0, ops: [{ op: "update_layer", layer: "dot0", properties: { x: 40 } }] });
  // The person's stops still come first; the critic's open line is no step in the gate list.
  const listed = await final(p0);
  assert.doesNotMatch(listed.text, /look critique|critique_open/);
  if (listed.data?.job) await agent("render", { project: p0, action: "cancel", job: listed.data.job });
});

test("saved subjects reach the footage checks: a head cut off in them is a finding from a real check, and one saliency did not measure is not", async (t) => {
  const fileId = "11111111-2222-3333-4444-555555555555.mp4";
  const clip = { id: fileId, name: "keeper", width: 1920, height: 1080, duration: 10 };
  const layer = createLayer("video", { id: "v", name: "clip", src: `/api/media/${fileId}`, mediaSourceDuration: 10, x: 0, y: 0, width: 1920, height: 1080 });
  // A person's body touches the top of the picture and the pose found no head, for 3 s.
  const subjects = { saliency: true, samples: [0, 0.5, 1, 1.5, 2, 2.5, 3].map((at) => ({ t: at, faces: [], people: [{ box: [0.4, 0, 0.3, 1], head: 0 }] })) };
  let saved = subjects;
  // The people file is never read or made: only the saved subjects hold the faces.
  const peopleCache = { saved: async () => null, get: async () => null, savedSubjects: async () => saved };
  const { call } = await serviceFor(t, { document: createDocument({ id: "faces", name: "faces", scenes: [createScene({ id: "s1", width: 1920, height: 1080, duration: 3, layers: [layer] })] }), media: [clip], peopleCache });
  assert.match((await call("check")).text, /head_cut_off/, "the saved subjects feed the check");
  // A check that renders nothing (edit receipts, status) reads them too, without a new decode.
  assert.match((await call("check", { pixels: false })).text, /head_cut_off/, "the saved subjects feed a check with pixels off");
  // The header says saliency did not run: unmeasured, so nothing is read from it.
  saved = { ...subjects, saliency: false };
  assert.doesNotMatch((await call("check")).text, /head_cut_off/);
  assert.doesNotMatch((await call("check", { pixels: false })).text, /head_cut_off/);
});

test("saved subjects reach frame_shot: it crops to the saved face, and says so when none were measured", async (t) => {
  const fileId = "11111111-2222-3333-4444-555555555555.mp4";
  const clip = { id: fileId, name: "keeper", mime: "video/mp4", width: 1920, height: 1080, duration: 2 };
  const placed = { id: "v", name: "keeper", src: `/api/media/${fileId}`, mediaSourceDuration: 2, x: -700, y: 0, width: 2400, height: 1350 };
  const document = createDocument({ id: "tall", name: "tall", scenes: [createScene({ id: "s1", width: 1080, height: 1350, duration: 2, layers: [createLayer("video", placed)] })] });
  // A face at [20, 30, 15, 25]% of the file, saved by saliency; the people file holds nothing.
  const subjects = { saliency: true, samples: [0, 0.5, 1, 1.5, 2].map((at) => ({ t: at, faces: [[0.2, 0.3, 0.15, 0.25]], people: [] })) };
  let saved = subjects;
  const peopleCache = { saved: async () => null, get: async () => null, savedSubjects: async () => saved };
  const { call } = await serviceFor(t, { document, media: [clip], peopleCache });
  const framed = await call("edit", { ops: [{ op: "frame_shot", layer: "keeper" }] });
  assert.match(framed.text, /frame_shot keeper: cropped to the face/, framed.text);
  assert.doesNotMatch(framed.text, /no faces measured/, framed.text);
  // Without saved subjects it frames by the file's size alone and says no faces were measured.
  saved = null;
  await call("edit", { ops: [{ op: "update_layer", layer: "keeper", properties: { x: -700, y: 0, width: 2400, height: 1350 } }] });
  assert.match((await call("edit", { ops: [{ op: "frame_shot", layer: "keeper" }] })).text, /frame_shot keeper: .*no faces measured for this file yet/);
});

test("match_references {made:true} through the edit tool: the references' moves land as animations, flashing passes, a splatter sits by a saved face or footage figure", async (t) => {
  // Three 1.5 s shots of one card; the reference's labels name a flash, a smear, a two color split and a light sweep.
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "kino-made-wired-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const card = createCanvas(64, 36), draw = card.getContext("2d");
  draw.fillStyle = "#506070"; draw.fillRect(0, 0, 64, 36); draw.fillStyle = "#e0c040"; draw.fillRect(8, 8, 20, 20);
  await writeFile(path.join(mediaRoot, "card.png"), card.toBuffer("image/png"));
  const timed = (index) => [...(index ? [{ id: `cut-in-${index}`, name: "In", kind: "show", start: index * 1.5 }] : []), ...(index < 2 ? [{ id: `cut-out-${index}`, name: "Out", kind: "hide", start: (index + 1) * 1.5 }] : [])];
  const shot = (id, index) => createLayer("image", { id, name: id, src: "/api/media/card.png", x: 0, y: 0, width: 640, height: 360, animations: timed(index) });
  const document = createDocument({ id: "made-wired", name: "Made", scenes: [createScene({ id: "main", width: 640, height: 360, duration: 4.5, layers: ["a", "b", "c"].map(shot) })] });
  const refs = [{ id: "yt:wired", seen: ["white flash", "an orange smear", "two color split", "light sweep"].map((words, index) => ({ at: index + 1, kinds: ["made"], words })) }];
  const { call, store } = await serviceFor(t, { document, mediaRoot, inspire: { savedFingerprints: async () => refs } });
  const placed = await call("edit", { ops: [{ op: "match_references", made: true }] });
  assert.equal(placed.isError, undefined, placed.text);
  const scene = (await store.getProject("made-wired")).document.scenes[0];
  const moves = (scene.moves ?? []).filter((move) => move.id.startsWith("match-made-"));
  assert.deepEqual(moves.map((move) => move.name).sort(), ["light-sweep", "overexpose", "smear", "split-fields"], placed.text);
  // Each move landed as animations on the scene's layers (its id is their prefix).
  const animated = (move) => scene.layers.some((layer) => (layer.animations ?? []).some((animation) => String(animation.id).startsWith(`${move.id}.`)) || layer.move?.instance === move.id);
  assert.deepEqual(moves.filter((move) => !animated(move)).map((move) => move.name), [], JSON.stringify(scene.layers.map((layer) => [layer.id, (layer.animations ?? []).map((animation) => animation.id)])));
  const checked = await call("check", { rules: ["flashing"] });
  assert.doesNotMatch(checked.text, /\bflashing\b.*flash/i, checked.text);

  // Video shots with no marked subject: a saved people-scan face, a footage scan's figure, then a guess.
  const file = (id) => `00000000-0000-4000-8000-00000000000${id.slice(1)}.mp4`;
  const videos = ["v1", "v2", "v3"].map((id, index) => createLayer("video", { id, name: id, src: `/api/media/${file(id)}`, x: 0, y: 0, width: 640, height: 360, mediaStart: index * 1.5, mediaDuration: 1.5, mediaSourceDuration: 1.5, animations: timed(index) }));
  const clips = createDocument({ id: "made-clips", name: "Clips", scenes: [createScene({ id: "main", width: 640, height: 360, duration: 4.5, layers: videos })] });
  // 3840 x 2160 files: the shot's own small frame is never decoded (no colors or busy part from them).
  const media = ["v1", "v2", "v3"].map((id) => ({ id: file(id), name: id, width: 3840, height: 2160, duration: 1.5, ...(id === "v2" ? { footage: { candidate: "clip:yt-wiredclip1", code: "F1", shot: 4 } } : {}) }));
  const splat = [{ id: "yt:splat", seen: [1, 2, 3].map((at) => ({ at, kinds: ["made"], words: "paint splatter" })) }];
  const wired = await serviceFor(t, { document: clips, media, state: (draft) => { draft.footage = { candidates: [{ id: "clip:yt-wiredclip1", code: "F1", scan: true }] }; },
    inspire: { savedFingerprints: async () => splat }, renderFrames: async (scene, times, { width }) => times.map(() => ({ width, height: Math.round((width * 9) / 16), pixels: new Uint8ClampedArray(width * Math.round((width * 9) / 16) * 4).fill(100) })),
    peopleCache: { saved: async (where) => (where.endsWith(file("v1")) ? { samples: [{ t: 0.5, faces: [[0.4, 0.1, 0.2, 0.3]] }] } : null), get: async () => null, savedSubjects: async () => null },
    footage: { readScan: async () => ({ shots: [{ n: 4, figure: { box: [0.05, 0.1, 0.3, 0.8], share: 0.24, seen: 1, by: "mask" } }] }) } });
  const spots = await wired.call("edit", { ops: [{ op: "match_references", made: true }] });
  assert.equal(spots.isError, undefined, spots.text);
  assert.match(spots.text, /, below the people scan's face at 0\.5 s of the file 256,36,128,108\)/, spots.text);
  assert.match(spots.text, /, right of the footage scan's figure \(by mask\) of F1 shot 4 32,36,192,288\)/, spots.text);
  assert.match(spots.text, /a starting guess \((top left|bottom right|top right|bottom left), by shot order\)/, spots.text);
  const splats = (await wired.store.getProject("made-clips")).document.scenes[0].layers.filter((layer) => layer.id.startsWith("match-made-"));
  assert.equal(new Set(splats.map((layer) => `${layer.x},${layer.y}`)).size, 3, JSON.stringify(splats.map((layer) => [layer.x, layer.y])));
});

test("the edit receipt and check name a shifted full-frame picture's bare strip and a scene's bare end; a longer scene moves the last shot's Hide and says so", async (t) => {
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "kino-strips-"));
  t.after(() => rm(mediaRoot, { recursive: true, force: true }));
  const card = createCanvas(64, 36);
  card.getContext("2d").fillStyle = "#506070";
  card.getContext("2d").fillRect(0, 0, 64, 36);
  await writeFile(path.join(mediaRoot, "card.png"), card.toBuffer("image/png"));
  // One picture 704 x 380 at x -64 covers the 640 x 360 frame, and hides at 5.85 s.
  const pic = createLayer("image", { id: "pic", name: "pic", src: "/api/media/card.png", x: -64, y: -10, width: 704, height: 380, animations: [{ id: "pic.hide", name: "Hide", kind: "hide", start: 5.85 }] });
  const document = createDocument({ id: "strips", name: "Strips", scenes: [createScene({ id: "main", width: 640, height: 360, duration: 5.85, background: "#15191e", layers: [pic] })] });
  const { call } = await serviceFor(t, { document, mediaRoot });
  const line = (text, start) => String(text).split("\n").find((entry) => entry.startsWith(start));
  assert.equal(line((await call("check", { pixels: false })).text, "bare "), undefined);
  // Moved 36 px too far left: the receipt and check name the edge, the px, the scale and the position that cover it.
  const moved = await call("edit", { ops: [{ op: "update_layer", layer: "pic", properties: { x: -100 } }] });
  assert.equal(moved.isError, undefined, moved.text);
  const strip = /bare strip: pic leaves 36 px at the right of the frame uncovered for its whole shot \(0–5\.85 s; nothing else covers it, 5 samples\); scale it ×1\.1 about its pivot: \{op:"update_layer", layer:"pic", properties:\{scaleX:1\.102, scaleY:1\.102\}\} or move it: \{op:"update_layer", layer:"pic", properties:\{x:-64\}\}/;
  assert.match(moved.data.notes.join("\n"), strip, moved.text);
  assert.match(line((await call("check", { pixels: false })).text, "bare strip:") ?? "", strip);
  const back = await call("edit", { ops: [{ op: "update_layer", layer: "pic", properties: { x: -64 } }] });
  assert.doesNotMatch(String(back.data.notes), /bare strip/, back.text);
  // A longer scene: the picture's Hide follows to the new end, the receipt names it, and the end is not bare.
  const longer = await call("edit", { ops: [{ op: "update_scene", properties: { duration: 6 } }] });
  assert.equal(longer.isError, undefined, longer.text);
  assert.deepEqual(longer.data.sceneLength.lastShot, { moved: ["pic Hide 5.85 to 6 s"] });
  assert.equal(line((await call("check", { pixels: false })).text, "bare background"), undefined);
  // A Hide that stays 0.15 s short of the end (set by hand) is the bare end: frames, seconds and the two calls that close it.
  const short = await call("edit", { ops: [{ op: "update_animation", animation: "pic.hide", properties: { start: 5.85 } }] });
  assert.equal(short.isError, undefined, short.text);
  assert.match(line((await call("check", { pixels: false })).text, "bare background") ?? "", /^bare background @5\.87s: 4 frames \(5\.87–6 s\) at the end of the scene show the scene background #15191e \(brightness 25\) after pic.*close it with \{op:"update_animation", animation:"[^"]+", properties:\{start:6\}\} keeps pic to the end, or \{op:"update_scene", properties:\{duration:5\.85\}\} ends the scene where pic does$/);
});
