import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createLayer, createScene } from "./model.js";
import { loadRtlTestFonts } from "../tests/rtl-fonts.mjs";
import { viewerFontEntries } from "./viewerFonts.js";

const fonts = await loadRtlTestFonts();
const documentWithLayers = (layers) => createDocument({ scenes: [createScene({ id: "main", layers })] });
const byFace = (entries, family, weight, style) => entries.find((entry) =>
  entry.family === family && entry.weight === weight && entry.style === style);

test("viewer font metadata includes only the used face in stable registry order", () => {
  const layer = createLayer("text", {
    id: "label", text: "Plain text", fontFamily: "Inter", fontWeight: 400, fontStyle: "normal",
  });
  const entries = viewerFontEntries(documentWithLayers([layer]), fonts);
  const expected = fonts.renderingFace(layer);

  assert.deepEqual(entries, fonts.entries().filter((entry) => entry.id === expected.id));
  assert.ok(entries.every((entry) => !Object.hasOwn(entry, "font") && !Object.hasOwn(entry, "ranges")));
});

test("mixed rich-text ranges contribute each effective family, weight, and style", () => {
  const layer = createLayer("text", {
    id: "label", text: "ABCD", fontFamily: "Inter", fontWeight: 400, fontStyle: "normal",
    textStyleRanges: [{ start: 1, end: 3, style: { fontFamily: "Montserrat", fontWeight: 700, fontStyle: "italic" } }],
  });
  const entries = viewerFontEntries(documentWithLayers([layer]), fonts);

  assert.ok(byFace(entries, "Inter", 400, "normal"));
  assert.ok(byFace(entries, "Montserrat", 700, "italic"));
  assert.equal(entries.length, 2);
});

test("script fallback and enabled text variants include only their needed faces", () => {
  const layer = createLayer("text", {
    id: "animated", text: "A", fontFamily: "Inter", animations: [
      { id: "enabled-change", kind: "change-text", enabled: true, text: "مرحبا" },
      { id: "disabled-change", kind: "change-text", enabled: false, text: "שָׁלוֹם" },
      { id: "counter", kind: "counter", enabled: true },
    ],
  });
  const entries = viewerFontEntries(documentWithLayers([layer]), fonts);

  assert.ok(byFace(entries, "Inter", 400, "normal"), "the base face covers ordinary and counter text");
  assert.ok(byFace(entries, "Noto Sans Arabic", 400, "normal"), "enabled Arabic text resolves to its actual fallback face");
  assert.ok(!entries.some((entry) => entry.family === "Noto Sans Hebrew"), "the disabled Hebrew change-text adds no face");
});

test("effective component text overrides and mirrored RTL references are covered", () => {
  const source = createScene({
    id: "component", isComponent: true,
    layers: [createLayer("text", { id: "title", text: "Source", fontFamily: "Inter" })],
  });
  const rtl = createLayer("text", {
    id: "rtl", text: "אב (", fontFamily: "Inter",
    textStyleRanges: [{ start: 3, end: 4, style: { fontWeight: 700 } }],
  });
  const page = createScene({ id: "page", layers: [
    rtl,
    createLayer("component", {
      id: "instance", componentSceneId: "component",
      componentOverrides: { title: { text: "שָׁלוֹם", fontFamily: "Noto Sans Hebrew", fontWeight: 400, fontStyle: "normal" } },
    }),
  ] });
  const registry = Object.assign(Object.create(Object.getPrototypeOf(fonts)), fonts);
  const seen = [];
  const textRuns = fonts.textRuns;
  registry.textRuns = function (text, style) {
    seen.push(text);
    return textRuns.call(this, text, style);
  };
  const entries = viewerFontEntries(createDocument({ scenes: [source, page] }), registry);

  assert.ok(byFace(entries, "Noto Sans Hebrew", 400, "normal"), "the effective component override is covered");
  assert.ok(byFace(entries, "Inter", 700, "normal"), "the rich RTL range's selected weight is covered");
  assert.ok(seen.includes("(") && seen.includes(")"), "mirrored bracket text is resolved as well as source text");
});

test("no text yields no viewer font metadata", () => {
  assert.deepEqual(viewerFontEntries(documentWithLayers([
    createLayer("rectangle", { id: "shape" }),
  ]), fonts), []);
});

test("an unavailable referenced family still includes its real rendering fallback", () => {
  const layer = createLayer("text", {
    id: "label", text: "Fallback", fontFamily: "Unavailable Family", fontWeight: 700,
  });
  const entries = viewerFontEntries(documentWithLayers([layer]), fonts);
  const renderingFace = fonts.renderingFace(layer);

  assert.ok(renderingFace.missingReference);
  assert.deepEqual(entries, fonts.entries().filter((entry) => entry.id === renderingFace.id));
  assert.equal(entries[0]?.family, "Inter");
});
