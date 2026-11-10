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
  const { findings } = await runQuality(endCard(), { codes, pixels: false, context: { house } });
  // Held to the end, the card is this video's ending.
  assert.deepEqual(findings.map((finding) => finding.rule), ["ending_seen"]);
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

test("ending_seen: a repeated ending keeps its slot past 3 closer mid-video repeats", async () => {
  const card = (from, shift) => [["name", "acme", { x: 760, y: 380, fontSize: 150, role: "logo" }], ["tag", "Tools for small teams.", { x: 560, y: 600, fontSize: 56 }], ["url", "acme.dev", { x: 820, y: 700, fontSize: 36 }]]
    .map(([id, value, props]) => text(`${id}${from}`, value, { ...props, y: props.y + shift, ...during(`${id}${from}`, from, from + 2) }));
  // Three end cards mid-video (the house has the card: distance 0), then a cut-out ending from 16 s.
  const video = modelOf([...card(1, 0), ...card(5, 60), ...card(9, 120), ...cutoutEnding(2, { from: 16, to: 20 })], 20);
  const house = [{ projectId: "old", name: "Old promo", rev: 7, moments: [...layoutMoments(endCard()), { t: 9, sig: layoutSignature(modelOf(cutoutEnding(3)), 1.5) }] }];
  const { findings } = await runQuality(video, { codes: ["seen_before", "ending_seen"], pixels: false, context: { house } });
  assert.deepEqual(findings.map((finding) => finding.rule), ["seen_before", "seen_before", "ending_seen"]);
  const ending = findings.at(-1);
  const distance = (finding) => Number(finding.measured.match(/distance ([\d.]+)/)[1]);
  assert.ok(findings.slice(0, 2).every((finding) => distance(finding) < distance(ending)), "the mid-video repeats are closer");
  assert.ok(ending.at >= 16, ending.at);
  assert.match(ending.message, /matches an earlier project's ending \(name under a cut-out subject\)/);
  assert.match(ending.fix.text, /own payoff material/);
});
