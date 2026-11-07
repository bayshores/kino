// Opening a document saved before document version 2, whose text letter spacing was pixels.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBundledFonts } from "../backend/fonts.mjs";
import { DOCUMENT_VERSION } from "./schema.js";
import { VERSION_1_FONT_SIZE, migrateDocument, migrateLayers, migrateScene } from "./documentMigration.js";
import { createDocument, createLayer, createScene, parseDocument } from "./model.js";
import { layoutText } from "./textLayout.js";

const fonts = await loadBundledFonts();

// A version 1 text layer laid out the old way: letterSpacing pixels added after each letter.
// The layout now reads percent, so pixels p on font size f are the percent p / f × 100.
function versionOneDocument(layers) {
  const document = createDocument({ scenes: [createScene({ id: "scene", name: "Scene", layers })] });
  const scenes = document.scenes.map(({ backgroundEnabled: _enabled, backgroundAnimations: _animations, ...scene }) => scene);
  return JSON.parse(JSON.stringify({ ...document, version: 1, scenes }));
}

// Every glyph's place in the text box, with its index in its line: [x, y, index].
function glyphPlaces(layer) {
  return layoutText(layer, fonts).lines.flatMap((line) => line.glyphs.map((glyph, index) => [line.x + glyph.x, line.y + glyph.y, index]));
}

test("document version 6 is current and createDocument makes it", () => {
  assert.equal(DOCUMENT_VERSION, 6);
  assert.equal(createDocument().version, DOCUMENT_VERSION);
});

test("version 4 upgrades without changing any scene values or operation timings", () => {
  const previous = { ...createDocument({ scenes: [createScene({ layers: [createLayer("rectangle", {
    animations: [{ id: "fade", name: "Fade", kind: "in", start: 1.25, duration: 0.75, easing: "smooth", from: { opacity: 0 }, to: { opacity: 1 } }],
  })] })] }), version: 4 };
  const snapshot = structuredClone(previous);
  const next = migrateDocument(previous);
  assert.equal(next.version, DOCUMENT_VERSION);
  assert.deepEqual(next.scenes, previous.scenes);
  assert.deepEqual(previous, snapshot);
  assert.deepEqual(parseDocument(next), parseDocument(previous));
});

test("a version 1 text layer and its migrated copy put every glyph in the same place (within 0.001 px)", () => {
  const cases = [
    { fontSize: 48, letterSpacing: 4.8 },
    { fontSize: 36, letterSpacing: -3 },
    { fontSize: 13, letterSpacing: 7.25 },
    { fontSize: 200, letterSpacing: 0.5 },
    { fontSize: 0.5, letterSpacing: 1 },
  ];
  for (const values of cases) {
    const old = createLayer("text", { id: "t", text: "AVATAR office\nWave ffi", width: 600, height: 200, textAlign: "left", textResize: "width-height", ...values });
    const document = parseDocument(versionOneDocument([old]));
    const migrated = document.scenes[0].layers[0];
    assert.equal(document.version, DOCUMENT_VERSION);
    // Version 1 laid letters out with no spacing, then moved each one letterSpacing pixels
    // further than the one before it on its line (these Latin glyphs all advance).
    const before = glyphPlaces({ ...old, letterSpacing: 0 }).map(([x, y, index]) => [x + values.letterSpacing * index, y]);
    const after = glyphPlaces(migrated);
    assert.equal(after.length, before.length);
    for (const [index, [x, y]] of after.entries()) {
      assert.ok(Math.abs(x - before[index][0]) <= 0.001, `font size ${values.fontSize}: glyph ${index} x ${x}, was ${before[index][0]}`);
      assert.ok(Math.abs(y - before[index][1]) <= 0.001, `font size ${values.fontSize}: glyph ${index} y`);
    }
  }
});

test("the migrated spacing adds exactly the old pixels after each letter", () => {
  // 48 px Inter with 9.6 px of spacing: the old file's glyph advances grow by 9.6 px each.
  const plain = createLayer("text", { id: "t", text: "HHHH", fontSize: 48, textResize: "width-height", letterSpacing: 0 });
  const document = parseDocument(versionOneDocument([{ ...plain, letterSpacing: 9.6 }]));
  const spaced = document.scenes[0].layers[0];
  assert.equal(spaced.letterSpacing, 20);
  const base = glyphPlaces({ ...plain, textAlign: "left" });
  const wide = glyphPlaces({ ...spaced, textAlign: "left" });
  for (const [index, [x]] of wide.entries()) assert.ok(Math.abs(x - base[index][0] - 9.6 * index) <= 0.001);
});

test("a version 1 text layer without a font size uses the version 1 default, 48 px", () => {
  const [layer] = migrateLayers([{ id: "t", type: "text", letterSpacing: 12 }], 1);
  assert.equal(VERSION_1_FONT_SIZE, 48);
  assert.equal(layer.letterSpacing, 25);
});

test("scene version 3 migrates transparent colors to Fill off and keeps partial alpha enabled", () => {
  const migrateLegacyScene = (background) => migrateScene({ id: "scene", background }, 2);
  assert.deepEqual(migrateLegacyScene("#ffffff00"), {
    id: "scene", background: "#ffffff", backgroundEnabled: false, backgroundAnimations: [],
  });
  assert.deepEqual(migrateLegacyScene("#abc0"), {
    id: "scene", background: "#abc", backgroundEnabled: false, backgroundAnimations: [],
  });
  assert.deepEqual(migrateLegacyScene("#33669980"), {
    id: "scene", background: "#33669980", backgroundEnabled: true, backgroundAnimations: [],
  });
  assert.deepEqual(migrateLegacyScene("#123456"), {
    id: "scene", background: "#123456", backgroundEnabled: true, backgroundAnimations: [],
  });
  assert.equal(migrateLegacyScene("#00000000").background, "#ffffff");
  assert.equal(migrateLegacyScene("#00000000").backgroundEnabled, false);
});

test("migration from version 2 skips scene-only steps for layers and is safe to repeat", () => {
  const layers = [{ id: "box", type: "rectangle" }];
  assert.equal(migrateLayers(layers, 2), layers);
  const scene = { id: "part", isComponent: true, background: "#abc0", layers };
  const once = migrateScene(scene, 2);
  const twice = migrateScene(once, 2);
  assert.notEqual(once, scene);
  assert.deepEqual(twice, once);
  assert.equal(twice.backgroundEnabled, false);
  assert.equal(twice.background, "#abc");
});

test("only text layers change, and the input is left as it was", () => {
  const input = versionOneDocument([
    createLayer("rectangle", { id: "box", letterSpacing: 7 }),
    createLayer("text", { id: "zero", letterSpacing: 0 }),
    createLayer("text", { id: "spaced", fontSize: 20, letterSpacing: 2 }),
  ]);
  const before = JSON.stringify(input);
  const output = migrateDocument(input);
  assert.equal(JSON.stringify(input), before, "migrateDocument does not change its input");
  const [box, zero, spaced] = output.scenes[0].layers;
  assert.equal(box.letterSpacing, 7);
  assert.equal(zero.letterSpacing, 0);
  assert.equal(spaced.letterSpacing, 10);
  assert.equal(output.version, DOCUMENT_VERSION);
});

test("a current, newer, or damaged document is passed on unchanged for parseDocument to check", () => {
  const current = createDocument();
  assert.equal(migrateDocument(current), current);
  const newer = { ...current, version: DOCUMENT_VERSION + 1 };
  assert.equal(migrateDocument(newer), newer);
  assert.throws(() => parseDocument(newer), new RegExp(`version.*must be ${DOCUMENT_VERSION}`));
  for (const value of [null, "text", [], { version: "1" }, { version: 0 }]) assert.equal(migrateDocument(value), value);
  // Version 1 with a damaged scene list: migration keeps it, and parseDocument says what is wrong.
  assert.throws(() => parseDocument({ ...current, version: 1, scenes: "none" }), /scenes/);
  // A letter spacing that isn't a number is left for the validator to refuse.
  assert.throws(() => parseDocument(versionOneDocument([{ ...createLayer("text", { id: "t" }), letterSpacing: "wide" }])), /letterSpacing/);
});

test("migrating twice changes nothing more: a migrated document is current", () => {
  const once = parseDocument(versionOneDocument([createLayer("text", { id: "t", fontSize: 40, letterSpacing: 4 })]));
  const twice = parseDocument(once);
  assert.equal(twice.scenes[0].layers[0].letterSpacing, 10);
  assert.deepEqual(twice, once);
});

test("version 1 to 3 migrates letter spacing and backgrounds in scenes and components", () => {
  const main = createScene({ id: "main", name: "Main", background: "#11111100", isComponent: false, layers: [createLayer("text", { id: "inner", fontSize: 10, letterSpacing: 1 })] });
  const scene = createScene({ id: "scene", name: "Scene", background: "#22222280", isComponent: true, layers: [createLayer("text", { id: "outer", fontSize: 50, letterSpacing: 5 })] });
  const original = createDocument({ scenes: [scene, main] });
  const oldScenes = original.scenes.map(({ backgroundEnabled: _enabled, backgroundAnimations: _animations, ...item }) => item);
  const document = parseDocument(JSON.parse(JSON.stringify({ ...original, version: 1, scenes: oldScenes })));
  assert.equal(document.scenes[0].layers[0].letterSpacing, 10);
  assert.equal(document.scenes[1].layers[0].letterSpacing, 10);
  assert.deepEqual(document.scenes.map(({ background, backgroundEnabled }) => [background, backgroundEnabled]), [
    ["#22222280", true],
    ["#111111", false],
  ]);
  assert.deepEqual(document.scenes.map((item) => item.backgroundAnimations), [[], []]);
});
