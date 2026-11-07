// Layout signatures (engine/quality/layoutSignature.js) and the seen_before check on small
// made-up scenes: an end card made twice in two projects is seen before; a different layout is not.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultFonts } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { runQuality } from "./quality/index.js";
import { kinoTimeline } from "./quality/kinoTimeline.js";
import { caseOf, layoutMoments, layoutSignature, signatureDistance } from "./quality/layoutSignature.js";

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
