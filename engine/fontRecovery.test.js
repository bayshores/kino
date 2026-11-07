import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { FontRegistry } from "./fonts.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { createComponentInstance, expandComponents } from "./linkedComponents.js";
import { documentFontSites, missingDocumentFonts } from "./fontRecovery.js";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { prepareFontPatches } from "../backend/font-selection.mjs";
import { exportScene } from "../backend/export.mjs";
import { renderSceneSvg } from "./render.js";

const fonts = await loadBundledFonts();
const offline = { list: async () => ({ families: [] }), loadInto: async () => {} };
const lostSource = "/api/media/00000000-0000-4000-8000-000000000099.ttf";
function fixture() {
  const source = createScene({ id: "source", name: "Main", isComponent: true, layers: [createLayer("text", {
    id: "label", name: "Label", fontFamily: "Lost Brand", fontSource: lostSource,
    x: 50, y: 20, width: 300, height: 60, text: "A headline", textResize: "width-height", textAlign: "center",
  })] });
  const page = createScene({ id: "page", name: "Page", layers: [
    createLayer("text", { id: "other", text: "Other", fontFamily: "Lost Brand", fontWeight: 700 }),
    createComponentInstance(source, { id: "inherited", componentOverrides: { label: { text: "Inherited copy" } } }),
    createComponentInstance(source, { id: "overridden", componentOverrides: { label: {
      fontFamily: "Other Missing", fontSource: "", fontWeight: 700,
    } } }),
  ] });
  return parseDocument(createDocument({ id: "fonts", scenes: [page, source] }));
}

test("legacy filename aliases and explicit duplicate sources resolve without rewriting the reference", async () => {
  const bytes = await readFile(new URL("../assets/fonts/Inter-400.ttf", import.meta.url));
  const registry = new FontRegistry();
  const first = registry.register(bytes, { id: "one", filename: "Brand Regular.ttf", src: "/api/media/one.ttf" });
  registry.register(bytes, { id: "two", filename: "Another Name.ttf", src: "/api/media/two.ttf" });
  assert.equal(first.family, "Inter");
  assert.deepEqual(first.aliases, ["Brand Regular"]);
  assert.equal(registry.resolve({ fontFamily: "Brand Regular" }).id, "one");
  const legacy = { fontFamily: "Old filename", fontSource: "/api/media/two.ttf" };
  assert.equal(registry.resolve(legacy).id, "two");
  assert.equal(legacy.fontFamily, "Old filename");
  assert.equal(registry.entries().filter((face) => face.family === "Inter").length, 2);
});

test("missing-font reports include each stored scene and effective component override", async () => {
  const document = fixture(), before = JSON.stringify(document);
  const sites = documentFontSites(document);
  assert.equal(sites.length, 4);
  const missing = missingDocumentFonts(document, fonts);
  assert.equal(missing.reduce((sum, item) => sum + item.layerCount, 0), 4);
  assert.equal(missing.find((item) => item.fontFamily === "Other Missing").locations[0].componentPath, "label");
  assert.ok(missing.every((item) => item.fallbackFamily === "Inter"));
  assert.match(renderSceneSvg(expandComponents(document, "page", { fonts }), 0, { fonts }), /<path/);
  await assert.rejects(prepareFontPatches([document.scenes[0].layers[0]], { family: "Inter", source: "/api/media/foreign.ttf" }, { fonts, catalog: offline }), /unavailable in this project/);
  assert.equal(JSON.stringify(document), before);
});

test("PNG and Lottie draw a real fallback and report the missing font without modifying the scene", async () => {
  const scene = fixture().scenes[1], before = JSON.stringify(scene);
  for (const format of ["png", "lottie"]) {
    const result = await exportScene(scene, { format }, { fonts });
    assert.ok(result.buffer.length > 100);
    assert.equal(result.warnings.filter((warning) => warning.code === "missing-font-fallback").length, 1);
    assert.match(result.warnings[0].message, /Lost Brand.*Inter/);
  }
  assert.equal(JSON.stringify(scene), before);
});

test("many missing Unicode families produce one bounded export warning", async () => {
  const scene = createScene({ width: 200, height: 100, layers: Array.from({ length: 20 }, (_, index) =>
    createLayer("text", { id: `text-${index}`, text: "Test", fontFamily: `未安装 ${index} ${"A".repeat(150)}` })) });
  const result = await exportScene(scene, { format: "png" }, { fonts });
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "missing-font-fallback");
  assert.ok(result.warnings[0].message.length < 1600);
  assert.match(result.warnings[0].message, /12 additional font references/);
});
