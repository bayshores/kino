import assert from "node:assert/strict";
import test from "node:test";
import { createLayer } from "../engine/model.js";
import { loadBundledFonts } from "./fonts.mjs";
import { prepareFontPatches, ensureDocumentFonts } from "./font-selection.mjs";

test("exact loaded font choices require no network", async () => {
  const fonts = await loadBundledFonts();
  const catalog = { list: () => { throw new Error("network should not be used"); }, loadInto: async () => {} };
  const layer = createLayer("text", { id: "one", fontFamily: "Inter", fontWeight: 400, text: "Café" });
  const patches = await prepareFontPatches([layer], { family: "Inter", weight: 700 }, { fonts, catalog });
  assert.equal(patches[0].fontWeight, 700);
  assert.match(patches[0].fontSource, /Inter-700/);
});

test("font preparation resolves sparse faces, keeps pinned versions and never changes source layers", async () => {
  const fonts = await loadBundledFonts(), requests = [];
  const metadata = { id: "qa-font", family: "QA Font", version: "5.2.8", variants: { 400: { normal: ["latin"] }, 700: { italic: ["latin"] } } };
  const catalog = {
    list: async () => ({ families: [{ id: "qa-font", family: "QA Font" }] }),
    detail: async (id, options) => { requests.push({ id, options }); return metadata; },
    ensureFace: async (input) => { requests.push(input); return { family: "QA Font", src: `/api/fonts/fs-qa-font--${input.version}--${input.weight}-${input.style}.ttf` }; },
    loadInto: async () => {},
  };
  const layer = createLayer("text", { id: "one", text: "Café", fontWeight: 700, fontStyle: "normal" });
  const original = structuredClone(layer);
  const patches = await prepareFontPatches([layer], { family: "QA Font" }, { fonts, catalog });
  assert.equal(patches[0].fontWeight, 400);
  assert.equal(patches[0].fontStyle, "normal");
  assert.deepEqual(layer, original);
  requests.length = 0;
  await prepareFontPatches([{ ...layer, ...patches[0] }], { family: "QA Font", weight: 700, style: "italic" }, { fonts, catalog });
  assert.deepEqual(requests[0], { id: "qa-font", options: { version: "5.2.8" } });
  assert.equal(requests[1].version, "5.2.8");
  assert.equal(requests[1].style, "italic");
  // A weight the family lacks becomes its nearest, named in a note instead of refusing the edit.
  const notes = [];
  const [nearest] = await prepareFontPatches([layer], { family: "QA Font", weight: 300 }, { fonts, catalog, notes });
  assert.equal(nearest.fontWeight, 400);
  assert.deepEqual(notes, ["QA Font has no weight 300: set 400, its nearest"]);
});

test("a failed font download is refused without changing layers", async () => {
  const targets = [createLayer("text", { id: "one", text: "Test", fontFamily: "Inter", fontWeight: 400, fontStyle: "normal" })];
  const before = JSON.stringify(targets);
  const fonts = await loadBundledFonts();
  await assert.rejects(prepareFontPatches(targets, { family: "Unavailable" }, { fonts, catalog: {
    list: async () => ({ families: [{ family: "Unavailable", id: "unavailable" }] }),
    detail: async () => { throw new Error("Offline"); },
  } }), /Offline/);
  assert.equal(JSON.stringify(targets), before);
});

test("document recovery requests only pinned catalog faces and includes changing text characters", async () => {
  const requests = [];
  await ensureDocumentFonts({ scenes: [{ layers: [
    createLayer("text", { text: "Café", fontSource: "/api/fonts/fs-inter--5.2.8--400-normal.ttf", animations: [{ id: "changed", kind: "change-text", start: 1, text: "Ж" }] }),
    createLayer("text", { fontSource: "/api/media/00000000-0000-0000-0000-000000000000.ttf" }),
  ] }] }, { ensureFace: async (request) => requests.push(request) });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].version, "5.2.8");
  assert.ok(requests[0].text.includes("Ж"));
});
