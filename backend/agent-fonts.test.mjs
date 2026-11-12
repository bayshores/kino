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

test("a Chinese character no font has names the font file to import", async (t) => {
  const { catalog, fonts } = await freshCatalog(t);
  const help = await missingGlyphsHelp({ layer: textLayer("zh", "离线"), layerRef: "zh", characters: ["离", "线"], fonts, catalog });
  assert.match(help.fix, /project import a font file that has them\. A free one is Noto Sans SC \(a file named like NotoSansSC-Regular\.ttf\)\.$/);
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
  assert.match(look, /^catalog, look "elegant serif" \(serif, 2 match; ignored: elegant\): Lora 400, Playfair Display 400\nCompare by eye with the reference strip, or library \{topic:"fonts", like:.*region:\[x,y,w,h\]\} ranks faces by the measured letters; set_font \{layerIds, family, weight\}/, look);
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
  assert.match(await fontsLibraryText("wide italic sans", { fonts, catalog }), /\(sans-serif, wide first, 4 match; ignored: italic\)/);
  const mono = await fontsLibraryText("bold mono", { fonts, catalog });
  assert.match(mono, /IBM Plex Mono 400-700 \[kino's own\]\n.*\[kino's own\] fonts are flagged by check/);
  // "brush script" is inside one family's name: the name result comes first, then the look's families.
  const brush = await fontsLibraryText("brush script", { fonts, catalog });
  assert.match(brush, /^installed: none match\ncatalog: Nanum Brush Script 400\n.*\ncatalog, look "brush script" \(handwriting, 2 match\): Nanum Brush Script 400, Zeyada 400\n/);
});

// The hand-lettering study found "brush", "marker", "stencil", "slab" and "japanese" matched nothing
// by class: the search reached only a category word plus a weight, or words inside a family name.
test("fonts library class, style and script words: one word alone works, a script reads the family's subsets, a style word reads its name", async () => {
  const entry = (family, category, weights, subsets = ["latin"]) => ({ family, category, weights, subsets });
  const families = [
    entry("Big Shoulders Stencil", "display", [100, 900]), entry("Roboto Slab", "serif", [100, 900]), entry("Alfa Slab One", "display", [400]),
    entry("Noto Sans JP", "sans-serif", [100, 900], ["japanese", "latin"]), entry("Yuji Mai", "serif", [400], ["japanese"]), entry("Klee One", "handwriting", [400, 600], ["japanese", "latin"]),
    entry("Caveat", "handwriting", [400, 700]), entry("Caveat Brush", "handwriting", [400]), entry("Permanent Marker", "handwriting", [400]), entry("Special Elite", "display", [400]),
    entry("Unifraktur Cook", "display", [700]), entry("Roboto", "sans-serif", [400, 900]),
  ];
  const catalog = { list: async ({ search = "" } = {}) => {
    const found = families.filter((family) => family.family.toLowerCase().includes(search.toLowerCase()));
    return { families: found, total: found.length, offline: false };
  } };
  const fonts = { entries: () => [] };
  const brush = await fontsLibraryText("brush", { fonts, catalog });
  assert.match(brush, /^catalog, look "brush" \(handwriting, 4 match\): Caveat Brush 400, Klee One 400-600, Permanent Marker 400, Caveat 400-700\n/, "the family named brush first, then the category, one face per family line before its siblings");
  assert.match(await fontsLibraryText("marker", { fonts, catalog }), /\(handwriting, 4 match\): Permanent Marker 400, Caveat 400-700, Klee One 400-600, Caveat Brush 400\n/);
  assert.match(await fontsLibraryText("stencil", { fonts, catalog }), /^catalog, look "stencil" \(all categories, stencil, 1 match\): Big Shoulders Stencil 100-900\n/);
  assert.match(await fontsLibraryText("slab serif", { fonts, catalog }), /\(serif, slab, 1 match\): Roboto Slab 100-900\n/, "a style word needs its name, a class word its category");
  assert.match(await fontsLibraryText("slab", { fonts, catalog }), /\(all categories, slab, 2 match\): Roboto Slab 100-900, Alfa Slab One 400\n/);
  assert.match(await fontsLibraryText("blackletter", { fonts, catalog }), /\(all categories, blackletter, 1 match\): Unifraktur Cook 700\n/);
  assert.match(await fontsLibraryText("typewriter", { fonts, catalog }), /\(all categories, typewriter, 1 match\): Special Elite 400\n/);
  // A script is the catalog's subset: "japanese" alone, with a class, or as "japanese script" (which is not handwriting).
  assert.match(await fontsLibraryText("japanese", { fonts, catalog }), /\(all categories, japanese, 3 match\): Klee One 400-600, Noto Sans JP 100-900, Yuji Mai 400\n/);
  assert.match(await fontsLibraryText("japanese brush", { fonts, catalog }), /\(handwriting, japanese, 1 match\): Klee One 400-600\n/);
  assert.match(await fontsLibraryText("japanese script", { fonts, catalog }), /\(all categories, japanese, 3 match\)/);
  assert.match(await fontsLibraryText("handwritten", { fonts, catalog }), /\(handwriting, 4 match\)/);
  // A family's own name still wins over a class word, and the names that were searched by name stay name searches.
  assert.match(await fontsLibraryText("Roboto", { fonts, catalog }), /^installed: none match\ncatalog: Roboto Slab 100\/900, Roboto 400\/900\n/);
  // A family's copies for other scripts ("<name> Thai") come after the different faces, unless a script is asked.
  const wide = [entry("Wavy Hand", "handwriting", [100, 900]), entry("Wavy Hand Thai", "handwriting", [100, 900], ["thai", "latin"]), entry("Quill", "handwriting", [400])];
  const scripts = { list: async () => ({ families: wide, total: wide.length, offline: false }) };
  assert.match(await fontsLibraryText("handwritten", { fonts, catalog: scripts }), /: Wavy Hand 100-900, Quill 400, Wavy Hand Thai 100-900\n/);
  assert.match(await fontsLibraryText("thai", { fonts, catalog: scripts }), /: Wavy Hand Thai 100-900\n/);
});

// GAPS item 1: "rounded geometric heavy sans" answered every heavy sans with "ignored: rounded, geometric".
test("fonts library shape words rank instead of being ignored: rounded and geometric order a category, dot-matrix alone picks by name", async () => {
  const entry = (family, category, weights) => ({ family, category, weights });
  const families = [entry("Archivo", "sans-serif", [400, 900]), entry("Nunito", "sans-serif", [200, 1000]), entry("Poppins", "sans-serif", [100, 900]),
    entry("M PLUS Rounded 1c", "sans-serif", [100, 900]), entry("Doto", "sans-serif", [100, 900]), entry("Silkscreen", "display", [400, 700]), entry("Lora", "serif", [400, 700])];
  const catalog = { list: async ({ search = "" } = {}) => {
    const found = families.filter((family) => family.family.toLowerCase().includes(search.toLowerCase()));
    return { families: found, total: found.length, offline: false };
  } };
  const fonts = { entries: () => [] };
  assert.match(await fontsLibraryText("rounded geometric heavy sans", { fonts, catalog }),
    /\(sans-serif, 800\+, rounded first, geometric first, 5 match\): M PLUS Rounded 1c 100-900, Nunito 200-1000, Poppins 100-900, /);
  assert.match(await fontsLibraryText("dot matrix", { fonts, catalog }), /\(all categories, dot first, matrix first, 1 match\): Doto 100-900\n/);
  assert.match(await fontsLibraryText("pixel", { fonts, catalog }), /\(all categories, pixel first, 1 match\): Silkscreen 400-700\n/);
});

// Run 8 asked "Anton condensed bold": the answer said "ignored: anton" and listed condensed faces A to Z.
test("fonts library keeps a named family: it is listed first with a category word beside it, then the category's matches", async () => {
  const entry = (id, family, category, weights) => ({ id, family, category, weights });
  const families = [entry("barlow-condensed", "Barlow Condensed", "sans-serif", [400, 800]), entry("anton", "Anton", "sans-serif", [400]),
    entry("anton-sc", "Anton SC", "sans-serif", [400]), entry("bebas-neue", "Bebas Neue", "sans-serif", [400]), entry("oswald", "Oswald", "sans-serif", [400, 700]),
    entry("antonio", "Antonio", "sans-serif", [700]), entry("big-shoulders", "Big Shoulders Display", "display", [100, 900])];
  const catalog = { list: async ({ search = "" } = {}) => {
    const found = families.filter((family) => family.family.toLowerCase().includes(search.toLowerCase()));
    return { families: found, total: found.length, offline: false };
  } };
  const fonts = { entries: () => [] };
  const named = await fontsLibraryText("Anton condensed bold", { fonts, catalog });
  assert.match(named, /^catalog, look "Anton condensed bold" \(all categories, 700\+, 3 match; named first: Anton, Anton SC\): Anton 400 \[kino's own\], Anton SC 400, Barlow Condensed 400-800\n/);
  assert.doesNotMatch(named, /ignored: anton/);
  // A name of two words, and a word that names no family (still ignored).
  assert.match(await fontsLibraryText("Bebas Neue sans-serif", { fonts, catalog }), /named first: Bebas Neue\): Bebas Neue 400 \[kino's own\], Barlow Condensed/);
  assert.match(await fontsLibraryText("wobbly condensed", { fonts, catalog }), /\(all categories, 1 match; ignored: wobbly\): Barlow Condensed/);
  // One plain word names a family only when it is the whole name: "big" is a description, not Big Shoulders Display.
  assert.match(await fontsLibraryText("big condensed", { fonts, catalog }), /\(all categories, 1 match; ignored: big\): Barlow Condensed/);
  // A name with only a weight word beside it is the name too.
  assert.match(await fontsLibraryText("Anton bold", { fonts, catalog }), /^catalog, named "Anton bold": Anton 400, Anton SC 400\n/);
});

// library {topic:"fonts", like}: a picture of letters set in one bundled face ranks that face first.
test("fonts like: the lettering in a picture ranks the face it was set in first, with words for what differs and a set_font call", async (t) => {
  const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
  const { fontsLikeText } = await import("./font-like.mjs");
  const folder = await mkdtemp(path.join(tmpdir(), "kino-like-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  GlobalFonts.registerFromPath(path.resolve("assets/fonts/NotoSerif-700.woff2"), "Like Serif");
  const canvas = createCanvas(640, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#182030"; context.fillRect(0, 0, 640, 200);
  context.fillStyle = "#f4f0e8"; context.font = "96px 'Like Serif'"; context.fillText("STORM", 120, 140);
  const file = path.join(folder, "frame.png");
  await (await import("node:fs/promises")).writeFile(file, canvas.toBuffer("image/png"));
  const fonts = await loadBundledFonts();
  const catalog = { measuresFile: path.join(folder, "measures.json") };
  const answer = await fontsLikeText({ like: file, region: [100, 30, 440, 140], text: "STORM", count: 3 }, { fonts, catalog });
  assert.equal(answer.fonts[0].family, "Noto Serif", answer.text);
  assert.ok(answer.fonts[0].weight >= 600, answer.text);
  assert.match(answer.text, /^fonts like the lettering in .*frame\.png \[100, 30, 440, 140\] px of the 640x200 picture: weight [\d.]+, width [\d.]+, slant/);
  // Each face names what it was matched on, beside the reference's own values.
  assert.match(answer.text, /\n1\. Noto Serif 700 \(distance [\d.]+: [a-z ,]+; face vs ref: weight [\d.]+ vs [\d.]+, width [\d.]+ vs [\d.]+, contrast [\d.]+ vs [\d.]+, upright vs upright\) set_font \{layerIds:\["<layer>"\], family:"Noto Serif", weight:700\}/);
  assert.doesNotMatch(answer.text, /px tall/, "70 px letters are measurable");
  // A saved reference's frame names its kind and time; letters under 24 px say they cannot be measured.
  const tiny = createCanvas(240, 136);
  const tinyContext = tiny.getContext("2d");
  tinyContext.fillStyle = "#182030"; tinyContext.fillRect(0, 0, 240, 136);
  tinyContext.fillStyle = "#f4f0e8"; tinyContext.font = "14px 'Like Serif'"; tinyContext.fillText("STORM", 100, 60);
  const small = await fontsLikeText({ like: "yt:aaaaaaaaaaa", text: "STORM", count: 2 }, { fonts, catalog, referenceFrame: async () => ({ bytes: tiny.toBuffer("image/png"), at: 0.1, kind: "first strip frame, t left out" }) });
  assert.match(small.text, /px of the 240x136 first strip frame, t left out @0\.1s: /);
  assert.match(small.text, /\nthe letters measured are \d+ px tall \(under 24 px their stroke weight, contrast and slant are not measurable, so faces are ranked on width, corners, rough edges and dots only\): pass t /);
  // Too small to measure: the reference's weight, contrast and stance are printed as not measured, not compared.
  assert.match(small.text, /\n1\. .*face vs ref: weight [\d.]+ vs not measured, width [\d.]+ vs [\d.]+, contrast [\d.]+ vs not measured, .* vs not measured\)/);
  assert.match(answer.text, /\n2\. (?!Noto Serif 700)/, "one line per face");
  assert.match(await (await import("node:fs/promises")).readFile(catalog.measuresFile, "utf8"), /Noto Serif|NotoSerif/, "measures are kept on disk");
  // Saved type labels: the same ranking runs at each labeled moment and its lines come first (here the saved moment is this picture).
  const { fontsLikeLabels } = await import("./font-like.mjs");
  const frame = await (await import("node:fs/promises")).readFile(file);
  const labels = [{ id: "yt:aaaaaaaaaaa", at: 3.8, words: "STORM in a serif" }, { id: "yt:bbbbbbbbbbb", at: 1, words: "x" }, { id: "yt:ccccccccccc", at: 2, words: "y" }];
  const labeled = await fontsLikeLabels(labels, { fonts, catalog, referenceFrame: async () => frame });
  assert.match(labeled.text, /^like your label yt:aaaaaaaaaaa @3\.8 "STORM in a serif" \(box \[[\d, ]+\] of \d+[^)]*\): \S.* \d+ \([\d.]+\)(, .*){3}\n/, "four faces, each with its distance, measured on the frame's lettering box");
  // Faces measured this close on the whole frame cannot be told apart: the line says so and gives the region call.
  const flat = await fontsLikeLabels([labels[0]], { fonts, catalog, referenceFrame: async () => frame });
  const spread = flat.found[0].fonts.map((font) => font.distance);
  assert.equal(/too close to tell apart: like:"yt:aaaaaaaaaaa", t:3\.8, region:\[x,y,w,h\]/.test(flat.text), (spread.at(-1) - spread[0]) / spread[0] < 0.1);
  assert.match(labeled.text, /\n.* yt:bbbbbbbbbbb @1 "x"[^\n]*\n\(smaller distance = closer letters; 1 more label: like:"<ref>", t; region/, "two labels are measured, the rest named");
  assert.equal(labeled.found.length, 2);
  assert.equal(await fontsLikeLabels([], { fonts }), null, "no labels, no lines");
  const blank = await fontsLikeLabels([labels[0]], { fonts, catalog, referenceFrame: async () => createCanvas(40, 40).toBuffer("image/png") });
  assert.match(blank.text, /^your label yt:aaaaaaaaaaa @3\.8 "STORM in a serif" was not measured \(no lettering found in that region\): library \{topic:"fonts", like:"yt:aaaaaaaaaaa", t:3\.8, region:\[x,y,w,h\]\}/);
});

// Without a region kino finds the lettering boxes itself: a contact sheet of frames measures the title, not the sheet.
test("fonts like: no region measures the largest lettering box, names the others, and marks faces turned down or seen before", async (t) => {
  const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
  const { fontsLikeText, letteringBoxes, faceNote } = await import("./font-like.mjs");
  const { writeFile } = await import("node:fs/promises");
  const folder = await mkdtemp(path.join(tmpdir(), "kino-like-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  GlobalFonts.registerFromPath(path.resolve("assets/fonts/NotoSerif-700.woff2"), "Like Serif");
  // A sheet: a dark frame with a big title and a small caption, and a noisy photo-like tile beside them.
  const canvas = createCanvas(1600, 800);
  const context = canvas.getContext("2d");
  context.fillStyle = "#182030"; context.fillRect(0, 0, 1000, 800);
  context.fillStyle = "#f4f0e8"; context.font = "150px 'Like Serif'"; context.fillText("STORM", 60, 300);
  context.font = "40px 'Like Serif'"; context.fillText("THE LONG NIGHT", 60, 600);
  for (let i = 0; i < 400; i += 1) { context.fillStyle = `hsl(${(i * 47) % 360} 50% ${20 + ((i * 29) % 60)}%)`; context.fillRect(1000 + ((i * 97) % 560), 20 + ((i * 53) % 740), 30 + (i % 40), 20 + (i % 30)); }
  const file = path.join(folder, "sheet.png");
  await writeFile(file, canvas.toBuffer("image/png"));
  const { loadImage } = await import("@napi-rs/canvas");
  const boxes = letteringBoxes(await loadImage(file));
  assert.ok(boxes.length >= 2, JSON.stringify(boxes));
  assert.ok(boxes[0].x < 100 && boxes[0].y < 300 && boxes[0].y + boxes[0].height > 300 && boxes[0].width > 500, `the title is the largest box: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.some((box) => box.y < 600 && box.y + box.height > 600 && box.x < 100), `the caption is another: ${JSON.stringify(boxes)}`);
  // White type over strands of hair: the edges join word and hair into one tall box, its white pixels do not.
  const hair = createCanvas(640, 360);
  const strands = hair.getContext("2d");
  strands.fillStyle = "#26302c"; strands.fillRect(0, 0, 640, 360);
  strands.strokeStyle = "#5a6a64"; strands.lineWidth = 3;
  for (let i = 0; i < 60; i += 1) { strands.beginPath(); strands.moveTo(80 + i * 8, 40); strands.quadraticCurveTo(140 + i * 7, 200, 60 + i * 9, 340); strands.stroke(); }
  strands.fillStyle = "#ffffff"; strands.font = "110px 'Like Serif'"; strands.fillText("kill", 200, 170);
  const [word] = letteringBoxes(hair);
  assert.ok(word && word.x > 150 && word.x < 220 && word.y > 50 && word.y < 110 && word.width < 260 && word.height < 130, `the white word is a box: ${JSON.stringify(word)}`);
  const fonts = await loadBundledFonts();
  const catalog = { measuresFile: path.join(folder, "measures.json") };
  const faceMarks = async () => ({ rejected: ["Noto Serif 700 looks dated"], seen: [{ family: "Inter", name: "Old promo", rev: 3 }] });
  const answer = await fontsLikeText({ like: file, text: "STORM", count: 6 }, { fonts, catalog, faceMarks });
  assert.match(answer.text, /\nbox measured: \[\d+, \d+, \d+, \d+\], the largest of \d+ lettering boxes kino found; others, to measure one pass region: \[/, answer.text);
  assert.ok(answer.region.length === 4 && answer.region.every(Number.isInteger), JSON.stringify(answer.region));
  assert.ok(answer.region[2] < 1000 && answer.box.found >= 2 && answer.box.others.length >= 1 && answer.box.others.length <= 3);
  assert.equal(answer.fonts[0].family, "Noto Serif", answer.text);
  // style.rejected is on-screen text, so the fact is that turned-down text names the family, quoted.
  assert.match(answer.text, /\n1\. Noto Serif 700 \([^)]*\) \[named in text the person turned down: "Noto Serif 700 looks dated"\] set_font /, "the face stays listed with the fact");
  assert.match(answer.text, /\n\d\. Inter \d+ \([^)]*\) \[seen before: the type of "Old promo" r3\] set_font /);
  assert.equal(answer.fonts[0].note, 'named in text the person turned down: "Noto Serif 700 looks dated"');
  // A given region is measured as it is: no box search, no box line.
  const given = await fontsLikeText({ like: file, region: [40, 120, 800, 220], text: "STORM", count: 2 }, { fonts, catalog });
  assert.equal(given.box, undefined);
  assert.doesNotMatch(given.text, /box measured/);
  // A word inside a longer one is not a match; no marks, no brackets.
  assert.equal(faceNote("Inter", { rejected: ["interesting cut"] }), null);
  assert.equal(faceNote("Anton", {}), null);
});

// Type by job: two saved type labels (a big cream serif title, a small white subtitle line) give a
// subtitle line and a payoff word different defaults; before, both were the plain text layer.
test("type by job: two measured type labels give a subtitle line and a payoff word their own face size, fill and entrance", async (t) => {
  const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
  const { labelTypes } = await import("./font-like.mjs");
  const { jobTreatment, labelsByJob, payoffEntrance, textJob } = await import("../engine/typeRoles.js");
  const folder = await mkdtemp(path.join(tmpdir(), "kino-jobs-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  GlobalFonts.registerFromPath(path.resolve("assets/fonts/NotoSerif-700.woff2"), "Like Serif");
  const frame = (size, fill, words) => {
    const canvas = createCanvas(640, 360);
    const context = canvas.getContext("2d");
    context.fillStyle = "#101418"; context.fillRect(0, 0, 640, 360);
    context.fillStyle = fill; context.font = `${size}px 'Like Serif'`; context.fillText(words, 40, 200);
    return canvas.toBuffer("image/png");
  };
  const frames = { "yt:title000000": frame(110, "#f0d8a8", "STORM"), "yt:subs0000000": frame(22, "#ffffff", "we walk into the night") };
  // Each label is measured where a text reader reads its own words (stubbed: Linux has no reader). A
  // label whose words are not read (the hair kino boxed on run b) or that names no lettering is left
  // out and says why, instead of measuring the largest edgy box.
  const hairy = { bytes: frame(30, "#726b95", "~~"), at: 14.83, kind: "strip frame" };
  const reads = new Map([[frames["yt:title000000"], [{ box: [0.05, 0.3, 0.9, 0.35], s: "STORM" }]], [frames["yt:subs0000000"], [{ box: [0.04, 0.5, 0.9, 0.1], s: "we walk into the night" }]], [hairy.bytes, [{ box: [0.1, 0.4, 0.2, 0.2], s: "A" }]]]);
  const labels = [{ id: "yt:title000000", at: 2, words: "cream serif title STORM" }, { id: "yt:subs0000000", at: 5, words: 'subtitle line "we walk into the night"' }];
  const deps = { fonts: await loadBundledFonts(), catalog: { measuresFile: path.join(folder, "m.json") }, readText: async (bytes) => reads.get(bytes) ?? [],
    referenceFrames: async (id, at) => (id === "yt:hair0000000" ? [hairy] : [{ bytes: frames[id], at: at + 0.2, kind: "still" }]) };
  const measured = await labelTypes(labels, deps);
  assert.equal(measured.length, 2);
  assert.deepEqual([measured[0].at, measured[0].labelAt, measured[0].frame, measured[0].read], [2.2, 2, "still 640x360", "STORM"]);
  const unread = await labelTypes([{ id: "yt:hair0000000", at: 14.83, words: "the lyric word KNOW in white" }, { id: "yt:hair0000000", at: 3, words: "a cut-out on clouds" }], deps);
  assert.equal(unread.length, 0);
  assert.deepEqual(unread.skipped.map((entry) => entry.why), ['"KNOW" was not read in its 1 frame within 0.5 s', "its words name no lettering (quote it or write it in capitals)"]);
  assert.equal((await labelTypes(labels, { ...deps, readText: async () => null })).skipped[0].why, "no text reader here to confirm its lettering");
  const scene = { width: 1920, height: 1080, background: "#000000", layers: [] };
  const before = createLayer("text");
  const style = (p) => `${p.fontFamily} ${p.fontWeight} ${p.fontSize}px ${p.fill}${p.strokeWidth ? ` edge ${p.strokeWidth}` : ""}`;
  assert.equal(textJob("but I will find you, I swear.", undefined), "subtitle");
  assert.equal(textJob("FIND YOU", undefined), "payoff");
  const line = jobTreatment("subtitle", { scene, labels: measured });
  const word = jobTreatment("payoff", { scene, labels: measured });
  console.log(`before: subtitle ${style(before)} | payoff ${style(before)}`);
  console.log(`after: subtitle ${style(line.properties)} (${line.from}) | payoff ${style(word.properties)} (${word.from})`);
  assert.match(line.from, /^label yt:subs0000000 @5 \(read "we walk into the night" in its still 640x360 at 5.2 s\)/);
  assert.match(word.from, /^label yt:title000000 @2 \(read "STORM" in its still 640x360 at 2.2 s\)/);
  assert.ok(word.properties.fontSize > line.properties.fontSize * 3, "the payoff takes the big label's size share");
  assert.deepEqual([word.properties.fontFamily, line.properties.fontFamily], [measured.find((one) => one.ref === "yt:title000000").family, measured.find((one) => one.ref === "yt:subs0000000").family], "each job takes its label's nearest face");
  assert.ok(parseInt(word.properties.fill.slice(1, 3), 16) > 0xd0 && parseInt(word.properties.fill.slice(5, 7), 16) < 0xc8, `cream fill measured: ${word.properties.fill}`);
  assert.ok(line.properties.strokeWidth > 0 && !word.properties.strokeWidth, "only the subtitle gets an edge");
  // No labels: the scene's colors (a saturated shape is the payoff's accent) and plain sizes by job.
  const plain = jobTreatment("payoff", { scene: { ...scene, layers: [{ type: "rectangle", fill: "#d02020" }] } });
  assert.equal(plain.properties.fill, "#d02020");
  assert.match(plain.from, /^scene colors/);
  // The payoff's letter entrance follows the cue it lands on.
  assert.match(payoffEntrance(7.9, [{ name: "song-drop-1", time: 7.92, kind: "marker" }]).why, /slam in on cue:song-drop-1/);
  assert.match(payoffEntrance(3, [{ name: "song-build-1", time: 3, kind: "marker" }]).why, /rise in on cue:song-build-1/);
  assert.equal(payoffEntrance(3, []).animation.unit, "letters");
  // Strip frames of busy footage measured the whole picture (letters 85% and 100% of the height):
  // those labels give nothing. A 22.8% label on a 9:16 frame keeps "FIND YOU" inside its box, and a
  // measured fill that would not read on the background gives way to the plain color.
  assert.deepEqual(labelsByJob([{ ref: "a", family: "Inter", share: 1 }, { ref: "b", family: "Inter", share: 0.853 }]), {});
  const tall = { ref: "c", at: 1, family: "Inter", weight: 900, share: 0.228, fill: "#3c3027" };
  const vertical = jobTreatment("payoff", { scene: { width: 1080, height: 1920, background: "#000000", layers: [] }, labels: [tall], text: "FIND YOU" });
  assert.ok(vertical.properties.fontSize * 8 * 0.62 <= vertical.properties.width, `${vertical.properties.fontSize} px in ${vertical.properties.width} px`);
  assert.equal(vertical.properties.fill, "#ffffff");
  assert.match(vertical.from, /size fit to 8 letters a line \(608 px wanted; widths a guess, 0.62 of the size a letter\); measured fill #3c3027 under 3:1 on #000000/);
  console.log(`9:16 payoff: ${style(vertical.properties)} (${vertical.from})`);
  // Widths measured from the face the words are set in: "WWWW" is wider than 4 letters at the guess, "IIII" narrower.
  const fonts = await loadBundledFonts();
  const advance = (words, family, weight) => { const face = fonts.faces.filter((one) => one.family === family && one.style === "normal").sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0]; return { em: face.font.layout(words).advanceWidth / face.font.unitsPerEm, face: `${face.family} ${face.weight}` }; };
  const sized = (words) => jobTreatment("payoff", { scene: { width: 1080, height: 1920, background: "#000000", layers: [] }, labels: [{ ...tall, family: "Inter" }], text: words, advance });
  assert.ok(sized("WWWW").properties.fontSize < sized("IIII").properties.fontSize, `${sized("WWWW").properties.fontSize} < ${sized("IIII").properties.fontSize}`);
  const wide = sized("WWWWWWWW");
  assert.match(wide.from, /widths measured from Inter 700\)/, "the nearest weight kino has");
  assert.ok(advance("WWWWWWWW", "Inter", 900).em * wide.properties.fontSize <= wide.properties.width, "the measured line fits its box");
  // A face the agent already named (board text with a family) is the one measured.
  const named = jobTreatment("payoff", { scene: { width: 1080, height: 1920, background: "#000000", layers: [] }, labels: [{ ...tall, family: "Inter" }], text: "WWWWWWWW", advance, face: { family: "Montserrat", weight: 600 } });
  assert.match(named.from, /widths measured from Montserrat 600\)/);
  assert.ok(advance("WWWWWWWW", "Montserrat", 600).em * named.properties.fontSize <= named.properties.width, "the named face's line fits its box");
});

// Replay of run b (rev 16): role hero with no label asked for Inter 900 (Inter has no 900: font_fallback)
// while the project's display face was another family, and took #111111 from the scene's #fafaf7
// background under full-frame dark footage. Now the face follows the project's own text (else a face
// that has the weight), the fill is measured behind the box, and every saved label up to 6 is tried.
test("type by job: the face follows the project's text, the fill the picture behind, and skipped labels are said once", async () => {
  const { freshSkips, jobFace, jobTreatment, pictureUnder, skipKey } = await import("../engine/typeRoles.js");
  const { labelTypes } = await import("./font-like.mjs");
  const faces = (await loadBundledFonts()).faces;
  const display = { type: "text", id: "t1", name: "title", text: "STAND", fontFamily: "Montserrat", fontWeight: 700, fontSize: 160 };
  const line = { type: "text", id: "t2", name: "sub", text: "we walk into the night", fontFamily: "Noto Serif", fontWeight: 400, fontSize: 40 };
  const hero = jobFace("payoff", { layers: [line, display], faces });
  assert.deepEqual([hero.family, hero.weight, hero.from], ["Montserrat", 700, "the project's text title (Montserrat 700, the largest text)"]);
  assert.equal(jobFace("subtitle", { layers: [line, display], faces }).family, "Noto Serif", "the smallest reading line");
  assert.equal(jobFace("payoff", { layers: [line, display], role: "caption", faces: [] }).family, "Montserrat", "no text with that role: the job's own rule");
  // No project text: a bundled face that really has the weight (Inter 600), else Inter's nearest real weight (700, not 900).
  assert.deepEqual([jobFace("subtitle", { faces }).family, jobFace("subtitle", { faces }).weight], ["Inter", 600]);
  const bare = jobFace("payoff", { faces });
  assert.deepEqual([bare.family, bare.weight], ["Inter", 700]);
  assert.match(bare.from, /no face has 900/);
  // A family named with no weight stays in that family: its nearest installed weight (Inter has no 900).
  assert.deepEqual(["family", "weight", "from"].map((key) => jobFace("payoff", { layers: [line, display], faces, family: "inter" })[key]), ["Inter", 700, "Inter 700, its nearest installed weight to 900"]);
  const scene = { width: 1920, height: 1080, background: "#fafaf7", layers: [] };
  const plain = jobTreatment("payoff", { scene, text: "STAND", follow: bare });
  assert.deepEqual([plain.properties.fontFamily, plain.properties.fontWeight, plain.properties.fill], ["Inter", 700, "#111111"]);
  // Full-frame footage shown from 1 s covers the light background: the fill is chosen against the measured picture.
  const clip = { type: "video", id: "v1", name: "night", src: "/api/media/night.mp4", x: 0, y: 0, width: 1920, height: 1080, opacity: 1, animations: [{ kind: "show", start: 1 }] };
  const box = { x: plain.properties.x, y: plain.properties.y, width: plain.properties.width, height: plain.properties.height };
  assert.equal(pictureUnder({ ...scene, layers: [clip] }, box, 0.5), null, "not on screen yet: the background shows");
  assert.equal(pictureUnder({ ...scene, layers: [clip] }, box, 2)?.id, "v1");
  // Shown again later (show, hide, show): on screen at 6 s. A cut-out's subject copy above it is not the picture behind.
  const again = { ...clip, animations: [{ kind: "show", start: 0 }, { kind: "hide", start: 2 }, { kind: "show", start: 5 }] };
  assert.deepEqual([3, 6].map((time) => pictureUnder({ ...scene, layers: [again] }, box, time)?.id ?? null), [null, "v1"]);
  assert.equal(pictureUnder({ ...scene, layers: [clip, { ...clip, id: "v1-subject", cutoutOf: "v1" }] }, box, 2)?.id, "v1");
  const over = jobTreatment("subtitle", { scene, text: "we walk into the night", follow: bare, behind: { color: "#16181c", from: "night at 2 s" } });
  assert.deepEqual([over.properties.fill, over.properties.stroke], ["#ffffff", "#000000"]);
  assert.match(over.from, /^the picture behind \(#16181c measured from night at 2 s\); no measured type label for this job; fill #ffffff at 17\.\d:1 on #16181c; face from Inter 700/);
  // Seven saved labels: all six up to the limit are tried, the seventh says why it was not.
  const seven = Array.from({ length: 7 }, (_, index) => ({ id: `yt:lbl${index}000000`, at: index, words: `word "W${index}X"` }));
  const tried = [];
  const found = await labelTypes(seven, { fonts: { faces }, catalog: {}, readText: async () => [], referenceFrames: async (id, at) => { tried.push(id); return [{ bytes: Buffer.from([]), at, kind: "still" }]; } });
  assert.equal(tried.length, 6);
  assert.equal(found.skipped.at(-1).why, "past the first 6 saved labels kino tries");
  // A skipped label is said once per project: the keys a saved edit said are left out next time.
  assert.equal(freshSkips(found.skipped, []).length, 7);
  assert.deepEqual(freshSkips(found.skipped, found.skipped.slice(0, 3).map(skipKey)), found.skipped.slice(3));
});

test("face at the call: a face that is not loaded names the face drawn and the call that loads it; a bundled face its fontSource missed is set at once", async () => {
  const { faceAtCallNotes, faceOff } = await import("./agent/face-at-call.mjs");
  const { jobTreatment } = await import("../engine/typeRoles.js");
  const fonts = await loadBundledFonts();
  const text = (name, fields) => ({ type: "text", id: name, name, text: "STEP", ...fields });
  assert.equal(faceOff({ fontFamily: "Inter", fontWeight: 700 }, fonts), null, "a bundled face draws as asked");
  const catalog = { list: async ({ search }) => ({ families: [{ id: "round-display", family: "Round Display", weights: [400, 500, 600, 700, 800], styles: ["normal"] }].filter((family) => family.family === search) }) };
  const pinned = text("pinned", { fontFamily: "Inter", fontWeight: 600, fontSource: "/api/fonts/Inter-700.ttf" });
  const lines = await faceAtCallNotes([text("one", { fontFamily: "Round Display", fontWeight: 800 }), text("two", { fontFamily: "Round Display", fontWeight: 800 }), text("heavy", { fontFamily: "Inter", fontWeight: 900 }), pinned], { fonts, catalog });
  assert.deepEqual(lines, [
    "font: pinned Inter 600 loaded from kino's bundled fonts (its fontSource named another face, so it drew in Inter 700)",
    `font: one, two ask Round Display 800, not loaded: drawn in Inter 700 now; set_font {layers:["one","two"], family:"Round Display", weight:800} loads it from kino's font catalog`,
    `font: heavy asks Inter 900, not loaded: drawn in Inter 700 now (Inter loaded here: 400, 500, 600, 700); kino's font catalog lists no Inter 900: weight 700 draws as asked, or project {action:"import", file:"<a Inter 900 font file>"} loads it`,
  ]);
  assert.equal(pinned.fontSource, "/api/fonts/Inter-600.ttf");
  // A payoff with no type label takes the project's largest text's size (printed), else the starting guess (printed as one).
  const scene = { width: 1280, height: 720, background: "#fafaf7", layers: [] };
  const big = jobTreatment("payoff", { scene, text: "KILL", largest: { size: 180, name: "title" } });
  assert.equal(big.properties.fontSize, 180);
  assert.match(big.from, /; size from the project's largest text title \(180 px, letters 18% of the height\)/);
  assert.match(jobTreatment("payoff", { scene, text: "KILL" }).from, /; size 14% of the height, a starting guess \(no type label; no project text\)/);
  // A largest text of a subtitle's size (run dm3-a: 49 px lines on 1080) is not a payoff's size: the guess, with that fact.
  const small = jobTreatment("payoff", { scene, text: "KILL", largest: { size: 33, name: "line" } });
  assert.equal(small.properties.fontSize, 101);
  assert.match(small.from, /a starting guess \(no type label; the project's largest text line \(33 px, letters 3\.3% of the height\) is 8% or under, a subtitle's size\)/);
});

test("agent service: an add_layer text with a role and no face or fill gets its job's fields and, as a payoff, a letter entrance by its cue", async (t) => {
  const { server, agent } = await startFontServer(t);
  await agent("project", { action: "create", id: "jobs", name: "Jobs", width: 1280, height: 720, duration: 4 });
  await agent("edit", { project: "jobs", ops: [{ op: "set_cues", cues: [{ name: "song-drop-1", time: 2, kind: "marker" }] }] });
  const added = await agent("edit", { project: "jobs", ops: [
    { op: "add_layer", layerType: "text", name: "line", properties: { text: "I will find you, I swear.", role: "caption" } },
    { op: "add_layer", layerType: "text", name: "word", properties: { text: "FIND YOU", role: "headline" }, animations: [{ kind: "show", start: 2 }] },
    { op: "add_layer", layerType: "text", name: "mine", properties: { text: "KEPT", role: "headline", fontFamily: "Inter", fill: "#123456" } },
    // A fill at the top level or under another name (color) is the agent's too: no "given twice" refusal.
    { op: "add_layer", layerType: "text", name: "top", properties: { text: "TOP", role: "headline" }, fill: "#00ff00" },
    { op: "add_layer", layerType: "text", name: "alias", properties: { text: "ALIAS", role: "headline", color: "#ff00ff" } },
    // Shown at 1 s by its mediaStart: the letter entrance starts there, not at 0.
    { op: "add_layer", layerType: "text", name: "late", properties: { text: "LATE", role: "headline", mediaStart: 1 } },
  ] });
  assert.equal(added.isError, undefined, added.text);
  const notes = (added.data.notes ?? []).join("\n");
  assert.doesNotMatch(notes, /type: (top|alias) /);
  assert.match(notes, /type: late as payoff[^\n]*letters rise in at 1 s/);
  assert.match(notes, /type: line as subtitle from scene colors \(background #[0-9a-f]{6}; no measured type label for this job\): Inter 600, 32 px, fill #[0-9a-f]{6}, edge 2 px/);
  // Bundled Inter has no 900: the payoff takes the nearest weight Inter really has (no font_fallback).
  assert.match(notes, /type: word as payoff from scene colors[^\n]*face from Inter 700, the nearest weight installed \(no face has 900[^\n]*: Inter 700, 101 px[^\n]*; entrance: letters slam in on cue:song-drop-1 \(2 s\)/);
  assert.doesNotMatch(notes, /type: mine/, "a text that names its face and fill keeps them");
  const layers = (await (await server.api("/api/projects/jobs")).json()).document.scenes[0].layers;
  const word = layers.find((layer) => layer.name === "word");
  assert.deepEqual([word.fontFamily, word.fontWeight], ["Inter", 700]);
  assert.ok(word.animations.some((animation) => animation.preset?.id === "custom-text" && animation.start === 2 && animation.unit === "letters"), JSON.stringify(word.animations.map((a) => a.preset)));
  assert.equal(layers.find((layer) => layer.name === "mine").fontSize, 48);
  assert.deepEqual(["top", "alias"].map((name) => layers.find((layer) => layer.name === name).fill), ["#00ff00", "#ff00ff"]);
  assert.ok(layers.find((layer) => layer.name === "late").animations.some((animation) => animation.preset?.id === "custom-text" && animation.start === 1));
  // Board shot text with no family, weight, size or fill: a line takes the subtitle treatment, the
  // last short word the payoff one; the values are printed and the fields the agent gave stay.
  const card = (cue, text) => ({ cue, dur: 2, pacing: "free", media: "none", in: "none", crop: "none", subject: "none", follow: "none", text, sound: "none", why: "the words" });
  const board = await agent("edit", { project: "jobs", ops: [{ op: "board", music: "none", shots: [card(0, { text: "I will find you, I swear." }), card(2, { text: "FIND YOU", fill: "#ff00ff" })] }] });
  assert.equal(board.isError, undefined, board.text);
  const boardNotes = board.data.notes.join("\n");
  assert.match(boardNotes, /board shot 1 text as subtitle from scene colors \([^\n]*\): family Inter, weight 600, size 32 px, fill #111111, y 86 % \(text\.family, text\.weight, text\.size, text\.fill, text\.y change them\)/);
  assert.match(boardNotes, /board shot 2 text as payoff from scene colors[^\n]*face from the project's text (word|late) \(Inter 700, the largest text\): family Inter, weight 700, size 101 px, y 50 % \(text\.family, text\.weight, text\.size, text\.y change them\)/);
  const shots = (await (await server.api("/api/projects/jobs")).json()).document.board.shots;
  assert.deepEqual(shots.map((shot) => [shot.text.weight, shot.text.size, shot.text.fill, shot.text.y]), [[600, 32, "#111111", 86], [700, 101, "#ff00ff", 50]]);
  // A caption over a full-frame dark picture: the fill and edge are chosen against the picture, not the white background.
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(64, 36);
  canvas.getContext("2d").fillStyle = "#14161a";
  canvas.getContext("2d").fillRect(0, 0, 64, 36);
  const upload = await server.api("/api/media", { method: "POST", headers: { "content-type": "image/png", "x-file-name": "night.png" }, body: canvas.toBuffer("image/png") });
  const media = await upload.json();
  const pictured = await agent("edit", { project: "jobs", ops: [{ op: "add_layer", layerType: "image", name: "night", properties: { src: media.src ?? media.media?.src, x: 0, y: 0, width: 1280, height: 720 } }] });
  assert.equal(pictured.isError, undefined, pictured.text);
  const over = await agent("edit", { project: "jobs", ops: [{ op: "add_layer", layerType: "text", name: "over", properties: { text: "We walk on, into the night.", role: "caption" } }] });
  assert.match((over.data.notes ?? []).join("\n"), /type: over as subtitle from the picture behind \(#14161a measured from night at 0 s\); no measured type label for this job; fill #ffffff at 1\d\.\d:1 on #14161a; face from the project's text line \(Inter 600, role caption\): Inter 600, 32 px, fill #ffffff, edge 2 px/);
  // check: the payoff's Inter 700 needs no fallback; an agent-named Inter 900 (bundled Inter stops at 700) still does.
  // Board words over a shot's own dark picture: the fill is read on that picture (not a layer yet), not the white background.
  const pictureShot = { cue: 2, dur: 1, pacing: "free", media: media.src ?? media.media?.src, in: "none", crop: "whole", subject: "none", follow: "none", text: { text: "We walk on, into the night." }, sound: "none", why: "the night" };
  // A tall picture shown whole covers under half the words' box (202 of 1152 px wide): the background shows there.
  const narrow = createCanvas(18, 64);
  narrow.getContext("2d").fillStyle = "#14161a";
  narrow.getContext("2d").fillRect(0, 0, 18, 64);
  const tall = await (await server.api("/api/media", { method: "POST", headers: { "content-type": "image/png", "x-file-name": "tall.png" }, body: narrow.toBuffer("image/png") })).json();
  const night = await agent("edit", { project: "jobs", ops: [{ op: "board", music: "none", shots: [card(0, { text: "I will find you, I swear." }), pictureShot, { ...pictureShot, cue: 3, media: tall.src ?? tall.media?.src }] }] });
  assert.equal(night.isError, undefined, night.text);
  assert.match(night.data.notes.join("\n"), /board shot 2 text as subtitle from the picture behind \(#14161a measured from night\.png, this shot's own picture\); no measured type label for this job; fill #ffffff at 1\d\.\d:1 on #14161a[^\n]*: family Inter, weight 600, size 32 px, fill #ffffff/);
  assert.match(night.data.notes.join("\n"), /board shot 3 text as subtitle from scene colors \(background #ffffff;[^\n]*fill #111111/);
  // A face named at the call that is not loaded: the receipt names the face drawn now and the call that loads it.
  const heavy = await agent("edit", { project: "jobs", ops: [{ op: "add_layer", layerType: "text", name: "heavy", properties: { text: "HEAVY", fontFamily: "Inter", fontWeight: 900, fontSize: 20, x: 10, y: 10, width: 200, height: 30 } }] });
  assert.match((heavy.data.notes ?? []).join("\n"), /font: heavy asks Inter 900, not loaded: drawn in Inter 700 now \(Inter loaded here: 400, 500, 600, 700\); /);
  const checked = JSON.stringify((await agent("check", { project: "jobs", rules: ["font_fallback"], pixels: false })).data);
  assert.match(checked, /font_fallback[^\]]*heavy|heavy[^\]]*font_fallback/, checked);
  assert.doesNotMatch(checked, /\bword\b/, checked);
});

// Measured on the benchmark crops: a dotted lettering read dots 0.43 and lost to solid condensed faces,
// and its class search ANDed "condensed" into the dotted families so none was downloaded.
test("fonts like: dotted and solid letterings compare as classes, and a dotted class fetches dotted families on their own", async () => {
  const { distance } = await import("./font-like.mjs");
  const { classFamilies } = await import("./agent/font-help.mjs");
  const dotted = { weight: 0.085, width: 0.557, slant: 0, corners: 0.833, contrast: 0, rough: 0.058, dots: 0.431 };
  const doto = { weight: 0.044, width: 0.616, slant: 0, corners: 0.763, contrast: 0, rough: 0.251, dots: 1 };
  const solid = { weight: 0.065, width: 0.404, slant: 0, corners: 0.85, contrast: 0, rough: 0.034, dots: 0 };
  assert.ok(distance(dotted, doto) < distance(dotted, solid), `${distance(dotted, doto)} vs ${distance(dotted, solid)}`);
  const families = [{ id: "doto", family: "Doto", category: "sans-serif", weights: [100, 900] }, { id: "barlow-condensed", family: "Barlow Condensed", category: "sans-serif", weights: [100, 900] }];
  const catalog = { list: async () => ({ families, total: families.length, offline: false }) };
  assert.deepEqual((await classFamilies(["dot-matrix", "condensed"], catalog)).map((family) => family.family), ["Doto", "Barlow Condensed"]);
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

// The same through the agent service: set_font sets the face and draws only the missing glyph
// in a font that has it (said in the notes), check's fix and library query.
test("agent service: set_font on a face that lacks a glyph sets it, draws that glyph in a font that has it and says so; check and library use the same help", async (t) => {
  const { server, agent } = await startFontServer(t);

  await agent("project", { action: "create", id: "glyphs", name: "Glyphs", width: 1280, height: 720, duration: 2 });
  const added = await agent("edit", { project: "glyphs", ops: [{ op: "add_layer", layerType: "text", properties: { id: "title", text: "GLOW +∞", x: 100, y: 100, width: 900, height: 160, fontSize: 96 } }] });
  assert.equal(added.isError, undefined, added.text);

  const retried = await agent("edit", { project: "glyphs", ops: [{ op: "set_font", layerIds: ["title"], family: "Anton" }] });
  assert.equal(retried.isError, undefined, retried.text);
  const said = (retried.data.notes ?? []).join(" ");
  assert.ok(said.includes(`op 0 set_font set Anton. Anton does not include "∞". Fonts with it (glyphs checked): Roboto 400 (fontSource ${source("roboto")}). Only those characters are drawn in the first font named`), said);
  assert.doesNotMatch(said, /Noto Sans Symbols 2/);
  const saved = await (await server.api("/api/projects/glyphs")).json();
  const title = saved.document.scenes[0].layers.find((layer) => layer.id === "title");
  assert.equal(title.fontFamily, "Anton");
  assert.deepEqual(title.textStyleRanges, [{ start: 6, end: 7, style: { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") } }]);

  await agent("edit", { project: "glyphs", ops: [{ op: "add_layer", layerType: "text", properties: { id: "line", text: "to ∞", x: 100, y: 400, width: 900, height: 120, fontSize: 64 } }] });
  const checked = await agent("check", { project: "glyphs", rules: ["missing_glyphs"] });
  assert.deepEqual(checked.data.findings.map((finding) => finding.ref), ["line"], "title draws every character now; line still lacks ∞");
  const [finding] = checked.data.findings;
  assert.deepEqual(Object.keys(finding).filter((key) => key === "explained"), [], "the answer's finding carries no bookkeeping field");
  assert.ok(finding.message.includes(`Roboto 400 (fontSource ${source("roboto")}) has them (glyphs checked)`), finding.message);
  assert.deepEqual(finding.fix, { op: "update_layer", layerId: "line", properties: { textStyleRanges: [{ start: 3, end: 4, style: { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") } }] } });
  assert.match(checked.text, /fix\(auto\): /, "the fix is marked auto");
  const fixed = await agent("check", { project: "glyphs", rules: ["missing_glyphs"], fix: "auto" });
  assert.equal(fixed.data.applied.ops, 1, fixed.text);
  assert.equal(fixed.data.findings.length, 0, "check fix:auto draws the missing character in a font that has it");
  const line = (await (await server.api("/api/projects/glyphs")).json()).document.scenes[0].layers.find((layer) => layer.id === "line");
  assert.deepEqual(line.textStyleRanges, finding.fix.properties.textStyleRanges);

  const byQuery = await agent("library", { topic: "fonts", query: "Roboto" });
  assert.match(byQuery.text, /^installed: Roboto\ncatalog: Roboto 400\n/, "query works like search");
  assert.doesNotMatch(byQuery.text, /Anton/);
  assert.match((await agent("library", { topic: "fonts", search: "∞" })).text, /^fonts with "∞" \(glyphs checked\): Roboto 400 /);

  // like with no region: the answer names the lettering box it measured (the face marks run here too, with no rejects or other projects).
  // The letters are set in a bundled face: a system face such as sans-serif is not on every computer.
  const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
  GlobalFonts.registerFromPath(path.resolve("assets/fonts/NotoSerif-700.woff2"), "Like Serif");
  const picture = createCanvas(900, 300);
  const drawing = picture.getContext("2d");
  drawing.fillStyle = "#182030"; drawing.fillRect(0, 0, 900, 300);
  drawing.fillStyle = "#f4f0e8"; drawing.font = "110px 'Like Serif'"; drawing.fillText("STORM", 60, 200);
  const folder = await mkdtemp(path.join(tmpdir(), "kino-like-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "title.png");
  await (await import("node:fs/promises")).writeFile(file, picture.toBuffer("image/png"));
  const liked = await agent("library", { topic: "fonts", project: "glyphs", like: file, text: "STORM" });
  assert.equal(liked.isError, undefined, liked.text);
  assert.match(liked.text, /\nbox measured: \[\d+, \d+, \d+, \d+\], the largest of 1 lettering box kino found\./);
  assert.equal(liked.data.box.found, 1);
});

// One set_font on several layers that lack ∞ sets them all in one edit.
test("agent service: set_font on several layers that lack ∞ sets them all at once, each missing glyph drawn in a font that has it", async (t) => {
  const { server, agent } = await startFontServer(t);
  await agent("project", { action: "create", id: "many", name: "Many", width: 1280, height: 720, duration: 2 });
  const text = (id, value, y) => ({ op: "add_layer", layerType: "text", properties: { id, text: value, x: 100, y, width: 900, height: 120, fontSize: 64 } });
  const added = await agent("edit", { project: "many", ops: [text("title", "GLOW +∞", 100), text("sub", "to ∞", 300), text("plain", "GLOW", 500)] });
  assert.equal(added.isError, undefined, added.text);

  const retried = await agent("edit", { project: "many", ops: [{ op: "set_font", layerIds: ["title", "sub", "plain"], family: "Anton" }] });
  assert.equal(retried.isError, undefined, retried.text);
  assert.match((retried.data.notes ?? []).join(" "), /title, sub: Anton does not include "∞"\. .*a textStyleRanges range on title, sub\)/);
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
test("agent service: with a serif installed, Anton's missing glyph still goes to the sans first, every time", async (t) => {
  const { server, agent } = await startFontServer(t, { withSerif: true });
  await agent("project", { action: "create", id: "kinds", name: "Kinds", width: 1080, height: 1920, duration: 2 });
  await agent("edit", { project: "kinds", ops: [{ op: "add_layer", layerType: "text", properties: { id: "save", text: "SAVE ∞", x: 100, y: 300, width: 880, height: 200, fontSize: 120 } }] });
  for (const attempt of [1, 2]) {
    const set = await agent("edit", { project: "kinds", ops: [{ op: "set_font", layerIds: ["save"], family: "Anton" }] });
    assert.equal(set.isError, undefined, set.text);
    assert.ok((set.data.notes ?? []).join(" ").includes(`Fonts with it (glyphs checked): Roboto 400 (fontSource ${source("roboto")}), Lora 400 (fontSource ${source("lora")}).`), `attempt ${attempt}: ${set.text}`);
    const saved = await (await server.api("/api/projects/kinds")).json();
    assert.deepEqual(saved.document.scenes[0].layers.find((layer) => layer.id === "save").textStyleRanges, [{ start: 5, end: 6, style: { fontFamily: "Roboto", fontWeight: 400, fontSource: source("roboto") } }]);
  }
});
