// House memory (house-memory.mjs): a copy is one family with its project and is never read back
// for it; other projects are.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHouseMemory, familyOf, houseType } from "./house-memory.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { createDocument, createLayer, createScene, parseDocument } from "../engine/model.js";
import { runQuality } from "../engine/quality/index.js";
import { kinoTimeline } from "../engine/quality/kinoTimeline.js";
import { SIGNATURE_VERSION } from "../engine/quality/layoutSignature.js";
import { STRUCTURE_VERSION } from "../engine/quality/structureSignature.js";

test("familyOf drops copies and a trailing number", () => {
  assert.equal(familyOf("Promo [copy] [copy]"), "promo");
  assert.equal(familyOf("Promo v2"), "promo");
  assert.equal(familyOf("promo-3"), "promo");
  assert.equal(familyOf("Year 2026 recap"), "year 2026 recap");
  assert.equal(familyOf("42"), "42");
});

test("others leaves out the project and its copies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-house-"));
  try {
    const house = createHouseMemory(directory);
    const moments = [{ scene: "s", t: 1, sig: { backdrop: 0, items: [] } }];
    await house.record({ projectId: "a", name: "Promo", rev: 3, moments });
    await house.record({ projectId: "b", name: "Promo [copy]", rev: 1, moments });
    const structure = { sections: [{ kind: "start", from: 0, rate: 1 }] };
    await house.record({ projectId: "c", name: "Recap", rev: 9, moments, structure });
    const seen = await house.others("a", "Promo");
    assert.deepEqual(seen.map((entry) => entry.projectId), ["c"]);
    // The signature format is saved, so seen_before knows an older file has no `o`.
    assert.equal(seen[0].sigVersion, SIGNATURE_VERSION);
    // The video's structure is saved with its format (a render with too few shots saves none).
    assert.deepEqual([seen[0].structVersion, seen[0].structure], [STRUCTURE_VERSION, structure]);
    assert.equal("structure" in (await house.others("c", "Recap"))[0], false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A one-scene project whose title is set in the given weight, text, size, and way of coming in.
function titled(name, { fontWeight, value, fontSize, from }) {
  const title = createLayer("text", { id: "title", name: "title", text: value, fontFamily: "Inter", fontWeight, fontSize, fill: "#111111", textResize: "width-height", textAlign: "center", x: 300, y: 400,
    animations: [{ id: "in", name: "in", kind: "in", start: 0.2, duration: 0.5, easing: "smooth", from, to: Object.fromEntries(Object.keys(from).map((key) => [key, key === "opacity" ? 1 : 0])) }] });
  return parseDocument(createDocument({ name, scenes: [createScene({ id: "scene", name: "Scene", width: 1920, height: 1080, duration: 3, background: "#f5f2ea", layers: [title] })] }));
}

test("type_seen: a second project with the first one's type look warns, another look does not", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kino-house-type-"));
  const fonts = await loadBundledFonts();
  try {
    const house = createHouseMemory(directory);
    const first = titled("Launch", { fontWeight: 700, value: "NEW FROM ACME", fontSize: 140, from: { opacity: 0, blur: 20 } });
    await house.record({ projectId: "a", name: "Launch", rev: 1, moments: [], type: houseType(first, first.scenes[0], { fonts }) });
    assert.deepEqual((await house.others("b", "Recap"))[0].type, { family: "inter", weight: "bold", case: "caps", size: "title", reveal: "blur" });
    const check = async (document) => {
      const model = kinoTimeline(document, "scene", { fonts });
      return (await runQuality(model, { codes: ["type_seen"], pixels: false, context: { house: await house.others("b", document.name), videoScene: true, sceneName: "s1" } })).findings;
    };
    // The same face, weight, case, size and blur-in again: the look of the last project.
    const same = await check(titled("Recap", { fontWeight: 700, value: "WHAT WE SHIPPED", fontSize: 140, from: { opacity: 0, blur: 20 } }));
    assert.deepEqual(same.map((finding) => finding.rule), ["type_seen"]);
    assert.match(same[0].message, /"Launch"/);
    // The picked treatment's type direction chose that look: quiet.
    const chosen = kinoTimeline(titled("Recap", { fontWeight: 700, value: "WHAT WE SHIPPED", fontSize: 140, from: { opacity: 0, blur: 20 } }), "scene", { fonts });
    const quiet = await runQuality(chosen, { codes: ["type_seen"], pixels: false, context: { house: await house.others("b", "Recap"), videoScene: true, style: { type: "heavy caps, big, blur in" } } });
    assert.deepEqual(quiet.findings, []);
    // A light lower-case line, smaller, that rises: only the face is shared.
    assert.deepEqual(await check(titled("Notes", { fontWeight: 300, value: "what we shipped", fontSize: 60, from: { opacity: 0, y: 40 } })), []);
    // A copy of the first project is its family, never compared.
    assert.deepEqual(await house.others("b", "Launch v2"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
