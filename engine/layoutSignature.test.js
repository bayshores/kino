// Layout signatures (engine/quality/layoutSignature.js) and the seen_before check on small
// made-up scenes: an end card made twice in two projects is seen before; a different layout is not.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { runQuality } from "./quality/index.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { caseOf, layoutDistance, layoutMoments, layoutSignature, shapeOf, signatureDistance } from "./quality/layoutSignature.js";

const text = (id, value, props = {}) => createLayer("text", { id, name: id, text: value, fontFamily: "Inter", fontSize: 64, fill: "#111111", textResize: "width-height", textAlign: "center", ...props });

function modelOf(layers) {
  const document = parseDocument(createDocument({ scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 3, background: "#f5f2ea", layers })] }));
  return kinoTimeline(document, "scene", { fonts: defaultFonts });
}

// A centered end card: a name, a tagline under it and a small address under that.
const endCard = (shift = 0) => modelOf([
  text("name", "acme", { x: 760, y: 380 + shift, fontSize: 150, role: "logo" }),
  text("tag", "Tools for small teams.", { x: 560, y: 600 + shift, fontSize: 56 }),
  text("url", "acme.dev", { x: 820, y: 700 + shift, fontSize: 36 }),
]);
const sideTitle = () => modelOf([text("title", "Chapter one", { x: 120, y: 120, fontSize: 96, textAlign: "left" })]);

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
  const { findings } = await runQuality(endCard(), { codes: ["seen_before"], pixels: false, context: { house } });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /Old promo/);
  const other = await runQuality(sideTitle(), { codes: ["seen_before"], pixels: false, context: { house } });
  assert.equal(other.findings.length, 0);
  // A saved reference closer than the old project backs the moment.
  const backed = await runQuality(endCard(), { codes: ["seen_before"], pixels: false, context: { house, referenceSignatures: [layoutSignature(endCard(), 1.5)] } });
  assert.equal(backed.findings.length, 0);
});
