// Layout signatures (engine/quality/layoutSignature.js) and the seen_before check on small
// made-up scenes: an end card made twice in two projects is seen before; a different layout is not.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { runQuality } from "./quality/index.js";
import { SEEN_THRESHOLD } from "./quality/rules/seenBefore.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { caseOf, layoutDistance, layoutMoments, layoutSignature, shapeOf, signatureDistance } from "./quality/layoutSignature.js";
import { STRUCTURE_VERSION, structureAlike, structureSignature } from "./quality/structureSignature.js";

const text = (id, value, props = {}) => createLayer("text", { id, name: id, text: value, fontFamily: "Inter", fontSize: 64, fill: "#111111", textResize: "width-height", textAlign: "center", ...props });

function modelOf(layers, duration = 3) {
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration, background: "#f5f2ea", layers })] }));
  return kinoTimeline(document, "scene", { fonts: defaultFonts });
}

// A centered end card: a name, a tagline under it and a small address under that.
const endCard = (shift = 0) => modelOf([
  text("name", "acme", { x: 760, y: 380 + shift, fontSize: 150, role: "logo" }),
  text("tag", "Tools for small teams.", { x: 560, y: 600 + shift, fontSize: 56 }),
  text("url", "acme.dev", { x: 820, y: 700 + shift, fontSize: 36 }),
]);
const sideTitle = () => modelOf([text("title", "Chapter one", { x: 120, y: 120, fontSize: 96, textAlign: "left" })]);

// Shown from `from` to `to` s.
const during = (id, from, to) => ({ animations: [{ id: `${id}.in`, name: "show", kind: "show", start: from }, { id: `${id}.out`, name: "hide", kind: "hide", start: to }] });
const clip = (id, props = {}) => createLayer("video", { id, name: id, src: `/api/media/${id}.mp4`, mediaSourceDuration: 30, x: 0, y: 0, width: 1920, height: 1080, ...props });
// An ending over a clip: a name under the clip's cut-out of a dancer (`cut`), then `rows - 1` lines.
const cutoutEnding = (rows, { cut = true, from = 0, to = 3 } = {}) => [
  clip(`shot${from}`, during(`shot${from}`, from, to)),
  text(`name${from}`, "MAYA", { x: 700, y: 380, fontSize: 220, ...during(`name${from}`, from, to) }),
  ...(cut ? [clip(`dancer${from}`, { cutoutOf: `shot${from}`, ...during(`dancer${from}`, from, to) })] : []),
  ...["Moves made here.", "maya.studio"].slice(0, rows - 1).map((line, index) => text(`line${from}-${index}`, line, { x: 760, y: 680 + index * 90, fontSize: 48, ...during(`line${from}-${index}`, from, to) })),
];

test("case and the signature's items", () => {
  assert.equal(caseOf("ABC 1"), "caps");
  assert.equal(caseOf("abc"), "lower");
  assert.equal(caseOf("Abc"), "mixed");
  const sig = layoutSignature(endCard(), 1.5);
  assert.equal(sig.items.length, 3);
  assert.equal(sig.backdrop, 0);
  assert.ok(sig.items.every((item) => item.k === "t" && item.d === 1));
  assert.equal(sig.items.find((item) => item.r === 0).c, "lower");
});

test("the same layout is near, a different one far", () => {
  const a = layoutSignature(endCard(), 1.5);
  assert.equal(signatureDistance(a, a), 0);
  assert.ok(signatureDistance(a, layoutSignature(endCard(20), 1.5)) < 0.05);
  assert.ok(signatureDistance(a, layoutSignature(sideTitle(), 1.5)) > 0.4);
});

test("the shape term: one arrangement spaced two ways is near, a row of spread labels has no shape", () => {
  const card = (top, gap) => ({ backdrop: 0, items: [
    { k: "i", x: 0.5, y: top, w: 0.1, h: 0.18, d: 0 },
    { k: "t", x: 0.5, y: top + gap, w: 0.4, h: 0.05, a: "center", c: "mixed", m: 0, n: 2, r: 0, d: 1 },
    { k: "t", x: 0.5, y: top + 2 * gap, w: 0.3, h: 0.03, a: "center", c: "lower", m: 1, n: 0, r: 1, d: 1 },
  ] });
  const a = card(0.35, 0.1), b = card(0.1, 0.4);
  assert.ok(signatureDistance(a, b) > 0.12);
  assert.ok(layoutDistance(a, b) < 0.12);
  assert.deepEqual(shapeOf(a), { order: "PT", centered: 1, logoAbove: 1, mono: 1, lines: 1, footage: 0 });
  const labels = { backdrop: 0, items: [0.1, 0.5, 0.9].flatMap((y) => [0.2, 0.8].map((x) => ({ k: "t", x, y, w: 0.05, h: 0.03, d: 1 }))) };
  assert.equal(shapeOf(labels), null);
});

test("seen_before warns on a layout another project already has", async () => {
  const house = [{ projectId: "old", name: "Old promo", rev: 7, moments: layoutMoments(endCard(10)) }];
  const codes = ["seen_before", "ending_seen"];
  const { findings } = await runQuality(endCard(), { codes, pixels: false, context: { house, videoScene: true } });
  // Held to the end, the card is this video's ending; in another scene (a variant) its tail is not.
  assert.deepEqual(findings.map((finding) => finding.rule), ["ending_seen"]);
  const variant = await runQuality(endCard(), { codes, pixels: false, context: { house, videoScene: false } });
  assert.deepEqual(variant.findings.map((finding) => finding.rule), ["seen_before"]);
  assert.match(findings[0].message, /Old promo/);
  const other = await runQuality(sideTitle(), { codes, pixels: false, context: { house } });
  assert.equal(other.findings.length, 0);
  // A saved reference closer than the old project backs the moment.
  const backed = await runQuality(endCard(), { codes, pixels: false, context: { house, referenceSignatures: [layoutSignature(endCard(), 1.5)] } });
  assert.equal(backed.findings.length, 0);
});

test("type under a cut-out is part of the layout: a 2-row and a 3-row cut-out ending match, the same rows without the cut-out do not", () => {
  const ending = (rows, cut = true) => layoutSignature(modelOf(cutoutEnding(rows, { cut })), 1.5);
  assert.equal(ending(2).items.find((item) => item.r === 0).o, 1);
  assert.equal(ending(2, false).items.find((item) => item.r === 0).o, undefined);
  assert.ok(layoutDistance(ending(2), ending(3)) < SEEN_THRESHOLD);
  assert.ok(layoutDistance(ending(2, false), ending(3, false)) >= SEEN_THRESHOLD);
  assert.ok(layoutDistance(ending(3), ending(3, false)) >= SEEN_THRESHOLD);
});

// The end card shown from `from` to `to` s, `shift` px lower.
const card = (from, shift, to = from + 2) => [["name", "acme", { x: 760, y: 380, fontSize: 150, role: "logo" }], ["tag", "Tools for small teams.", { x: 560, y: 600, fontSize: 56 }], ["url", "acme.dev", { x: 820, y: 700, fontSize: 36 }]]
  .map(([id, value, props]) => text(`${id}${from}`, value, { ...props, y: props.y + shift, ...during(`${id}${from}`, from, to) }));
const codes = ["seen_before", "ending_seen"];

test("ending_seen: a repeated ending keeps its slot past 3 closer mid-video repeats", async () => {
  // Three end cards mid-video (the house has the card: distance 0), then a cut-out ending from 16 s.
  const video = modelOf([...card(1, 0), ...card(5, 60), ...card(9, 120), ...cutoutEnding(2, { from: 16, to: 20 })], 20);
  const house = [{ projectId: "old", name: "Old promo", rev: 7, sigVersion: 2, moments: [...layoutMoments(endCard()), { t: 9, sig: layoutSignature(modelOf(cutoutEnding(3)), 1.5) }] }];
  const { findings } = await runQuality(video, { codes, pixels: false, context: { house, videoScene: true } });
  assert.deepEqual(findings.map((finding) => finding.rule), ["seen_before", "seen_before", "ending_seen"]);
  const ending = findings.at(-1);
  const distance = (finding) => Number(finding.measured.match(/distance ([\d.]+)/)[1]);
  assert.ok(findings.slice(0, 2).every((finding) => distance(finding) < distance(ending)), "the mid-video repeats are closer");
  assert.ok(ending.at >= 16, ending.at);
  assert.match(ending.message, /matches an earlier project's ending \(name under a cut-out subject\)/);
  assert.match(ending.fix.text, /own payoff material/);
});

test("ending_seen: a house file from before signature format 2 (no `o`) still matches a cut-out ending", async () => {
  const video = modelOf([...card(1, 0), ...cutoutEnding(3, { from: 8, to: 10 })], 10);
  const { o, ...name } = layoutSignature(modelOf(cutoutEnding(3)), 1.5).items.find((item) => item.o === 1);
  const old = { ...layoutSignature(modelOf(cutoutEnding(3)), 1.5) };
  old.items = old.items.map((item) => (item.o ? name : item));
  const rules = async (entry) => (await runQuality(video, { codes, pixels: false, context: { house: [entry], videoScene: true } })).findings.map((finding) => finding.rule);
  assert.deepEqual(await rules({ projectId: "old", name: "Old promo", rev: 3, moments: [{ t: 2, sig: old }] }), ["ending_seen"]);
  // Saved in format 2, the same file says that ending had no cut-out: not the same layout.
  assert.deepEqual(await rules({ projectId: "old", name: "Old promo", rev: 3, sigVersion: 2, moments: [{ t: 2, sig: old }] }), []);
});

test("ending_seen: an earlier showing of the ending's layout is not the ending", async () => {
  // The card at 1-3 s (the house's own place), a title, then the card 40 px lower from 8 s to the end.
  const video = modelOf([...card(1, 10), text("title", "Chapter one", { x: 120, y: 120, fontSize: 96, textAlign: "left", ...during("title", 4, 7) }), ...card(8, 50, 10)], 10);
  const house = [{ projectId: "old", name: "Old promo", rev: 7, sigVersion: 2, moments: layoutMoments(endCard(10)) }];
  const { findings } = await runQuality(video, { codes, pixels: false, context: { house, videoScene: true } });
  assert.deepEqual(findings.map((finding) => [finding.rule, finding.at >= 8]), [["seen_before", false], ["ending_seen", true]]);
});

// A cut edit: full-frame clips of `lengths` s one after another, a title, a drop marker at 6 s with
// a white flash on it, and the last clip ending 0.5 s early (the video ends on black).
const markers = [{ name: "song-drop-1", time: 6, kind: "marker" }];
const flashAt = (time) => createLayer("rectangle", { id: "flash", name: "flash", x: 0, y: 0, width: 1920, height: 1080, fill: "#ffffff", ...during("flash", time, time + 0.1) });
function cutEdit(lengths, { shift = 0, title = { x: 700, y: 120, from: 0.5 } } = {}) {
  let at = 0;
  const clips = lengths.map((length, index) => { const from = index ? at + shift : 0; at += length; return clip(`c${index}`, during(`c${index}`, from, index === lengths.length - 1 ? 11.5 : at + shift)); });
  return modelOf([...clips, flashAt(6), text("title", "NIGHT RUN", { x: title.x, y: title.y, fontSize: 96, fill: "#ffffff", ...during("title", title.from, title.from + 1.5) })], 12);
}
// Six 1 s shots, a burst of five 0.2 s shots on the drop, then nine 0.5 s shots.
const builtA = [...Array(6).fill(1), ...Array(5).fill(0.2), ...Array(9).fill(0.5)];
// Steady `length` s shots with a cut on the drop at `drop` s, an optional flash on it and a title at (x, y).
function steady(duration, drop, length, { flash = false, x = 700, y = 120 } = {}) {
  const layers = [];
  for (let at = 0, index = 0; at < duration - 1e-6; index += 1) {
    const next = at < drop && at + length > drop ? drop : Math.min(duration, at + length);
    layers.push(clip(`c${index}`, { mediaSourceDuration: 400, ...during(`c${index}`, at, next) }));
    at = next;
  }
  return modelOf([...layers, ...(flash ? [flashAt(drop)] : []), text("title", "NIGHT RUN", { x, y, fontSize: 96, fill: "#ffffff", ...during("title", 1, 2.5) })], duration);
}

test("seen_before: an edit built like another kino edit warns once; a differently built one does not", async () => {
  const old = structureSignature(cutEdit(builtA), { markers });
  assert.deepEqual(old.burst, { at: 0.5, n: 5 });
  assert.deepEqual(old.drop, { at: 0.5, cut: true, effects: ["flash"], hold: 0.2 });
  // A flash on the drop of a 60 s edit is on the drop (read in seconds, not from rounded shares).
  assert.deepEqual(structureSignature(steady(60, 37, 2, { flash: true }), { markers: [{ name: "song-drop-1", time: 37 }] }).drop.effects, ["flash"]);
  const house = [{ projectId: "old", name: "Night run", rev: 4, moments: [], structVersion: STRUCTURE_VERSION, structure: old }];
  const context = { house, videoScene: true, cues: markers };
  // One frame later on every cut and the title 20 px lower: the same structure.
  const { findings } = await runQuality(cutEdit(builtA, { shift: 1 / 30, title: { x: 700, y: 140, from: 0.5 } }), { codes, pixels: false, context });
  assert.deepEqual(findings.map((finding) => finding.rule), ["seen_before"]);
  assert.match(findings[0].message, /built like "Night run" \(r4\): alike in cut rate per section, first drop, burst place, ending, title place/);
  // Fast first half, slow second half, no burst, the title low and late: not alike.
  const other = cutEdit([...Array(15).fill(0.4), ...Array(4).fill(1.5)], { title: { x: 80, y: 900, from: 4 } });
  assert.deepEqual((await runQuality(other, { codes, pixels: false, context })).findings, []);
  // Not the video's scene, or a house file without a structure: nothing to compare.
  assert.deepEqual((await runQuality(cutEdit(builtA), { codes, pixels: false, context: { ...context, videoScene: false } })).findings, []);
  // Two songs cut steadily with a plain cut on each drop: that follows the song, not a house habit.
  const plainOld = structureSignature(steady(30, 9, 0.5), { markers: [{ name: "song-drop-1", time: 9 }] });
  const plainHouse = [{ ...house[0], structure: plainOld }];
  const plain = steady(40, 22, 0.6, { x: 200, y: 800 });
  // Steady pace, a plain cut on each drop and a plain ending are not compared; only the title is.
  assert.deepEqual(structureAlike(structureSignature(plain, { markers: [{ name: "song-drop-1", time: 22 }] }), plainOld), { compared: ["title"], alike: [] });
  const quiet = await runQuality(plain, { codes, pixels: false, context: { house: plainHouse, videoScene: true, cues: [{ name: "song-drop-1", time: 22 }] } });
  assert.deepEqual(quiet.findings, []);
});
