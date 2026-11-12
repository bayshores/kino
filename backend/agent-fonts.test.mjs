// Text whose font lacks a character (such as "∞") and the fonts library. Before this, set_font
// refused "∞" without naming a font that has it, check only said "choose another font", and
// library {topic:"fonts"} ignored `query` and stopped after 15 families with no count.
// Every font here is synthesized from the bundled Inter face (tests/color-font.mjs) and a fake
// fetch answers the catalog requests, so nothing is downloaded.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { layerGlyphProblems } from "../engine/fontGlyphReferences.js";
import { createLayer } from "../engine/model.js";
import { createCmapFontFixture } from "../tests/color-font.mjs";
import { fontsLibraryText, fontsWithCharacters, missingCharactersHelp, missingGlyphsHelp } from "./agent/font-help.mjs";
import { createFontCatalog } from "./font-catalog.mjs";
import { loadBundledFonts } from "./fonts.mjs";
import { startTestServer } from "./media.test.support.mjs";

const VERSION = "1.0.0";
const LATIN = "U+0000-00FF";
const MATH = "U+2200-22FF";
// Each family's subsets: [Unicode range the catalog lists, characters its file really draws].
// `category` is the catalog's, as Fontsource gives it.
const FAMILIES = {
  // A sans with ∞ that kino never looks for in the catalog: it is offered only once installed.
  afacad: { family: "Afacad", category: "sans-serif", subsets: { latin: [LATIN, {}], math: [MATH, { "∞": "8" }] } },
  anton: { family: "Anton", category: "sans-serif", subsets: { latin: [LATIN, {}] } },
  // A serif that has ∞: font help offers it after the sans fonts for a sans such as Anton.
  lora: { family: "Lora", category: "serif", subsets: { latin: [LATIN, {}], math: [MATH, { "∞": "8" }] } },
  // Lists ∞ in its range but its file has no ∞, like the real Noto Sans Symbols 2.
  "noto-sans-symbols-2": { family: "Noto Sans Symbols 2", category: "sans-serif", subsets: { symbols: [MATH, {}] } },
  // A serif without ∞: font help offers Lora before Roboto for it.
  "playfair-display": { family: "Playfair Display", category: "serif", subsets: { latin: [LATIN, {}] } },
  roboto: { family: "Roboto", category: "sans-serif", subsets: { latin: [LATIN, {}], math: [MATH, { "∞": "8" }] } },
};
// Catalog-only families, so the list is longer than the 15 the library shows.
const FILLERS = Array.from({ length: 16 }, (_, index) => `Filler ${String(index + 1).padStart(2, "0")}`);
const source = (id) => `/api/fonts/fs-${id}--${VERSION}--400-normal.ttf`;

const listRecord = (id, family, subsets, category) => ({ id, family, type: "google", subsets, weights: [400], styles: ["normal"], defSubset: subsets[0], license: "OFL-1.1", ...(category ? { category } : {}) });
const catalogList = [
  ...Object.entries(FAMILIES).map(([id, entry]) => listRecord(id, entry.family, Object.keys(entry.subsets), entry.category)),
  ...FILLERS.map((family) => listRecord(family.toLowerCase().replace(" ", "-"), family, ["latin"])),
];

let fontBytes;
before(async () => {
  fontBytes = new Map();
  for (const [id, entry] of Object.entries(FAMILIES))
    for (const [subset, [, borrowed]] of Object.entries(entry.subsets))
      fontBytes.set(`${id}/${subset}`, await createCmapFontFixture(borrowed));
});

function response(body, url, { status = 200, type = "application/json" } = {}) {
  const result = new Response(body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

// Answers the catalog list, family details and subset files; records every URL in `calls`.
function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (url === "https://api.fontsource.org/v1/fonts?type=google") return response(catalogList, url);
    const detail = /^https:\/\/api\.fontsource\.org\/v1\/fonts\/([a-z0-9-]+)$/.exec(url);
    if (detail) {
      const entry = FAMILIES[detail[1]];
      if (!entry) return response({ error: "not found" }, url, { status: 404 });
      const subsets = Object.keys(entry.subsets);
      return response({
        ...listRecord(detail[1], entry.family, subsets, entry.category), npmVersion: VERSION,
        unicodeRange: Object.fromEntries(subsets.map((subset) => [subset, entry.subsets[subset][0]])),
        variants: { 400: { normal: Object.fromEntries(subsets.map((subset) => [subset, { url: { ttf: "/fixture-only.ttf" } }])) } },
      }, url);
    }
    const face = /^https:\/\/cdn\.jsdelivr\.net\/fontsource\/fonts\/([a-z0-9-]+)@1\.0\.0\/([a-z0-9-]+)-400-normal\.ttf$/.exec(url);
    if (face && fontBytes.has(`${face[1]}/${face[2]}`)) return response(fontBytes.get(`${face[1]}/${face[2]}`), url, { type: "font/ttf" });
    throw new Error(`Unexpected font request: ${url}`);
  };
}

async function freshCatalog(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "kino-agent-fonts-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const calls = [];
  const catalog = await createFontCatalog({ dataRoot, fetchImpl: fakeFetch(calls), enabled: true });
  return { catalog, calls, dataRoot, fonts: await loadBundledFonts() };
}

const textLayer = (id, text, font = {}) => createLayer("text", { id, name: id, text, fontFamily: "Inter", fontSource: "", fontWeight: 400, fontStyle: "normal", fontSize: 48, ...font });
const glyphs = (layer, fonts) => layerGlyphProblems(layer, fonts).map((problem) => problem.text);

test("fonts with a character are checked glyph by glyph: a catalog range that lists ∞ is not enough", async (t) => {
  const { catalog, calls, fonts } = await freshCatalog(t);
  const result = await fontsWithCharacters(["∞"], { fonts, catalog });

  assert.deepEqual(result.fonts, [{ family: "Roboto", weight: 400, style: "normal", fontSource: source("roboto") },
    { family: "Lora", weight: 400, style: "normal", fontSource: source("lora") }]);
  assert.ok(calls.includes(`https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-symbols-2@${VERSION}/symbols-400-normal.ttf`),
    "Noto Sans Symbols 2 lists ∞, so its file is downloaded and looked at, then left out");
  assert.equal(calls.some((url) => url.includes("anton@")), false, "Anton does not list ∞, so it is not downloaded");
});

test("set_font help: an update_layer op keeps the chosen font and draws only ∞ in a font that has it", async (t) => {
  const { catalog, fonts } = await freshCatalog(t);
  await catalog.ensureFace({ id: "anton", weight: 400, style: "normal", text: "GLOW +" });
  await catalog.loadInto(fonts);
  const layer = textLayer("title", "GLOW +∞");
  const choice = { family: "Anton", weight: 400, style: "normal", fontSource: source("anton") };
  assert.deepEqual(glyphs({ ...layer, fontFamily: "Anton", fontSource: source("anton") }, fonts), ["∞"], "Anton alone draws ∞ as a box");

  const help = await missingCharactersHelp([{ layer, layerRef: "title", characters: ["∞"], choice }], { fonts, catalog, opNumber: 0 });
  assert.equal(help.message.split(". \"instead\"")[0], `Anton does not include "∞". Fonts with it (glyphs checked): Roboto 400 (fontSource ${source("roboto")}), Lora 400 (fontSource ${source("lora")})`);
  assert.match(help.message, /edit \{retry, fix:\{"0": instead\}\}/);
  assert.doesNotMatch(help.message, /Noto Sans Symbols 2/);
  assert.deepEqual(help.instead, [{ op: "update_layer", layerId: "title", properties: {
    fontFamily: "Anton", fontWeight: 400, fontStyle: "normal", fontSource: source("anton"),
    textStyleRanges: [{ start: 6, end: 7, style: { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") } }],
  } }]);
  assert.deepEqual(glyphs({ ...layer, ...help.instead[0].properties }, fonts), [], "with the op every character has a glyph");
});

// Once Lora was downloaded, Anton's refusal offered Lora (a serif) first, because
// installed fonts came in alphabetical order. A stand-in is now of the same kind as the font.
test("set_font and check help offer a font of the same kind first: a sans for Anton, a serif for Playfair Display", async (t) => {
  const { catalog, fonts } = await freshCatalog(t);
  await catalog.ensureFace({ id: "anton", weight: 400, style: "normal", text: "GLOW +" });
  await catalog.ensureFace({ id: "lora", weight: 400, style: "normal", text: "A∞" });
  await catalog.loadInto(fonts);
  const layer = textLayer("title", "GLOW +∞");
  const anton = { family: "Anton", weight: 400, style: "normal", fontSource: source("anton") };
  for (const attempt of [1, 2]) {
    const help = await missingCharactersHelp([{ layer, layerRef: "title", characters: ["∞"], choice: anton }], { fonts, catalog, opNumber: 0 });
    assert.match(help.message, /Fonts with it \(glyphs checked\): Roboto 400 \(fontSource [^)]+\), Lora 400 /, `attempt ${attempt}`);
    assert.equal(help.instead[0].properties.textStyleRanges[0].style.fontFamily, "Roboto", `attempt ${attempt}`);
  }
  const check = await missingGlyphsHelp({ layer: { ...layer, fontFamily: "Anton", fontSource: source("anton") }, layerRef: "title", characters: ["∞"], fonts, catalog });
  assert.match(check.message, /^Roboto 400 \(fontSource [^)]+\), Lora 400 \(fontSource [^)]+\) have them/);
  assert.equal(check.fix.properties.textStyleRanges[0].style.fontFamily, "Roboto");

  // Another sans installed (Afacad comes before Roboto alphabetically) does not change the first
  // choice: fonts of the same kind keep the order kino tries catalog families in.
  await catalog.ensureFace({ id: "afacad", weight: 400, style: "normal", text: "A∞" });
  await catalog.loadInto(fonts);
  const more = await missingCharactersHelp([{ layer, layerRef: "title", characters: ["∞"], choice: anton }], { fonts, catalog, opNumber: 0 });
  assert.match(more.message, /Fonts with it \(glyphs checked\): Roboto 400 \(fontSource [^)]+\), Afacad 400 \(fontSource [^)]+\), Lora 400 /);

  // A serif gets the serif first, though Roboto is installed too now.
  const serif = await missingCharactersHelp([{ layer, layerRef: "title", characters: ["∞"],
    choice: { family: "Playfair Display", weight: 400, style: "normal", fontSource: source("playfair-display") } }], { fonts, catalog, opNumber: 0 });
  assert.match(serif.message, /Fonts with it \(glyphs checked\): Lora 400 \(fontSource [^)]+\), Roboto 400 /);
  assert.equal(serif.instead[0].properties.textStyleRanges[0].style.fontFamily, "Lora");
});

test("check help: the missing_glyphs fix gives each ∞ (and only ∞) a range in a font that has it", async (t) => {
  const { catalog, fonts } = await freshCatalog(t);
  const layer = textLayer("line", "to ∞ and ∞!");
  assert.deepEqual(glyphs(layer, fonts), ["∞"]);

  const help = await missingGlyphsHelp({ layer, layerRef: "line", characters: ["∞"], fonts, catalog });
  assert.equal(help.message, `Roboto 400 (fontSource ${source("roboto")}), Lora 400 (fontSource ${source("lora")}) have them (glyphs checked); the fix draws only those characters in Roboto 400.`);
  const style = { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") };
  assert.deepEqual(help.fix, { op: "update_layer", layerId: "line", properties: { textStyleRanges: [{ start: 3, end: 4, style }, { start: 9, end: 10, style }] } });
  assert.deepEqual(glyphs({ ...layer, ...help.fix.properties }, fonts), []);
});

test("a character no font has says so and suggests importing a font or changing the text", async (t) => {
  const { catalog, fonts } = await freshCatalog(t);
  const help = await missingGlyphsHelp({ layer: textLayer("rune", "ᚠ"), layerRef: "rune", characters: ["ᚠ"], fonts, catalog });
  assert.equal(help.message, "");
  assert.match(help.fix, /^No installed font and no catalog font kino looked at has "ᚠ"\. Change the text, or project import a font file that has it\.$/);
});

test("∞ shown only by a Change text animation gets fonts named but no range, since a range cannot hold it", async (t) => {
  const { catalog, fonts } = await freshCatalog(t);
  const layer = textLayer("count", "Soon", { animations: [{ id: "swap", name: "Change text", kind: "change-text", start: 1, text: "∞", overlap: false, out: null, in: null }] });
  assert.deepEqual(glyphs(layer, fonts), ["∞"]);
  const help = await missingGlyphsHelp({ layer, layerRef: "count", characters: ["∞"], fonts, catalog });
  assert.equal(help.message, `Roboto 400 (fontSource ${source("roboto")}), Lora 400 (fontSource ${source("lora")}) have them (glyphs checked).`);
  assert.match(help.fix, /^They come from an animation's text \(Change text or Counter\)/);
});

test("fonts library: a name filters, one character lists fonts that have it, a cut list says how many more", async (t) => {
  const { catalog, fonts } = await freshCatalog(t);

  const named = await fontsLibraryText("Roboto", { fonts, catalog });
  assert.match(named, /^installed: none match\ncatalog: Roboto 400\n/);

  const everything = await fontsLibraryText("", { fonts, catalog });
  const catalogLine = everything.split("\n")[1];
  assert.equal(catalogLine.split(", ").length, 15, "the first 15 families are shown");
  assert.match(catalogLine, / \+7 more; search a name \(such as "Roboto"\) or one character \(such as "∞"\) to narrow\.$/);

  const character = await fontsLibraryText("∞", { fonts, catalog });
  assert.ok(character.startsWith(`fonts with "∞" (glyphs checked): Roboto 400 ${source("roboto")}, Lora 400 ${source("lora")}\n`), character);
  assert.match(character, /textStyleRanges range/);

  // Words that name no family but describe a look filter by category and weight.
  const look = await fontsLibraryText("elegant serif", { fonts, catalog });
  assert.match(look, /^catalog, look "elegant serif" \(serif, 2 match; ignored: elegant\): Lora 400, Playfair Display 400\nCompare by eye with the reference strip; set_font \{layerIds, family, weight\}/, look);
  assert.match(await fontsLibraryText("condensed bold sans", { fonts, catalog }), /\(sans-serif, 700\+, 0 match\): none match; use fewer words/);
  assert.match(await fontsLibraryText("Filler 01", { fonts, catalog }), /^installed: none match\ncatalog: Filler 01 /, "a name that matches stays a name search");
});

test("fonts library look search: sans serif is one category, condensed is a name word, heavy means 800+, kino's own fonts are tagged and ranked last", async () => {
  const entry = (family, category, weights) => ({ family, category, weights });
  const families = [
    entry("Abhaya Libre", "serif", [400, 700]), entry("Barlow Condensed", "sans-serif", [400, 800]), entry("Alkatra", "display", [400, 700]),
    entry("Archivo", "sans-serif", [400, 900]), entry("Oswald", "sans-serif", [400]), entry("Roboto Condensed", "sans-serif", [300, 700, 800]),
    entry("IBM Plex Mono", "monospace", [400, 700]), entry("Nanum Brush Script", "handwriting", [400]), entry("Zeyada", "handwriting", [400]),
  ];
  const catalog = { list: async ({ search = "" } = {}) => {
    const found = families.filter((family) => family.family.toLowerCase().includes(search.toLowerCase()));
    return { families: found, total: found.length, offline: false };
  } };
  const fonts = { entries: () => [] };
  const sans = await fontsLibraryText("bold sans-serif", { fonts, catalog });
  assert.doesNotMatch(sans, /Abhaya Libre|Alkatra/, "sans-serif is not also serif");
  assert.match(sans, /\(sans-serif, 700\+, 3 match\): Roboto Condensed 300-800, Barlow Condensed 400-800, Archivo 400-900 \[kino's own\]\n/, "more weights first, kino's own last");
  assert.equal((await fontsLibraryText("bold sans serif", { fonts, catalog })).replace("sans serif", "sans-serif"), sans);
  const condensed = await fontsLibraryText("bold condensed", { fonts, catalog });
  assert.match(condensed, /\(all categories, 700\+, 2 match\): Roboto Condensed 300-800, Barlow Condensed 400-800\n/, "only families with the word in their name");
  assert.match(await fontsLibraryText("heavy sans", { fonts, catalog }), /\(sans-serif, 800\+, 3 match\)/);
  assert.match(await fontsLibraryText("wide italic sans", { fonts, catalog }), /ignored: wide, italic\)/);
  const mono = await fontsLibraryText("bold mono", { fonts, catalog });
  assert.match(mono, /IBM Plex Mono 400-700 \[kino's own\]\n.*\[kino's own\] fonts are flagged by check/);
  // "brush script" is inside one family's name: the name result comes first, then the look's families.
  const brush = await fontsLibraryText("brush script", { fonts, catalog });
  assert.match(brush, /^installed: none match\ncatalog: Nanum Brush Script 400\n.*\ncatalog, look "brush script" \(handwriting, 2 match\): Nanum Brush Script 400, Zeyada 400\n/);
});

// The agent service. The server does not download; this fills its font cache first.
async function startFontServer(t, { withSerif = false } = {}) {
  const server = await startTestServer({ env: { MOTION_FONT_DOWNLOADS: "off" } });
  t.after(() => server.stop());
  const filler = await createFontCatalog({ dataRoot: server.dataDirectory, fetchImpl: fakeFetch([]), enabled: true });
  await filler.list();
  await filler.ensureFace({ id: "anton", weight: 400, style: "normal", text: "GLOW +" });
  await filler.ensureFace({ id: "noto-sans-symbols-2", weight: 400, style: "normal", text: "∞" });
  await filler.ensureFace({ id: "roboto", weight: 400, style: "normal", text: "A∞" });
  if (withSerif) await filler.ensureFace({ id: "lora", weight: 400, style: "normal", text: "A∞" });
  const agent = async (verb, body) => (await server.api(`/api/agent/${verb}`, { method: "POST", body })).json();
  return { server, agent };
}

// The same through the agent service: set_font's refusal, retry with its "instead" op, check's
// fix and library query.
test("agent service: set_font refusal points at the op and gives a working instead op; check and library use the same help", async (t) => {
  const { server, agent } = await startFontServer(t);

  await agent("project", { action: "create", id: "glyphs", name: "Glyphs", width: 1280, height: 720, duration: 2 });
  const added = await agent("edit", { project: "glyphs", ops: [{ op: "add_layer", layerType: "text", properties: { id: "title", text: "GLOW +∞", x: 100, y: 100, width: 900, height: 160, fontSize: 96 } }] });
  assert.equal(added.isError, undefined, added.text);

  const refused = await agent("edit", { project: "glyphs", ops: [{ op: "set_font", layerIds: ["title"], family: "Anton" }] });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.error, "op_failed");
  assert.equal(refused.data.op, 0);
  assert.equal(refused.data.type, "set_font");
  assert.equal(refused.data.field, "family");
  assert.ok(refused.data.reason.startsWith(`Operation 0 (set_font) was refused: Anton does not include "∞". Fonts with it (glyphs checked): Roboto 400 (fontSource ${source("roboto")}).`), refused.data.reason);
  assert.doesNotMatch(refused.data.reason, /Noto Sans Symbols 2/);
  assert.equal(refused.data.instead.op, "update_layer");

  const retried = await agent("edit", { project: "glyphs", retry: refused.data.retry, fix: { 0: refused.data.instead } });
  assert.equal(retried.isError, undefined, retried.text);
  const saved = await (await server.api("/api/projects/glyphs")).json();
  const title = saved.document.scenes[0].layers.find((layer) => layer.id === "title");
  assert.equal(title.fontFamily, "Anton");
  assert.deepEqual(title.textStyleRanges, [{ start: 6, end: 7, style: { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") } }]);

  await agent("edit", { project: "glyphs", ops: [{ op: "add_layer", layerType: "text", properties: { id: "line", text: "to ∞", x: 100, y: 400, width: 900, height: 120, fontSize: 64 } }] });
  const checked = await agent("check", { project: "glyphs", rules: ["missing_glyphs"] });
  assert.deepEqual(checked.data.findings.map((finding) => finding.ref), ["line"], "title draws every character now; line still lacks ∞");
  const [finding] = checked.data.findings;
  assert.ok(finding.message.includes(`Roboto 400 (fontSource ${source("roboto")}) has them (glyphs checked)`), finding.message);
  assert.deepEqual(finding.fix, { op: "update_layer", layerId: "line", properties: { textStyleRanges: [{ start: 3, end: 4, style: { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") } }] } });
  await agent("edit", { project: "glyphs", ops: [finding.fix] });
  assert.equal((await agent("check", { project: "glyphs", rules: ["missing_glyphs"] })).data.findings.length, 0);

  const byQuery = await agent("library", { topic: "fonts", query: "Roboto" });
  assert.match(byQuery.text, /^installed: Roboto\ncatalog: Roboto 400\n/, "query works like search");
  assert.doesNotMatch(byQuery.text, /Anton/);
  assert.match((await agent("library", { topic: "fonts", search: "∞" })).text, /^fonts with "∞" \(glyphs checked\): Roboto 400 /);
});

// Before, `instead` fixed only the first layer that lacked ∞, so each such layer took one more retry.
test("agent service: set_font on several layers that lack ∞ is refused once, and one retry with instead sets them all", async (t) => {
  const { server, agent } = await startFontServer(t);
  await agent("project", { action: "create", id: "many", name: "Many", width: 1280, height: 720, duration: 2 });
  const text = (id, value, y) => ({ op: "add_layer", layerType: "text", properties: { id, text: value, x: 100, y, width: 900, height: 120, fontSize: 64 } });
  const added = await agent("edit", { project: "many", ops: [text("title", "GLOW +∞", 100), text("sub", "to ∞", 300), text("plain", "GLOW", 500)] });
  assert.equal(added.isError, undefined, added.text);

  const refused = await agent("edit", { project: "many", ops: [{ op: "set_font", layerIds: ["title", "sub", "plain"], family: "Anton" }] });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.op, 0);
  assert.equal(refused.data.field, "family");
  assert.ok(refused.data.reason.startsWith(`Operation 0 (set_font) was refused: title, sub: Anton does not include "∞". Fonts with it (glyphs checked): Roboto 400 (fontSource ${source("roboto")}). "instead" keeps Anton and draws only the characters each layer lacks `), refused.data.reason);
  assert.deepEqual(refused.data.instead.map((op) => [op.op, op.layerIds ?? op.layerId]),
    [["set_font", ["plain"]], ["update_layer", "title"], ["update_layer", "sub"]]);

  const retried = await agent("edit", { project: "many", retry: refused.data.retry, fix: { 0: refused.data.instead } });
  assert.equal(retried.isError, undefined, retried.text);
  const saved = await (await server.api("/api/projects/many")).json();
  const layers = Object.fromEntries(saved.document.scenes[0].layers.map((layer) => [layer.id, layer]));
  const roboto = { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") };
  assert.deepEqual(Object.values(layers).map((layer) => layer.fontFamily), ["Anton", "Anton", "Anton"]);
  assert.deepEqual(layers.title.textStyleRanges, [{ start: 6, end: 7, style: roboto }]);
  assert.deepEqual(layers.sub.textStyleRanges, [{ start: 3, end: 4, style: roboto }]);
  assert.deepEqual(layers.plain.textStyleRanges ?? [], [], "plain has every character in Anton");
  assert.equal((await agent("check", { project: "many", rules: ["missing_glyphs"] })).data.findings.length, 0);
});

// The server here does not download (a real edit did), so the font kinds come from the faces
// it has: each downloaded face keeps its family's catalog category.
test("agent service: with a serif installed, Anton's refusal still offers the sans first, every time", async (t) => {
  const { agent } = await startFontServer(t, { withSerif: true });
  await agent("project", { action: "create", id: "kinds", name: "Kinds", width: 1080, height: 1920, duration: 2 });
  await agent("edit", { project: "kinds", ops: [{ op: "add_layer", layerType: "text", properties: { id: "save", text: "SAVE ∞", x: 100, y: 300, width: 880, height: 200, fontSize: 120 } }] });
  for (const attempt of [1, 2]) {
    const refused = await agent("edit", { project: "kinds", ops: [{ op: "set_font", layerIds: ["save"], family: "Anton" }] });
    assert.equal(refused.data.error, "op_failed", refused.text);
    assert.ok(refused.data.reason.includes(`Fonts with it (glyphs checked): Roboto 400 (fontSource ${source("roboto")}), Lora 400 (fontSource ${source("lora")}).`), `attempt ${attempt}: ${refused.data.reason}`);
    assert.deepEqual(refused.data.instead.properties.textStyleRanges, [{ start: 5, end: 6, style: { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") } }]);
  }
});
